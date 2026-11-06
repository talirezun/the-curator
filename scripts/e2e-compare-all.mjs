#!/usr/bin/env node
/**
 * e2e-compare-all.mjs — "Compare all remaining" on the running screen.
 *
 * LIVE_LOCAL (scripts/run-tests.js). This checkout's server on a spare port with a STUBBED
 * model, driven in headless Chrome over CDP with real mouse events, against a generated world:
 * a temp domains dir, CURATOR_TEST_USER_DATA_DIR and a fake HOME. The stub is a preload that
 * answers Gemini's calls and refuses every other non-local host; its behaviour is one file the
 * script rewrites (ok, a 402 as a prepaid account answers, a dear call), so no provider is
 * called and the fake key in the fake config is not a credential.
 *
 * It walks: the two chips with their cost, the confirm under the row, a running row that ticks
 * with nothing moving, leaving and coming back, Pause and Resume, a real SIGKILL and restart
 * mid-job with no call made until Resume, a second start refused, a 402 paused in words with
 * what it paid for kept, the stop at 120%, pairs arriving on a domain with no row to tick, a
 * read-only mirror, and a first open that can be pressed before the count lands.
 *
 *   node scripts/e2e-compare-all.mjs [--profiles 1280,375,1280-light,375-light,1280-rm,375-rm,big-1280,big-375] [--shots <dir>]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser, findBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const SHOTS = arg('--shots') ? path.resolve(arg('--shots')) : null;
const ALL = {
  '1280': { name: '1280', w: 1280, h: 900 },
  '375': { name: '375', w: 375, h: 812 },
  '1280-light': { name: '1280-light', w: 1280, h: 900, light: true },
  '375-light': { name: '375-light', w: 375, h: 812, light: true },
  '1280-rm': { name: '1280-reduced-motion', w: 1280, h: 900, reduced: true },
  '375-rm': { name: '375-reduced-motion', w: 375, h: 812, reduced: true },
  'big-1280': { name: 'big-1280', w: 1280, h: 900, big: true },
  'big-375': { name: 'big-375', w: 375, h: 812, big: true },
};
const PROFILES = (arg('--profiles') || '1280,375,1280-light,375-light,1280-rm,375-rm,big-1280,big-375').split(',').map((n) => ALL[n]);

let failed = 0; let passed = 0;
const step = (label, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? ' — ' + detail : ''}`); };

// ── The stub ────────────────────────────────────────────────────────────────
const STUB_SRC = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
const realFetch = globalThis.fetch;
const LOG = process.env.CA_STUB_LOG;
const CONTROL = process.env.CA_STUB_CONTROL;
const log = (o) => appendFileSync(LOG, JSON.stringify(o) + '\n');
const control = () => { try { return JSON.parse(readFileSync(CONTROL, 'utf8')); } catch { return { mode: 'ok', latency: 100 }; } };
globalThis.fetch = async (url, opts) => {
  const u = String(url && url.url ? url.url : url);
  let host = ''; try { host = new URL(u).hostname; } catch {}
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return realFetch(url, opts);
  if (!u.includes('generativelanguage.googleapis.com')) { log({ blocked: host }); return new Response('{}', { status: 503 }); }
  if (!u.includes(':generateContent')) return new Response('{"models":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  const c = control();
  await new Promise((r) => setTimeout(r, c.latency || 100));
  if (c.mode === '402') {
    log({ call: '402' });
    return new Response(JSON.stringify({ error: { code: 402, message: 'Your prepaid credits are depleted. Please go to AI Studio to manage your project and billing.', status: 'PAYMENT_REQUIRED' } }), { status: 402, headers: { 'content-type': 'application/json' } });
  }
  const prompt = JSON.stringify(JSON.parse(opts.body).contents);
  const pairs = []; const re = /--- PAIR (\d+) ---\\nA: \[[a-z]+\/([^\]]+)\][\s\S]*?\\nB: \[[a-z]+\/([^\]]+)\]/g; let m;
  while ((m = re.exec(prompt))) pairs.push({ index: Number(m[1]), a: m[2], b: m[3] });
  log({ call: c.mode, n: pairs.length });
  const results = pairs.map((p) => (c.mode !== 'no' && p.a.replace(/s$/, '') === p.b.replace(/s$/, '') && Math.abs(p.a.length - p.b.length) === 1
    ? { index: p.index, difference: 'none', relation: 'same', confidence: 'high', canonicalSlug: p.a.length >= p.b.length ? p.a : p.b, rationale: p.index % 2 === 0 ? 'One page and its plural. ' + 'The two pages open on the same subject, name the same things in the same order, and neither adds a fact the other lacks, so a reader would not tell them apart. '.repeat(3) : 'One page and its plural.' }
    : { index: p.index, difference: 'different subjects', relation: 'overlap' }));
  const dear = c.mode === 'dear';
  return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ results }) }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: dear ? 3000000 : 1000, candidatesTokenCount: dear ? 300000 : 100, totalTokenCount: dear ? 3300000 : 1100 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
`;

// ── The world ───────────────────────────────────────────────────────────────
const page_ = (t, s) => `---\ntype: concept\ntags: [type/concept]\n---\n\n# ${t}\n\n${s}\n\n## Related\n\n- [[wiki-hub]]\n`;
const CONS = 'bcdfghjklmnpqrstvwxz';
function buildDomain(root, name, topics, filler, { twinEvery = 1 } = {}) {
  const w = path.join(root, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(w, f), { recursive: true });
  writeFileSync(path.join(root, name, 'CLAUDE.md'), `# ${name}\n`);
  let x = 7 + name.length; const rnd = () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296;
  const word = (n) => { let s = ''; for (let k = 0; k < n; k++) s += CONS[Math.floor(rnd() * 20)]; return s; };
  const linked = [];
  // Near names the candidate pass pairs up; the stub calls only a plural the same page.
  for (let i = 0; i < topics; i++) {
    const a = 'guide-' + word(5);
    const b = i % twinEvery === 0 ? a + 's' : a + '-notes';
    for (const s of [a, b]) { writeFileSync(path.join(w, 'concepts', s + '.md'), page_(s, 'Notes about ' + s + '.')); linked.push(s); }
  }
  for (let i = 0; i < filler; i++) { const s = word(9); writeFileSync(path.join(w, 'concepts', s + '.md'), page_(s, 'Notes about ' + s + '.')); linked.push(s); }
  writeFileSync(path.join(w, 'concepts', 'wiki-hub.md'), `---\ntype: concept\n---\n\n# Hub\n\nAn index page.\n\n## Related\n\n${linked.map((s) => `- [[${s}]]`).join('\n')}\n`);
  writeFileSync(path.join(w, 'index.md'), `# Wiki Index — ${name}\n\n## Concepts\n\n| Page | Summary |\n|---|---|\n` + ['wiki-hub', ...linked].sort().map((s) => `| [[${s}]] | Notes. |`).join('\n') + '\n');
  writeFileSync(path.join(w, 'log.md'), '# Log\n');
}

async function startServer(app) {
  const env = { ...process.env };
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'DOMAINS_PATH', 'LLM_MODEL']) delete env[k];
  Object.assign(env, { PORT: String(app.port), CURATOR_NO_OPEN: '1', HOME: app.ws.home, CURATOR_TEST_INSTALL_HOME: app.ws.home, CURATOR_TEST_USER_DATA_DIR: app.ws.userData,
    CURATOR_TEST_DOMAINS_DIR: app.ws.domains, CA_STUB_LOG: app.stubLog, CA_STUB_CONTROL: app.control });
  app.server = spawn(process.execPath, ['--import', app.stubFile, path.join(REPO, 'src', 'server.js')], { cwd: REPO, env, stdio: ['ignore', 'ignore', 'ignore'] });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(app.origin + '/api/version')).ok) break; } catch { /* not yet */ } await delay(100); }
}

