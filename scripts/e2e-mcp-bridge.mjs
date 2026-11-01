#!/usr/bin/env node
/**
 * e2e-mcp-bridge.mjs — Settings › MCP bridge, DRIVEN IN A REAL BROWSER (v3.89.0;
 * v3.90.0 the copy deck: its words, ② Skills, an app's Details, and the
 * computed checks — nothing wider than its card, no CSS capitals, every
 * clickable thing a real button — each proved by a mutation in the page).
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
 *   ② Skills (Download serves a zip; Antigravity's stale copy reads "out of
 *   date") → an app's Details (only existing files, plus the one Install for
 *   me would create) → the computed checks and their mutations → Install
 *   for me → "Check the change · nothing written yet" (the exact setup text,
 *   the other connections kept) → Apply → the fake config holds our line,
 *   the other server and the preference, and a backup exists → Check again
 *   shows connected → Test connection reports "Works — …" → Remove (danger)
 *   → the file is byte-identical to the original → Install again → Restore
 *   original → byte-identical; Copy the setup text; Test connection; Test
 *   all N tools; and the LIVE page against the page contract.
 *
 * SAFETY. It fingerprints the REAL Claude Desktop, Cursor and Antigravity
 * configs and the real .curator-config.json files (sha256 + size) before and
 * after, and fails if any moved. Nothing outside the temp folder is written.
 *
 *   node scripts/e2e-mcp-bridge.mjs [--shots <dir>] [--audit <file.json>] [--keep]
 *
 * `--shots <dir>` also writes the dark screenshots `v390-1280.png`,
 * `v390-375.png` (one app open with its Details, a Skills row open) and
 * `v390-open-1280.png` (every fold open). `--audit` writes every visible
 * string, every fold open, as JSON.
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
// v3.90.0 — `--audit <file>`: every visible string, every fold open, as JSON (the word audit).
const AUDIT = args.includes('--audit') ? path.resolve(args[args.indexOf('--audit') + 1]) : null;

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
// v3.90.0 — ② Skills: Antigravity holds an OUTDATED my-curator (one file
// edited) and a CURRENT curator-continuity (this checkout's own copy).
for (const sk of ['my-curator', 'curator-continuity']) {
  const dir = path.join(ws.home, '.gemini/config/skills', sk);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(path.join(REPO, 'skills', sk))) writeFileSync(path.join(dir, f), readFileSync(path.join(REPO, 'skills', sk, f)));
}
writeFileSync(path.join(ws.home, '.gemini/config/skills/my-curator/SKILL.md'), 'an older copy\n');
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
  await until('the agent app rows', () => !!document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"]') && !!document.querySelector('#mcp-card-use .cur-mon') && !!document.querySelector('#mcp-card-skills details[data-mcpi-skill]'), null, 30000);
  await delay(800);

  // ── 0. the page itself ──────────────────────────────────────────────────
  const liveHtml = () => page.evaluate(() => {
    const vh = document.querySelector('.main-inner .tx-vh');
    const body = document.getElementById('settings-view-body');
    return (vh ? vh.outerHTML : '') + (body ? body.innerHTML : '');
  });
  const openAll = (keys) => page.evaluate((ks) => {
    for (const d of document.querySelectorAll('#settings-view-body details.cur-fold')) {
      if (!ks || ks.some((k) => d.dataset.foldKey === k)) d.open = true;
    }
  }, keys || null);
  const closeAll = () => page.evaluate(() => { for (const d of document.querySelectorAll('#settings-view-body details.cur-fold')) d.open = false; });
  {
    const v = checkPageContract(await liveHtml(), MCP_PAGE_CONTRACT);
    step('the live page passes the page contract (overview, four sections, one card each, the deck’s checks)', v.length === 0, v.join(' | '));
    step('Claude Desktop starts as "can be added"', (await rowStatus('claude-desktop')) === 'not-installed', await rowStatus('claude-desktop'));
    const titles = await page.evaluate(() => [...document.querySelectorAll('#settings-view-body .cur-section-title')].map((e) => e.textContent.trim()).join(' · '));
    step('four sections, the deck’s words', titles === 'Your AI apps · Skills · Connection test · Tool activity', titles);
    const ov = await text('#settings-view-body > .cur-ov');
    step('the overview: CONNECTED · NEEDS ATTENTION · TOOLS WORKING · LAST USED', /CONNECTED[^]*NEEDS ATTENTION[^]*TOOLS WORKING[^]*LAST USED/.test(ov || '') && !/HANDOFF|SAVES/.test(ov || ''), (ov || '').slice(0, 200));
    const nx = await text('#mcpi-next-step');
    step('Next step lists Claude Desktop as not connected yet', /Next step · \d+ to do/.test(nx || '') && /Claude Desktop isn’t connected yet\./.test(nx || ''), (nx || '').slice(0, 300));
  }

  // ── 0b. ② Skills ──────────────────────────────────────────────────────
  {
    await openAll(['skill-my-curator', 'skill-curator-continuity']);
    const sk = await page.evaluate(() => {
      const card = document.getElementById('mcp-card-skills');
      const rows = [...card.querySelectorAll('details[data-mcpi-skill]')].map((d) => ({
        skill: d.dataset.mcpiSkill, label: d.querySelector('.cur-fold-label').textContent.trim(), meta: (d.querySelector('.cur-fold-meta') || {}).textContent || '',
        mono: !!d.querySelector('.cur-fold-label .mono'), download: (d.querySelector('a.btn[download]') || {}).getAttribute ? d.querySelector('a.btn[download]').getAttribute('href') : null,
        ag: (d.querySelector('[data-mcpi-skill-app="antigravity"]') || {}).textContent || '', claude: (d.querySelector('[data-mcpi-skill-app="claude"]') || {}).textContent || '',
        show: !!d.querySelector('[data-mcpi-skill-app="antigravity"] button[data-setup-act="reveal"]') }));
      return { rows, meta: document.getElementById('mcp-meta-skills').textContent, lede: card.previousElementSibling.querySelector('.cur-section-lede')?.textContent || '' };
    });
    const mc = sk.rows.find((r) => r.skill === 'my-curator') || {};
    const cc = sk.rows.find((r) => r.skill === 'curator-continuity') || {};
    step('② Skills: one fold row per skill, the name in mono with what it teaches',
      mc.label === 'my-curator — how to read and write your knowledge' && cc.label === 'curator-continuity — how to save and resume work between sessions' && mc.mono, mc.label + ' | ' + cc.label);
    step('…its head: "carried by The Curator {version}", and the lede says they don’t update on their own',
      /^carried by The Curator \d+\.\d+\.\d+$/.test(sk.meta) && /They don’t update on their own\./.test(sk.lede), sk.meta);
    step('…a Download button for each skill, this app’s own zip', mc.download === '/api/setup/skills/my-curator.zip' && cc.download === '/api/setup/skills/curator-continuity.zip');
    step('…Antigravity’s stale my-curator reads "out of date", its folder and Show the folder', /^Antigravity — out of date~\/\.gemini\/config\/skills\/my-curator/.test(mc.ag) && mc.show, mc.ag);
    step('…its current curator-continuity reads "up to date"', /^Antigravity — up to date/.test(cc.ag), cc.ag);
    step('…"0 of 1 app up to date" / "1 of 1 app up to date"', mc.meta === '0 of 1 app up to date' && cc.meta === '1 of 1 app up to date', mc.meta + ' | ' + cc.meta);
    step('…Claude: the upload path, and that The Curator can’t see the account', /^Claude — upload it in Claude: Customize → Skills\. The Curator can’t see your Claude account/.test(mc.claude), mc.claude);
    const res = await fetch(origin + mc.download);
    const buf = Buffer.from(await res.arrayBuffer());
    step('…and the Download serves a zip', res.ok && buf.slice(0, 2).toString() === 'PK', res.status + ' ' + buf.length + ' bytes');
    const nx = await text('#mcpi-next-step');
    step('Next step: "Antigravity’s my-curator skill is out of date." with Download my-curator',
      /Antigravity’s my-curator skill is out of date\. Download the new version and replace the old one — see Skills below\.Download my-curator/.test(nx || ''), (nx || '').slice(0, 400));
    await closeAll();
  }

  // ── 0c. one app's Details: only existing files, plus the one Install would create ──
  {
    await openAll(['app-antigravity', 'app-details-antigravity', 'app-cursor', 'app-details-cursor']);
    const d = await page.evaluate(() => {
      const files = (id) => [...document.querySelectorAll('#mcpi-rows details[data-fold-key="app-details-' + id + '"] [data-mcpi-file]')]
        .map((e) => e.querySelector('.cur-fold-item-main').textContent.trim() + ' · ' + e.querySelector('.cur-fold-item-meta').textContent.trim());
      const def = (id) => (document.querySelector('#mcpi-rows [data-mcpi-tool="' + id + '"] [data-mcpi-default]') || {}).textContent || '';
      return { ag: files('antigravity'), cursor: files('cursor'), agDef: def('antigravity'), cursorDef: def('cursor') };
    });
    step('Antigravity’s Details lists only the file that exists — its missing alternates are hidden',
      d.ag.length === 1 && d.ag[0] === '~/.gemini/config/mcp_config.json · no Curator line', d.ag.join(' | '));
    step('Cursor’s Details lists the one file Install for me would create, "not there yet"',
      d.cursor.length === 1 && d.cursor[0] === '~/.cursor/mcp.json · not there yet', d.cursor.join(' | '));
    step('an app that can be added says "Not connected yet. Tick it in Next step and press Install for me."',
      d.cursorDef.trim() === 'Not connected yet. Tick it in Next step and press Install for me.', d.cursorDef);
    await closeAll();
  }
  if (SHOTS) {
    // The deck's screenshots: one app open with its Details, and a Skills row open.
    await openAll(['app-antigravity', 'app-details-antigravity', 'skill-my-curator']);
    await shots(page, 'v390', [1280, 375], (label, w) => label + '-' + w + '.png');
    await openAll();
    await shots(page, 'v390-open', [1280], (label, w) => label + '-' + w + '.png');
    await closeAll();
  }

  // ── 0d. the computed checks: nothing wider than its card, no CSS capitals,
  //        every clickable thing a real button — each proved by mutation ──
  {
    await openAll();
    for (const w of [1280, 375]) {
      await page.setViewport(w, 1000, 1);
      await delay(500);
      const over = await page.evaluate(computedOverflow);
      step('at ' + w + ' px, every fold open: no element or line of text runs past its card', over.length === 0, over.slice(0, 6).join(' | '));
    }
    await page.setViewport(1280, 1000, 1);
    await delay(300);
    const caps = await page.evaluate(computedCaps);
    step('no text is painted in capitals outside the overview (computed text-transform)', caps.length === 0, caps.slice(0, 6).join(' | '));
    const clicks = await page.evaluate(computedClickables);
    step('every clickable element is a <button> or a button-styled <a> (computed cursor)', clicks.length === 0, clicks.slice(0, 6).join(' | '));
    // MUTATIONS — each check goes red on v3.89.0's shape, then the page is put back.
    await page.evaluate(() => { const s = document.createElement('style'); s.id = 'e2e-mut';
      s.textContent = '.cur-fold-line-text{flex:none!important;white-space:nowrap!important}'; document.head.appendChild(s); });
    await page.setViewport(375, 1000, 1);
    await delay(400);
    const mOver = await page.evaluate(computedOverflow);
    step('MUTATION — a sentence that may not wrap (v3.89.0’s flex:none) runs past its card at 375 px → red', mOver.length > 0, mOver.slice(0, 2).join(' | '));
    await page.evaluate(() => { document.getElementById('e2e-mut').remove(); });
    await page.setViewport(1280, 1000, 1);
    await page.evaluate(() => { const e = document.querySelector('#mcpi-next-step .cur-action-eyebrow'); if (e) { e.classList.remove('cur-action-eyebrow-sentence'); e.classList.add('cur-eyebrow'); } });
    const mCaps = await page.evaluate(computedCaps);
    step('MUTATION — the Next step eyebrow given back its uppercase caption class → red', mCaps.some((x) => /Next step/i.test(x)), mCaps.slice(0, 2).join(' | '));
    await page.evaluate(() => { const e = document.querySelector('#mcpi-next-step .cur-action-eyebrow'); if (e) { e.classList.remove('cur-eyebrow'); e.classList.add('cur-action-eyebrow-sentence'); } });
    await page.evaluate(() => { const b = document.querySelector('#mcpi-rows [data-mcpi-tool="cursor"] .cur-fold-line');
      if (b) { const s = document.createElement('span'); s.id = 'e2e-fake'; s.textContent = 'Copy entry'; s.style.cursor = 'pointer'; b.appendChild(s); } });
    const mClick = await page.evaluate(computedClickables);
    step('MUTATION — text styled as a clickable label (a pointer span) → red', mClick.some((x) => /Copy entry/.test(x)), mClick.slice(0, 2).join(' | '));
    await page.evaluate(() => { document.getElementById('e2e-fake')?.remove(); });
    await closeAll();
  }

  // ── 0e. THE WORD AUDIT: every visible string, every fold open ───────────
  if (AUDIT) {
    await openAll();
    const strings = await page.evaluate(visibleStrings);
    writeFileSync(AUDIT, JSON.stringify(strings, null, 2));
    step('the word audit wrote ' + strings.length + ' visible strings', strings.length > 40);
    await closeAll();
  }

  // ── 1. Install for me → preview → Apply ───────────────────────────────────
  // Only Claude Desktop is ticked, so the file under test is the only one written.
  const tickOnly = (id) => page.evaluate((want) => {
    for (const cb of document.querySelectorAll('[data-mcpi-tick]')) {
      const w = cb.dataset.mcpiTick === want;
      if (cb.checked !== w) { cb.checked = w; cb.dispatchEvent(new Event('change')); }
    }
  }, id);
  await tickOnly('claude-desktop');
  await click('#mcpi-install-btn');
  await until('the preview', () => !!document.querySelector('[data-mcpi-plan]'));
  {
    const plan = await text('[data-mcpi-plan]');
    const entry = await text('[data-mcpi-plan] [data-mcpi-entry]');
    const kept = await text('[data-mcpi-plan] [data-mcpi-preserved]');
    let parsed = null;
    try { parsed = JSON.parse(entry); } catch { /* not JSON */ }
    step('Install for me shows "Check the change · nothing written yet", "{App} — {path}" and "Adds:" with the exact setup text',
      /Check the change · nothing written yet/.test(plan || '') && /Claude Desktop —~\/Library\/Application Support\/Claude\/claude_desktop_config\.json/.test(plan || '')
      && /Adds:/.test(plan || '') && !!parsed && typeof parsed.command === 'string', (plan || '').slice(0, 300));
    step('…"Your other connections stay as they are: other-server."', kept === 'Your other connections stay as they are: other-server.', kept);
    step('…"Backup: {file name}"', /Backup: claude_desktop_config\.json\.curator-backup-/.test(plan || ''), (plan || '').match(/Backup:[^\n]*/)?.[0]);
    step('…and nothing was written yet', readFileSync(CLAUDE, 'utf8') === ORIGINAL);
    const v = checkPageContract(await liveHtml(), MCP_PAGE_CONTRACT);
    step('the page with the preview open passes the page contract', v.length === 0, v.join(' | '));
  }
  await click('[data-mcpi-act="apply"]');
  await until('the results', () => !!document.querySelector('[data-mcpi-results]'));
  {
    const doc = JSON.parse(readFileSync(CLAUDE, 'utf8'));
    const ours = doc.mcpServers && doc.mcpServers['my-curator'];
    step('Apply writes the my-curator line into the fake Claude Desktop settings', !!ours && typeof ours.command === 'string', JSON.stringify(ours));
    step('…keeping the other server and the preference', !!doc.mcpServers['other-server'] && doc.preferences && doc.preferences.menuBarEnabled === true);
    const backups = readdirSync(path.dirname(CLAUDE)).filter((f) => f.startsWith('claude_desktop_config.json.curator-backup-'));
    step('…with a backup of the original beside it', backups.length === 1 && readFileSync(path.join(path.dirname(CLAUDE), backups[0]), 'utf8') === ORIGINAL, backups.join(', '));
    const line = await text('[data-mcpi-results] [data-mcpi-result]');
    step('the result: "✓ Claude Desktop is set up. Quit Claude Desktop completely and open it again to use My Curator."',
      /✓ Claude Desktop is set up\. Quit Claude Desktop completely and open it again to use My Curator\./.test(line || ''), line);
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
    const def = await text('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-default]');
    step('its one sentence: "Connected. Claude Desktop hasn’t used My Curator since it was set up {age} — quit and reopen …"',
      /^Connected\. Claude Desktop hasn’t used My Curator since it was set up .+ — quit and reopen Claude Desktop if it doesn’t show up\.Test connection$/.test((def || '').trim()), def);
  }

  // ── 2. Test connection ─────────────────────────────────────────────────
  await click('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-act="check-entry"]');
  await until('the test outcome', () => /Works —|Doesn’t start|only tests its own setup line/.test(document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-default]')?.textContent || ''), null, 20000);
  {
    const t = await text('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-default]');
    step('Test connection on Claude Desktop: "Works — My Curator starts the way Claude Desktop starts it and answers with all 24 tools."',
      /Connected\. Works — My Curator starts the way Claude Desktop starts it and answers with all 24 tools\./.test(t || ''), t);
  }

  // ── 3. Remove ─────────────────────────────────────────────────────────
  await openRow('claude-desktop');
  await page.evaluate(() => { const d = document.querySelector('#mcpi-rows details[data-fold-key="app-details-claude-desktop"]'); if (d) d.open = true; });
  {
    const rm = await page.evaluate(() => { const b = document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-act="remove"]');
      return b ? b.className + ' | ' + b.closest('.cur-fold-line').textContent : null; });
    step('Details: "Remove The Curator from Claude Desktop" with Remove as the danger button', /btn-danger/.test(rm || '') && /Remove The Curator from Claude Desktop/.test(rm || ''), rm);
  }
  await click('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-act="remove"]');
  await until('the remove preview', () => !!document.querySelector('[data-mcpi-plan]'));
  await click('[data-mcpi-act="apply"]');
  await until('the remove results', () => !!document.querySelector('[data-mcpi-results]'));
  {
    const now = readFileSync(CLAUDE, 'utf8');
    const doc = JSON.parse(now);
    step('Remove takes our line out of the fake settings file', !(doc.mcpServers && doc.mcpServers['my-curator']), Object.keys(doc.mcpServers || {}).join(','));
    step('…leaving it byte-identical to the original', now === ORIGINAL, sha(now).slice(0, 12) + ' vs ' + sha(ORIGINAL).slice(0, 12));
  }

  // ── 4. Install again → Restore original ─────────────────────────────────
  await click('[data-mcpi-act="check-again"]');
  await until('can be added again', () => {
    const el = document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"]');
    return el && el.dataset.mcpiStatus === 'not-installed' && document.getElementById('mcpi-install-btn');
  });
  await tickOnly('claude-desktop');
  await click('#mcpi-install-btn');
  await until('the second preview', () => !!document.querySelector('[data-mcpi-plan]'));
  await click('[data-mcpi-act="apply"]');
  await until('the second results', () => !!document.querySelector('[data-mcpi-results]'));
  step('Install again writes the line', /my-curator/.test(readFileSync(CLAUDE, 'utf8')));
  await click('[data-mcpi-act="check-again"]');
  await until('Restore offered', () => !!document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-act="restore"]'));
  await openRow('claude-desktop');
  await click('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-act="restore"]');
  await until('the restore preview', () => !!document.querySelector('[data-mcpi-plan]'));
  {
    const from = await text('[data-mcpi-plan] [data-mcpi-restore-from]');
    step('Restore original previews "Put back the original settings file"', /Put back the original settings file/.test(from || ''), from);
  }
  await click('[data-mcpi-act="apply"]');
  await until('the restore results', () => !!document.querySelector('[data-mcpi-results]'));
  {
    const now = readFileSync(CLAUDE, 'utf8');
    step('Restore original leaves the file byte-identical to the original', now === ORIGINAL, sha(now).slice(0, 12) + ' vs ' + sha(ORIGINAL).slice(0, 12));
  }
  // Restore is refused once the file has changed since our write.
  {
    await click('[data-mcpi-act="check-again"]');
    await until('can be added (3)', () => document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"]')?.dataset.mcpiStatus === 'not-installed' && document.getElementById('mcpi-install-btn'));
    await tickOnly('claude-desktop');
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

  // ── 5. Copy the setup text ──────────────────────────────────────────────
  {
    await tickOnly('cursor');
    const tool = await page.evaluate(() => document.querySelector('#mcpi-next-step [data-mcpi-act="copy-myself"]')?.dataset.tool || null);
    step('Next step’s Copy the setup text copies for the ticked app', tool === 'cursor' || tool === 'antigravity', tool);
    await click('#mcpi-next-step [data-mcpi-act="copy-myself"]');
    await until('the copy status', () => !!document.querySelector('[data-mcpi-copied]'));
    const copied = await page.evaluate(() => window.__copied[window.__copied.length - 1] || '');
    const said = await text('[data-mcpi-copied]');
    let doc = null;
    try { doc = JSON.parse(copied); } catch { /* */ }
    step('…for an app with no file yet: a whole small file, "Save as …"', !!doc && !!doc.mcpServers && !!doc.mcpServers['my-curator'] && /^Setup text copied\. Save as ~\/\.cursor\/mcp\.json\.$/.test(said || ''), copied.slice(0, 80) + ' | ' + said);
  }

  // ── 6. Test connection, Test all N tools ─────────────────────────────────
  await click('#btn-mcp-self-test');
  await until('the test outcome', () => /Works\.|Not working:/.test(document.getElementById('mcp-card-bridge')?.textContent || ''), null, 20000);
  {
    const t = await text('#mcp-card-bridge');
    step('Test connection: "Works. My Curator started and answered with all 24 tools ({time})."',
      /Works\. My Curator started and answered with all 24 tools \(\d\d:\d\d\)\./.test(t || ''), (t || '').match(/Works\.[^)]*\)\.|Not working:[^.]*/)?.[0]);
    step('…and the overview’s TOOLS WORKING reads "24 of 24"', /TOOLS WORKING\s*24 of 24/.test(await text('#settings-view-body > .cur-ov') || ''));
    step('…and ③’s head reads "last test just now"', /^last test /.test(await text('#mcp-meta-bridge') || ''), await text('#mcp-meta-bridge'));
  }
  await click('#btn-mcp-exercise');
  await until('the full-test outcome', () => !document.getElementById('btn-mcp-exercise')?.disabled && /Works\.|Not working:/.test(document.getElementById('mcp-card-bridge')?.textContent || ''), null, 90000);
  await delay(500);
  {
    const t = (await text('#mcp-card-bridge')) || '';
    step('Test all 24 tools: "Works. … all 24 tools"', /Works\. My Curator started and answered with all 24 tools/.test(t), t.slice(0, 200));
  }
  {
    const v = checkPageContract(await liveHtml(), MCP_PAGE_CONTRACT);
    step('the page after every action still passes the page contract', v.length === 0, v.join(' | '));
  }
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
  (moved.length ? 'MOVED: ' + moved.map((f) => f + ' ' + before[f] + ' → ' + after[f]).join(' · ') + ' — ' : '')
  + REAL_FILES.map((f) => path.basename(path.dirname(f)) + '/' + path.basename(f) + ' ' + before[f]).join(' · '));

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
async function shots(page, label, widths = [1280, 1100, 375], nameOf = (l, w) => l + '-' + w + '-dark.png') {
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
    writeFileSync(path.join(SHOTS, nameOf(label, w)), Buffer.from(data, 'base64'));
  }
  await page.setViewport(1280, 1000, 1);
  await delay(400);
}
// ── v3.90.0: the computed checks, run INSIDE the page (page.evaluate) ──────

