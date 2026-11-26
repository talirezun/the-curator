#!/usr/bin/env node
/**
 * e2e-context-pro.mjs — Context's Pro switch, DRIVEN IN A REAL BROWSER
 * (v4.2.0 fix package: audit M1, the focus minors, minor 2, DEF-6, DEF-8).
 *
 * LIVE_LOCAL (scripts/run-tests.js): starts this checkout's server on a spare
 * port against an ISOLATED world (scripts/demo-domain.mjs --workspace, its own
 * user-data and domains dirs, a FAKE HOME, CURATOR_NO_OPEN) and drives the
 * page with headless Chrome over CDP (scripts/visual/), with real mouse
 * events. No model is called, nothing is pushed.
 *
 *   1  "More in Pro" on step 5 and on step 4: the step stays where it was on
 *      screen (±8 px) and focus moves to it — never <body> (M1 / DEF-1).
 *   2  The toast's Undo: Pro goes off, the step stays, focus is not <body>.
 *   3  "What an agent receives, in full" open, Pro turned on, the reader
 *      closed: focus lands on a control, not <body> (minor 1b).
 *   4  Re-check with a harness's reader open: "What Setup read" keeps its
 *      open state and the reader keeps its scroll (minor 2).
 *   5  "+ Add an agent harness" → a pick: focus is inside the new reader
 *      (DEF-6).
 *   6  375 px: no sideways scroll on Context (DEF-8).
 *
 *   node scripts/e2e-context-pro.mjs [--shots <dir>] [--keep]
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
  console.log('⊘ e2e-context-pro: no Chrome / Chromium / Edge found — skipped (it needs a real browser).');
  process.exit(0);
}

// ── the isolated world ─────────────────────────────────────────────────────
const base = mkdtempSync(path.join(os.tmpdir(), 'curator-e2e-ctxpro-'));
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
  await page.setViewport(1280, 1000, 1);
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
  const shot = async (name) => { if (!SHOTS) return; const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64')); };
  const mouseClick = async (sel) => {
    // Scrolled into view only when it is not already on screen (a press
    // never moves the page itself).
    const r = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const b0 = el.getBoundingClientRect();
      if (b0.top < 0 || b0.bottom > innerHeight) el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel);
    if (!r) return false;
    await delay(150);
    const r2 = await page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r2.x, y: r2.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r2.x, y: r2.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r2.x, y: r2.y, button: 'left', clickCount: 1 });
    return true;
  };
  const active = () => page.evaluate(() => { const a = document.activeElement; return a ? { tag: a.tagName, id: a.id || '', cls: String(a.className || '').slice(0, 80), body: a === document.body } : null; });
  const topOf = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? Math.round(el.getBoundingClientRect().top) : null; }, sel);
  const setPro = (on) => page.evaluate(async (v) => { const r = await fetch('/api/config/ui-detail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uiDetail: v ? 'pro' : 'simple' }) }); return r.ok; }, on);

  await until('Context › exhibit-site, steps 4 and 5', () => !!document.querySelector('#mem-step-context-session [data-pro-more]')
    && !!document.querySelector('#mem-step-context-setup .mem-hr-list'), null, 40000);
  await delay(600);
  step('Context opens in the simple view (Pro off): both steps carry a "More in Pro" door', await page.evaluate(() => document.documentElement.getAttribute('data-pro') === 'off'
    && !!document.querySelector('#mem-step-context-setup [data-pro-more]')));
  await shot('FIX-01-simple-1280');

  // ── 1. the door keeps the place (step 5, then step 4) ───────────────────
  for (const [stepId, label] of [['mem-step-context-setup', 'step 5 (Setup)'], ['mem-step-context-session', 'step 4 (Session start)']]) {
    if (await page.evaluate(() => document.documentElement.getAttribute('data-pro') === 'on')) {
      await setPro(false);
      await page.evaluate(() => location.reload());
      await until('the simple view again', () => document.documentElement.getAttribute('data-pro') === 'off' && !!document.querySelector('#mem-step-context-setup [data-pro-more]'), null, 30000);
      await delay(600);
    }
    // Bring the door into view the way a user does: scroll so it sits low in the viewport.
    await page.evaluate((id) => { const b = document.querySelector('#' + id + ' [data-pro-more]'); const m = document.querySelector('main.main');
      m.scrollTop += b.getBoundingClientRect().top - 640; }, stepId);
    await delay(250);
    const before = await topOf('#' + stepId);
    await page.evaluate((id) => { window.__tops = []; const t0 = performance.now(); const m = document.querySelector('main.main');
      const f = () => { const el = document.getElementById(id); window.__tops.push([Math.round(performance.now() - t0), el ? Math.round(el.getBoundingClientRect().top) : null, m.scrollTop]); if (performance.now() - t0 < 900) requestAnimationFrame(f); }; requestAnimationFrame(f); }, stepId);
    if (process.env.E2E_DEBUG) await page.evaluate((id) => { window.__sets = []; const m = document.querySelector('main.main');
      const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      Object.defineProperty(m, 'scrollTop', { configurable: true, get() { return d.get.call(this); }, set(v) { const el = document.getElementById(id);
        window.__sets.push({ from: d.get.call(this), to: Math.round(v), top: el ? Math.round(el.getBoundingClientRect().top) : null, stack: new Error().stack.split('\n').slice(2, 4).join(' | ').replace(/http:\/\/localhost:\d+/g, '') }); d.set.call(this, v); } });
      m.addEventListener('scroll', () => window.__sets.push({ scroll: d.get.call(m) }));
      const si = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (...a) { window.__sets.push({ sIV: this.id || this.className, stack: new Error().stack.split('\n').slice(2, 4).join(' | ') }); return si.apply(this, a); };
      const fo = HTMLElement.prototype.focus; HTMLElement.prototype.focus = function (...a) { window.__sets.push({ focus: this.id || this.className, opt: JSON.stringify(a[0] || null), stack: new Error().stack.split('\n').slice(2, 3).join(' | ').replace(/http:\/\/localhost:\d+/g, '') }); return fo.apply(this, a); };
    }, stepId);
    await mouseClick('#' + stepId + ' [data-pro-more]');
    await delay(700);
    if (process.env.E2E_DEBUG) console.log('  [sets] ' + JSON.stringify(await page.evaluate(() => window.__sets)));
    const after = await topOf('#' + stepId);
    if (process.env.E2E_DEBUG) console.log('  [tops] ' + JSON.stringify(await page.evaluate(() => window.__tops)));
    const a = await active();
    const on = await page.evaluate(() => document.documentElement.getAttribute('data-pro') === 'on');
    step(label + ': "More in Pro" turns Pro on', on);
    // Where Pro makes the page SHORTER below the step (step 5's folds start
    // shut), the page may simply end: then the step sits as close as the end
    // of the page allows, and the shortfall is exactly the clamp.
    const end = await page.evaluate(() => { const m = document.querySelector('main.main'); return { atEnd: m.scrollTop >= m.scrollHeight - m.clientHeight - 1, top: m.scrollTop }; });
    const held = before !== null && after !== null && (Math.abs(after - before) <= 8 || (end.atEnd && after > before && after - before <= 60));
    step(label + ': …the step stays where it was on screen (±8 px, or as close as the end of the page allows)', held,
      `before ${before} · after ${after}${end.atEnd ? ' · the page is at its end' : ''}`);
    step(label + ': …and focus moves to it, never <body>', a && !a.body && a.id === stepId, JSON.stringify(a));
    await shot('FIX-02-door-' + (stepId === 'mem-step-context-setup' ? 'step5' : 'step4') + '-after');

    // ── 2. the toast's Undo ───────────────────────────────────────────────
    if (stepId === 'mem-step-context-setup') {
      const hasUndo = await until('the "Pro is on" toast with Undo', () => !!document.querySelector('[data-pro-undo]'), null, 4000).catch(() => false);
      step('the "Pro is on" toast carries Undo', !!hasUndo);
      if (hasUndo) {
        const b0 = await topOf('#' + stepId);
        await mouseClick('[data-pro-undo]');
        await delay(700);
        const b1 = await topOf('#' + stepId);
        const a2 = await active();
        step('Undo: Pro is off again', await page.evaluate(() => document.documentElement.getAttribute('data-pro') === 'off'));
        step('Undo: …the step stays where it was (±8 px)', Math.abs(b1 - b0) <= 8, `before ${b0} · after ${b1}`);
        step('Undo: …and focus is on the step, not <body>', a2 && !a2.body && a2.id === stepId, JSON.stringify(a2));
      }
    }
  }

  // ── 3. the "in full" reader, Pro turned on while it is open, then closed ─
  {
    await setPro(false);
    await page.evaluate(() => location.reload());
    await until('the simple view', () => document.documentElement.getAttribute('data-pro') === 'off' && !!document.getElementById('mem-ss-full'), null, 30000);
    await delay(500);
    await mouseClick('#mem-ss-full');
    await until('the in-full reader', () => !!document.querySelector('#reader-root .reader-panel'), null, 5000);
    await delay(300);
    // Turn Pro on with the rail switch (behind the reader: a script press, as the keyboard shortcut would).
    await page.evaluate(() => document.querySelector('[data-pro-switch]').click());
    await delay(500);
    await page.evaluate(() => document.getElementById('reader-close-btn').click());
    await delay(500);
    const a = await active();
    step('"in full" reader, Pro turned on, reader closed: focus is not <body>', a && !a.body, JSON.stringify(a));
    step('…it is on the "What an agent receives" fold that replaced the door', a && a.id === 'mem-fold-receives', JSON.stringify(a));
  }

  // ── 4. Re-check with a harness's reader open ────────────────────────────
  {
    // Pro is on now: the reader's "What Setup read" opens with Pro. Shut it,
    // scroll the reader, then Re-check.
    await page.evaluate(() => { const d = document.querySelector('details[data-mem-fold="setup-tools"]'); if (d) d.open = true; });
    await delay(200);
    await mouseClick('#mem-setup-tool-claude-code');
    await until('Claude Code\'s reader', () => !!document.querySelector('#reader-root .mem-setup-evfold'), null, 5000);
    await delay(300);
    await page.evaluate(() => { document.querySelector('#reader-root .mem-setup-evfold').open = false; const b = document.querySelector('#reader-root .reader-body'); b.scrollTop = 260; });
    await delay(150);
    const before = await page.evaluate(() => ({ open: document.querySelector('#reader-root .mem-setup-evfold').open, scroll: document.querySelector('#reader-root .reader-body').scrollTop }));
    await page.evaluate(() => document.querySelector('#mem-step-context-setup [data-setup-act="check"]').click());
    await until('the re-check to land', () => !document.querySelector('#mem-step-context-setup [data-setup-act="check"][disabled]'), null, 15000);
    await delay(800);
    const after = await page.evaluate(() => ({ open: document.querySelector('#reader-root .mem-setup-evfold').open, scroll: document.querySelector('#reader-root .reader-body').scrollTop }));
    step('Re-check with a reader open: "What Setup read" stays as the user left it (shut)', before.open === false && after.open === false, JSON.stringify({ before, after }));
    step('…and the reader keeps its scroll (±8 px)', before.scroll > 0 && Math.abs(after.scroll - before.scroll) <= 8, JSON.stringify({ before, after }));
    await page.evaluate(() => { document.querySelector('#reader-root .mem-setup-evfold').open = true; });
    await page.evaluate(() => document.querySelector('#mem-step-context-setup [data-setup-act="check"]').click());
    await until('the second re-check', () => !document.querySelector('#mem-step-context-setup [data-setup-act="check"][disabled]'), null, 15000);
    await delay(800);
    step('…and stays OPEN when the user had opened it', await page.evaluate(() => document.querySelector('#reader-root .mem-setup-evfold').open === true));
    await shot('FIX-03-reader-after-recheck');
    await page.evaluate(() => document.getElementById('reader-close-btn').click());
    await delay(400);
  }

  // ── 4b. no maintainer notes in "What Setup read" (DEF-7), real backend ──
  {
    await mouseClick('#mem-setup-tool-antigravity');
    await until('Antigravity\'s reader', () => !!document.querySelector('#reader-root .mem-setup-evfold'), null, 5000);
    await page.evaluate(() => { document.querySelector('#reader-root .mem-setup-evfold').open = true; });
    const t = await page.evaluate(() => document.querySelector('#reader-root .mem-setup-evbody').innerText);
    step('Antigravity\'s "What Setup read": no maintainer notes or test dates (DEF-7)',
      t.length > 40 && !/maintainer|observed|three separate files|not seen used|\b20\d\d-\d\d-\d\d\b/i.test(t), t.replace(/\s+/g, ' ').slice(0, 500));
    await shot('FIX-03b-antigravity-what-setup-read');
    await page.evaluate(() => document.getElementById('reader-close-btn').click());
    await delay(400);
  }

  // ── 5. "+ Add an agent harness" → a pick → focus in the new reader ──────
  {
    await mouseClick('#mem-setup-add');
    await until('the Add menu', () => [...document.querySelectorAll('[role="option"]')].some((o) => /Cursor/.test(o.textContent || '')), null, 5000);
    await delay(200);
    await shot('FIX-04-add-menu-hover');
    await mouseClick('[role="option"][data-value="cursor"]').then(async (okc) => {
      if (!okc) await page.evaluate(() => { const o = [...document.querySelectorAll('[role="option"]')].find((x) => /Cursor/.test(x.textContent || '')); if (o) o.click(); });
    });
    await until('Cursor\'s reader', () => !!document.querySelector('#reader-root #mem-setup-guide-h'), null, 15000);
    await delay(400);
    const a = await active();
    step('Add a harness: focus is INSIDE its new reader (its guide), not <body>', a && !a.body
      && await page.evaluate(() => document.getElementById('reader-root').contains(document.activeElement)), JSON.stringify(a));
    await shot('FIX-05-after-add-reader');
    await page.evaluate(() => document.getElementById('reader-close-btn').click());
    await delay(400);
  }

  // ── 6. 375 px: no sideways scroll, both modes ───────────────────────────
  // The repository folder set to a fresh git repo with no .curator-project,
  // so the loud line carries its longest button ("Copy the command that
  // creates, commits and pushes it", e2e DEF-8).
  {
    const repo = path.join(ws.home, 'Projects', 'exhibit-site');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const r = await page.evaluate(async (p) => { const res = await fetch('/api/setup/projects/early-computing/exhibit-site/repo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) }); return res.status; }, repo);
    step('the repository folder is set (a git repo with no marker yet)', r === 200, r);
  }
  for (const on of [false, true]) {
    await setPro(on);
    await page.setViewport(375, 812, 2);
    await page.evaluate(() => location.reload());
    await until('Context at 375', () => !!document.querySelector('#mem-step-context-setup'), null, 30000);
    await delay(900);
    await page.evaluate(() => { for (const d of document.querySelectorAll('#mem-step-context-setup details, #mem-step-context-session details')) d.open = true; });
    await delay(300);
    const o = await page.evaluate(() => {
      const m = document.querySelector('main.main');
      const vw = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('#mem-step-context-setup *, #mem-step-context-session *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > vw + 1; })
        .slice(0, 4).map((e) => (e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().right));
      return { doc: document.documentElement.scrollWidth - vw, main: m ? m.scrollWidth - m.clientWidth : 0, wide };
    });
    step(`375 px, Pro ${on ? 'on' : 'off'}: no sideways scroll on Context`, o.doc <= 0 && o.main <= 0 && !o.wide.length, JSON.stringify(o));
    if (!on) {
      const long = await page.evaluate(() => [...document.querySelectorAll('#mem-step-context-setup .mem-setup-note-acts .btn')].map((b) => b.textContent.trim()).find((t) => /creates, commits and pushes/.test(t)) || null);
      step('…the loud line with the longest button is on screen (anti-vacuity)', !!long, long);
    }
    await page.evaluate(() => document.querySelector('#mem-step-context-setup').scrollIntoView({ block: 'start' }));
    await delay(200);
    await shot('FIX-06-step5-375-' + (on ? 'pro' : 'simple'));
    await page.setViewport(1280, 1000, 1);
  }

  // ── screenshots of the end state, Pro on, both steps ────────────────────
  await page.evaluate(() => location.reload());
  await until('Pro view', () => document.documentElement.getAttribute('data-pro') === 'on' && !!document.querySelector('#mem-step-context-setup'), null, 30000);
  await delay(900);
  await page.evaluate(() => document.querySelector('#mem-step-context-session').scrollIntoView({ block: 'start' }));
  await delay(300);
  await shot('FIX-07-pro-step4-1280');
  await page.evaluate(() => document.querySelector('#mem-step-context-setup').scrollIntoView({ block: 'start' }));
  await delay(300);
  await shot('FIX-08-pro-step5-1280');
  await setPro(false);
  await page.evaluate(() => location.reload());
  await until('simple view', () => document.documentElement.getAttribute('data-pro') === 'off' && !!document.querySelector('#mem-step-context-setup .mem-hr-list'), null, 30000);
  await delay(900);
  await page.evaluate(() => document.querySelector('#mem-step-context-session').scrollIntoView({ block: 'start' }));
  await delay(300);
  await shot('FIX-09-simple-step4-1280');
  await page.evaluate(() => document.querySelector('#mem-step-context-setup').scrollIntoView({ block: 'start' }));
  await delay(300);
  await shot('FIX-10-simple-step5-1280');
} catch (err) {
  step('the run itself', false, (err && err.stack) || String(err));
  console.log(serverLog.slice(-2000));
} finally {
  try { if (conn) conn.close(); } catch { /* */ }
  try { if (browser) await browser.close(); } catch { /* */ }
  child.kill('SIGTERM');
  if (!KEEP) { try { rmSync(base, { recursive: true, force: true }); } catch { /* */ } }
}
console.log('\n' + '─'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('Context Pro e2e FAILED'); process.exit(1); }
console.log('Context Pro e2e passed');
