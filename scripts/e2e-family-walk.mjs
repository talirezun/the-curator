#!/usr/bin/env node
/**
 * e2e-family-walk.mjs — a family at the review desk, on the running screen, on a real server.
 *
 * LIVE_LOCAL (scripts/run-tests.js). This checkout's server on a spare port, driven in headless
 * Chrome over CDP with real mouse events, against a generated world: a temp domains dir,
 * CURATOR_TEST_USER_DATA_DIR and a fake HOME. No model is called: the answers are written into
 * the domain's cache, as a scan would have left them, and a preload refuses every non-local host
 * and logs it. The fake key in the fake config is not a credential.
 *
 * It walks families of 3, 8 and 30 pages with long names: choosing, the walk, stopping, the
 * summary and the leftovers, with every frame's button positions measured, the gate timed, focus
 * and the live region read, and THE FILES ON DISK compared with what they held: every line of
 * every page merged must be on the page that stays.
 *
 *   node scripts/e2e-family-walk.mjs [--profiles 1280,375,1280-light,375-light,1280-rm,375-rm] [--shots <dir>] [--words <file>]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser, findBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';
import { wordAllowed, BANNED } from './test-helpers/health-words.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const SHOTS = arg('--shots') ? path.resolve(arg('--shots')) : null;
const WORDS = arg('--words') ? path.resolve(arg('--words')) : null;
const ALL = {
  '1280': { name: '1280', w: 1280, h: 900, full: true },
  '375': { name: '375', w: 375, h: 812, full: true },
  '1280-light': { name: '1280-light', w: 1280, h: 900, light: true },
  '375-light': { name: '375-light', w: 375, h: 812, light: true },
  '1280-rm': { name: '1280-reduced-motion', w: 1280, h: 900, reduced: true },
  '375-rm': { name: '375-reduced-motion', w: 375, h: 812, reduced: true },
};
const PROFILES = (arg('--profiles') || '1280,375,1280-light,375-light,1280-rm,375-rm').split(',').map((n) => ALL[n]);

let failed = 0; let passed = 0;
const step = (label, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail !== '' ? ' — ' + String(detail).slice(0, 600) : ''}`); };

const STUB_SRC = String.raw`
import { appendFileSync } from 'node:fs';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url && url.url ? url.url : url);
  let host = ''; try { host = new URL(u).hostname; } catch {}
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return realFetch(url, opts);
  appendFileSync(process.env.FW_STUB_LOG, JSON.stringify({ blocked: host }) + '\n');
  return new Response('{"models":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
};
`;

// ── The world ───────────────────────────────────────────────────────────────
const TAIL = '-and-the-long-history-of-how-this-subject-came-to-be-described-in-so-many-different-ways';
const THREE = ['privacy-and-data-protection', 'data-privacy', 'personal-data-protection-and-privacy-law-in-the-european-union'];
const EIGHT = ['claude-opus', 'claude-opus-model-family-overview-and-pricing-tiers', 'anthropic-claude-opus-large-model-tier', 'opus-tier', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4', 'claude-opus-3-legacy-and-its-retirement-from-the-public-api' + TAIL];
const THIRTY = Array.from({ length: 30 }, (_, i) => (i === 0 ? 'search-engine-history' : 'search-engine-history-part-' + i + (i % 7 === 0 ? TAIL : '')));

const LONE = ['lone-a', 'lone-b', 'lone-c'];

const pageText = (slug, i) => `---\ntype: concept\ntags: [type/concept, topic/${i % 3}]\ncreated: 2026-01-0${(i % 9) + 1}\nupdated: 2026-02-0${(i % 9) + 1}\n---\n\n# ${slug}\n\nThe opening of ${slug}, in its own words, ${'with more to read '.repeat((i % 4) + 1)}.\n\n## Key Facts\n\n- A fact only ${slug} states.\n- A second fact, number ${i}.\n\n## Own section of ${slug}\n\nA paragraph that belongs to ${slug} and to no other page.\n\n- A bullet under that section, ${slug}.\n`;

function buildWorld(root) {
  const w = path.join(root, 'main', 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(w, f), { recursive: true });
  writeFileSync(path.join(root, 'main', 'CLAUDE.md'), '# main\n');
  const all = [...THREE, ...EIGHT, ...THIRTY, ...LONE, 'solo-page', 'solo-pages', 'other-page', 'other-pages', 'wiki-hub'];
  all.forEach((s, i) => writeFileSync(path.join(w, 'concepts', s + '.md'), pageText(s, i)));
  const links = all.filter((s) => s !== 'wiki-hub').map((s, i) => Array.from({ length: (all.length - i) % 5 + 1 }, () => `- [[${s}]]`).join('\n')).join('\n');
  writeFileSync(path.join(w, 'concepts', 'wiki-hub.md'), `---\ntype: concept\n---\n\n# Hub\n\nAn index page.\n\n## Related\n\n${links}\n`);
  writeFileSync(path.join(w, 'summaries', 'a-source.md'), `# A source\n\n## Entities Mentioned\n\n- [[claude-opus]]\n- [[opus-tier]]\n\n## Concepts Introduced or Referenced\n\n- [[data-privacy]]\n`);
  writeFileSync(path.join(w, 'index.md'), '# Wiki Index\n\n## Concepts\n\n| Page | Summary |\n|---|---|\n' + all.sort().map((s) => `| [[${s}]] | Notes. |`).join('\n') + '\n');
  writeFileSync(path.join(w, 'log.md'), '# Log\n');
  return w;
}

/** The answers, as a scan leaves them: only yes and no about exact pairs. */
function answersFor() {
  const out = [];
  const same = (keep, remove, why) => out.push({ keep, remove, verdict: 'yes', why: why || `The openings of ${remove} and ${keep} describe the same subject.` });
  const no = (a, b, why) => out.push({ keep: a, remove: b, verdict: 'no', why: why || `${b} is about a different subject.` });
  // 3 pages: A~B, A~C.
  same(THREE[0], THREE[1], 'Both pages describe the protection of personal data.');
  same(THREE[1], THREE[2]);
  // 8 pages: 9 of 28, with a bridge: 5-5 and 4 reach claude-opus only through claude-opus-5.
  const [o, ...e] = EIGHT;
  same(o, e[0]); same(o, e[1]); same(o, e[2]);
  no(o, e[5], 'The AI said this one is a separate model.');
  no(o, e[6]);
  same(e[2], e[4]); same(e[4], e[3]); same(e[4], e[5]); same(e[6], e[5]);
  // 30 pages: 41 of 435, a chain with spokes.
  for (let i = 1; i < 30; i++) same(THIRTY[i - 1], THIRTY[i]);
  for (let i = 3; i < 15; i++) (i % 3 ? same : no)(THIRTY[0], THIRTY[i]);
  same(LONE[0], LONE[1]); same(LONE[1], LONE[2]);
  // Two pairs in no family.
  same('solo-page', 'solo-pages'); same('other-page', 'other-pages');
  return out;
}

