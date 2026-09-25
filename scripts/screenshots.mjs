#!/usr/bin/env node
/**
 * Regenerate EVERY screenshot the docs use, from the SYNTHETIC demo workspace.
 *
 *   node scripts/screenshots.mjs                    write all of them into docs/images/
 *   node scripts/screenshots.mjs --out <dir>        write them somewhere else (to review first)
 *   node scripts/screenshots.mjs --only chat,sync   just these shots (by name, see SHOTS)
 *   node scripts/screenshots.mjs --list             print the shot names and exit
 *
 * WHAT IT DOES
 *   1. writes the demo workspace (scripts/demo-domain.mjs --workspace) into a
 *      fresh /tmp/curator-demo-XXXXXX: two wiki domains, a project with a
 *      brief, two canonical documents, handoffs from two tools (with a kept
 *      previous.md), a journal, a content-free MCP usage log, three items in
 *      the trash, and a Personal Sync repo whose "GitHub" is a LOCAL bare repo
 *      labelled github.com/example/my-brain;
 *   2. starts src/server.js ISOLATED on an ephemeral port — both test seams,
 *      HOME pointed at an empty fake home (so no real MCP-client config is
 *      read), every provider and GitHub credential stripped from the child's
 *      env, and FAKE provider keys (or none, for the shots that show the
 *      unset state). No call leaves this machine;
 *   3. drives the Chromium-family browser already installed (the visual
 *      harness's own launcher and CDP client — no dependency is added) and
 *      captures each shot.
 *
 * NOT IN `npm test`: it needs a browser and takes about a minute. With no
 * browser it prints why and exits 0, like the visual harness.
 *
 * NOTHING PERSONAL can reach an image: the data is synthetic, the machine is
 * `demo-mac-4d3e2f`, and before each capture the page's visible text is checked
 * for this machine's host name, user name, home path and checkout path — a hit
 * ABORTS rather than writing the file.
 *
 * PROCESS SAFETY: only the exact child processes this script spawned are ever
 * signalled. No pkill, no port sweep.
 */

import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';

import { findBrowser, launchBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const OUT_DIR = path.resolve(arg('--out') || path.join(REPO_ROOT, 'docs', 'images'));
const ONLY = arg('--only') ? new Set(arg('--only').split(',').map(s => s.trim())) : null;

// Every shot is 1280 CSS px wide — the app's reference width — at x1.25, so
// the PNG is 1600 px: crisp at the README's width="800".
const SCALE = 1.25;
const FAKE = (p) => p + '-SCREENSHOT-FAKE-KEY-not-a-credential';   // assembled, as in scripts/visual/server.js

// ── in-page helpers (serialised into the page) ─────────────────────────────

const inPage = {
  clickRail: (view) => { document.querySelector(`#rail .rail-btn[data-view="${view}"]`).click(); return true; },
  settings: (section) => { const b = document.querySelector(`.settings-nav-row[data-section="${section}"]`); if (!b) return false; b.click(); return true; },
  openFold: (startsWith) => {
    const s = [...document.querySelectorAll('summary')].find(x => x.innerText.trim().startsWith(startsWith));
    if (!s) return false;
    const d = s.closest('details');
    if (d && !d.open) s.click();
    return true;
  },
  // Scroll whichever scroll container holds `sel` so that it sits `pad` px
  // below the top of that container.
  scrollTo: (sel, pad) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    let p = el.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    if (!p) { window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - pad); return true; }
    p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - pad;
    return true;
  },
  hasText: (t) => document.body.innerText.includes(t),
  clickText: (sel, t) => {
    const el = [...document.querySelectorAll(sel)].find(e => e.innerText.trim().startsWith(t));
    if (!el) return false;
    el.click();
    return true;
  },
};

// ── the shots ──────────────────────────────────────────────────────────────
//
// session: 'keys' = fake Gemini + Anthropic keys; 'nokeys' = none at all.
// themes:  both for the images the README shows as a light/dark <picture>.

