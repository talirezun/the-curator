/**
 * ONE-OFF PROBE (not a suite, not registered in run-tests.js).
 *
 * The text-ramp change moved --text-2, --text-3 and --text-faint. The visual
 * harness grades TEXT only, so it cannot see the NON-TEXT uses of those tokens:
 * the scrollbar thumb, two 6px dots, an svg chevron, and a 1.5px inset ring.
 * A text fix that degrades a non-text use is not a win, so those are measured
 * here, composited over the REAL painted backdrop, in BOTH themes.
 *
 * WCAG 1.4.11 floor for a UI component is 3:1.
 *
 * CONTROLS, asserted before any measurement is trusted: an identical pair must
 * read 1.00 and black-on-white 21.00, or the probe refuses to report.
 *
 * Run:  node scripts/visual/nontext-probe.mjs
 */
import { launchBrowser, findBrowser } from './browser.js';
import { startIsolatedServer } from './server.js';
import { CdpConnection, CdpPage } from './cdp.js';
import { contrastRatio, compositeOver, flattenStack, round2, parseSimpleCssColor } from './contrast.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const w = [255, 255, 255, 1], k = [0, 0, 0, 1];
console.log(`CONTROL identical pair = ${round2(contrastRatio(w, w)).toFixed(2)} (must be 1.00)`);
console.log(`CONTROL black-on-white = ${round2(contrastRatio(k, w)).toFixed(2)} (must be 21.00)`);
if (round2(contrastRatio(w, w)) !== 1 || round2(contrastRatio(k, w)) !== 21) {
  console.error('PROBE CONTROLS FAILED — refusing to report'); process.exit(1);
}
if (!findBrowser()) { console.log('⊘ no browser installed — skip'); process.exit(0); }

// Selector -> which CSS property carries the token, and a human label.
const TARGETS = [
  ['memory',   '.mem-row-mark-off',      'boxShadow',       '--text-faint  1.5px inset ring (memory row, no state)'],
  ['settings', 'LOCAL_MODEL_DOT',       'backgroundColor', '--text-faint  "Local model" provider dot'],
  ['domains',  '.dm-browse-dot',         'backgroundColor', '--text-3      6px browse dot'],
  ['sync',     '.sync-domain-dot',       'backgroundColor', '--text-3      6px sync domain dot'],
  ['domains',  '.dm-group-summary svg',  'color',           '--text-3      disclosure chevron glyph'],
  ['chat',     ':root',                  'scrollbarColor',  '--text-3      scrollbar thumb (inherited app-wide)'],
];

let server = null, browser = null, conn = null;
try {
  server = await startIsolatedServer({});
  if (String(server.port) === '3333') throw new Error('refusing to run on 3333');
  browser = await launchBrowser();
  console.log(`server ${server.origin}   browser pid ${browser.pid}`);
  conn = await CdpConnection.connect(browser.wsUrl);
  const page = await CdpPage.create(conn);
  await page.setViewport(1280, 860);
  await page.navigate(server.origin);
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!window.__curatorBooted)) break; await delay(100); }

  const rows = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate((port, t) => {
      if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port');
      document.documentElement.setAttribute('data-theme', t);
      return document.documentElement.getAttribute('data-theme');
    }, server.port, theme);
    for (const [view, sel, prop, label] of TARGETS) {
      await page.evaluate((port, v) => {
        if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port');
        const b = document.querySelector(`#rail .rail-btn[data-view="${v}"]`); if (b) b.click();
      }, server.port, view);
      await delay(900);
      const r = await page.evaluate((port, s, p) => {
        if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port');
        if (!innerWidth) throw new Error('zero viewport');
        let el;
        if (s === ':root') el = document.documentElement;
        else if (s === 'LOCAL_MODEL_DOT') {
          // Addressed BY ITS ROW LABEL, not by index: `.provider-dot` alone
          // returns Gemini's cyan dot, and the first draft of this probe
          // reported that as the Local-model figure.
          const row = [...document.querySelectorAll('*')]
            .filter((n) => n.children.length && /Local model/.test(n.textContent) && n.textContent.length < 120)
            .pop();
          el = row ? row.querySelector('[class*="dot"]') : null;
        } else el = document.querySelector(s);
        if (!el) return { missing: true };
        const cs = getComputedStyle(el);
        const value = cs[p] || cs.getPropertyValue(p);
        // Walk ancestors for the painted backdrop, innermost first.
        const layers = [];
        // For :root there is no ancestor to walk, and html's own background is
        // usually transparent — the paint comes from body's --canvas. Start the
        // walk AT body, or the fallback white base silently becomes the answer,
        // which is how the first draft reported 3.16 for a dark-theme thumb
        // that is really 6.32.
        let n = s === ':root' ? document.body : el.parentElement;
        while (n) {
          const c = getComputedStyle(n).backgroundColor;
          const m = c.match(/rgba?\(([^)]+)\)/);
          if (m) {
            const q = m[1].split(',').map(Number); const a = q.length > 3 ? q[3] : 1;
            if (a > 0) { layers.push([q[0], q[1], q[2], a]); if (a >= 1) break; }
          }
          n = n.parentElement;
        }
        return { value: String(value), layers, rect: el.getBoundingClientRect() };
      }, server.port, sel, prop);
      if (r.missing) { rows.push({ theme, label, note: 'element not rendered in this state' }); continue; }
      const found = String(r.value).match(/rgba?\([^)]+\)/g) || [];
      // Drop fully transparent matches (e.g. the scrollbar TRACK, transparent by design).
      const colours = found.map(parseSimpleCssColor).filter((c) => c && c[3] > 0);
      if (!colours.length) { rows.push({ theme, label, note: `no opaque colour in "${r.value}"` }); continue; }
      // Ancestors were collected innermost-first; flattenStack wants front-most LAST.
      const ls = r.layers.slice().reverse();
      const base = ls.length ? [ls[0][0], ls[0][1], ls[0][2], 1] : [255, 255, 255, 1];
      const bg = flattenStack(ls.slice(1), base);
      const fg = colours[0];
      const ratio = round2(contrastRatio(compositeOver(fg, bg), bg));
      rows.push({ theme, label, fg: `rgb(${fg[0]},${fg[1]},${fg[2]})`, bg: `rgb(${Math.round(bg[0])},${Math.round(bg[1])},${Math.round(bg[2])})`, ratio });
    }
  }
  console.log('\n  theme  target                                                  fg              bg              ratio  3:1');
  for (const x of rows) {
    if (x.note) { console.log(`  ${x.theme.padEnd(6)} ${x.label.padEnd(54)} — ${x.note}`); continue; }
    console.log(`  ${x.theme.padEnd(6)} ${x.label.padEnd(54)} ${x.fg.padEnd(15)} ${x.bg.padEnd(15)} ${x.ratio.toFixed(2).padStart(5)}  ${x.ratio >= 3 ? 'PASS' : 'FAIL'}`);
  }
} finally {
  try { if (conn && conn.close) await conn.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  try { if (server && server.close) await server.close(); } catch {}
  for (const [n, p] of [['browser', browser && browser.pid]]) {
    if (!p) continue;
    try { process.kill(p, 0); console.error(`  ${n} pid ${p} STILL ALIVE after close() — SIGKILL`); process.kill(p, 'SIGKILL'); }
    catch { console.log(`  ${n} pid ${p} confirmed gone`); }
  }
}