async function startApp(profile) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'curator-e2e-family-'));
  const ws = { domains: path.join(base, 'domains'), userData: path.join(base, 'userdata'), home: path.join(base, 'home') };
  for (const d of [ws.domains, ws.userData, ws.home]) mkdirSync(d, { recursive: true });
  const app = { profile, base, ws, stubFile: path.join(base, 'stub.mjs'), stubLog: path.join(base, 'stub.log') };
  writeFileSync(app.stubFile, STUB_SRC); writeFileSync(app.stubLog, '');
  app.wiki = buildWorld(ws.domains);
  writeFileSync(path.join(ws.userData, '.curator-config.json'), JSON.stringify({ activeProvider: 'gemini', domainsPath: ws.domains, geminiApiKey: 'AIza-E2E-FAKE-KEY-not-a-credential', aiHealth: { semanticDupeMaxPairs: 40, costCeilingTokens: 40000 } }, null, 2), { mode: 0o600 });
  // The cache file, through the app's own functions, so its format can never drift from theirs.
  const seed = `
    import { readFileSync } from 'node:fs'; import path from 'node:path';
    const { saveDuplicateChecks, pairKey, openingsHash, pageOpening } = await import(${JSON.stringify(path.join(REPO, 'src/brain/duplicate-checks.js'))});
    const { SEMANTIC_PROMPT_ID } = await import(${JSON.stringify(path.join(REPO, 'src/brain/health-ai.js'))});
    const { getProviderInfo } = await import(${JSON.stringify(path.join(REPO, 'src/brain/llm.js'))});
    const info = getProviderInfo();
    const wiki = ${JSON.stringify(app.wiki)};
    const open = (s) => pageOpening(readFileSync(path.join(wiki, 'concepts', s + '.md'), 'utf8'));
    const m = new Map();
    for (const a of ${JSON.stringify(answersFor())}) {
      const rec = { provider: info.provider, model: info.model, prompt: SEMANTIC_PROMPT_ID, at: new Date().toISOString(), openings: openingsHash('concepts', a.keep, open(a.keep), 'concepts', a.remove, open(a.remove)), verdict: a.verdict, rationale: a.why };
      if (a.verdict === 'yes') Object.assign(rec, { keep: 'concepts/' + a.keep, remove: 'concepts/' + a.remove, confidence: 'high' });
      m.set(pairKey('concepts', a.keep, 'concepts', a.remove), rec);
    }
    console.log(await saveDuplicateChecks('main', m));
  `;
  const seedFile = path.join(base, 'seed.mjs');
  writeFileSync(seedFile, seed);
  const env = { ...process.env };
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'DOMAINS_PATH', 'LLM_MODEL']) delete env[k];
  Object.assign(env, { HOME: ws.home, CURATOR_TEST_INSTALL_HOME: ws.home, CURATOR_TEST_USER_DATA_DIR: ws.userData, CURATOR_TEST_DOMAINS_DIR: ws.domains, FW_STUB_LOG: app.stubLog });
  await new Promise((res, rej) => { const c = spawn(process.execPath, [seedFile], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'inherit'] }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('exit', () => (o.trim() === 'true' ? res() : rej(new Error('seed failed: ' + o)))); });
  app.port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  app.origin = `http://localhost:${app.port}`;
  app.server = spawn(process.execPath, ['--import', app.stubFile, path.join(REPO, 'src', 'server.js')], { cwd: REPO, env: { ...env, PORT: String(app.port), CURATOR_NO_OPEN: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(app.origin + '/api/version')).ok) break; } catch { /* not yet */ } await delay(100); }
  app.browser = await launchBrowser({ headless: true });
  app.conn = await CdpConnection.connect(app.browser.wsUrl);
  app.page = await CdpPage.create(app.conn);
  await app.page.setViewport(profile.w, profile.h, 1);
  await app.page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: profile.light ? 'light' : 'dark' }, { name: 'prefers-reduced-motion', value: profile.reduced ? 'reduce' : 'no-preference' }] });
  app.stop = async () => {
    try { await app.conn.close(); } catch { /* gone */ }
    try { await app.browser.close(); } catch { /* gone */ }
    if (app.server.exitCode === null) { app.server.kill('SIGTERM'); for (let i = 0; i < 40 && app.server.exitCode === null && app.server.signalCode === null; i++) await delay(50); }
    if (app.server.exitCode === null) app.server.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  };
  return app;
}