const SHOTS = [
  { name: 'chat', file: 'curator-chat', themes: ['light', 'dark'], h: 1000, view: 'chat',
    async go(page) {
      await waitText(page, 'What linked the Analytical Engine');
      await page.evaluate(() => {
        const t = 'What linked the Analytical Engine';
        const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim().startsWith(t));
        el.click();
      });
      await waitText(page, "Babbage's half");
      await delay(1000);                         // the thread scrolls itself to its end once it has rendered
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
          if (el.scrollTop > 0 && el.innerText.includes("Babbage's half")) el.scrollTop = 0;
        }
        window.scrollTo(0, 0);
      });
    } },
  { name: 'domains', file: 'curator-domains', themes: ['light', 'dark'], h: 1000, view: 'domains',
    async go(page) { await waitText(page, 'OVERVIEW'); await waitText(page, 'Missing backlinks'); } },
  { name: 'ingest', file: 'curator-ingest', themes: ['light'], h: 1000, view: 'domains',
    async go(page, ws) {
      await waitText(page, 'Drop a source here');
      await setFiles(page, 'input[type=file]', ws.ingestFiles);
      await waitText(page, 'Estimated');
      await delay(800);
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('*')].filter(e => e.textContent.trim().startsWith('Batch ingest')).pop();
        el.setAttribute('data-shot-anchor', '');
      });
      await page.evaluate(inPage.scrollTo, '[data-shot-anchor]', 70);
    } },
  { name: 'agent-memory', file: 'curator-agent-memory', themes: ['light', 'dark'], h: 1150, view: 'memory',
    async go(page) {
      await waitText(page, 'Handoffs');
      await page.evaluate(inPage.openFold, 'Handoffs');
      await waitText(page, 'Checklist run once');
      await waitText(page, 'reply');          // the SESSION START tile arrives last
    } },
  { name: 'agent-memory-reader', file: 'curator-agent-memory-reader', themes: ['light'], h: 900, view: 'memory',
    async go(page) {
      await waitText(page, 'Handoffs');
      await page.evaluate(inPage.openFold, 'Handoffs');
      await waitText(page, 'Checklist run once');
      await page.evaluate(() => {
        const r = [...document.querySelectorAll('tr.mem-ws-row')].find(x => x.innerText.trim().startsWith('main'));
        r.querySelector('td:nth-child(2)').click();
      });
      await waitText(page, 'Previous handoff by');
    } },
  { name: 'capture-meter', file: 'curator-capture-meter', themes: ['light'], h: 900, view: 'memory',
    async go(page) {
      await waitText(page, 'Agent connections');
      await page.evaluate(inPage.openFold, 'Agent connections');
      await delay(600);
      await page.evaluate(() => {
        const s = [...document.querySelectorAll('summary')].find(x => x.innerText.trim().startsWith('Agent connections'));
        s.setAttribute('data-shot-anchor', '');
      });
      await delay(1200);
      await page.evaluate(inPage.scrollTo, '[data-shot-anchor]', 140);
    } },
  { name: 'sync', file: 'curator-sync', themes: ['light'], h: 640, view: 'sync',
    async go(page) { await waitText(page, 'github.com/example/my-brain'); await waitText(page, 'local changes'); } },
  { name: 'providers-keys', file: 'curator-providers-keys', themes: ['light', 'dark'], h: 1000, session: 'nokeys', view: 'settings',
    async go(page) { await page.evaluate(inPage.settings, 'providers'); await waitText(page, 'Connect a provider'); } },
  { name: 'model-picker', file: 'curator-model-picker', themes: ['light'], h: 1000, view: 'settings',
    async go(page) {
      await page.evaluate(inPage.settings, 'providers');
      await waitText(page, 'every model that can build your wiki');
      await page.evaluate(() => document.querySelector('summary.build-change-summary').click());
      await waitText(page, 'Use this');
      await page.evaluate(inPage.scrollTo, 'summary.build-change-summary', 24);
    } },
  { name: 'settings-general', file: 'curator-settings-general', themes: ['light'], h: 900, view: 'settings',
    async go(page) { await page.evaluate(inPage.settings, 'general'); await waitText(page, 'System check'); } },
  { name: 'health-limits', file: 'curator-health-limits', themes: ['light'], h: 640, view: 'settings',
    async go(page) { await page.evaluate(inPage.settings, 'health'); await waitText(page, 'candidate pairs'); } },
  { name: 'mcp-bridge', file: 'curator-mcp-bridge', themes: ['light'], h: 1000, view: 'settings',
    async before(origin) {
      // Exactly what "Set up Claude Desktop" does — into the FAKE home.
      const r = await fetch(`${origin}/api/mcp/write-config`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' });
      if (!r.ok) throw new Error(`write-config refused: ${r.status} ${await r.text()}`);
    },
    async go(page) { await page.evaluate(inPage.settings, 'mcp'); await waitText(page, 'Tool map'); } },
  { name: 'settings-trash', file: 'curator-settings-trash', themes: ['light'], h: 760, view: 'settings',
    async go(page) { await page.evaluate(inPage.settings, 'trash'); await waitText(page, 'old-drafts'); } },
  { name: 'shared-brain', file: 'curator-shared-brain', themes: ['light'], h: 640, view: 'domains',
    async go(page) {
      await waitText(page, 'Open Shared Brain');
      await page.evaluate(inPage.clickText, 'button', 'Open Shared Brain');
      await waitText(page, 'TEAM');
    } },
  { name: 'getting-started', file: 'curator-getting-started', themes: ['light'], h: 860, session: 'nokeys', view: 'settings', onboarding: true,
    async go(page) {
      // Settings › General › "Show setup guide" re-opens the panel on demand.
      await page.evaluate(inPage.settings, 'general');
      await waitText(page, 'Show setup guide');
      await page.evaluate(inPage.clickText, 'button', 'Show setup guide');
      await waitText(page, 'Getting started');
    } },
];