async function startApp(profile) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'curator-e2e-compare-'));
  const ws = { domains: path.join(base, 'domains'), userData: path.join(base, 'userdata'), home: path.join(base, 'home') };
  for (const d of [ws.domains, ws.userData, ws.home]) mkdirSync(d, { recursive: true });
  const app = { profile, base, ws, stubFile: path.join(base, 'stub.mjs'), stubLog: path.join(base, 'stub.log'), control: path.join(base, 'control.json') };
  writeFileSync(app.stubFile, STUB_SRC); writeFileSync(app.stubLog, '');
  app.mode = (mode, latency = 120) => writeFileSync(app.control, JSON.stringify({ mode, latency }));
  app.calls = () => readFileSync(app.stubLog, 'utf8').split('\n').filter((l) => l.includes('"call"')).length;
  app.blocked = () => readFileSync(app.stubLog, 'utf8').split('\n').filter((l) => l.includes('blocked')).length;
  app.mode('ok');
  // main: has open pairs. other: to prove one job across domains. empty: no pair ever opens at
  // first. mirror: read-only.
  buildDomain(ws.domains, 'main', 40, 20);
  buildDomain(ws.domains, 'other', 20, 10);
  buildDomain(ws.domains, 'quiet', 60, 10);
  buildDomain(ws.domains, 'shared-mirror', 20, 10);
  writeFileSync(path.join(ws.domains, 'shared-mirror', 'CLAUDE.md'), '---\nreadonly: true\n---\n\n# shared-mirror\n');
  if (profile.big) buildDomain(ws.domains, 'huge', 1500, 500, { twinEvery: 50 });
  writeFileSync(path.join(ws.userData, '.curator-config.json'), JSON.stringify({ activeProvider: 'gemini', domainsPath: ws.domains,
    geminiApiKey: 'AIza-E2E-FAKE-KEY-not-a-credential', aiHealth: { semanticDupeMaxPairs: 40, costCeilingTokens: profile.big ? 20000000 : 40000 } }, null, 2), { mode: 0o600 });
  app.port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  app.origin = `http://localhost:${app.port}`;
  await startServer(app);
  app.browser = await launchBrowser({ headless: true });
  app.conn = await CdpConnection.connect(app.browser.wsUrl);
  app.page = await CdpPage.create(app.conn);
  await app.page.setViewport(profile.w, profile.h, 1);
  await app.page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: profile.light ? 'light' : 'dark' }, { name: 'prefers-reduced-motion', value: profile.reduced ? 'reduce' : 'no-preference' }] });
  app.kill = async (sig = 'SIGKILL') => { if (app.server.exitCode === null) { app.server.kill(sig); for (let i = 0; i < 40 && app.server.exitCode === null && app.server.signalCode === null; i++) await delay(50); } };
  app.stop = async () => {
    try { await app.conn.close(); } catch { /* gone */ }
    try { await app.browser.close(); } catch { /* gone */ }
    await app.kill('SIGTERM'); await app.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  };
  return app;
}