/** Every element and line of text that runs past the edge of its card. */
function computedOverflow() {
  const out = [];
  const blocks = document.querySelectorAll('#settings-view-body .cur-card, #settings-view-body > .cur-ov, #settings-view-body > .cur-section-intro, #settings-view-body > .cur-section-foot');
  for (const card of blocks) {
    const cr = card.getBoundingClientRect();
    if (!cr.width) continue;
    // Clipped content is not "past the card": an ancestor that scrolls or
    // hides its overflow (a text node's own parent included), and the
    // visually-hidden labels (position:absolute, 1 px, clipped).
    const clipped = (el, self) => {
      for (let p = el; p && p !== card; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if ((cs.overflowX !== 'visible' && (self || p !== el)) || cs.position === 'absolute' || cs.position === 'fixed') return true;
      }
      return false;
    };
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const el = n.nodeType === 3 ? n.parentElement : n;
      if (!el || clipped(el, n.nodeType === 3)) continue;
      let rects;
      if (n.nodeType === 3) {
        if (!n.textContent.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        rects = [...r.getClientRects()];
      } else {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        rects = [n.getBoundingClientRect()];
      }
      for (const r of rects) {
        if (!r.width || !r.height) continue;
        if (r.right > cr.right + 1 || r.left < cr.left - 1) {
          out.push((n.nodeType === 3 ? '"' + n.textContent.trim().slice(0, 40) + '"' : '<' + n.tagName.toLowerCase() + '.' + String(n.className).split(' ').join('.') + '>')
            + ' ' + Math.round(r.right - cr.right) + 'px past ' + (card.id || card.className));
          break;
        }
      }
    }
  }
  return out;
}