async function waitFor(page, fn, label, tries = 400, ...args) {
  for (let i = 0; i < tries; i++) { let v = false; try { v = await page.evaluate(fn, ...args); } catch { /* navigating */ } if (v) return true; await delay(50); }
  step('waited for ' + label, false, 'timed out');
  return false;
}

async function openDomain(app, { reload = false } = {}) {
  const { page, origin, profile } = app;
  await page.navigate(origin + '/api/version');
  await page.evaluate((theme, again) => {
    if (!again) localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('curator-next-theme', theme); localStorage.setItem('curator-next-view', 'domains');
    localStorage.setItem('curator-next-onboarding-dismissed-v1', '1'); localStorage.setItem('curator-ai-health-disclosure-seen-v1', 'yes');
    sessionStorage.setItem('curator-next-instance-banner-dismissed-v1', '1');
  }, profile.light ? 'light' : 'dark', reload);
  await page.navigate(origin);
  for (let i = 0; i < 100 && !(await page.evaluate(() => !!window.__curatorBooted)); i++) await delay(100);
  await page.evaluate(() => { const b = document.querySelector('#rail .rail-btn[data-view="domains"]'); if (b) b.click(); });
  await delay(400);
  await page.evaluate(() => { const e = document.querySelector('.dm-row[data-domain-slug="main"]'); if (e) e.click(); });
  await waitFor(page, () => !!document.querySelector('.dm-health #dm-rescan-btn'), 'health card', 1200);
  await delay(300);
}

/** A real press: the pointer goes to the control, and stays there. */
async function press(app, sel) {
  const { page } = app;
  await page.evaluate((s) => { const e = document.querySelector(s); if (e) e.scrollIntoView({ block: 'center' }); }, sel);
  await delay(60);
  const c = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 14) }; }, sel);
  if (!c) { step('a control to press: ' + sel, false); return false; }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  return true;
}
const leave = (app) => app.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });

const shot = async (app, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await delay(100);
  const b = await app.page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(SHOTS, `${app.profile.name}-${name}.png`), Buffer.from(b.data, 'base64'));
};
const deskText = (page) => page.evaluate(() => { const e = document.querySelector('.hr-desk'); return e ? e.innerText.replace(/\s+/g, ' ') : ''; });
const headIntoView = (page) => page.evaluate(() => { const e = document.querySelector('.hr-desk'); if (e) e.scrollIntoView({ block: 'start' }); });

/** Everything on the desk that is not a page's own text, a line at a time. */
async function auditWords(app, label, seen, known) {
  const lines = await app.page.evaluate(() => {
    const desk = document.querySelector('.hr-desk');
    if (!desk) return [];
    const copy = desk.cloneNode(true);
    copy.querySelectorAll('.hr-pane-body, .hr-fam-pick-open').forEach((n) => n.remove());
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + desk.clientWidth + 'px';
    host.appendChild(copy); document.body.appendChild(host);
    const out = copy.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
    host.remove();
    return out;
  });
  if (lines.length < 3) { step(`the audit read the screen: ${label}`, false, lines.join(' | ')); return; }
  const bad = [];
  for (const raw of lines) {
    // The fact sits beside its sentence, a small button at the end of its line.
    let line = raw.replace(/^(Spelling variant|Version numbers differ|Different names) (?!\d+$)/, '').replace(/ (Undo|Try again)$/, '');
    for (const n of known) if (line === n) line = '';
    if (!line || /^[→·\s]*$/.test(line)) continue;
    if (seen) seen.add(line);
    if (BANNED.test(line) || !wordAllowed(line)) bad.push(line);
  }
  step(`every word is the deck's: ${label}`, bad.length === 0, bad.slice(0, 6).join(' | '));
}

const POSITIONS = () => {
  const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; };
  const m = document.querySelector('#main');
  const desk = document.querySelector('.hr-desk');
  const parts = desk ? [...desk.children].map((c) => String(c.className).split(' ')[0] + ':' + Math.round(c.getBoundingClientRect().height)).join(' ') : '';
  return { parts, scroll: m ? m.scrollTop : 0, h: desk ? Math.round(desk.getBoundingClientRect().height) : 0,
    keep: box('#hr-keep'), merge: box('#hr-merge'), title: box('#hr-title'), prev: box('#hr-prev'), next: box('#hr-next'), done: box('#hr-done'), panes: box('.hr-panes'), note: box('.hr-note'), outcome: box('.hr-outcome') };
};
const sameSpots = (a, b) => {
  const moved = [];
  for (const k of ['keep', 'merge', 'title', 'prev', 'next', 'done', 'panes', 'note', 'outcome']) {
    if (!a[k] || !b[k]) { moved.push(k + ' missing'); continue; }
    const dy = Math.abs((a[k].y + a.scroll) - (b[k].y + b.scroll)); const dx = Math.abs(a[k].x - b[k].x);
    if (dx > 1 || dy > 1) moved.push(`${k} ${dx},${dy}`);
  }
  if (a.h !== b.h) moved.push(`desk height ${a.h}→${b.h} [${a.parts}] → [${b.parts}]`);
  return moved;
};
const noOverflow = (page) => page.evaluate(() => {
  const root = document.documentElement; const out = [];
  if (root.scrollWidth > root.clientWidth + 1) out.push('page ' + root.scrollWidth + '>' + root.clientWidth);
  const desk = document.querySelector('.hr-desk');
  if (desk) {
    const d = desk.getBoundingClientRect();
    for (const e of desk.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.width && r.right > d.right + 1 && !e.closest('.hr-pane-body') && !e.closest('.hr-marks')) out.push(e.className + ' ' + Math.round(r.right - d.right)); }
  }
  return out.slice(0, 5);
});

