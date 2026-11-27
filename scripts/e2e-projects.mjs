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
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    // Toasts and the app-wide provider-news banner are transient and are not the page.
    await page.evaluate(() => document.querySelectorAll('#model-retirement-banner').forEach((t) => { t.style.display = 'none'; }));
    // Toasts are transient and can carry provider news; they are not the page.
    await page.evaluate(() => document.querySelectorAll('.cur-toast, [data-toast]').forEach((t) => { t.style.display = 'none'; }));
    // At phone width the Pro tile strip fills the first screen; a 375 px shot
    // scrolls the tab strip to the top so the tab's own content is in frame.
    if (/-375$/.test(name)) await page.evaluate(() => { const t = document.querySelector('.kit-op-tabs'); if (t) t.scrollIntoView({ block: 'start' }); });
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
  // An agent's save, written to disk the way the store writes it, and the
  // view's WAKE (focus) — the poll's own refresh path, run now.
  const STATE = path.join(ws.domains, 'early-computing', 'state', 'exhibit-site');
  const agentSave = (scope, headline, harness = 'Claude Code') => {
    const dir = path.join(STATE, scope, 'demo-mac-4d3e2f');
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(path.join(dir, 'current.md'), '# Working state — ' + scope + '\n\n> ' + headline + '\n\n_Machine: demo-mac-4d3e2f · Scope: ' + scope
      + ' · Saved: ' + at + ' · Harness: ' + harness + ' · Model: claude-opus-5-5 · Curator: 4.3.0_\n\n## Where things stand\n\nBODY ' + headline + '\n');
    appendFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify({ at, scope, machine: 'demo-mac-4d3e2f', harness, model: 'claude-opus-5-5', curator: '4.3.0', headline, bytes: 300, rejections: [] }) + '\n');
  };
  const wake = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const inView = (sel) => page.evaluate((x) => { const el = document.querySelector(x); if (!el) return false; const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }, sel);
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
  step('the flow says what is true: it sets the agent up where it can, otherwise shows what to paste', await page.evaluate(() =>
    /sets it up for you where it can; otherwise it shows exactly what to paste/.test(document.querySelector('#reader-root .prj-connect').textContent)));
  await shot('simple-connect-pick-dark');
  {
    const before = await page.evaluate(() => (document.querySelector('#prj-tab-agents .kit-tab-count') || {}).textContent);
    const picked = await page.evaluate(() => { const r = [...document.querySelectorAll('#reader-root [data-kit-row-open^="connect:"]')].find((b) => /Not set up for this project yet/.test(b.closest('.kit-row').textContent)); if (!r) return null; r.click(); return r.getAttribute('data-kit-row-open'); });
    if (picked) {
      await until('the picked agent', () => !!document.querySelector('#reader-root [data-prj-connect="back"]'), null, 10000);
      await delay(800);
      step('a picked agent\'s flow: "On this computer" then "For this project", and a Done', await page.evaluate(() => {
        const parts = [...document.querySelectorAll('#reader-root .prj-flow-part > .prj-h, #reader-root section.prj-flow-part > h2')].map((h) => h.textContent);
        return parts[0] === 'On this computer' && parts.includes('For this project') && !!document.querySelector('#reader-root [data-prj-connect="done"]'); }));
      await page.evaluate(() => document.querySelector('#reader-root [data-prj-connect="back"]').click());
      await delay(800);
      step('Back leaves the project\'s agent list unchanged (e2e m14)', await page.evaluate(() => (document.querySelector('#prj-tab-agents .kit-tab-count') || {}).textContent) === before, picked);
    }
  }
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

  // ── 1b. v4.3.0 fix round — the must-fix behaviours, in Simple ─────────────
  await tab('agents');
  // Review items 1–2 and e2e M6: the toolbar connects; a fix appears once; the folder prompt is an optional notice.
  step('Simple › Agents: the toolbar says "+ Connect an agent" (no "+ Add an agent harness")', await page.evaluate(() =>
    !!document.querySelector('#prj-agents-connect') && !document.querySelector('[data-prj-panel="agents"] #mem-setup-add')));
  step('a row whose fix is in a notice carries a SHORT reason and no fix button (the fix appears once)', await page.evaluate(() => {
    const notices = [...document.querySelectorAll('[data-prj-panel="agents"] .kit-notice-title')].map((n) => n.textContent);
    const rows = [...document.querySelectorAll('[data-prj-panel="agents"] .kit-row')];
    return rows.every((r) => { const meta = (r.querySelector('.kit-row-meta') || {}).textContent || ''; return !notices.some((t) => t.length > 20 && meta.includes(t.replace(/\.$/, ''))); });
  }));
  step('the folder prompt is a kit notice, optional for a project without code', await page.evaluate(() =>
    [...document.querySelectorAll('[data-prj-panel="agents"] .kit-notice')].some((n) => /If this project has a folder on this/.test(n.textContent) && /without code can skip/.test(n.textContent))));
  // e2e M4: focus after Check again stays on the control, never body.
  await page.evaluate(() => document.querySelector('[data-prj-panel="agents"] [data-setup-act="check"]').focus());
  await page.evaluate(() => document.querySelector('[data-prj-panel="agents"] [data-setup-act="check"]').click());
  await delay(2500);
  step('after Check again, focus is on Check again (never body)', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-setup-act') === 'check'),
    JSON.stringify(await active()));
  // e2e M3: a background paint never shuts an open menu, never takes a field.
  await click('#prj-more');
  await until('the ··· menu', () => document.getElementById('prj-more').getAttribute('aria-expanded') === 'true');
  agentSave('claude-code', 'A SAVE WHILE THE MENU IS OPEN');
  await wake();
  await delay(3000);
  step('a background refresh does NOT close an open menu (···)', await page.evaluate(() => document.getElementById('prj-more').getAttribute('aria-expanded') === 'true'));
  await click('#prj-more');   // the trigger toggles the menu shut
  await until('the menu to close', () => document.getElementById('prj-more').getAttribute('aria-expanded') !== 'true', null, 4000).catch(() => null);
  await until('the deferred paint after the menu closes', () => /just now/.test(document.querySelector('.kit-op-status').textContent), null, 15000).catch(() => null);
  step('...and the deferred paint lands once it closes', await page.evaluate(() => /just now/.test(document.querySelector('.kit-op-status').textContent)),
    await page.evaluate(() => document.querySelector('.kit-op-status').textContent));
  if (await click('[data-prj-panel="agents"] .kit-notice [data-setup-act="choose-repo"]')) {
    await until('the folder field', () => !!document.getElementById('mem-setup-repo-input'), null, 5000).catch(() => null);
    await page.evaluate(() => { const f = document.getElementById('mem-setup-repo-input'); if (f) { f.focus(); f.value = '/tmp/typing-here'; } });
    agentSave('claude-code', 'A SAVE WHILE TYPING');
    await wake();
    await delay(3000);
    step('a background refresh never takes focus from a field the user is in', await page.evaluate(() =>
      document.activeElement && document.activeElement.id === 'mem-setup-repo-input' && document.activeElement.value === '/tmp/typing-here'),
      await page.evaluate(() => JSON.stringify({ a: document.activeElement && (document.activeElement.id || document.activeElement.tagName), f: !!document.getElementById('mem-setup-repo-input') })));
    await page.evaluate(() => { const f = document.getElementById('mem-setup-repo-input'); if (f) f.blur(); });
    await delay(1200);
  }
  // Audit B1: a NEW work-stream saved after mount becomes the Now card's note.
  await tab('now');
  agentSave('session-after-mount', 'A NEW WORK-STREAM AFTER MOUNT');
  await wake();
  await until('the new work-stream on the Now card', () => /A NEW WORK-STREAM AFTER MOUNT/.test((document.querySelector('.prj-handoff-body') || {}).textContent || ''), null, 15000).catch(() => null);
  step('B1: a work-stream added after mount is fetched and shown on Now (never stuck on "Reading the note…")', await page.evaluate(() =>
    /A NEW WORK-STREAM AFTER MOUNT/.test((document.querySelector('.prj-handoff-body') || {}).textContent || '') && !document.querySelector('.prj-handoff-body [aria-busy="true"]')));
  // e2e M7: delete says whose notes, the card is AT the press and in view, Keep it returns focus.
  const delLabel = await page.evaluate(() => (document.querySelector('[data-prj-panel="now"] [data-ws-delete]') || {}).textContent || '');
  step('the Now card\'s delete says whose notes it deletes', /^Delete .+’s notes…$|^Delete the notes saved as/.test(delLabel), delLabel);
  await page.evaluate(() => document.querySelector('[data-prj-panel="now"] [data-ws-delete]').click());
  await until('the delete card', () => !!document.querySelector('.mem-wsdel-card') && !document.querySelector('.mem-wsdel-card [disabled]#mem-ws-del-no'), null, 8000);
  await delay(600);
  step('the confirm card renders AT the note (before Earlier notes) and is in view, its field focused', await page.evaluate(() => {
    const card = document.querySelector('.mem-wsdel-card'); const earlier = [...document.querySelectorAll('.prj-h')].find((h) => /Earlier notes/.test(h.textContent));
    const r = card.getBoundingClientRect();
    return (!earlier || (card.compareDocumentPosition(earlier) & Node.DOCUMENT_POSITION_FOLLOWING)) && r.top < innerHeight && r.bottom > 0
      && document.activeElement && document.activeElement.id === 'mem-ws-del-input';
  }));
  step('...and shows the name to type as visible text', await page.evaluate(() => !!document.querySelector('.mem-wsdel-card code.mem-wsdel-name')));
  await click('#mem-ws-del-no');
  await delay(500);
  step('Keep it puts focus back on the Delete press (never body)', await page.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-ws-delete')),
    JSON.stringify(await active()));
  // Audit M1: over the window is said in Simple.
  await page.evaluate(async () => { await fetch('/api/config/context-window', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextWindowTokens: 8000, harnessEstimateTokens: 6000 }) }); });
  await page.evaluate(() => location.reload());
  await until('the page again', () => !!document.querySelector('.prj-page [role="tablist"]'), null, 30000);
  await delay(1500);
  await tab('kit');
  await until('the measurement', () => !!document.querySelector('[data-prj-panel="kit"] .prj-meter'), null, 15000).catch(() => null);
  step('M1: Simple › Starting kit says "Over the window by …" when the start does not fit', await page.evaluate(() => /Over the window by ≈/.test(document.querySelector('[data-prj-panel="kit"]').textContent)));
  step('the reading-budget picker is beside the bar, in Simple', await page.evaluate(() => !!document.querySelector('[data-prj-panel="kit"] #mem-budget-lb')));
  await page.evaluate(async () => { await fetch('/api/config/context-window', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextWindowTokens: 200000, harnessEstimateTokens: null }) }); });
  await page.evaluate(() => location.reload());
  await until('the page again', () => !!document.querySelector('.prj-page [role="tablist"]'), null, 30000);
  await delay(1200);
  await tab('kit');
  await click('[data-kit-row-open="kit:documents"]');
  await delay(600);
  step('Simple: the Documents row opens the list — each with its At-start picker, Edit, Delete', await page.evaluate(() =>
    document.querySelectorAll('[data-kit-table="prj-docs"] [data-fnd-first] [data-lb-trigger]').length >= 1
    && document.querySelectorAll('[data-kit-table="prj-docs"] [data-fnd-delete]').length >= 1));
  // e2e M4: Save brief by keyboard → focus on the Brief's Edit, and the next Tab stays on the page.
  await click('[data-prj-act="brief-edit"]');
  await until('the brief editor', () => !!document.getElementById('mem-brief-text'));
  await page.evaluate(() => { const t = document.getElementById('mem-brief-text'); t.value = t.value + '\nOne more line.'; t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 4, windowsVirtualKeyCode: 83 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 4, windowsVirtualKeyCode: 83 });
  await until('the save to land', () => !document.getElementById('mem-brief-text'), null, 10000).catch(() => null);
  await delay(800);
  step('after Save brief, focus is on the Brief\'s Edit (never body)', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-prj-act') === 'brief-edit'),
    JSON.stringify(await active()));
  // e2e M2: + New project lands on a working form with focus in it.
  await click('#mem-new-project');
  await until('the Domains create form', () => !!document.getElementById('dm-proj-name') && document.activeElement && document.activeElement.id === 'dm-proj-name', null, 15000).catch(() => null);
  step('+ New project lands on the create form, focus in its name field, in view', await page.evaluate(() => {
    const el = document.getElementById('dm-proj-name'); if (!el || document.activeElement !== el) return false;
    const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), JSON.stringify(await active()));
  await page.evaluate(() => { const b = document.querySelector('.rail [data-view="memory"], [data-rail="memory"], #rail-btn-memory'); if (b) b.click(); });
  await until('Projects again', () => !!document.querySelector('.prj-page [role="tablist"]'), null, 20000);
  await delay(800);

  // ── 2. Pro ────────────────────────────────────────────────────────────────
  await setPro(true);
  const proTabs = await page.evaluate(() => [...document.querySelectorAll('[data-kit-tab]')].map((b) => b.getAttribute('data-kit-tab')));
  step('Pro draws six tabs', JSON.stringify(proTabs) === '["now","agents","kit","history","budget","computers"]', proTabs);
  step('Pro: every tab has the same style (History, Budget, Computers are not link-coloured; review item 3)', await page.evaluate(() => {
    const col = (id) => getComputedStyle(document.getElementById('prj-tab-' + id)).color;
    return col('history') === col('agents') && col('budget') === col('agents') && col('computers') === col('agents'); }));
  step('Pro: the sidebar meta gives way before the freshness dot (review item 5)', await page.evaluate(() =>
    [...document.querySelectorAll('#sidebar .cur-sb-meta')].every((m) => { const d = m.querySelector('.fresh-dot'); if (!d) return true; const r = d.getBoundingClientRect(); const mr = m.getBoundingClientRect(); return r.right <= mr.right + 1; })));
  step('Pro: the tile strip, and still no PRO label on the page', await page.evaluate(() => !!document.querySelector('.prj-page .cur-ov')
    && !document.querySelector('.prj-page [data-pro-mark], .prj-page [data-pro-drawn]')));
  await tab('now');
  step('Pro › now: the note, plus its facts as a table (work-stream, harness, model, computer, size, file)', await page.evaluate(() =>
    !!document.querySelector('[data-prj-panel="now"] .prj-handoff-body') && /Work-stream/.test((document.querySelector('[data-kit-table="prj-now-facts"]') || {}).textContent || '')));
  await shot('pro-now-dark');
  for (const id of ['agents', 'history', 'budget', 'computers']) {
    await tab(id);
    step('Pro › ' + id + ': data is open — a table, no fold', await page.evaluate((t) => !!document.querySelector('[data-prj-panel="' + t + '"] .kit-table')
      && !document.querySelector('[data-prj-panel="' + t + '"] > .prj-stack > details'), id));
    await shot('pro-' + id + '-dark');
  }

  // ── 2b. folded in from e2e-context-pro.mjs (retired with the five-step page) ──
  await tab('agents');
  {
    // Check again with a harness's reader open: the reader is refreshed in
    // place and "What Setup read" stays as the user left it.
    await click('#mem-setup-tool-claude-code');
    await until('Claude Code\'s reader', () => !!document.querySelector('#reader-root .mem-setup-evfold'), null, 8000);
    await delay(300);
    await page.evaluate(() => { document.querySelector('#reader-root .mem-setup-evfold').open = false; });
    await page.evaluate(() => { const b = document.querySelector('[data-prj-panel="agents"] [data-setup-act="check"]'); if (b) b.click(); });
    await delay(400);
    await until('the re-check to land', () => !document.querySelector('[data-prj-panel="agents"] [data-setup-act="check"][disabled]'), null, 15000);
    await delay(800);
    step('Check again with a reader open: the reader stays, "What Setup read" stays shut as left', await page.evaluate(() => {
      const f = document.querySelector('#reader-root .mem-setup-evfold'); return !!f && f.open === false; }));
    await page.evaluate(() => document.getElementById('reader-close-btn').click());
    await delay(400);
  }
  {
    await click('#mem-setup-tool-antigravity');
    await until('Antigravity\'s reader', () => !!document.querySelector('#reader-root .mem-setup-evfold'), null, 8000);
    await page.evaluate(() => { document.querySelector('#reader-root .mem-setup-evfold').open = true; });
    const t = await page.evaluate(() => document.querySelector('#reader-root .mem-setup-evbody').innerText);
    step('Antigravity\'s "What Setup read": no maintainer notes or test dates', t.length > 40
      && !/maintainer|observed|three separate files|not seen used|\b20\d\d-\d\d-\d\d\b/i.test(t), t.replace(/\s+/g, ' ').slice(0, 300));
    await page.evaluate(() => document.getElementById('reader-close-btn').click());
    await delay(400);
  }
  {
    // v4.3.0 fix round (e2e M6): Pro's add menu leads to the ONE connect flow.
    const before = await page.evaluate(() => (document.querySelector('#prj-tab-agents .kit-tab-count') || {}).textContent);
    await click('#mem-setup-add');
    await until('the Add menu', () => [...document.querySelectorAll('[role="option"]')].some((o) => /Cursor/.test(o.textContent || '')), null, 8000);
    await page.evaluate(() => { const o = [...document.querySelectorAll('[role="option"]')].find((x) => /Cursor/.test(x.textContent || '')); if (o) o.click(); });
    await until('the connect flow at Cursor', () => /Cursor/.test((document.querySelector('#reader-root #prj-connect-h') || {}).textContent || ''), null, 15000);
    await delay(600);
    step('Pro\'s add menu opens the ONE connect flow at that agent, focus inside it', await page.evaluate(() =>
      document.activeElement !== document.body && document.getElementById('reader-root').contains(document.activeElement)));
    await page.evaluate(() => document.querySelector('#reader-root [data-prj-connect="back"]').click());
    await delay(1200);
    await page.evaluate(() => document.getElementById('reader-close-btn').click());
    await delay(800);
    step('...and backing out leaves the agent list unchanged (it is added only when you go ahead)',
      await page.evaluate(() => (document.querySelector('#prj-tab-agents .kit-tab-count') || {}).textContent) === before, before);
  }
  // Pro off while on a Pro-only tab → Now.
  await tab('history');
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
  for (const id of ['now', 'agents', 'history', 'budget', 'computers']) { await tab(id); await shot('pro-' + id + '-light'); }

  // ── 4. 375 px ─────────────────────────────────────────────────────────────
  await setTheme('dark');
  await page.setViewport(375, 812, 1);
  await delay(500);
  step('375 px: the tab strip scrolls sideways on one line, it never wraps (review item 7)', await page.evaluate(() => {
    const tabsEl = document.querySelector('.kit-tabs'); const tops = [...tabsEl.querySelectorAll('.kit-tab')].map((t) => Math.round(t.getBoundingClientRect().top));
    return new Set(tops).size === 1 && tabsEl.scrollWidth > tabsEl.clientWidth; }));
  step('375 px: the Pro tiles are a compact strip, not the whole first screen (review item 9)', await page.evaluate(() => {
    const g = document.querySelector('.prj-tiles .cur-ov-grid'); return !!g && g.getBoundingClientRect().height < innerHeight * 0.4; }),
    await page.evaluate(() => { const g = document.querySelector('.prj-tiles .cur-ov-grid'); return g ? Math.round(g.getBoundingClientRect().height) : null; }));
  step('no tile figure wraps (review item 4)', await page.evaluate(() => [...document.querySelectorAll('.prj-tiles .cur-ov-value')].every((v) => getComputedStyle(v).whiteSpace === 'nowrap')));
  for (const id of ['now', 'agents', 'history', 'budget', 'computers']) {
    await tab(id);
    step('375 px, Pro › ' + id + ': no sideways scroll (tables stack)', await noSideways());
    if (id === 'history') {
      step('375 px: a table caption is a line of its own (review item 11)', await page.evaluate(() => {
        const c = document.querySelector('[data-prj-panel="history"] .kit-table-caption'); const w = c && c.closest('.kit-table-wrap');
        return !!c && getComputedStyle(c).display === 'block' && c.getBoundingClientRect().width >= w.getBoundingClientRect().width * 0.8; }));
    }
    await shot('pro-' + id + '-375');
  }
  await setPro(false);
  for (const id of ['now', 'agents', 'kit']) {
    await tab(id);
    step('375 px, Simple › ' + id + ': no sideways scroll', await noSideways());
    await shot('simple-' + id + '-375');
  }
  // ── 5. e2e M7: a real delete, then every count agrees ───────────────────
  await page.setViewport(1360, 1000, 1);
  await setPro(true);
  await tab('now');
  {
    const scope = await page.evaluate(() => document.querySelector('[data-prj-panel="now"] [data-ws-delete]').getAttribute('data-ws-delete'));
    await page.evaluate(() => document.querySelector('[data-prj-panel="now"] [data-ws-delete]').click());
    await until('the delete preview', () => !!document.querySelector('.mem-wsdel-card code.mem-wsdel-name') && !!document.querySelector('.mem-wsdel-list'), null, 8000);
    await page.evaluate((sc) => { const i = document.getElementById('mem-ws-del-input'); i.value = sc; i.dispatchEvent(new Event('input', { bubbles: true })); }, scope);
    await page.evaluate(() => document.getElementById('mem-ws-del-go').click());
    await until('the outcome', () => !!document.getElementById('mem-ws-del-dismiss'), null, 15000);
    await delay(4000);
    const counts = await page.evaluate((sc) => ({
      history: (document.querySelector('#prj-tab-history .kit-tab-count') || {}).textContent || '',
      agentsTab: (document.querySelector('#prj-tab-agents .kit-tab-count') || {}).textContent || '',
      agentsTile: ((([...document.querySelectorAll('.prj-tiles .cur-ov-card')].find((c) => /Agents/i.test(c.textContent)) || { querySelector: () => null }).querySelector('.cur-ov-value')) || {}).textContent || '',
      outcome: document.querySelector('.mem-wsdel-outcome') ? document.querySelector('.mem-wsdel-outcome').textContent : '',
      deletedStillListed: [...document.querySelectorAll('[data-kit-row-open^="note:"]')].some((b) => decodeURIComponent((b.getAttribute('data-kit-row-open') || '').split(':')[1] || '') === sc),
    }), scope);
    const n = (x) => (/\d+/.exec(x) || [''])[0];
    step('after a delete, the Agents tab count and the Agents tile agree', n(counts.agentsTab) === n(counts.agentsTile), JSON.stringify(counts));
    step('...the deleted work-stream is listed nowhere, and the outcome prints no long path', !counts.deletedStillListed && !/\/Users\/|\.curator-trash/.test(counts.outcome), JSON.stringify(counts));
    await click('#mem-ws-del-dismiss');
    await delay(500);
    step('Dismiss puts focus on the page (never body)', await page.evaluate(() => document.activeElement && document.activeElement !== document.body), JSON.stringify(await active()));
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