/** Text painted in capitals (computed text-transform) outside the overview. */
function computedCaps() {
  const out = [];
  const root = document.getElementById('settings-view-body');
  for (const el of root ? root.querySelectorAll('*') : []) {
    if (el.closest('.cur-ov') || el.closest('[hidden]') || !el.getClientRects().length) continue;
    const own = [...el.childNodes].filter((c) => c.nodeType === 3 && /[a-z]{2}/i.test(c.textContent)).map((c) => c.textContent.trim()).join(' ');
    if (!own) continue;
    if (getComputedStyle(el).textTransform === 'uppercase') out.push('"' + own.slice(0, 40) + '" in <' + el.tagName.toLowerCase() + '.' + String(el.className).split(' ').join('.') + '>');
  }
  return out;
}

/** Anything that shows a pointer but is not a real control: a <button>, a button-styled <a>, a fold toggle, a tick. */
function computedClickables() {
  const out = [];
  const root = document.getElementById('settings-view-body');
  for (const el of root ? root.querySelectorAll('*') : []) {
    if (!el.getClientRects().length || getComputedStyle(el).cursor !== 'pointer') continue;
    const ctl = el.closest('button, a, summary, label, input, [role="option"], [role="listbox"]');
    if (ctl) {
      if (ctl.tagName === 'A' && !ctl.classList.contains('btn') && !ctl.closest('.tx-vh-panel')) out.push('a bare link "' + ctl.textContent.trim().slice(0, 40) + '"');
      continue;
    }
    out.push('<' + el.tagName.toLowerCase() + '> "' + el.textContent.trim().slice(0, 40) + '"');
  }
  return out;
}