/** Both panes brought on screen, as a reader would, until Merge opens. Returns ms it took. */
async function readUntilOpen(app) {
  const { page } = app;
  await waitFor(page, () => !!document.querySelector('.hr-pane-text'), 'the comparison');
  await leave(app);
  const t0 = Date.now();
  for (let i = 0; i < 80; i++) {
    const open = await page.evaluate(() => { const b = document.querySelector('#hr-merge'); return b && !b.disabled; });
    if (open) return Date.now() - t0;
    await page.evaluate((n) => { const list = document.querySelectorAll('.hr-pane'); const e = list[n % list.length]; if (e) e.scrollIntoView({ block: 'center' }); }, Math.floor(i / 8));
    await delay(100);
  }
  step('Merge opened after reading', false, 'never opened');
  return -1;
}

const titleFocused = (page) => page.evaluate(() => document.activeElement && document.activeElement.id === 'hr-title');
const liveText = (page) => page.evaluate(() => { const l = document.querySelector('.dm-health [aria-live="polite"]'); return l ? l.textContent : ''; });
const dec = (s) => s.replace(/\s+/g, ' ');

/** Reach a family the way a person can: Next among decisions; out of a walk by Done, then Review. */
async function toFamily(app, size, naming) {
  const { page } = app;
  const here = (t) => t.includes('Family of ' + size + ' pages') && (!naming || t.includes(naming));
  for (let i = 0; i < 24; i++) {
    const t = await deskText(page);
    if (here(t)) return true;
    if (!t) { await waitFor(page, () => !!document.querySelector('.dm-review-btn'), 'Review'); await press(app, '.dm-review-btn'); await waitFor(page, () => !!document.querySelector('.hr-desk'), 'the desk'); await delay(250); continue; }
    if (/Page \d+ of \d+ ·|pages? not decided|All decided/.test(t)) { await press(app, '#hr-done'); await delay(250); continue; }
    await press(app, '#hr-next');
    await delay(250);
  }
  step('reached the family of ' + size, false, await deskText(page));
  return false;
}
/** A slot that cuts its text off, a name or a warning. */
const clipped = (page) => page.evaluate(() => {
  const out = [];
  for (const s of ['.hr-running', '.hr-after', '.hr-note', '.hr-decide', '.hr-pane-head', '.hr-outcome', '.hr-marks-row', '.hr-merge-label', '.hr-marks-words']) {
    for (const e of document.querySelectorAll('.hr-desk ' + s)) if (e.scrollHeight > e.clientHeight + 1) out.push(s + ' ' + e.scrollHeight + '>' + e.clientHeight);
  }
  return out;
});
const titleInView = (page) => page.evaluate(() => { const r = document.getElementById('hr-title').getBoundingClientRect(); const m = document.getElementById('main').getBoundingClientRect(); return r.top >= m.top - 1 && r.bottom <= innerHeight; });
const pickPage = (app, slug) => press(app, `[data-fam-pick="concepts/${slug}"]`);

