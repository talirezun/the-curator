#!/usr/bin/env node
/**
 * LIVE_LOCAL — the Chat composer's four pills, measured in a real browser.
 * $0, no API key, no network beyond localhost.
 *
 * WHY THIS EXISTS (v3.77.0). v3.72.0 required the four pills (domain, project,
 * length, model) to sit on one row at 1400px, and met it by switching the strip
 * to `nowrap` and letting each pill give way by a flex-shrink weight. At the
 * 1280px reference width the pills were ~50px over the row, so the model name
 * lost 24px and the domain and project lost ~0.22px each — enough for ellipsis
 * to drop whole glyphs: "Early Computi…", "No proje…", on the README's own
 * screenshot, with every offline suite green (they read chat.css as text).
 *
 * WHAT IS MEASURED. At window widths 1400, 1280, 1100, 900 and 700 (the last
 * two inside v3.76.0's 800–1099 band and <800 drawer mode): every pill's value
 * text is laid out at its natural width — the Range box of its text is not
 * wider than the element that shows it, to 0.01px, because `scrollWidth` is an
 * integer and cannot see the 0.22px clip that caused the report. Checked with a
 * short domain name and with a 39-character one. No pill passes the composer's
 * edge and the page never scrolls sideways. With the short name at 1400 and
 * 1280, the four pills share ONE row (v3.72.0's requirement, now met without
 * clipping).
 *
 * THE DETECTOR IS SHOWN TO FIRE FIRST: a 60px cap is planted on the pills, the
 * clip check must report it, and the plant is removed and checked gone.
 *
 * SELF-SKIP: with no Chromium-family browser this prints `⊘` and exits 0.
 * Run twice: a short domain name with no project picked, and the long name
 * with a project picked in the pill.
 * NOT ENFORCED: a named model other than the default (the menu's model names
 * are catalogue data), and the dark theme (layout-identical).
 */