/** Every visible string on the page, block by block, in reading order. */
function visibleStrings() {
  const SEL = ['h1', '.tx-vh-eyebrow', 'p', 'pre', 'button', 'a', 'label', '.cur-ov-label', '.cur-ov-value', '.cur-ov-sub', '.cur-eyebrow', '.cur-section-title',
    '.cur-section-meta', '.cur-fold-label', '.cur-fold-meta', '.cur-fold-pill', '.cur-fold-item-main', '.cur-fold-item-meta', '.cur-mon-key', '.cur-mon-value',
    '.cur-mon-note', '.tx-status-title', '.tx-status-detail', '.cur-action-eyebrow', '.lb-btn-text'].join(',');
  const out = [];
  const roots = [document.querySelector('.main-inner .tx-vh'), document.getElementById('settings-view-body')];
  for (const root of roots) {
    if (!root) continue;
    for (const el of root.querySelectorAll(SEL)) {
      if (el.closest('[hidden]') || !el.getClientRects().length) continue;
      const anc = el.parentElement && el.parentElement.closest(SEL);
      const door = (x) => !!x && !!x.closest('.cur-ov') && !!x.querySelector('.cur-ov-label, .cur-ov-value');
      if (anc && root.contains(anc) && !el.matches('button, a') && !door(anc)) continue;
      if (door(el)) continue;   // a figure's door: its label and value are read on their own
      // The text a person SEES (as written; CSS capitals are computedCaps'),
      // minus the screen-reader-only labels.
      const parts = [];
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let tn;
      while ((tn = tw.nextNode())) if (!tn.parentElement.closest('.visually-hidden')) parts.push(tn.textContent);
      const t = parts.join('').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const card = el.closest('[id^="mcp-card-"]');
      const head = el.closest('.cur-section-head');
      out.push({ text: t, where: card ? card.id.replace('mcp-card-', '') : head ? 'head:' + (head.querySelector('.cur-section-title') || {}).textContent
        : el.closest('.cur-ov') ? 'overview' : el.closest('.tx-vh') ? 'header' : 'page', data: !!el.closest('.mono, pre') });
    }
  }
  return out;
}