function onDisk(app, slug) { const f = path.join(app.wiki, 'concepts', slug + '.md'); return existsSync(f) ? readFileSync(f, 'utf8') : null; }
/** Every line of what a page held, apart from its frontmatter and blank lines, is in the kept file. */
function lostLines(original, kept) {
  const body = original.replace(/^---\n[\s\S]*?\n---\n/, '');
  return body.split('\n').map((l) => l.trim().replace(/^#+\s*/, '')).filter(Boolean).filter((l) => !kept.includes(l));
}

async function walk(app) {
  const { page, profile } = app;
  const pn = profile.name;
  console.log(`\n── ${pn} ──`);
  await openDomain(app);
  await waitFor(page, () => !!document.querySelector('.dm-review-btn'), 'Review', 600);
  const seen = new Set();
  const known = [...THREE, ...EIGHT, ...THIRTY, ...LONE, 'solo-page', 'solo-pages', 'other-page', 'other-pages'];
  await press(app, '.dm-review-btn');
  await waitFor(page, () => !!document.querySelector('.hr-desk'), 'the desk');

  // ── Mixed list ────────────────────────────────────────────────
  const first = await deskText(page);
  step('a mixed list: it opens on the first decision', /Family of \d+ pages|Pair 1 of 2/.test(first), first.slice(0, 120));
  // ── The family of 8 ───────────────────────────────────────────
  await toFamily(app, 8);
  await waitFor(page, () => /possible pairs/.test(document.querySelector('.hr-desk').innerText), 'the summary');
  let t = await deskText(page);
  step('8: the summary says how little was compared', t.includes('The AI compared 9 of the 28 possible pairs here. A match between two pages says nothing about a third.'), t.slice(0, 300));
  step('8: the question, and nothing is ticked', t.includes('Which page stays?') && (await page.evaluate(() => document.querySelectorAll('.hr-desk input[type=radio], .hr-desk input[type=checkbox]').length)) === 0);
  await headIntoView(page);
  await shot(app, '8-choose');
  await auditWords(app, '8, choosing', seen, known);
  const of = await noOverflow(page);
  step('8, choosing: nothing pokes out', of.length === 0, of.join(' | '));

  const beforeOpus = { stays: onDisk(app, EIGHT[0]) };
  await pickPage(app, EIGHT[0]);
  await delay(100);
  await waitFor(page, () => !!document.querySelector('.hr-pane-text'), 'the first comparison');
  step('8: focus goes to the title, never a button', await titleFocused(page));
  step('8: arriving, the title is in view', await titleInView(page));
  t = await deskText(page);
  step('8: the walk starts', t.includes('Page 1 of 7 · 0 merged · 0 kept · 7 left'), t.slice(0, 200));
  step('8: same first', t.includes('The AI compared these two pages and said they are the same.'), t.slice(0, 500));
  const gone1 = await page.evaluate(() => document.querySelector('.hr-pane-goes .hr-pane-name').textContent);
  step('8: nothing was written by choosing', onDisk(app, EIGHT[0]) === beforeOpus.stays && onDisk(app, gone1) !== null);

  // The gate, timed. The pointer is elsewhere.
  await leave(app);
  await page.evaluate(() => { const e = document.querySelector('.hr-panes'); e.scrollIntoView({ block: 'center' }); });
  const closedAtFirst = await page.evaluate(() => document.querySelector('#hr-merge').disabled);
  step('the gate: shut at once', closedAtFirst);
  const ms = await readUntilOpen(app);
  step('the gate: opens when the comparison has been seen', ms >= 0 && ms < (profile.w < 720 ? 8000 : 2500), ms);
  await auditWords(app, '8, walking', seen, known);
  await press(app, '.hr-merge-label');
  await delay(10);
  const label = await page.evaluate(() => { const b = document.querySelector('#hr-merge'); return b ? b.innerText + '|' + b.getAttribute('aria-busy') : ''; });
  step('the press answers in its own label', /Merging…\|true|Merge/.test(label), label);
  await waitFor(page, () => /Page 2 of 7/.test(document.querySelector('.hr-desk').innerText), 'the next page');
  await waitFor(page, () => !!document.querySelector('.hr-pane-text'), 'its comparison');
  const after1 = onDisk(app, gone1);
  const kept1 = onDisk(app, EIGHT[0]);
  step('a merge: the page is gone from disk', after1 === null);
  step('a merge: the kept page holds all of it', lostLines(pageText(gone1, [...THREE, ...EIGHT, ...THIRTY, ...LONE, 'solo-page', 'solo-pages', 'other-page', 'other-pages', 'wiki-hub'].indexOf(gone1)), kept1).length === 0, lostLines(pageText(gone1, 0), kept1).join('|'));
  step('a merge: under the heading it promised', kept1.includes('## Merged from ' + gone1));
  step('a merge: its own opening stayed at the top', kept1.replace(/^---[\s\S]*?---\n/, '').trimStart().startsWith('# ' + EIGHT[0]));
  step('a merge: focus on the title again', await titleFocused(page));
  step('a merge: the next page\'s title is in view', await titleInView(page));
  t = dec(await liveText(page));
  step('spoken: the outcome and where you are', /Merged .* into claude-opus\..*Page 2 of 7\./.test(t), t);
  const openNow = await page.evaluate(() => document.querySelector('#hr-merge').disabled);
  step('a resting pointer: the next page is shut', openNow);
  await delay(profile.w < 720 ? 700 : 700);
  const said = await page.evaluate(() => (document.querySelector('#hr-merge').disabled ? document.querySelector('.hr-gate').textContent : 'open'));
  step('a resting pointer stays shut, and says why', said === 'Move the pointer off Merge and back to press it.' || said.startsWith('Merge opens'), said);
  t = await deskText(page);
  step('the kept page grew on screen', (await page.evaluate(() => document.querySelector('.hr-pane-stays .hr-pane-body').innerText)).includes('Merged from'));
  step('its figures rose', /It has taken in 1 page so far\./.test(t));
  await headIntoView(page);
  await shot(app, '8-after-one');

  // Positions across decisions: the same spots, whatever the page.
  await leave(app);
  await headIntoView(page);
  await delay(100);
  await readUntilOpen(app);
  await headIntoView(page);
  await delay(50);
  const spot1 = await page.evaluate(POSITIONS);
  await page.evaluate(() => { document.querySelector('#hr-keep').click(); });
  await waitFor(page, () => /Page 3 of 7/.test(document.querySelector('.hr-desk').innerText), 'the third page');
  await waitFor(page, () => !!document.querySelector('.hr-pane-text'), 'its comparison');
  await headIntoView(page);
  await delay(80);
  const spot2 = await page.evaluate(POSITIONS);
  let moved = sameSpots(spot1, spot2);
  step('Keep both: no button moved', moved.length === 0, moved.join(', '));
  t = await deskText(page);
  step('Keep both: says so, with Undo', /Kept .* apart\. This pair will not come back\. Undo/.test(t), t.slice(-300));
  const dismissed = path.join(app.wiki, '.health-dismissed.jsonl');
  step('Keep both: recorded on disk', existsSync(dismissed) && readFileSync(dismissed, 'utf8').includes('claude-opus'));

  // The bridge: claude-opus-5-5 and -4 reach the page that stays only through -5.
  for (let i = 0; i < 6; i++) {
    t = await deskText(page);
    if (t.includes('The AI never compared these two pages.')) break;
    await press(app, '#hr-next'); await delay(200);
    await waitFor(page, () => !!document.querySelector('.hr-pane-text'), 'the comparison');
  }
  t = await deskText(page);
  step('never compared: said plainly, on the page', t.includes('The AI never compared these two pages.') && /It is here because the AI matched it with .*\. That says nothing about claude-opus\. Only your reading decides this one\./.test(t), t.slice(0, 700));
  step('never compared: spoken on arrival', dec(await liveText(page)).includes('The AI never compared these two pages.'));
  await headIntoView(page);
  await shot(app, '8-never-compared');
  await auditWords(app, '8, never compared', seen, known);
  await press(app, '[data-group-key="reviewFamily"] summary');
  await waitFor(page, () => /The AI never compared these with/.test(document.querySelector('.hr-desk').innerText), 'the fold');
  t = await deskText(page);
  step('the fold: three groups, each named', t.includes('The AI never compared these with claude-opus') && t.includes('The AI said these are the same as claude-opus') && t.includes('The AI said these are not the same as claude-opus'), t.slice(-600));
  await auditWords(app, '8, the fold', seen, known);
  await press(app, '[data-group-key="reviewFamily"] summary');
  await waitFor(page, () => !/The AI never compared these with/.test(document.querySelector('.hr-desk').innerText), 'the fold shut');

  // Merge one that was never compared: through the same gate.
  await readUntilOpen(app);
  const neverPage = await page.evaluate(() => document.querySelector('.hr-pane-goes .hr-pane-name').textContent);
  const neverHeld = onDisk(app, neverPage);
  await press(app, '.hr-merge-label');
  await waitFor(page, (p) => !document.querySelector('.hr-pane-goes .hr-pane-name') || document.querySelector('.hr-pane-goes .hr-pane-name').textContent !== p, 'the next page', 400, neverPage);
  step('a never-compared merge reached the disk', onDisk(app, neverPage) === null);
  step('and lost nothing', lostLines(neverHeld, onDisk(app, EIGHT[0])).length === 0);

  // Done: the summary.
  await leave(app);
  await press(app, '#hr-done');
  await waitFor(page, () => /Stays/.test(document.querySelector('.hr-desk').innerText) && /Links pointing to it went/.test(document.querySelector('.hr-desk').innerText), 'the summary');
  t = await deskText(page);
  step('the summary: what stayed and how it grew', /Took in 2 pages\. Links pointing to it went from \d+ to \d+, its text from [\d.]+ (KB|B) to [\d.]+ KB\./.test(t), t.slice(0, 400));
  step('the summary: names a page merged without a comparison', t.includes('You merged 1 page the AI never compared with claude-opus: ' + neverPage + '. Only your reading decided it.'), t.slice(0, 600));
  step('the summary: the pinned note', t.includes('You can undo this in Recent changes for 30 days, on this computer, while the pages stay unchanged.'));
  await headIntoView(page);
  await shot(app, '8-finished');
  await auditWords(app, '8, finished', seen, known);
  // Leaving and coming back.
  await press(app, '#hr-done');
  await waitFor(page, () => !document.querySelector('.hr-desk') && !!document.querySelector('.dm-review-btn'), 'the lanes');
  step('Done: back at the lanes, focus on Review', await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('dm-review-btn')));
  await press(app, '.dm-review-btn');
  await waitFor(page, () => !!document.querySelector('.hr-desk'), 'the desk');
  await toFamily(app, 8);
  await waitFor(page, () => !!document.querySelector('.hr-pane-text'), 'the comparison');
  t = await deskText(page);
  step('coming back: remembered, and it says so', t.includes('You chose claude-opus earlier. 2 merged, 1 kept, 4 left.') || /You chose claude-opus earlier\./.test(t), t.slice(0, 300));
  step('coming back: nothing armed', await page.evaluate(() => document.querySelector('#hr-merge').disabled));

  if (!profile.full) { await press(app, '#hr-done'); await delay(150); await press(app, '#hr-done'); await delay(150); }
  if (profile.reduced) {
    const dur = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--t-layout').trim());
    step("reduced motion: the tokens are zero", /^0(ms|s)?\b/.test(dur), dur);
  }
  if (profile.full) await fullWalks(app, seen, known);
  step('no provider was called', !readFileSync(app.stubLog, 'utf8').includes('blocked'), readFileSync(app.stubLog, 'utf8').slice(0, 200));
  if (WORDS) appendFileSync(WORDS, [...seen].join('\n') + '\n');
}

/** 1280 and 375 only: the long family, the short one to its end, and Keep all apart. */
async function fullWalks(app, seen, known) {
  const { page, profile } = app;
  // 30 pages.
  await press(app, '#hr-done');
  await delay(200);
  if (await page.evaluate(() => /not decided/.test((document.querySelector('.hr-desk') || { innerText: '' }).innerText))) { await press(app, '#hr-done'); await delay(200); }
  await waitFor(page, () => !!document.querySelector('.dm-review-btn'), 'Review');
  await press(app, '.dm-review-btn');
  await waitFor(page, () => !!document.querySelector('.hr-desk'), 'the desk');
  await toFamily(app, 30);
  await waitFor(page, () => /possible pairs/.test(document.querySelector('.hr-desk').innerText), 'the summary');
  let t = await deskText(page);
  step('30: the summary', t.includes('of the 435 possible pairs here.'), t.slice(0, 300));
  step('30: shows 8, offers the rest', (await page.evaluate(() => document.querySelectorAll('[data-fam-pick]').length)) === 8 && t.includes('Show the other 22'));
  const of1 = await noOverflow(page);
  step('30, choosing: nothing pokes out', of1.length === 0, of1.join(' | '));
  await headIntoView(page);
  await shot(app, '30-choose');
  // Find keeps focus while the list changes.
  await page.evaluate(() => document.getElementById('hr-fam-find').focus());
  await page.send('Input.insertText', { text: 'part-28' });
  await delay(150);
  step('30: Find finds, and keeps focus', (await page.evaluate(() => document.activeElement && document.activeElement.id === 'hr-fam-find' && document.querySelectorAll('[data-fam-pick]').length === 1)));
  await page.evaluate(() => { const i = document.getElementById('hr-fam-find'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await delay(100);
  await press(app, '#hr-fam-show');
  await delay(150);
  step('30: Show the other shows them', (await page.evaluate(() => document.querySelectorAll('[data-fam-pick]').length)) === 30);
  await pickPage(app, THIRTY[0]);
  await waitFor(page, () => !!document.querySelector('.hr-pane-text'), 'the comparison');
  t = await deskText(page);
  step('30: the walk', t.includes('Page 1 of 29 · 0 merged · 0 kept · 29 left'), t.slice(0, 200));
  const markBox = await page.evaluate(() => { const m = document.querySelector('.hr-marks'); const d = document.querySelector('.hr-desk'); if (!m) return null; const r = m.getBoundingClientRect(); return { fit: r.right <= d.getBoundingClientRect().right + 1, marks: m.querySelectorAll('.hr-mark').length, spoken: m.getAttribute('aria-label') }; });
  step('30: one mark a page, inside the card, spoken in words', markBox && markBox.fit && markBox.marks === 29 && markBox.spoken === '29 pages to go through: 0 merged, 0 kept, 29 left', JSON.stringify(markBox));
  await headIntoView(page);
  await shot(app, '30-walk-start');
  // Positions across the long names: Keep both on each of six pages, then Merge on two.
  const spots = [];
  const clippedAt = [];
  for (let i = 0; i < 6; i++) {
    await leave(app);
    await waitFor(page, () => !!document.querySelector('.hr-pane-text'), 'the comparison');
    await headIntoView(page);
    // The fold's row settles after the one move from choosing to walking; from then on nothing may.
    await delay(i === 0 ? 500 : 60);
    spots.push(await page.evaluate(POSITIONS));
    const cut = await clipped(page);
    if (cut.length) clippedAt.push(cut.join(', '));
    await page.evaluate(() => { document.querySelector('#hr-keep').click(); });
    await waitFor(page, (n) => new RegExp('· ' + n + ' kept').test(document.querySelector('.hr-desk').innerText), 'the next page', 400, i + 1);
  }
  step('30: long names: every name and the warning are whole, nothing cut off', clippedAt.length === 0, clippedAt.join(' | '));
  const allMoved = spots.slice(1).flatMap((s) => sameSpots(spots[0], s));
  step('30: long names and short, six decisions: no button moved', allMoved.length === 0, allMoved.join(', '));
  const of2 = await noOverflow(page);
  step('30, walking: nothing pokes out', of2.length === 0, of2.join(' | '));
  await headIntoView(page);
  await shot(app, '30-walk-mid');
  await auditWords(app, '30, walking', seen, known);
  await press(app, '#hr-done');
  await waitFor(page, () => /pages not decided/.test(document.querySelector('.hr-desk').innerText), 'the summary');
  await headIntoView(page);
  await shot(app, '30-finished');
  t = await deskText(page);
  step('30: stop any time: the rest are not decided, and nothing happened to them', t.includes('23 pages not decided') && t.includes('Go back to them') && t.includes('Nothing was merged into it.'), t.slice(0, 300));
  await auditWords(app, '30, finished', seen, known);
  step('30: leftovers offered', /pages left over still match one another/.test(t), t.slice(-400));
  await press(app, '#hr-done');
  await waitFor(page, () => !!document.querySelector('.dm-review-btn'), 'Review');

  // The family of 3, to its end, by real merges, with a bridge. Then its leftovers.
  await press(app, '.dm-review-btn');
  await waitFor(page, () => !!document.querySelector('.hr-desk'), 'the desk');
  await toFamily(app, 3, THREE[0]);
  await waitFor(page, () => /possible pairs/.test(document.querySelector('.hr-desk').innerText), 'the summary');
  await headIntoView(page);
  await shot(app, '3-choose');
  await auditWords(app, '3, choosing', seen, known);
  const held = Object.fromEntries(THREE.map((s) => [s, onDisk(app, s)]));
  await pickPage(app, THREE[0]);
  await waitFor(page, () => !!document.querySelector('.hr-pane-text'), 'the comparison');
  t = await deskText(page);
  step('3: same first', /Merge data-privacy into privacy-and-data-protection/.test(t), t.slice(0, 300));
  await headIntoView(page);
  await shot(app, '3-walk');
  await readUntilOpen(app);
  await press(app, '.hr-merge-label');
  await waitFor(page, () => /Page 2 of 2/.test(document.querySelector('.hr-desk').innerText), 'the bridge page');
  await waitFor(page, () => !!document.querySelector('.hr-pane-text'), 'the comparison');
  t = await deskText(page);
  step('3: the bridge merged, the page it bridged is still here and still never compared', t.includes('The AI never compared these two pages.') && t.includes(', which you have since merged in. That says nothing about privacy-and-data-protection. Only your reading decides this one.'), t.slice(0, 600));
  await readUntilOpen(app);
  await press(app, '.hr-merge-label');
  await waitFor(page, () => /All decided/.test(document.querySelector('.hr-desk').innerText), 'the end');
  await waitFor(page, () => /Links pointing to it went/.test(document.querySelector('.hr-desk').innerText), 'the figures');
  const final = onDisk(app, THREE[0]);
  step('3: both pages gone from disk', onDisk(app, THREE[1]) === null && onDisk(app, THREE[2]) === null);
  const lost = [...lostLines(held[THREE[0]], final), ...lostLines(held[THREE[1]], final), ...lostLines(held[THREE[2]], final)];
  step('3: every line of all three pages is on the kept page', lost.length === 0, lost.join(' | '));
  const summ = readFileSync(path.join(app.wiki, 'summaries', 'a-source.md'), 'utf8');
  step('3: links moved', !summ.includes('[[data-privacy]]') && summ.includes('[[privacy-and-data-protection]]'), summ);
  await headIntoView(page);
  await shot(app, '3-finished');
  await auditWords(app, '3, finished', seen, known);
  await press(app, '#hr-done');
  await waitFor(page, () => !!document.querySelector('.dm-review-btn'), 'Review');

  // A plain pair still gets the plain desk.
  await press(app, '.dm-review-btn');
  await waitFor(page, () => !!document.querySelector('.hr-desk'), 'the desk');
  for (let i = 0; i < 6 && !/Pair \d+ of \d+/.test(await deskText(page)); i++) { await press(app, '#hr-next'); await delay(250); }
  t = await deskText(page);
  step('a pair in no family keeps the plain desk', /Pair \d+ of 2/.test(t) && /Merge into /.test(t), t.slice(0, 200));
  await headIntoView(page);
  await shot(app, 'pair-desk');
  await auditWords(app, 'the plain pair', seen, known);
  await page.evaluate(() => { const s = document.querySelector('[data-group-key="reviewPairs"] summary'); if (s) s.click(); });
  await delay(100);
  await auditWords(app, 'the list of decisions', seen, known);
  await page.evaluate(() => { const s = document.querySelector('[data-group-key="reviewPairs"] summary'); if (s) s.click(); });

  // A page whose only pair a merge closes: named by nothing, and it must not vanish at a reload.
  await toFamily(app, 3, 'lone-a');
  await waitFor(page, () => /possible pairs/.test(document.querySelector('.hr-desk').innerText), 'the summary');
  await pickPage(app, 'lone-a');
  await readUntilOpen(app);
  await press(app, '.hr-merge-label');
  await waitFor(page, () => /Page 2 of 2/.test(document.querySelector('.hr-desk').innerText), 'the page still waiting');
  await press(app, '#hr-done');
  await waitFor(page, () => /1 page not decided/.test(document.querySelector('.hr-desk').innerText), 'the summary');
  await press(app, '#hr-done');
  await waitFor(page, () => !!document.querySelector('.dm-review-btn'), 'Review');

  // The leftovers of the 8: a smaller family, with its facts read afresh.
  await press(app, '.dm-review-btn');
  await waitFor(page, () => !!document.querySelector('.hr-desk'), 'the desk');
  await toFamily(app, 8);
  await press(app, '#hr-done');
  // Its figures land just after it opens, and the sentence can then take another line.
  await waitFor(page, () => /Review those|Review the first/.test(document.querySelector('.hr-desk').innerText) && /Links pointing to it went/.test(document.querySelector('.hr-desk').innerText), 'the leftovers');
  await delay(100);
  await press(app, '#hr-fam-residue');
  await waitFor(page, () => /Which page stays\?/.test(document.querySelector('.hr-desk').innerText) && /possible pairs/.test(document.querySelector('.hr-desk').innerText), 'a smaller family');
  t = await deskText(page);
  step('leftovers: a smaller family, from the start', /Family of [34] pages/.test(t), t.slice(0, 200));
  await headIntoView(page);
  await shot(app, 'leftovers');
  await auditWords(app, 'leftovers', seen, known);

  // Keep all apart, on the 30, then Undo. It is under way, so back to the start of a fresh one.
  await press(app, '#hr-done');
  await waitFor(page, () => !document.querySelector('.hr-desk'), 'the lanes');
  await delay(600);
  await openDomain(app, { reload: true });
  await waitFor(page, () => !!document.querySelector('.dm-review-btn'), 'Review', 600);
  await press(app, '.dm-review-btn');
  await waitFor(page, () => !!document.querySelector('.hr-desk'), 'the desk');
  await toFamily(app, 2, 'lone-a');
  await waitFor(page, () => /You chose lone-a earlier\. 1 page is still waiting\./.test(document.querySelector('.hr-desk').innerText), 'the walk back after a reload');
  t = await deskText(page);
  step('after a reload a page no pair names comes back in its walk, and says so', t.includes('Merge lone-c into lone-a') && t.includes('Page 1 of 1'), t.slice(0, 300));
  step('and nothing claims the match it no longer has', t.includes('The AI never compared these two pages.') && t.includes('Only your reading decides this one.') && !t.includes('since merged'), t.slice(0, 500));
  await press(app, '#hr-done');
  await delay(250);
  await toFamily(app, 30);
  await waitFor(page, () => /You chose search-engine-history earlier/.test(document.querySelector('.hr-desk').innerText), 'the long walk back');
  await press(app, '#hr-fam-rechoose');
  await delay(200);
  const reachedFamily = /Which page stays\?/.test(await deskText(page));
  step('a walk with no merge yet: Choose again still works after a reload', reachedFamily, (await deskText(page)).slice(0, 200));
  if (reachedFamily) {
    await waitFor(page, () => /possible pairs/.test(document.querySelector('.hr-desk').innerText), 'the summary');
    const before = existsSync(path.join(app.wiki, '.health-dismissed.jsonl')) ? readFileSync(path.join(app.wiki, '.health-dismissed.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
    const beforePages = THIRTY.filter((s) => onDisk(app, s) !== null).length;
    await press(app, '#hr-fam-apart');
    await waitFor(page, () => /pages apart\. They will not come back\./.test(document.querySelector('.hr-desk').innerText), 'kept apart', 800);
    t = await deskText(page);
    step('Keep all apart: the sentence, with Undo', /Kept these \d+ pages apart\. They will not come back\. Pairs the AI has not compared may still come up later\. Undo/.test(t), t.slice(-400));
    const nowRecords = readFileSync(path.join(app.wiki, '.health-dismissed.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    step('Keep all apart: recorded on disk, one per pair', nowRecords > before, nowRecords + ' vs ' + before);
    step('Keep all apart: no page deleted', THIRTY.filter((s) => onDisk(app, s) !== null).length === beforePages);
    await auditWords(app, 'kept all apart', seen, known);
    await press(app, '#hr-undo');
    await waitFor(page, () => /Brought back\./.test(document.querySelector('.hr-desk').innerText), 'brought back', 800);
    const afterUndo = readFileSync(path.join(app.wiki, '.health-dismissed.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    step('Undo: the records are gone again', afterUndo === before, afterUndo + ' vs ' + before);
    step('Undo: the family is back', (await deskText(page)).includes('Which page stays?'));
  }
  void profile;
}

const hasBrowser = (() => { try { return !!findBrowser(); } catch { return false; } })();
if (!hasBrowser) { console.log('No browser installed: skipping.'); process.exit(0); }
if (WORDS) writeFileSync(WORDS, '');
for (const profile of PROFILES) {
  const app = await startApp(profile);
  try { await walk(app); } catch (err) { step('the walk ran to its end', false, err.stack); } finally { await app.stop(); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