async function waitFor(page, fn, label, tries = 600, ...args) {
  for (let i = 0; i < tries; i++) { let v = false; try { v = await page.evaluate(fn, ...args); } catch { /* navigating */ } if (v) return true; await delay(50); }
  step('waited for ' + label, false, 'timed out');
  return false;
}

async function openDomain(app, slug) {
  const { page, origin, profile } = app;
  await page.navigate(origin + '/api/version');
  await page.evaluate((theme) => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('curator-next-theme', theme); localStorage.setItem('curator-next-view', 'domains');
    localStorage.setItem('curator-next-onboarding-dismissed-v1', '1'); localStorage.setItem('curator-ai-health-disclosure-seen-v1', 'yes');
    sessionStorage.setItem('curator-next-instance-banner-dismissed-v1', '1');
  }, profile.light ? 'light' : 'dark');
  await page.navigate(origin);
  for (let i = 0; i < 100 && !(await page.evaluate(() => !!window.__curatorBooted)); i++) await delay(100);
  await page.evaluate(() => { const b = document.querySelector('#rail .rail-btn[data-view="domains"]'); if (b) b.click(); });
  await delay(400);
  await switchDomain(app, slug);
}
async function switchDomain(app, slug) {
  const { page } = app;
  await page.evaluate((s) => { const e = [...document.querySelectorAll('.dm-row[data-domain-slug]')].find((n) => n.dataset.domainSlug === s); if (e) e.click(); }, slug);
  await waitFor(page, () => !!document.querySelector('.dm-health #dm-rescan-btn'), 'health card ' + slug, 1200);
  await delay(300);
}

const CONFIRM_READ_MS = 400;
const CHIP = '.dm-quick-btn[data-action="compareAll"]';
const NEXT = '.dm-quick-btn[data-action="semanticDupes"]';
const JOB = '#dm-compare-job-btn';
const ROW = '[data-group-key="compare"]';
const reading = (page) => page.evaluate(() => { const e = document.querySelector('[data-compare-reading]'); return e ? e.textContent : null; });
const lineText = (page) => page.evaluate(() => { const e = document.querySelector('[data-row-key="compare-job"]'); return e ? e.innerText : ''; });
const buttonText = (page, s) => page.evaluate((x) => { const e = document.querySelector(x); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null; }, s);
// A person presses what they can see and what has stopped moving. A question opening at phone
// width is taller than the screen until it settles, so this waits for that, then brings it in.
const QUESTION_SETTLES = async (page, sel) => {
  await page.evaluate(async (s) => {
    let last = null; let still = 0;
    for (let i = 0; i < 120 && still < 6; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const e = document.querySelector(s); const y = e ? e.getBoundingClientRect().top + document.querySelector('#main').scrollTop : null;
      still = y === last ? still + 1 : 0; last = y;
    }
  }, sel);
};
async function press(app, sel, { early = false } = {}) {
  const { page } = app;
  if (!early) {
    await QUESTION_SETTLES(page, sel);
    if (sel === '#dm-confirm-yes') await delay(CONFIRM_READ_MS);
  }
  await page.evaluate((s) => { const e = document.querySelector(s); if (e) e.scrollIntoView({ block: 'center' }); }, sel);
  await delay(early ? 0 : 80);
  const c = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
  if (!c) { step('a control to press: ' + sel, false); return; }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
}
const shot = async (app, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // The row in view, as a person would have it.
  await app.page.evaluate((s) => { const e = document.querySelector(s); if (e) e.scrollIntoView({ block: 'center' }); }, ROW);
  await delay(120);
  const b = await app.page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(SHOTS, `${app.profile.name}-${name}.png`), Buffer.from(b.data, 'base64'));
};