import { setTimeout as delay } from 'timers/promises';
import { findBrowser, launchBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';
import { startIsolatedServer } from './visual/server.js';

let passed = 0, failed = 0;
const ok = (c, label, detail) => {
  if (c) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('Chat composer pills (real browser, real server, isolated tempdirs)\n');
if (!findBrowser()) {
  console.log('⊘ SKIPPED — no Chromium-family browser found (set CURATOR_VISUAL_BROWSER). Nothing was measured.');
  process.exit(0);
}

const WIDTHS = [1400, 1280, 1100, 900, 700];
const LONG = 'The History of Early Computing Machines';
const PROJECT = 'museum-exhibit-website';

// In-page: one reading of the composer's pill strip.
function measure() {
  const row = document.querySelector('.chat-composer-controls');
  const composer = document.querySelector('.chat-composer') || row;
  const cr = composer ? composer.getBoundingClientRect() : null;
  const pills = [...document.querySelectorAll('.chat-composer-pickers .lb-btn')].map((b) => {
    const t = b.querySelector('[data-lb-text]') || b;
    const range = document.createRange();
    range.selectNodeContents(t);
    const natural = range.getBoundingClientRect().width;
    const shown = t.getBoundingClientRect().width;
    const r = b.getBoundingClientRect();
    return { id: b.id, text: t.textContent.trim(), natural, shown, top: Math.round(r.top), right: r.right };
  });
  return {
    port: location.port,
    rowWidth: row ? row.getBoundingClientRect().width : 0,
    composerRight: cr ? cr.right : 0,
    hscroll: document.documentElement.scrollWidth > window.innerWidth,
    pills,
  };
}

const clipped = (m) => m.pills.filter((p) => p.natural > p.shown + 0.01);

let server = null, browser = null, conn = null;
try {
  server = await startIsolatedServer();
  const expectPort = String(server.port);
  const r = await fetch(`${server.origin}/api/domains`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: LONG }),
  });
  const longSlug = (await r.json()).slug;
  ok(r.status === 201 && !!longSlug, `fixture: a second domain named "${LONG}" (${LONG.length} chars)`);
  // A project in each, so the Project pill is a real control and not the
  // "no projects yet" note — the pill that read "No proje…" in the report.
  for (const d of [server.fixture.domainSlug, longSlug]) {
    const pr = await fetch(`${server.origin}/api/memory/${d}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: PROJECT }),
    });
    ok(pr.ok, `fixture: project "${PROJECT}" in ${d} (${pr.status})`);
  }

  browser = await launchBrowser();
  conn = await CdpConnection.connect(browser.wsUrl);

  const open = async (width, domain, pin = false) => {
    const page = await CdpPage.create(conn);
    await page.setViewport(width, 900, 1);
    await page.navigate(`${server.origin}/api/version`);
    await page.evaluate((d, pin) => {
      localStorage.clear(); sessionStorage.clear();
      localStorage.setItem('curator-next-theme', 'light');
      localStorage.setItem('curator-next-view', 'chat');
      localStorage.setItem('curator-next-chat-domain', d);
      localStorage.setItem('curator-next-onboarding-dismissed-v1', '1');
      sessionStorage.setItem('curator-next-instance-banner-dismissed-v1', '1');
      if (pin) localStorage.setItem('curator-chat-project-v1', JSON.stringify({ [d]: pin }));
    }, domain, pin);
    await page.navigate(server.origin);
    for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__curatorBooted)); i++) await delay(100);
    for (let i = 0; i < 60 && (await page.evaluate(() => document.querySelectorAll('.chat-composer-pickers .lb-btn').length)) < 3; i++) await delay(100);
    await page.evaluate(() => document.fonts && document.fonts.ready.then(() => true));
    await delay(400);
    return page;
  };

  // §1 The detector fires on a planted clip, and the plant comes out clean.
  console.log('§1 Detector control');
  {
    const page = await open(1280, server.fixture.domainSlug);
    try {
      const m0 = await page.evaluate(measure);
      ok(m0.port === expectPort, `the page is the isolated server's (port ${m0.port})`);
      await page.evaluate(() => {
        const s = document.createElement('style'); s.id = 'pill-clip-plant';
        s.textContent = '.chat-composer-pickers .lb-btn { max-width: 60px !important; }';
        document.head.appendChild(s);
      });
      const m1 = await page.evaluate(measure);
      ok(clipped(m1).length >= 2, `a 60px cap planted on the pills is DETECTED (${clipped(m1).length} clipped)`);
      await page.evaluate(() => document.getElementById('pill-clip-plant').remove());
      const m2 = await page.evaluate(measure);
      ok(clipped(m2).length === clipped(m0).length, '…and removing it restores the prior reading');
    } finally { await page.close(); }
  }

  // §2 Every width, both names.
  for (const [label, slug, pin] of [
    ['short name, no project picked', server.fixture.domainSlug, false],
    ['39-character name, a project picked', longSlug, PROJECT],
  ]) {
    console.log(`\n§2 ${label}`);
    for (const w of WIDTHS) {
      const page = await open(w, slug, pin);
      try {
        const m = await page.evaluate(measure);
        const summary = m.pills.map((p) => `${p.text} ${p.shown.toFixed(2)}/${p.natural.toFixed(2)}`).join(' · ');
        ok(m.pills.length === 4, `@${w}: the composer shows its pills (${m.pills.length}, row ${Math.round(m.rowWidth)}px)`);
        const c = clipped(m);
        ok(c.length === 0, `@${w}: no pill's value is clipped`,
          c.map((p) => `"${p.text}" shown ${p.shown.toFixed(2)}px of ${p.natural.toFixed(2)}px`).join('; ') || summary);
        if (pin) ok(m.pills.some((p) => p.text === PROJECT), `@${w}: the picked project is the pill's value`, summary);
        ok(!m.hscroll && m.pills.every((p) => p.right <= m.composerRight + 0.5), `@${w}: nothing passes the composer's edge; no sideways scroll`);
        if (!pin && (w === 1400 || w === 1280)) {
          const tops = new Set(m.pills.map((p) => p.top));
          ok(tops.size === 1, `@${w}: all ${m.pills.length} pills on ONE row (v3.72.0), without clipping`, summary);
        }
      } finally { await page.close(); }
    }
  }
} catch (err) {
  ok(false, `harness error: ${err.message}`);
} finally {
  try { conn && conn.close && await conn.close(); } catch { /* gone */ }
  if (browser) await browser.close();
  if (server) await server.close();
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
