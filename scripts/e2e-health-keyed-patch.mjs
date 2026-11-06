#!/usr/bin/env node
/**
 * Wiki health keeps its nodes across a paint: the browser half.
 * LIVE_LOCAL: it needs a browser, not a key, and self-skips at exit 0 without one.
 *
 * Real Chrome over CDP, real mouse events at viewport coordinates, the real
 * server on an isolated workspace with a fake HOME. The model is stubbed
 * (test-helpers/health-model-stub.mjs): no provider call is possible, and the
 * stub's refusal log is asserted empty.
 *
 * The offline half, scripts/test-next-health-morph.js, holds the matching logic.
 * This holds what only a browser can say: node identity through real paints,
 * focus through a real focus fixup, real clicks on a disabled button, the real
 * `toggle` event, and exactly one request per press through
 * every action in the section.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser, findBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg + (detail ? ' — ' + String(detail).slice(0, 160) : '')); }
  else { failed++; console.log('  ✗ FAILED: ' + msg + (detail !== undefined ? ' — ' + String(detail).slice(0, 500) : '')); }
}
const section = (t) => console.log('\n' + t);

if (!findBrowser()) {
  console.log('⊘ e2e-health-keyed-patch: no Chrome / Chromium / Edge found — skipped (it needs a real browser).');
  process.exit(0);
}

// ── The real files, fingerprinted ──────────────────────────────────────────
const REAL = [path.join(REPO, '.curator-config.json'), path.join(os.homedir(), 'Library/Application Support/The Curator/.curator-config.json')];
const fingerprint = () => REAL.map((f) => { try { const b = readFileSync(f); return createHash('sha256').update(b).digest('hex') + ' ' + b.length; } catch { return 'absent'; } }).join('|');
const before = fingerprint();

// ── The isolated world ─────────────────────────────────────────────────────
const base = mkdtempSync(path.join(os.tmpdir(), 'curator-e2e-health-'));
const ws = { domains: path.join(base, 'domains'), userData: path.join(base, 'userdata'), home: path.join(base, 'home') };
mkdirSync(ws.home); mkdirSync(ws.userData, { recursive: true });
execFileSync(process.execPath, [path.join(REPO, 'scripts/demo-domain.mjs'), ws.domains], {
  cwd: REPO, stdio: 'ignore', env: { ...process.env, HOME: ws.home, CURATOR_TEST_DOMAINS_DIR: ws.domains, CURATOR_TEST_USER_DATA_DIR: ws.userData },
});
const WORDS = ['ledger', 'quorum', 'tidal', 'sonar', 'prism', 'cobalt', 'meridian', 'harbor', 'lattice', 'ember', 'vector', 'glacier', 'orbit', 'canopy', 'saffron', 'basalt', 'quartz', 'willow', 'falcon', 'marble', 'onyx', 'juniper', 'aurora', 'cedar', 'delta', 'fjord', 'gantry', 'hollow', 'indigo', 'jasper', 'kelvin', 'lumen', 'mosaic', 'nimbus', 'opal', 'pylon', 'quill', 'rivet', 'summit', 'thistle', 'umbra', 'vellum', 'wharf', 'xenon', 'yarrow', 'zephyr', 'anvil', 'beacon', 'cinder', 'dune'];
function buildDomain(name, { readonly = false } = {}) {
  const w = path.join(ws.domains, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(w, f), { recursive: true });
  writeFileSync(path.join(ws.domains, name, 'CLAUDE.md'), readonly ? '---\nreadonly: true\n---\n# ' + name + '\n' : '# ' + name + '\n');
  const page = (t, opening) => `---\ntype: concept\ntags: [type/concept]\n---\n\n# ${t}\n\n${opening}\n\n## Key Facts\n\n- A fact recorded about ${t}.\n\n## Related\n\n- [[wiki-hub]]\n`;
  const linked = [];
  const concept = (s, opening) => writeFileSync(path.join(w, 'concepts', s + '.md'), page(s, opening || 'Notes about ' + s + '.'));
  // 60 topic pairs, past the 50-card page, so Show more is real.
  for (let i = 0; i < 60; i++) {
    const a = WORDS[i % WORDS.length] + (i >= WORDS.length ? '-two' : '') + '-method';
    concept(a); concept(a + '-notes'); linked.push(a, a + '-notes');
  }
  // Spelling variants, for the batch.
  for (const [a, b] of [['hand-off', 'handoff'], ['e-mail', 'email'], ['open-ai', 'openai']]) { concept(a); concept(b); linked.push(a, b); }
  // One name in two folders, for the Fix all that deletes a page and so still asks.
  concept('shared-name'); linked.push('shared-name');
  writeFileSync(path.join(w, 'entities', 'shared-name.md'), '---\ntype: entity\n---\n\n# Shared name\n\nA company.\n\n## Related\n\n- [[wiki-hub]]\n');
  // Pages nothing links to, for Dismiss and Rescue.
  const orphans = ['stray-one', 'stray-two', 'stray-three', 'stray-four'];
  for (const s of orphans) writeFileSync(path.join(w, 'concepts', s + '.md'), `---\ntype: concept\n---\n\n# ${s}\n\nAlone.\n\n## Key Facts\n\n- A fact about ${s}.\n`);
  writeFileSync(path.join(w, 'concepts', 'wiki-hub.md'), `---\ntype: concept\n---\n\n# Hub\n\nAn index page.\n\n## Related\n\n${linked.map((s) => `- [[${s}]]`).join('\n')}\n- [[concepts/wiki-hub]]\n- [[nowhere-at-all]]\n- [[ledger-methodd]]\n`);
  writeFileSync(path.join(w, 'summaries', 'a-summary.md'), `---\ntype: summary\n---\n\n# A summary\n\nA summary.\n\n## Key Takeaways\n\n- One point.\n\n## Concepts Introduced or Referenced\n\n- [[wiki-hub]]\n- [[wiki-hub]]\n`);
  writeFileSync(path.join(w, 'index.md'), `# Wiki Index — ${name}\n\n| Page | Summary |\n|---|---|\n| [[wiki-hub]] | hub |\n`);
  writeFileSync(path.join(w, 'log.md'), '# Log\n');
}
for (const d of ['alpha', 'beta', 'gamma']) buildDomain(d);
buildDomain('mirror', { readonly: true });
writeFileSync(path.join(ws.userData, '.curator-config.json'), JSON.stringify({
  activeProvider: 'gemini', domainsPath: ws.domains, geminiApiKey: 'AIza-E2E-FAKE-KEY-not-a-credential',
  aiHealth: { semanticDupeMaxPairs: 500, costCeilingTokens: 2000000 },
}, null, 2), { mode: 0o600 });
const stubLog = path.join(base, 'stub.log');
writeFileSync(stubLog, '');

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const env = { ...process.env };
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'DOMAINS_PATH', 'LLM_MODEL']) delete env[k];
Object.assign(env, { PORT: String(port), CURATOR_NO_OPEN: '1', HOME: ws.home, CURATOR_TEST_USER_DATA_DIR: ws.userData, CURATOR_TEST_DOMAINS_DIR: ws.domains, HEALTH_STUB_LOG: stubLog });
const child = spawn(process.execPath, ['--import', path.join(REPO, 'scripts/test-helpers/health-model-stub.mjs'), path.join(REPO, 'src/server.js')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  await page.setViewport(1280, 900, 1);
  const exceptions = [];
  const warnings = [];
  await page.send('Runtime.enable');
  conn.on(page.sessionId, 'Runtime.exceptionThrown', (p) => exceptions.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  conn.on(page.sessionId, 'Runtime.consoleAPICalled', (p) => { if (p.type === 'warning') warnings.push(p.args.map((a) => a.value || a.description).join(' ')); });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const f = window.fetch; window.__reqs = [];
    window.fetch = (...a) => { const o = a[1] || {}; window.__reqs.push({ m: o.method || 'GET', u: typeof a[0] === 'string' ? a[0] : a[0].url, b: typeof o.body === 'string' ? o.body : '' }); return f(...a); };
  })();` });

  const openDomain = async (slug) => {
    await page.navigate(origin + '/api/version');
    await page.evaluate(() => {
      localStorage.setItem('curator-next-theme', 'dark'); localStorage.setItem('curator-next-view', 'domains');
      localStorage.setItem('curator-next-onboarding-dismissed-v1', '1'); localStorage.setItem('curator-ai-health-disclosure-seen-v1', 'yes');
      sessionStorage.setItem('curator-next-instance-banner-dismissed-v1', '1');
    });
    await page.navigate(origin);
    for (let i = 0; i < 100 && !(await page.evaluate(() => !!window.__curatorBooted)); i++) await delay(100);
    await page.evaluate(() => document.querySelector('#rail .rail-btn[data-view="domains"]').click());
    await delay(400);
    await pick(slug);
  };
  const pick = async (slug) => {
    await page.evaluate((s) => { [...document.querySelectorAll('.dm-row[data-domain-slug]')].find((n) => n.dataset.domainSlug === s).click(); }, slug);
    await delay(150);
    await quiet();
  };
  const quiet = async (max = 60000) => {
    let last = ''; let same = 0; const t0 = Date.now();
    while (Date.now() - t0 < max) {
      const cur = await page.evaluate(() => { const s = document.querySelector('.dm-health'); if (!s) return 'BUSY'; const h = s.outerHTML; return (/dm-btn-ring|dm-ai-progress|Counting the pairs|Scanning…/.test(h) ? 'BUSY' : '') + h; });
      if (cur === last && !cur.startsWith('BUSY')) { if (++same >= 6) return true; } else same = 0;
      last = cur; await delay(100);
    }
    throw new Error('the section never settled');
  };
  const place = (sel, y = 320) => page.evaluate((s, yy) => { const e = document.querySelector(s); const m = document.getElementById('main'); m.scrollTop += e.getBoundingClientRect().top - yy; }, sel, y);
  // A real press at the element's own coordinates.
  const press = async (sel, { y, settle = true, at } = {}) => {
    if (!(await page.evaluate((s) => !!document.querySelector(s), sel))) throw new Error('no target: ' + sel);
    await place(sel, y); await delay(60);
    const r = await page.evaluate((s, a) => { const n = a ? document.querySelector(s).querySelector(a) : document.querySelector(s); const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel, at || null);
    await page.evaluate(() => { window.__reqs.length = 0; });
    await page.click(r.x, r.y, { settleMs: 30 });
    if (settle) await quiet();
  };
  const reqs = (re, method) => page.evaluate((src, m) => window.__reqs.filter((q) => new RegExp(src).test(q.u) && (!m || q.m === m)), re.source, method || null);
  const mark = () => page.evaluate(() => { const s = document.querySelector('.dm-health'); s.__mark = 1; s.querySelectorAll('*').forEach((n) => { n.__mark = 1; }); });
  const kept = () => page.evaluate(() => { const s = document.querySelector('.dm-health'); const all = [...s.querySelectorAll('*')]; return { section: !!s.__mark, nodes: all.filter((n) => n.__mark).length, total: all.length }; });
  const focus = () => page.evaluate(() => { const a = document.activeElement; return a === document.body || !a ? 'BODY' : (a.id || (a.innerText || '').trim().slice(0, 30)); });
  const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText || null, sel);

  section('§1 The patch, on the real DOM: random trees to random trees');
  await openDomain('alpha');
  const morphUrl = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).find((n) => /shared\/morph\.js/.test(n)));
  ok(!!morphUrl, 'shared/morph.js is loaded by the running page');
  const fuzz = await page.evaluate(async (url) => {
    const { patchInPlace } = await import(url);
    let x = 987654; const rnd = (n) => { x = (x * 1664525 + 1013904223) >>> 0; return x % n; };
    const TAGS = ['div', 'span', 'button', 'details', 'summary', 'p', 'ul', 'li', 'section', 'input'];
    let ids = 0;
    const gen = (d) => {
      const t = TAGS[rnd(TAGS.length)];
      let at = '';
      if (rnd(3) === 0) at += ' class="' + ['row', 'card a', 'row b', 'x'][rnd(4)] + '"';
      if (rnd(4) === 0) at += ' id="i' + (ids++ % 7) + '"';
      if (t === 'details' && rnd(2)) at += ' open';
      if (t === 'button' && rnd(3) === 0) at += ' disabled';
      if (t === 'input') return '<input' + at + ' value="v' + rnd(3) + '">';
      const inner = d > 3 ? '' : Array.from({ length: rnd(5) }, () => (rnd(3) === 0 ? 'text ' + rnd(4) + ' ' : rnd(9) === 0 ? '<svg viewBox="0 0 2 2"><path d="M0 0"></path></svg>' : gen(d + 1))).join('');
      return '<' + t + at + '>' + inner + '</' + t + '>';
    };
    const parse = (html) => { const t = document.createElement('div'); t.innerHTML = html; return t; };
    // The dumb reading: a serialiser of its own, so the patch's isEqualNode is not marking its own work.
    const canon = (n) => (n.nodeType === 3 ? JSON.stringify(n.nodeValue)
      : '<' + n.nodeName + ' ' + [...n.attributes].map((a) => a.name + '=' + a.value).sort().join(' ') + '>' + [...n.childNodes].map(canon).join('') + '</>');
    const host = document.createElement('div'); document.body.appendChild(host);
    let bad = 0; let falsy = 0; let n = 0; let identity = 0; let first = null;
    for (let i = 0; i < 600; i++) {
      ids = 0;
      const live = parse(gen(0) + gen(0));
      host.replaceChildren(live);
      const next = parse(gen(0) + gen(0));
      const snap = next.innerHTML;
      n++;
      const r = patchInPlace(live, next);
      if (r !== true) falsy++;
      if (next.innerHTML !== snap || canon(live) !== canon(parse(snap))) { bad++; first = first || [canon(live), snap]; }
    }
    // A row leaving keeps the rest of the rows, on the real DOM.
    const rows = (names) => parse(names.map((s) => '<div class="row"><span>' + s + '</span></div>').join(''));
    const live = rows(['a', 'b', 'c', 'd']); host.replaceChildren(live);
    const [a, , c, d] = [...live.children];
    patchInPlace(live, rows(['a', 'c', 'd']));
    if (live.children[0] === a && live.children[1] === c && live.children[2] === d) identity = 1;
    host.remove();
    return { n, bad, falsy, identity, first };
  }, morphUrl);
  ok(fuzz.bad === 0, fuzz.n + ' random pairs end equal to the target', JSON.stringify(fuzz.first));
  ok(fuzz.falsy === 0, 'and every one reported true', fuzz.falsy);
  ok(fuzz.identity === 1, 'a row leaving keeps the rows after it as the same nodes');

  section('§2 Nodes and focus across real paints');
  await page.evaluate(() => { const d = document.querySelector('.dm-health [data-group-key="orphans"]'); d.open = true; });
  await delay(150);
  await mark();
  await press('#dm-rescan-btn');
  let k = await kept();
  ok(k.section, 'Rescan: the section is the same node');
  ok(k.nodes >= k.total * 0.9, 'and nearly everything in it', k.nodes + ' of ' + k.total);
  ok((await focus()) === 'dm-rescan-btn', 'and focus is back on Rescan after it was disabled while it ran', await focus());
  ok(await page.evaluate(() => document.querySelector('.dm-health [data-group-key="orphans"]').open), 'an open fold stays open through a rescan');
  ok((await reqs(/\/api\/health\/alpha(\?|$)/, 'GET')).length === 1, 'one press, one scan');

  await mark();
  // A Fix all that deletes pages still asks; a free one runs on the press (the press
  // rule, owner's decision 2026-11-05). So the question is asked here of the former.
  const askFA = '[data-group-key="crossFolderDupes"] .dm-group-fixall-btn';
  const canAsk = await page.evaluate((s) => !!document.querySelector(s), askFA);
  ok(canAsk, 'this wiki has a Fix all that deletes pages, to ask about');
  const foldOpenBefore = await page.evaluate((s) => document.querySelector(s).closest('details').open, askFA);
  await press(askFA, { y: 500 });
  await delay(300);
  k = await kept();
  ok(k.section && !!(await text('.dm-confirm-card')), 'a deleting Fix all: the question opens, nothing was replaced');
  ok((await focus()) === 'dm-confirm-no', 'focus moves into it, onto Cancel, so a held Enter cannot answer it', await focus());
  ok(await page.evaluate((s, o) => document.querySelector(s).closest('details').open === o, askFA, foldOpenBefore), 'the press did not toggle the fold it sits in');
  await press('#dm-confirm-no');
  await delay(400);
  ok(!(await text('.dm-confirm-card')), 'Cancel closes it');
  ok(await page.evaluate((s) => document.querySelector(s) === document.activeElement, askFA), 'and focus returns to the Fix all that asked');

  section('§3 One press is one request, after many paints');
  await press(askFA, { y: 500 });
  await delay(300);
  await press('#dm-confirm-yes');
  await delay(1600);
  ok((await reqs(/\/api\/health\/alpha\/fix$/, 'POST')).length === 1, 'a deleting Fix all, answered, after many paints of the same section: exactly one POST', JSON.stringify(await reqs(/\/fix$/)));
  const FA = '[data-group-key="missingBacklinks"] .dm-group-fixall-btn';
  if (await page.evaluate((s) => !!document.querySelector(s), FA)) {
    await press(FA, { y: 500 });
    await delay(1600);
    ok((await reqs(/\/api\/health\/alpha\/fix$/, 'POST')).length === 1, 'a free Fix all: one press, one POST, no question');
  }
  if (await page.evaluate(() => !!document.getElementById('dm-repair-all-btn'))) {
    await press('#dm-repair-all-btn');
    ok(!(await page.evaluate(() => !!document.getElementById('dm-confirm-yes'))), 'Repair all asks nothing');
    await delay(1600);
    const sent = await reqs(/\/api\/health\/alpha\/fix$/, 'POST');
    ok(sent.length >= 2 && sent.length <= 4, 'Repair all: one POST per free row', JSON.stringify(sent));
  }
  ok((await reqs(/\/fix-all-safe$/, 'POST')).length === 0, 'and the route that also deletes is never called');
  ok((await kept()).section, 'and the section survived all of it');

  // Compare wears its cost, and waits for it: the row has to be on screen first.
  const compareReady = async () => {
    await place('[data-group-key="compare"]');
    for (let i = 0; i < 400 && await page.evaluate(() => { const b = document.querySelector('.dm-quick-btn[data-action="semanticDupes"]'); return !b || b.disabled; }); i++) await delay(50);
    await delay(100);
  };
  section('§4 A press inside a disabled button');
  await compareReady();
  const control = await page.evaluate(() => {
    const b = document.querySelector('.dm-quick-btn[data-action="semanticDupes"]');
    const svg = b.querySelector('svg');
    b.disabled = true;
    window.__sawPress = 0;
    document.querySelector('.dm-health').addEventListener('click', () => { window.__sawPress++; }, { once: true });
    return !!svg;
  });
  ok(control, 'the button has an icon inside it to press');
  await press('.dm-quick-btn[data-action="semanticDupes"]', { at: 'svg', settle: false });
  await delay(250);
  const saw = await page.evaluate(() => window.__sawPress);
  console.log('    (a real click reached the section ' + saw + ' time(s) in this browser)');
  ok(!(await text('.dm-confirm-card')), 'a real click on its icon opens nothing');
  ok((await reqs(/semantic-dupes/)).length === 0, 'and sends nothing');
  // A click that does get through to the delegate: the control proves it arrived.
  const scripted = await page.evaluate(() => {
    window.__sawPress = 0;
    document.querySelector('.dm-health').addEventListener('click', () => { window.__sawPress++; }, { once: true });
    document.querySelector('.dm-quick-btn[data-action="semanticDupes"] svg').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return window.__sawPress;
  });
  ok(scripted >= 1, 'a scripted click on the icon does reach the section (the control)');
  await delay(250);
  ok(!(await text('.dm-confirm-card')), 'and the delegate still does nothing, because the button is disabled');
  await page.evaluate(() => { document.querySelector('.dm-quick-btn[data-action="semanticDupes"]').disabled = false; });

  section('§5 Duplicates: every action, once');
  await compareReady();
  await press('.dm-quick-btn[data-action="semanticDupes"]');
  await press('#dm-confirm-yes');
  ok((await reqs(/semantic-dupes\/scan/, 'POST')).length === 1, 'Compare the next: one run');
  await mark();
  await press('.dm-review-btn');
  ok(await page.evaluate(() => !!document.querySelector('.hr-desk')), 'Review opens the desk');
  ok((await kept()).section, 'in the same section');
  ok((await focus()) === 'hr-title', 'focus lands on the pair title', await focus());
  await delay(50);
  ok(await page.evaluate(() => document.getElementById('hr-merge').disabled), 'Merge is shut on arrival');
  await press('#hr-merge', { settle: false }); await delay(100);
  ok((await reqs(/\/api\/health\/alpha\/fix$/)).length === 0, 'and a press on it sends nothing');
  const armed = async () => { for (let i = 0; i < 200; i++) { if (await page.evaluate(() => { const m = document.getElementById('hr-merge'); return !!m && !m.disabled; })) return true; await delay(25); } return false; };
  ok(await armed(), 'the comparison, seen for 500 ms, opens the gate');
  ok((await reqs(/semantic-dupes\/preview/, 'POST')).length === 1, 'one comparison: one request');

  // Reported, not asserted: a timing here would be a flake. On this size of list
  // a paint must stay far under a frame's worth of a press's feedback.
  const cost = await page.evaluate(async (url) => {
    const { patchInPlace } = await import(url);
    const sec = document.querySelector('.dm-health');
    const a = sec.cloneNode(true); const b = sec.cloneNode(true);
    b.querySelector('.hr-pane-goes').remove();
    const host = document.createElement('div'); host.style.display = 'none'; host.appendChild(a); document.body.appendChild(host);
    const t0 = performance.now(); patchInPlace(a, b); const ms = performance.now() - t0;
    host.remove();
    return { ms: Math.round(ms * 10) / 10, nodes: sec.querySelectorAll('*').length };
  }, morphUrl);
  console.log('    (patching ' + cost.nodes + ' nodes took ' + cost.ms + ' ms)');

  const nameOf = (side) => text('.hr-pane-' + side + ' .hr-pane-name');
  const before = await nameOf('stays');
  await page.evaluate(() => { document.getElementById('hr-flip').__flipBtn = 1; });
  await press('#hr-flip');
  ok((await focus()) === 'hr-flip', 'Keep this one instead keeps focus', await focus());
  ok(await page.evaluate(() => document.getElementById('hr-flip').__flipBtn === 1), 'and is the same button');
  ok((await nameOf('goes')) === before, 'the pair now reads the other way round');
  ok(await page.evaluate(() => document.getElementById('hr-merge').disabled), 'and the gate closed again');
  ok(await armed(), 'and opens again, for this direction');
  const stays = await nameOf('stays'); const goes = await nameOf('goes');
  await press('#hr-merge', { y: 600 });
  const merges = await reqs(/\/api\/health\/alpha\/fix$/, 'POST');
  ok(merges.length === 1, 'Merge: exactly one POST', merges.length);
  ok(merges[0] && merges[0].b.includes(stays) && /"basis":"[0-9a-f]+"/.test(merges[0].b), 'and it merges in the direction on screen, with its basis');
  const fileOf = async (name) => { for (const f of ['concepts', 'entities']) if (existsSync(path.join(ws.domains, 'alpha/wiki', f, name + '.md'))) return true; return false; };
  ok(!(await fileOf(goes)), 'the page it said it deletes is gone');
  ok(await fileOf(stays), 'the page it said it keeps is there');
  ok((await kept()).section, 'and the section survived all of it');
  ok((await focus()) === 'hr-title', 'focus goes to the pair title', await focus());
  await armed();
  await press('#hr-keep');
  ok((await reqs(/\/dismiss$/, 'POST')).length === 1, 'Keep both: one POST');
  await armed();
  await press('#hr-done');
  ok(await page.evaluate(() => !document.querySelector('.hr-desk') && document.querySelectorAll('.dm-lane').length > 0), 'Done: back to the lanes');
  await delay(600);
  await press('#dm-semantic-merge-btn');
  await press('#dm-confirm-yes');
  ok((await reqs(/merge-batch/, 'POST')).length === 1, 'Merge N spelling variants: one POST');
  await delay(600);
  if (await page.evaluate(() => !!document.querySelector('.dm-quick-btn[data-action="semanticDupes"]'))) {
    await compareReady();
    await press('.dm-quick-btn[data-action="semanticDupes"]');
    ok(!!(await text('.dm-confirm-card')), 'Compare the next opens its confirm');
    await press('#dm-confirm-no');
  }
  // Surviving nodes hand the browser's scroll anchoring something to hold. This
  // press sits under the list and the confirm opens above it, so with anchoring
  // on, the browser moves scrollTop and carries the confirm further off screen.
  await page.evaluate(() => { document.querySelector('[data-group-key="compare"]').open = true; }); await delay(150);
  await place('#dm-semantic-reset-btn'); await delay(60);
  const scrollBefore = await page.evaluate(() => document.getElementById('main').scrollTop);
  await press('#dm-semantic-reset-btn');
  const scrollAfter = await page.evaluate(() => document.getElementById('main').scrollTop);
  ok(Math.abs(scrollAfter - scrollBefore) <= 1, 'a confirm opening above the press leaves scrollTop alone', scrollAfter + ' from ' + scrollBefore);
  ok(!!(await text('.dm-confirm-card')), 'Forget all comparisons opens its confirm');
  await press('#dm-confirm-yes');
  ok((await reqs(/semantic-dupes\/forget/, 'POST')).length === 1, 'and its Confirm sends one forget');

  section('§6 Rows and plans');
  await pick('beta');
  await page.evaluate(() => { document.querySelector('.dm-health [data-group-key="orphans"]').open = true; });
  await delay(150);
  const rowsBefore = await page.evaluate(() => document.querySelectorAll('[data-group-key="orphans"] .dm-issue-row').length);
  await mark();
  await press('[data-group-key="orphans"] .dm-issue-row:nth-child(2) .dm-dismiss-btn', { y: 450 });
  ok((await reqs(/\/dismiss$/, 'POST')).length === 1, 'Leave as is: one POST');
  await delay(1600);
  ok(await page.evaluate((n) => document.querySelectorAll('[data-group-key="orphans"] .dm-issue-row').length === n && !!document.querySelector('.dm-left-undo-btn'), rowsBefore), 'the row stays in place, with Undo');
  ok(await page.evaluate(() => { const rows = [...document.querySelectorAll('[data-group-key="orphans"] .dm-issue-row')]; return rows.length > 0 && rows.every((r) => r.__mark === 1); }), 'and the other rows are the same nodes');
  await press('[data-group-key="dismissed"] > summary');
  ok(!!(await page.evaluate(() => document.querySelector('.dm-restore-btn'))), 'opening Left as is, with a real press, loads its list');
  await press('.dm-restore-btn', { y: 500 });
  ok((await reqs(/\/undismiss$/, 'POST')).length === 1, 'Bring back: one POST');
  await press('.dm-quick-btn[data-action="orphans"]');
  await press('#dm-confirm-yes');
  ok((await reqs(/orphans\/plan/, 'POST')).length === 1, 'Rescue: one plan');
  await press('#dm-plan-discard-btn');
  ok(!(await text('.dm-plan-card')), 'Discard closes the plan');
  await press('.dm-quick-btn[data-action="orphans"]');
  await press('#dm-confirm-yes');
  await press('#dm-plan-apply-btn');
  ok((await reqs(/orphans\/apply/, 'POST')).length === 1, 'Apply this plan: one POST');
  await press('.dm-quick-btn[data-action="indexPlan"]');
  ok((await reqs(/index\/plan/, 'POST')).length === 1, 'Rebuild index: one plan');
  await press('#dm-plan-apply-btn');
  ok((await reqs(/index\/apply/, 'POST')).length === 1, 'and one apply');

  section('§7 Folds, with real presses');
  const foldSel = 'details[data-group-key="brokenLinksOpen"], details[data-group-key="orphans"]';
  const was = await page.evaluate((s) => document.querySelector(s).open, foldSel);
  await press(foldSel + ' > summary');
  ok(await page.evaluate((s, w) => document.querySelector(s).open === !w, foldSel, was), 'a press on a summary toggles it');
  await press('#dm-rescan-btn');
  ok(await page.evaluate((s, w) => document.querySelector(s).open === !w, foldSel, was), 'and a rescan does not undo it');
  await press(foldSel + ' > summary');
  await press('#dm-rescan-btn');
  ok(await page.evaluate((s, w) => document.querySelector(s).open === w, foldSel, was), 'closing holds too');
  // The race itself. A paint from the same task as the press composes the fold
  // from state; if state were only written by `toggle`, this would undo the press.
  const race = await page.evaluate((s) => new Promise((res) => {
    const fold = document.querySelector(s);
    const want = !fold.open;
    fold.querySelector('summary').click();
    const rescan = document.getElementById('dm-rescan-btn');
    // A synchronous paint, the way a landing load paints: any render reads state.
    rescan.click();
    setTimeout(() => res({ want, open: document.querySelector(s).open }), 1500);
  }), foldSel);
  await quiet();
  ok(race.open === race.want, 'a paint landing right after the press does not undo it', JSON.stringify(race));

  section('§8 A read-only mirror');
  await pick('mirror');
  ok(await page.evaluate(() => document.querySelectorAll('.dm-health .dm-quick-btn, .dm-health .dm-group-fixall-btn, .dm-health .dm-dismiss-btn').length === 0), 'no action on a mirror');
  await press('#dm-rescan-btn');
  ok((await reqs(/\/api\/health\/mirror(\?|$)/, 'GET')).length === 1, 'Rescan still works there, once');

  section('§9 A section never survives a domain switch');
  await mark();
  await pick('gamma');
  ok(!(await kept()).section, 'switching domains replaces the section whole');
  await press('#dm-rescan-btn');
  const gammaScans = await reqs(/\/api\/health\/gamma(\?|$)/, 'GET');
  const mirrorScans = await reqs(/\/api\/health\/mirror(\?|$)/, 'GET');
  ok(gammaScans.length === 1 && mirrorScans.length === 0, 'Rescan on the new section scans the new domain, once');

  section('§10 Leaving during a run');
  await press('.dm-quick-btn[data-action="semanticDupes"]');
  await page.evaluate(() => { document.getElementById('dm-confirm-yes').click(); });
  await delay(60);
  await page.evaluate(() => document.querySelector('#rail .rail-btn[data-view="chat"]').click());
  await delay(1200);
  ok(!(await page.evaluate(() => !!document.querySelector('.dm-health'))), 'the Chat view holds no Health section, and no paint from the abandoned mount put one back');
  await page.evaluate(() => document.querySelector('#rail .rail-btn[data-view="domains"]').click());
  await delay(600);
  await pick('gamma');
  await press('#dm-rescan-btn');
  ok((await reqs(/\/api\/health\/gamma(\?|$)/, 'GET')).length === 1, 'back on the page, one press is one scan');

  section('§11 The patch failing degrades to today\'s replacement');
  await pick('beta');
  await mark();
  await page.evaluate(() => {
    const real = Element.prototype.setAttribute;
    window.__restoreAttr = () => { Element.prototype.setAttribute = real; };
    Element.prototype.setAttribute = function (...a) {
      if (this.closest && this.closest('.dm-health')) throw new Error('forced for this test');
      return real.apply(this, a);
    };
  });
  warnings.length = 0;
  await press('#dm-rescan-btn', { settle: false });
  await delay(800);
  await page.evaluate(() => window.__restoreAttr());
  await quiet();
  ok(warnings.some((w) => /patch failed/.test(w)), 'the failure is on the console, not silent', warnings.join(' | '));
  ok(!(await kept()).section, 'the section was replaced whole');
  ok(await page.evaluate(() => !!document.querySelector('.dm-health #dm-rescan-btn') && !document.querySelector('.dm-health #dm-rescan-btn').disabled), 'and the screen works: Rescan is there and enabled');
  await press('#dm-rescan-btn');
  ok((await reqs(/\/api\/health\/beta(\?|$)/, 'GET')).length === 1, 'the replacement bound itself once: one press, one scan');
  await mark();
  await press('#dm-rescan-btn');
  ok((await kept()).section, 'and the next paint keeps nodes again');

  section('§12 Clean exit');
  ok(exceptions.length === 0, 'no uncaught exception in the page', exceptions.join(' | '));
  ok(!readFileSync(stubLog, 'utf8').includes('blocked'), 'no call reached for any host but the stub');
  ok(!/patch did not match/.test(warnings.join(' ')), 'the patch never reported a mismatch');
} catch (e) {
  ok(false, 'the walk finished', e.stack);
  console.log(serverLog.slice(-800));
} finally {
  try { await conn?.close(); } catch { /* closing */ }
  try { await browser?.close(); } catch { /* closing */ }
  child.kill('SIGTERM');
  await delay(200);
  rmSync(base, { recursive: true, force: true });
}
ok(fingerprint() === before, 'the real config files are byte-identical');
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
process.exit(0);