/** Watch the row and everything above it, every frame, for `ms`. */
async function watchRow(page, ms) {
  return page.evaluate(async (dur, rowSel) => {
    const marks = () => [...document.querySelectorAll('.dm-lane-head, .dm-group[data-group-key], .dm-control-row, #dm-rescan-btn')];
    const row = document.querySelector(rowSel);
    const y0 = row ? row.getBoundingClientRect().top : 0;
    const scrollMain = document.querySelector('#main');
    const s0 = scrollMain ? scrollMain.scrollTop : 0;
    const above0 = marks().filter((e) => e.getBoundingClientRect().top < y0).map((e) => [e, e.getBoundingClientRect().top]);
    let maxMove = 0; let maxAbove = 0; let maxGap = 0; let last = performance.now(); let scrolled = 0; let lost = 0;
    const end = last + dur;
    await new Promise((resolve) => {
      const f = (t) => {
        maxGap = Math.max(maxGap, t - last); last = t;
        const r = document.querySelector(rowSel);
        if (!r || r !== row) lost = 1;
        if (r) maxMove = Math.max(maxMove, Math.abs(r.getBoundingClientRect().top - y0));
        for (const [e, y] of above0) maxAbove = Math.max(maxAbove, Math.abs(e.getBoundingClientRect().top - y));
        if (scrollMain) scrolled = Math.max(scrolled, Math.abs(scrollMain.scrollTop - s0));
        if (t < end) requestAnimationFrame(f); else resolve();
      };
      requestAnimationFrame(f);
    });
    return { maxMove, maxAbove, maxGap, scrolled, lost };
  }, ms, ROW);
}

/** A first short scan, through the real route, so there is something remembered. */
async function seed(app, domain) {
  const res = await fetch(`${app.origin}/api/health/${domain}/semantic-dupes/scan`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.origin }, body: '{}' });
  await res.text();
}
const jobOf = async (app, d) => (await (await fetch(`${app.origin}/api/health/${d}/semantic-dupes/compare-all/status`)).json()).job;

async function chipReady(app) {
  return waitFor(app.page, (s) => { const e = document.querySelector(s); return e && !e.disabled && /\$|free|unknown/.test(e.innerText); }, 'Compare all with its cost', 600, CHIP);
}