// ── plumbing ───────────────────────────────────────────────────────────────

async function waitText(page, text, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(inPage.hasText, text)) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for "${text}"`);
}

async function setFiles(page, selector, files) {
  const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`no ${selector}`);
  await page.send('DOM.setFileInputFiles', { nodeId, files });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function writeConfig(ws, keys) {
  const cfg = { activeProvider: 'gemini', domainsPath: ws.domains, sharedBrainEnabled: true };
  if (keys) { cfg.geminiApiKey = FAKE('AIza'); cfg.anthropicApiKey = FAKE('sk-ant'); }
  writeFileSync(path.join(ws.userData, '.curator-config.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

async function startServer(ws) {
  const port = await freePort();
  if (port === 3333) throw new Error('refusing port 3333 (the live app)');
  const env = { ...process.env };
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
                   'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL']) delete env[k];
  Object.assign(env, {
    PORT: String(port), CURATOR_NO_OPEN: '1', HOME: ws.home,
    CURATOR_TEST_USER_DATA_DIR: ws.userData, CURATOR_TEST_DOMAINS_DIR: ws.domains,
  });
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

function makeWorkspace() {
  // /tmp rather than os.tmpdir(): the path is printed on two screens (MCP
  // bridge, Trash), and /tmp/curator-demo-… reads as what it is.
  const base = mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'curator-demo-'));
  const ws = { base, domains: path.join(base, 'domains'), userData: path.join(base, 'userdata'), home: path.join(base, 'home') };
  mkdirSync(ws.home);
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'demo-domain.mjs'), ws.domains, '--workspace', ws.userData], {
    cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, HOME: ws.home, CURATOR_TEST_DOMAINS_DIR: ws.domains, CURATOR_TEST_USER_DATA_DIR: ws.userData },
  });
  // Two small sources for the Ingest shot (staged, never ingested).
  const src = path.join(base, 'sources');
  mkdirSync(src);
  writeFileSync(path.join(src, 'manchester-baby.md'),
    '# The Manchester Baby\n\nThe Small-Scale Experimental Machine ran its first stored program on 21 June 1948.\n\n' +
    'It used a Williams tube as memory, holding 32 words of 32 bits.\n'.repeat(12));
  writeFileSync(path.join(src, 'the-z3.md'),
    '# The Z3\n\nKonrad Zuse completed the Z3 in Berlin in 1941. It used about 2,600 relays and binary floating-point arithmetic.\n'.repeat(5));
  ws.ingestFiles = [path.join(src, 'manchester-baby.md'), path.join(src, 'the-z3.md')];
  return ws;
}

async function capture(conn, server, ws, shot, theme, forbidden) {
  const page = await CdpPage.create(conn);
  try {
    await page.setViewport(1280, shot.h, SCALE);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await page.send('DOM.enable');
    await page.navigate(`${server.origin}/api/version`);
    await page.evaluate((t, v, onboarding) => {
      localStorage.clear(); sessionStorage.clear();
      localStorage.setItem('curator-next-theme', t);
      localStorage.setItem('curator-next-view', v);
      localStorage.setItem('curator-next-chat-domain', 'early-computing');
      if (!onboarding) localStorage.setItem('curator-next-onboarding-dismissed-v1', '1');
      sessionStorage.setItem('curator-next-instance-banner-dismissed-v1', '1');
    }, theme, shot.view, !!shot.onboarding);
    await page.navigate(server.origin);
    for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__curatorBooted)); i++) await delay(100);
    await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
    await page.evaluate(inPage.clickRail, shot.view);
    await shot.go(page, ws);
    await page.evaluate(() => document.fonts && document.fonts.ready.then(() => true));
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1279, y: shot.h - 1 });
    await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
    await delay(900);

    const text = await page.evaluate(() => document.body.innerText);
    const leak = forbidden.find(s => text.includes(s));
    if (leak) throw new Error(`refusing to capture ${shot.name}: the page shows a machine-specific string (${leak.length} chars)`);

    const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT_DIR, `${shot.file}${theme === 'dark' && shot.themes.length > 1 ? '-dark' : ''}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  ✓ ${shot.name.padEnd(20)} ${theme.padEnd(5)} → ${path.relative(REPO_ROOT, file) || file}`);
  } finally {
    await page.close();
  }
}

async function main() {
  if (argv.includes('--list')) { for (const s of SHOTS) console.log(`${s.name}\t${s.file}.png\t${s.themes.join('+')}`); return; }
  if (!findBrowser()) {
    console.log('⊘ SKIPPED — no Chromium-family browser found (set CURATOR_VISUAL_BROWSER). Nothing was written.');
    return;
  }
  const shots = SHOTS.filter(s => !ONLY || ONLY.has(s.name));
  if (!shots.length) throw new Error(`no shot matches --only ${arg('--only')}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const forbidden = forbiddenStrings();

  let browser = null, conn = null;
  try {
    browser = await launchBrowser();
    conn = await CdpConnection.connect(browser.wsUrl);
    for (const session of ['keys', 'nokeys']) {
      const group = shots.filter(s => (s.session || 'keys') === session);
      if (!group.length) continue;
      // A FRESH workspace per session, seeded right now: every age on screen
      // ("8 min ago") is measured from this moment.
      const ws = makeWorkspace();
      writeConfig(ws, session === 'keys');
      const server = await startServer(ws);
      try {
        for (const shot of group) {
          if (shot.before) await shot.before(server.origin);
          for (const theme of shot.themes) await capture(conn, server, ws, shot, theme, forbidden);
        }
      } finally {
        await server.close();
        rmSync(ws.base, { recursive: true, force: true });
      }
    }
  } finally {
    try { conn && conn.close && await conn.close(); } catch { /* gone */ }
    if (browser) await browser.close();
  }
}

main().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