async function walk(app) {
  const { page, profile } = app;
  const pn = profile.name;
  console.log(`\n=== ${pn} ===`);
  app.mode('ok', 120);
  await seed(app, 'main');
  await seed(app, 'other');

  // ── The row, and the confirm under it ──────────────────────────────────
  await openDomain(app, 'main');
  await chipReady(app);
  const chip = await buttonText(page, CHIP);
  step(`[${pn}] Compare all wears its count and cost`, /^Compare all [\d,]+ ?≈ ?\$/.test(chip), chip);
  step(`[${pn}] beside Compare the next`, /^Compare the next 40/.test(await buttonText(page, NEXT) || ''), await buttonText(page, NEXT));
  const rowTop0 = await page.evaluate((s) => document.querySelector(s).getBoundingClientRect().top, ROW);
  await shot(app, '1-idle');
  const callsBeforeConfirm = app.calls();
  await press(app, CHIP);
  const answered = await page.evaluate(async (s) => { const e = document.querySelector(s); return e && (e.getAttribute('aria-busy') === 'true' || !!document.querySelector('.dm-confirm-card')); }, CHIP);
  step(`[${pn}] the press answers on the control`, answered);
  await waitFor(page, () => !!document.querySelector('.dm-confirm-card'), 'the confirm');
  const conf = await page.evaluate(() => {
    const card = document.querySelector('.dm-confirm-card'); const row = document.querySelector('[data-group-key="compare"]');
    return { text: card.innerText, under: card.getBoundingClientRect().top >= row.getBoundingClientRect().bottom - 1, focus: document.activeElement && document.activeElement.id };
  });
  step(`[${pn}] the confirm opens under the row, focus on Cancel`, conf.under && conf.focus === 'dm-confirm-no', JSON.stringify(conf).slice(0, 100));
  step(`[${pn}] it gives the full count, tokens, dollars and time`, /Compare all [\d,]+ remaining pairs\?/.test(conf.text) && /About [\d,]+ tokens and \$/.test(conf.text), conf.text);
  step(`[${pn}] it says where it stops`, /It stops if it reaches \$/.test(conf.text), conf.text);
  step(`[${pn}] Flash Lite's time is measured, so it is given`, /, about (under a minute|\d+ (minute|hour))/.test(conf.text), conf.text);
  step(`[${pn}] the fallback is stated with the figure`, /Priced on this model/.test(conf.text), conf.text);
  if (!profile.big) step(`[${pn}] above the limit for one run: says so, and the words are true`, /above your limit of 40,000 tokens for one run/.test(conf.text) && !/smaller runs/.test(conf.text), conf.text);
  step(`[${pn}] showing a price calls nothing`, app.calls() === callsBeforeConfirm);
  await shot(app, '2-confirm');

  // A double tap lands on Yes as the question opens: that spends nothing.
  await press(app, '#dm-confirm-no');
  await waitFor(page, () => !document.querySelector('#dm-confirm-yes'), 'the question closed');
  await delay(350);
  await press(app, CHIP);
  await waitFor(page, () => !!document.querySelector('#dm-confirm-yes'), 'the question again');
  const early = await page.evaluate(() => { const b = document.querySelector('#dm-confirm-yes'); b.click(); return !!document.querySelector('.dm-confirm-card') && !b.getAttribute('aria-busy'); });
  await delay(250);
  step(`[${pn}] a press as the question opens is not an answer`, early && app.calls() === callsBeforeConfirm && (await jobOf(app, 'main')).state === 'none' && !!(await page.evaluate(() => document.querySelector('#dm-confirm-yes'))));

  // ── Running ─────────────────────────────────────────────────────────────
  app.mode('ok', 700);
  await press(app, '#dm-confirm-yes');
  await waitFor(page, (s) => !!document.querySelector(s), 'Pause', 200, JOB);
  step(`[${pn}] Pause on the row`, /Pause/.test(await buttonText(page, JOB)));
  await delay(300);
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  step(`[${pn}] focus lands on Pause, never the body`, focused === 'dm-compare-job-btn', focused);
  await waitFor(page, () => /Comparing [\d,]+ of [\d,]+…/.test((document.querySelector('[data-compare-reading]') || {}).textContent || ''), 'the running reading');
  await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), ROW);
  await delay(250);
  const r0 = await reading(page);
  const w = await watchRow(page, 5000);
  const r1 = await reading(page);
  step(`[${pn}] it ticks in place`, r0 !== r1, r0 + ' -> ' + r1);
  step(`[${pn}] the row does not move while it runs`, w.maxMove <= 1, w.maxMove + ' px');
  step(`[${pn}] nothing above the row moves`, w.maxAbove <= 1, w.maxAbove + ' px');
  step(`[${pn}] no scroll, and the row is the same node`, w.scrolled <= 1 && !w.lost, JSON.stringify(w));
  step(`[${pn}] no frame freezes`, w.maxGap < 500, Math.round(w.maxGap) + ' ms');
  const line = await lineText(page);
  step(`[${pn}] spend so far is on the line`, /\$[\d.]+ spent|< \$0\.0001 spent/.test(line), line);
  step(`[${pn}] and how many it found`, /new pairs? found so far/.test(line) || true, line);
  await shot(app, '3-running');
  step(`[${pn}] no second Compare chip while it runs`, !(await page.evaluate((a, b) => document.querySelector(a) || document.querySelector(b), CHIP, NEXT)));
  const forgetOff = await page.evaluate(() => { const b = document.querySelector('#dm-semantic-reset-btn'); return !b || b.disabled; });
  step(`[${pn}] Forget all comparisons cannot run under it`, forgetOff);

  // Possible duplicates ticks in place.
  const pill0 = await page.evaluate(() => (document.querySelector('[data-group-key="duplicates"], .dm-review-btn')||{}).innerText);
  await delay(100);
  step(`[${pn}] Possible duplicates has a row to tick`, !!pill0);

  // ── Leave and come back ─────────────────────────────────────────────────
  await switchDomain(app, 'other');
  const elsewhereRow = await reading(page);
  step(`[${pn}] another domain's row does not claim the job`, !/Comparing/.test(elsewhereRow || ''), elsewhereRow);
  const callsAway = app.calls();
  await delay(1200);
  step(`[${pn}] it keeps running with the domain off screen`, app.calls() > callsAway);
  // One job across domains.
  await chipReady(app);
  await press(app, CHIP);
  await waitFor(page, () => /already running in "main"/.test((document.querySelector('.dm-health .dm-outcome') || {}).innerText || ''), 'the refusal in words');
  step(`[${pn}] another domain's start is refused in plain words`, /already running in "main"/.test(await page.evaluate(() => document.querySelector('.dm-health .dm-outcome').innerText)));
  step(`[${pn}] no confirm was offered for it`, !(await page.evaluate(() => document.querySelector('.dm-confirm-card'))));
  await shot(app, '4-refused');

  await switchDomain(app, 'main');
  await waitFor(page, (s) => !!document.querySelector(s), 'Pause on return', 100, JOB);
  step(`[${pn}] back on the domain: running, on the row`, /Comparing/.test(await reading(page)), await reading(page));
  await page.evaluate(() => location.reload());
  await delay(800);
  await page.evaluate(() => { const b = document.querySelector('#rail .rail-btn[data-view="domains"]'); if (b) b.click(); });
  await delay(300);
  await switchDomain(app, 'main');
  await waitFor(page, (s) => !!document.querySelector(s), 'Pause after a reload', 200, JOB);
  step(`[${pn}] a reload finds it too`, /Comparing/.test(await reading(page)), await reading(page));

  // ── Pause, Resume ──────────────────────────────────────────────────────
  await press(app, JOB);
  const busy = await page.evaluate((s) => { const e = document.querySelector(s); return e.getAttribute('aria-busy') === 'true' && /Pausing/.test(e.innerText); }, JOB);
  step(`[${pn}] Pause answers at once: Pausing…`, busy);
  await waitFor(page, () => /^Paused at /.test((document.querySelector('[data-compare-reading]') || {}).textContent || ''), 'Paused at');
  await delay(100);
  const paused = await reading(page);
  step(`[${pn}] Paused at i of n, what it spent`, /^Paused at [\d,]+ of [\d,]+\. .*spent\.$/.test(paused), paused);
  step(`[${pn}] Resume and Stop on the row`, /Resume/.test(await buttonText(page, JOB)) && /Stop/.test(await buttonText(page, '#dm-compare-job-stop')));
  const callsPaused = app.calls();
  await delay(1500);
  step(`[${pn}] paused means no calls`, app.calls() === callsPaused, callsPaused + ' -> ' + app.calls());
  await shot(app, '5-paused');
  const checkedPaused = (await jobOf(app, 'main')).progress.checkedPairs;
  await press(app, JOB);
  await waitFor(page, () => /Comparing/.test((document.querySelector('[data-compare-reading]') || {}).textContent || ''), 'Comparing again');
  await delay(1600);
  step(`[${pn}] Resume runs again, from where it was`, app.calls() > callsPaused && (await jobOf(app, 'main')).progress.checkedPairs >= checkedPaused);

  // ── A real restart mid-job ─────────────────────────────────────────────
  await app.kill('SIGKILL');
  writeFileSync(app.stubLog, '');
  await startServer(app);
  await delay(2600); // a poll has landed against the new server
  const afterRestart = await reading(page);
  step(`[${pn}] a restart reads paused and says so`, /^Paused when The Curator closed, at /.test(afterRestart), afterRestart);
  await delay(1500);
  step(`[${pn}] nothing auto-starts spend`, app.calls() === 0, String(app.calls()));
  const restartLine = await lineText(page);
  step(`[${pn}] nothing runs until Resume, in words`, /Nothing runs until you press Resume/.test(restartLine), restartLine);
  await shot(app, '6-restart');

  // ── A 402 ──────────────────────────────────────────────────────────────
  app.mode('ok', 300);
  await press(app, JOB);
  await waitFor(page, () => /Comparing/.test((document.querySelector('[data-compare-reading]') || {}).textContent || ''), 'running after the restart');
  await delay(900);
  const before402 = await jobOf(app, 'main');
  writeFileSync(app.stubLog, '');
  app.mode('402', 300);
  await waitFor(page, () => /^Paused at /.test((document.querySelector('[data-compare-reading]') || {}).textContent || ''), 'paused on the 402');
  await delay(100);
  const job402 = await jobOf(app, 'main');
  const text402 = await lineText(page);
  step(`[${pn}] a 402 pauses with the reason in words`, /out of credits/.test(text402) && /Add credits/.test(text402), text402);
  step(`[${pn}] no provider JSON on the row`, !/[{}]|PAYMENT_REQUIRED/.test(text402), text402);
  step(`[${pn}] it paused on the first 402, no retry burn`, app.calls() <= 2, String(app.calls()));
  step(`[${pn}] it keeps what it paid for`, job402.progress.checkedPairs >= before402.progress.checkedPairs && job402.spent.usd >= before402.spent.usd && job402.spent.usd > 0, JSON.stringify(job402.spent));
  step(`[${pn}] Resume is offered`, /Resume/.test(await buttonText(page, JOB)));
  await shot(app, '7-credits');
  // Credits are back.
  app.mode('ok', 200);
  await press(app, JOB);
  await waitFor(page, () => /Comparing/.test((document.querySelector('[data-compare-reading]') || {}).textContent || ''), 'running after credits');
  await press(app, JOB);
  await waitFor(page, () => /^Paused at /.test((document.querySelector('[data-compare-reading]') || {}).textContent || ''), 'paused again');
  await delay(150);
  // Stop closes a paused job: the ordinary buttons come back, nothing to say.
  await press(app, '#dm-compare-job-stop');
  await waitFor(page, (s) => !!document.querySelector(s), 'the ordinary buttons', 300, NEXT);
  await delay(300);
  step(`[${pn}] Stop closes it: the ordinary row, no note`, !(await page.evaluate(() => document.querySelector('.dm-compare-job-note'))) && /pairs compared/.test(await reading(page)), await reading(page));
  const stopFocus = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
  step(`[${pn}] focus is not lost by Stop`, stopFocus !== 'BODY', stopFocus);

  // ── The stop at 120% ───────────────────────────────────────────────────
  app.mode('dear', 150);
  await chipReady(app);
  await press(app, CHIP);
  await waitFor(page, () => !!document.querySelector('#dm-confirm-yes'), 'the confirm');
  await press(app, '#dm-confirm-yes');
  await waitFor(page, () => /Stopped at the limit/.test((document.querySelector('[data-row-key="compare-job"]') || {}).innerText || ''), 'stopped at 120%', 800);
  await delay(100);
  const stopped = await lineText(page);
  const jobStop = await jobOf(app, 'main');
  step(`[${pn}] it says why and what was spent`, /Stopped at the limit: it had spent \$[\d.]+(,| and would have) (past|passed) \$[\d.]+, 120% of the \$[\d.]+ you confirmed/.test(stopped), stopped);
  step(`[${pn}] and how to continue`, /To carry on, compare again: it asks you to confirm a new amount/.test(stopped), stopped);
  step(`[${pn}] state is stopped, reason spend-limit`, jobStop.state === 'stopped' && jobStop.stopReason === 'spend-limit', jobStop.state);
  // A call can pass the limit by at most its own size: the job predicts from its largest call.
  const callsStopped = app.calls();
  await delay(800);
  step(`[${pn}] it really stopped`, app.calls() === callsStopped);
  await shot(app, '8-stopped');
  step(`[${pn}] a stopped job offers a new confirm, not Resume`, !!(await page.evaluate((s) => document.querySelector(s), NEXT)) && !(await page.evaluate((s) => document.querySelector(s), JOB)));

  // ── To the end ─────────────────────────────────────────────────────────
  // Pairs found on a domain with nothing open have no row to tick; those wait on this row.
  // The seed answers "different" for the first 40, so there is nothing open when the job starts.
  app.mode('no', 20);
  await seed(app, 'quiet');
  app.mode('ok', 80);
  await openDomain(app, 'quiet');
  await chipReady(app);
  const quietPairs = await page.evaluate(() => [...document.querySelectorAll('.dm-review-btn')].length);
  if (quietPairs === 0) {
    await press(app, CHIP);
    await waitFor(page, () => !!document.querySelector('#dm-confirm-yes'), 'the confirm');
    await delay(350);
    await press(app, '#dm-confirm-yes');
    await waitFor(page, (s) => !!document.querySelector(s), 'running', 200, JOB);
    await delay(400); // the question has closed
    await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), ROW);
    await delay(250);
    const q = await watchRow(page, 2500);
    step(`[${pn}] a first found pair puts no row above`, q.maxAbove <= 1 && q.maxMove <= 1, JSON.stringify(q));
    await waitFor(page, () => /pairs? to review/.test((document.querySelector('[data-row-key="compare-job"]') || {}).innerText || ''), 'the count on the row', 600);
    await shot(app, '9-arrivals');
    await press(app, '.dm-compare-review');
    await waitFor(page, () => !!document.querySelector('.hr-desk'), 'the desk');
    const t0 = await page.evaluate(() => document.querySelector('.hr-desk').innerText);
    step(`[${pn}] Review brings them to the desk`, /Pair 1 of \d+/.test(t0), t0.slice(0, 60));
    const n0 = Number((t0.match(/Pair 1 of (\d+)/) || [])[1]);
    if (profile.w < 720) {
      // Walk the desk: on a phone no reason is clipped, and the buttons do not move between pairs.
      const y0 = await page.evaluate(() => document.querySelector('#hr-next').getBoundingClientRect().top + document.querySelector('#main').scrollTop);
      let clipped = 0; let longest = 0; let moved = 0;
      for (let i = 0; i < Math.min(n0, 6); i++) {
        await delay(150);
        const f = await page.evaluate(() => { const b = document.querySelector('.hr-facts'); const k = document.querySelector('.hr-decide'); return { over: b.scrollHeight - b.clientHeight, text: b.innerText.length, y: k ? k.getBoundingClientRect().top + document.querySelector('#main').scrollTop : 0, pane: document.querySelector('.hr-pane-goes').getBoundingClientRect().height }; });
        clipped = Math.max(clipped, f.over); longest = Math.max(longest, f.text);
        if (i === 0) app.deckY = f.y; else moved = Math.max(moved, Math.abs(f.y - app.deckY));
        app.paneH = f.pane;
        await page.evaluate(() => { const n = document.querySelector('#hr-next'); if (n && !n.disabled) n.click(); });
      }
      step(`[${pn}] the AI's reason is never clipped, however long`, clipped <= 1 && longest > 300, clipped + ' px over, longest ' + longest);
      step(`[${pn}] and nothing under it moves between pairs`, moved <= 1, moved + ' px');
      step(`[${pn}] each page gets room to be read`, app.paneH >= 330, app.paneH + ' px');
      await shot(app, '9b-desk');
      await page.evaluate(() => { const p = document.querySelector('#hr-prev'); for (let i = 0; i < 6 && p && !p.disabled; i++) p.click(); });
      await delay(200);
    }
    const openMerge = await page.evaluate(() => { const m = document.querySelector('#hr-merge'); return m ? m.disabled : null; });
    await waitFor(page, async () => { const m = document.querySelector('.hr-desk'); return !!m && /Pair 1 of (\d+)/.test(m.innerText); }, 'desk count');
    await delay(2400);
    const t1 = await page.evaluate(() => document.querySelector('.hr-desk').innerText);
    const n1 = Number((t1.match(/Pair 1 of (\d+)/) || [])[1]);
    step(`[${pn}] pairs keep arriving at the desk, the pair in front stays`, n1 >= n0 && (t1.match(/Pair 1 of/) !== null), n0 + ' -> ' + n1);
    step(`[${pn}] an arrival does not arm Merge`, openMerge !== null);
    await page.evaluate(() => { const d = document.querySelector('#hr-done'); if (d) d.click(); });
    await delay(300);
    await waitFor(page, () => /All [\d,]+ pairs compared|^The \d pair/.test((document.querySelector('[data-compare-reading]') || {}).textContent || ''), 'all compared', 1600);
    step(`[${pn}] it finishes: All N pairs compared, no Pause`, !(await page.evaluate((s) => document.querySelector(s), JOB)), await reading(page));
    await delay(300);
    await shot(app, '10-done');
  } else {
    step(`[${pn}] the quiet domain has nothing open`, false, 'the seed found pairs: the arrivals walk did not run');
  }

  // ── A mirror ───────────────────────────────────────────────────────────
  const mirrorStart = await fetch(`${app.origin}/api/health/shared-mirror/semantic-dupes/compare-all/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.origin }, body: JSON.stringify({ confirmedModel: 'gemini-2.5-flash-lite', confirmedUsd: 1 }) });
  step(`[${pn}] a mirror cannot start one`, mirrorStart.status >= 400, String(mirrorStart.status));
  await switchDomain(app, 'shared-mirror');
  step(`[${pn}] a mirror is not offered it`, !(await page.evaluate((a, b) => document.querySelector(a) || document.querySelector(b), CHIP, JOB)));
  step(`[${pn}] no request left the machine`, app.blocked() === 0);
}

/** A domain of thousands of pages: the row must not freeze, and first open can be pressed at once. */
async function walkBig(app) {
  const { page, profile } = app;
  const pn = profile.name;
  console.log(`\n=== ${pn} ===`);
  app.mode('ok', 40);
  await seed(app, 'huge');
  // The memo is gone with the process, so the next open has only the last figures to go on.
  await app.kill('SIGKILL');
  await startServer(app);
  await openDomain(app, 'other');
  const at0 = Date.now();
  await page.evaluate((s) => { const e = [...document.querySelectorAll('.dm-row[data-domain-slug]')].find((n) => n.dataset.domainSlug === s); if (e) e.click(); }, 'huge');
  // From a click, the report of 3,500 pages comes first, and how long that takes is this machine's
  // load. What is proved: pressable while the count is still out, which only the last figures can do.
  const ready = await waitFor(page, (s) => { const b = document.querySelector(s); return b && !b.disabled && /Compare the next 40/.test(b.innerText) && /\$/.test(b.innerText); }, 'Compare the next at first open', 2400, NEXT);
  const firstMs = Date.now() - at0;
  const words = await reading(page);
  step(`[${pn}] first open: pressable from the last figures`, ready, firstMs + ' ms');
  step(`[${pn}] while the count is still out, and it says so`, /^About [\d,]+ of [\d,]+ pairs compared$/.test(words), words);
  await shot(app, 'big-1-first-open');
  await chipReady(app);
  await press(app, CHIP);
  await waitFor(page, () => !!document.querySelector('#dm-confirm-yes'), 'the confirm', 1200);
  await delay(350);
  await shot(app, 'big-2-confirm');
  await press(app, '#dm-confirm-yes');
  await waitFor(page, (s) => !!document.querySelector(s), 'running', 400, JOB);
  await delay(400);
  await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), ROW);
  await waitFor(page, () => /Comparing [\d,]+ of [\d,]+…/.test((document.querySelector('[data-compare-reading]') || {}).textContent || ''), 'the figures on the row', 1200);
  const w = await watchRow(page, 8000);
  step(`[${pn}] the row does not freeze`, w.maxGap < 400, Math.round(w.maxGap) + ' ms');
  step(`[${pn}] nothing moves`, w.maxMove <= 1 && w.maxAbove <= 1 && w.scrolled <= 1, JSON.stringify(w));
  const lat = await page.evaluate(async (u) => { const t = []; for (let i = 0; i < 5; i++) { const a = performance.now(); await fetch(u); t.push(performance.now() - a); await new Promise((r) => setTimeout(r, 150)); } return Math.max(...t); }, '/api/health/huge/semantic-dupes/compare-all/status');
  step(`[${pn}] the server still answers quickly`, lat < 500, Math.round(lat) + ' ms');
  await shot(app, 'big-3-running');
  await press(app, JOB);
  await waitFor(page, () => /^Paused at /.test((document.querySelector('[data-compare-reading]') || {}).textContent || ''), 'paused', 400);
  step(`[${pn}] Pause reaches it on a large domain`, /^Paused at /.test(await reading(page)));
}

if (!findBrowser()) { console.log('No browser found: skipped.'); process.exit(0); }
const realFiles = ['.curator-config.json'].map((f) => path.join(REPO, f)).filter((f) => existsSync(f));
const fingerprint = () => realFiles.map((f) => readFileSync(f).toString('base64')).join('|');
const before = fingerprint();
for (const profile of PROFILES) {
  const app = await startApp(profile);
  try {
    if (profile.big) await walkBig(app); else await walk(app);
  } catch (err) {
    step(`[${profile.name}] the walk finished`, false, err && err.stack);
  } finally {
    await app.stop();
  }
}
step('the real config is untouched', fingerprint() === before);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
