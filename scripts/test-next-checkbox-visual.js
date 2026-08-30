/**
 * test-next-checkbox-visual.js — LIVE_LOCAL suite (a BROWSER, not an API key).
 *
 * Its offline sibling, scripts/test-next-checkbox.js, proves every checkbox in
 * /next ADOPTS shared/checkbox.css. It cannot prove the component then RENDERS
 * as anything — a stylesheet can be written, correct, and inert (v3.9.1
 * shipped the progress ring never linked; v3.23.0 found a "fixed" rule in a
 * file that loads BEFORE the one it was meant to override, at identical
 * specificity, doing nothing). Only a browser can separate those states.
 *
 * ── WHAT IS MEASURED ─────────────────────────────────────────────────────
 *  §1  CONTROLS FIRST. Two probes in this repo have been silently wrong in
 *      exactly the way a contrast probe goes wrong — one read a transparent
 *      backdrop as BLACK and reported 1.15 for text genuinely at 17.68. So
 *      this suite states its controls in its own output every run: an
 *      identical pair must read 1.00, black-on-white exactly 21.00, and a
 *      translucent foreground composited over its real backdrop must differ
 *      materially from the naive opaque reading. Nothing below is believed
 *      until those three hold.
 *  §2  THE SHEET ACTUALLY APPLIES. Served with a CSS content-type, present in
 *      document.styleSheets, and — the assertion that matters —
 *      `appearance` computes to `none` on a real element. A checkbox whose
 *      computed appearance is `auto` is OS chrome no matter what any file says.
 *  §3  FIVE STATES, BOTH THEMES, all distinguishable from each other by
 *      measured computed values, not by looking.
 *  §4  PAINTED PIXELS, not just computed styles. A 1x1 screenshot clip at the
 *      centre of a checked box must come back near-white (the glyph is really
 *      drawn) and a clip at its corner must come back the accent (the fill is
 *      really painted). This is the cross-check that the CSS-chain model
 *      matches what Chrome put on screen — the control probes.js already
 *      applies to its backdrop walk.
 *  §5  CONTRAST, composited after cascade, against the 3:1 non-text floor:
 *      the check glyph against its fill, and the unchecked border against the
 *      surface actually behind it (walked, not assumed).
 *  §6  KEYBOARD AND LABEL, through Chrome's own input pipeline — Tab reaches
 *      it, Space toggles it, a click on the LABEL toggles it, and the focus
 *      ring is a real painted box-shadow. `Input.dispatchKeyEvent` and
 *      `Input.dispatchMouseEvent` at viewport coordinates, never `el.click()`
 *      or a synthetic KeyboardEvent: a synthetic event fires on the reference
 *      you already hold and PASSES on a control that is covered, 0x0, or
 *      scrolled off, which is the whole class a browser suite exists to catch.
 *  §7  A REAL SITE, RENDERED BY A REAL VIEW — including the Shared Brain
 *      CONSENT GATE, reached by opening the actual wizard from the actual
 *      CTA. Without this the probe instances in §3-§6 would prove the
 *      component works somewhere nothing ships.
 *  §7b THE ONE SITE THAT DIMS THE COMPONENT. views/chat.css holds
 *      `.chat-conv-check` at opacity 0.45 at rest so unticked conversation
 *      rows stay quiet — a deliberate, commented decision several releases
 *      older than this component, deliberately NOT changed here. Its resting
 *      border therefore measures 1.76 against its row, under the 3:1 floor,
 *      and §7b REPORTS that rather than letting §5's component figure be read
 *      as this site's. What it ASSERTS is the mitigation: ticking, keyboard
 *      focus and row hover all restore full opacity.
 *
 * ── HOW THE STATES ARE REACHED, STATED PLAINLY ───────────────────────────
 * Four of the five states (indeterminate, disabled, hover, and an unchecked
 * box beside a checked one) are not simultaneously reachable on any one
 * shipping screen, and driving each view's real flow to reach them would mean
 * queueing files for a paid ingest and completing a Shared Brain
 * CONTRIBUTION. So §3-§6 measure PROBE INSTANCES: real
 * `<input type="checkbox" class="cur-check">` elements inserted into the live
 * document, under the real stylesheet, the real tokens and the real theme
 * attribute. That is a measurement of the COMPONENT, and it is honest only
 * because §7 independently proves a real view's checkbox computes IDENTICALLY
 * to the probe — if the two ever diverge, §7 reds and the probes stop meaning
 * anything.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────
 *  - An ISOLATED server on an ephemeral port with BOTH CURATOR_TEST_* seams
 *    and every provider credential stripped from the child. Never port 3333.
 *  - NO SHARED BRAIN FLOW IS COMPLETED. The wizard is opened and its step-5
 *    panel is un-hidden so the real consent gate can be measured. No repo, no
 *    token, no validation call, no Save. Nothing is contributed anywhere.
 *  - Teardown in a `finally` that signals ONLY this run's own children, and
 *    then VERIFIES the browser process is actually gone with `kill(pid, 0)`
 *    before returning — "I called close()" is not "it exited", and a stray
 *    headless Chrome on the maintainer's machine is a real cost.
 *  - With no Chromium-family browser installed this prints a `⊘` line, no
 *    assertion tally, and exits 0 — the same contract a missing API key gets.
 *
 * ── NOT ENFORCED ─────────────────────────────────────────────────────────
 *  - Only Chromium is measured. `appearance: none` and the background-image
 *    glyph are chosen precisely because they are the portable pair, but no
 *    Firefox or WebKit rendering is verified here.
 *  - Screenshots for the release are taken by hand; this suite samples 1x1
 *    clips rather than diffing full images (test-visual-regression.js owns
 *    baselines, and adding a second baseline set is a decision, not a fix).
 *  - The four sites §7 does not reach (the ingest queue's overwrite toggle,
 *    the Settings model filter) are covered by the offline suite's class
 *    invariant plus the probe/real-site equivalence, not by driving their
 *    flows. Both need state a fixture would have to fake.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startIsolatedServer } from './visual/server.js';
import { launchBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';
import { compositeOver, contrastRatio, round2, FLOOR_NON_TEXT } from './visual/contrast.js';
import { decodePng, pixelAt } from './visual/png.js';

let passed = 0;
let failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else {
    failed++;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
}
function section(t) { console.log(`\n${t}`); }

const browser = await launchBrowser({ headless: true });
if (!browser) {
  console.log('⊘ SKIPPED — no Chromium-family browser found on this machine.');
  console.log('  This suite measures real rendering; there is nothing to measure without one.');
  process.exit(0);
}

const server = await startIsolatedServer();
if (server.port === 3333) {                       // belt and braces; server.js refuses it too
  await server.close(); await browser.close();
  throw new Error('refusing to run against port 3333 — the maintainer\'s live app');
}

// Two conversations in the throwaway fixture, so the chat sidebar renders its
// per-row checkboxes and its bulk strip at all. Both are inert records with no
// messages beyond a seeded pair; nothing here reaches an LLM (the child has no
// provider key) and nothing is written outside the temp domains dir.
for (const [i, title] of [[0, 'Checkbox fixture A'], [1, 'Checkbox fixture B']]) {
  writeFileSync(
    path.join(server.fixture.domainsDir, server.fixture.domainSlug, 'conversations',
      `0000000${i}-0000-4000-8000-00000000000${i}.json`),
    JSON.stringify({
      id: `0000000${i}-0000-4000-8000-00000000000${i}`,
      title,
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      messages: [{ role: 'user', content: 'fixture' }, { role: 'assistant', content: 'fixture' }],
    }));
}

let conn = null;
let page = null;
try {
  conn = await CdpConnection.connect(browser.wsUrl);
  page = await CdpPage.create(conn);
  await page.setViewport(1280, 860);
  await page.navigate(`${server.origin}/next/`);

  const PORT = server.port;

  // ── §1 CONTROLS ───────────────────────────────────────────────────────
  section('§1 — probe controls (nothing below is believed until these hold)');

  const identical = round2(contrastRatio([0x7C, 0x5A, 0xF5, 1], [0x7C, 0x5A, 0xF5, 1]));
  const blackOnWhite = round2(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1]));
  const naive = round2(contrastRatio([124, 90, 245, 1], [10, 10, 17, 1]));
  const composited = round2(contrastRatio(compositeOver([124, 90, 245, 0.14], [10, 10, 17, 1]), [10, 10, 17, 1]));
  console.log(`  · identical pair = ${identical.toFixed(2)}   black-on-white = ${blackOnWhite.toFixed(2)}`);
  console.log(`  · translucent 14% accent: naive ${naive.toFixed(2)} vs composited ${composited.toFixed(2)}`);
  ok(identical === 1.00, `CONTROL: an identical pair reads exactly 1.00 (got ${identical})`, identical);
  ok(blackOnWhite === 21.00, `CONTROL: black on white reads exactly 21.00 (got ${blackOnWhite})`, blackOnWhite);
  ok(Math.abs(naive - composited) > 1.0,
    'CONTROL: a translucent foreground composited over its real backdrop reads MATERIALLY ' +
    'differently from the naive opaque reading — the step whose absence produced this repo\'s ' +
    `1.15-for-17.68 report (naive ${naive} vs composited ${composited})`,
    { naive, composited });

  // The in-page colour resolver: the BROWSER's own parser via a 1x1 canvas,
  // so `oklch()`, `color(srgb …)` and named keywords all come back as rgba
  // tuples rather than being re-parsed by us. probes.js uses the same device.
  const RESOLVER = function () {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    return function resolve(css) {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = '#000';
      cx.fillStyle = css;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
  };

  // ── §2 THE SHEET ACTUALLY APPLIES ─────────────────────────────────────
  section('§2 — the stylesheet is served, loaded, and actually applies');

  const cssResp = page.responses.find(r => r.url.includes('/next/shared/checkbox.css'));
  ok(!!cssResp && cssResp.status === 200,
    `shared/checkbox.css was requested and returned 200 (got ${cssResp ? cssResp.status : 'no request at all'})`,
    cssResp);
  ok(!!cssResp && /^text\/css/.test(cssResp.mimeType),
    `it is served as text/css, not swallowed by the SPA fallback — a missing /next path returns ` +
    `index.html with a 200, so status alone proves nothing (got ${cssResp ? cssResp.mimeType : 'n/a'})`,
    cssResp);

  const sheetInfo = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    const sheets = [...document.styleSheets].map(s => s.href || '(inline)');
    const idx = sheets.findIndex(h => h.includes('/next/shared/checkbox.css'));
    const firstView = sheets.findIndex(h => h.includes('/next/views/'));
    return { count: sheets.length, idx, firstView };
  }, PORT);
  ok(sheetInfo.idx > -1, 'the sheet is in document.styleSheets (parsed, not merely downloaded)', sheetInfo);
  ok(sheetInfo.idx > -1 && sheetInfo.firstView > -1 && sheetInfo.idx < sheetInfo.firstView,
    'it is ordered BEFORE the first views/ stylesheet, so a view can still override placement at ' +
    'equal specificity — measured in the browser\'s own sheet list, not read off the HTML',
    sheetInfo);

  // Insert the probe rig once; every later measurement addresses it by id.
  const rigReady = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    document.getElementById('cbx-rig')?.remove();
    const rig = document.createElement('div');
    rig.id = 'cbx-rig';
    rig.style.cssText = 'position:fixed;left:24px;top:24px;z-index:99999;display:flex;flex-direction:column;gap:14px;background:var(--surface);padding:16px;';
    rig.innerHTML =
      '<label class="cur-check-label" id="cbx-lab-off"><input type="checkbox" class="cur-check" id="cbx-off"><span>unchecked</span></label>' +
      '<label class="cur-check-label"><input type="checkbox" class="cur-check" id="cbx-on" checked><span>checked</span></label>' +
      '<label class="cur-check-label"><input type="checkbox" class="cur-check" id="cbx-ind"><span>indeterminate</span></label>' +
      '<label class="cur-check-label"><input type="checkbox" class="cur-check" id="cbx-dis" disabled><span>disabled</span></label>' +
      '<label class="cur-check-label"><input type="checkbox" class="cur-check cur-check-sm" id="cbx-sm"><span>compact</span></label>';
    document.body.appendChild(rig);
    document.getElementById('cbx-ind').indeterminate = true;
    return rig.querySelectorAll('input').length;
  }, PORT);
  ok(rigReady === 5, `probe rig mounted with ${rigReady} real <input type="checkbox"> elements`, rigReady);

  const appearance = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    const el = document.getElementById('cbx-off');
    const cs = getComputedStyle(el);
    return { appearance: cs.appearance || cs.webkitAppearance, tag: el.tagName, type: el.type };
  }, PORT);
  ok(appearance.appearance === 'none',
    `THE LOAD-BEARING ONE: computed \`appearance\` is "${appearance.appearance}" — anything other ` +
    'than "none" means the browser is still painting OS chrome, whatever the CSS file says',
    appearance);
  ok(appearance.tag === 'INPUT' && appearance.type === 'checkbox',
    'and the element doing the work is still a real <input type="checkbox"> — not a <div> with ' +
    'role="checkbox", so Space/Tab/label association remain the browser\'s job',
    appearance);

  // ── §3-§5, per theme ──────────────────────────────────────────────────

  /** Everything measurable about the rig in the current theme, in one round trip. */
  const MEASURE = function (port, resolverSrc) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    const resolve = (new Function('return ' + resolverSrc))()();

    /** Walk up for the first ancestor painting an opaque-enough background. */
    function backdropOf(el) {
      const layers = [];
      let n = el.parentElement;
      while (n) {
        const bg = resolve(getComputedStyle(n).backgroundColor);
        if (bg[3] > 0) { layers.unshift(bg); if (bg[3] >= 1) break; }
        n = n.parentElement;
      }
      return layers;
    }

    const out = { boxes: {}, tokens: {} };
    const root = getComputedStyle(document.documentElement);
    for (const t of ['--accent', '--border-strong', '--surface-inset', '--border-focus', '--text-on-accent', '--text-3', '--surface']) {
      out.tokens[t] = resolve(root.getPropertyValue(t).trim());
    }
    out.theme = document.documentElement.getAttribute('data-theme');

    for (const id of ['cbx-off', 'cbx-on', 'cbx-ind', 'cbx-dis', 'cbx-sm']) {
      const el = document.getElementById(id);
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out.boxes[id] = {
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        bg: resolve(cs.backgroundColor),
        borderColor: resolve(cs.borderTopColor),
        borderWidth: cs.borderTopWidth,
        radius: cs.borderTopLeftRadius,
        image: cs.backgroundImage,
        opacity: cs.opacity,
        cursor: cs.cursor,
        boxShadow: cs.boxShadow,
        backdrop: backdropOf(el),
      };
    }
    return out;
  };

  /**
   * Flip the theme and WAIT FOR THE TRANSITION TO FINISH.
   *
   * A MEASUREMENT TRAP THIS SUITE FELL INTO ON ITS FIRST RUN, recorded
   * because it is invisible and it lies in the reassuring direction. The
   * component transitions `background-color` and `border-color` on --t-state.
   * Flipping `data-theme` therefore starts an ANIMATION, and
   * getComputedStyle during it returns the INTERMEDIATE value — measured
   * immediately after the attribute set, it returned the value at t=0, i.e.
   * the OLD theme's colours, while `getPropertyValue('--accent')` on the root
   * (which does not transition) correctly returned the NEW theme's.
   *
   * The result was a light-theme pass that was really a second dark-theme
   * reading: "the page really is in the light theme" went GREEN off the
   * attribute, the unchecked border measured 12.26 (the DARK border against
   * a WHITE backdrop — a colour pair that exists on no screen), and the
   * genuine light figure was 1.64. A suite that reports a fabricated ratio
   * as measured is worse than one that reports nothing.
   *
   * `getAnimations()` is the honest wait — it asks the browser whether
   * anything is still running rather than guessing a duration — with a
   * bounded fallback so a stuck animation cannot hang the run.
   */
  const settleTheme = async (t) => {
    await page.evaluate(function (port, theme) {
      if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
      document.documentElement.setAttribute('data-theme', theme);
    }, PORT, t);
    for (let i = 0; i < 40; i++) {
      const running = await page.evaluate(function (port) {
        if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
        return document.getAnimations().filter(a => a.playState === 'running').length;
      }, PORT);
      if (running === 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 120));   // one paint beyond the last animation
  };

  const results = {};
  for (const theme of ['dark', 'light']) {
    await settleTheme(theme);

    const m = await page.evaluate(MEASURE, PORT, RESOLVER.toString());
    results[theme] = m;

    section(`§3 — states are distinguishable (${theme})`);
    ok(m.theme === theme, `the page really is in the ${theme} theme`, m.theme);

    const off = m.boxes['cbx-off'];
    const on = m.boxes['cbx-on'];
    const ind = m.boxes['cbx-ind'];
    const dis = m.boxes['cbx-dis'];
    const sm = m.boxes['cbx-sm'];
    const key = (c) => c.slice(0, 3).map(Math.round).join(',');

    ok(key(off.bg) !== key(on.bg),
      `[${theme}] unchecked and checked have different FILLS (${key(off.bg)} vs ${key(on.bg)})`,
      { off: off.bg, on: on.bg });
    ok(key(on.bg) === key(m.tokens['--accent']),
      `[${theme}] the checked fill IS --accent, per the design system (${key(on.bg)})`,
      { fill: on.bg, accent: m.tokens['--accent'] });
    // NOT --border-strong. See the DELIBERATE DEVIATION in the component's
    // header: the system's token measures 1.59 dark / 1.64 light against
    // --surface, and the unchecked border is the control's entire visible
    // presence. This assertion pins the deviation so it cannot be silently
    // "corrected" back to the system's value without the contrast assertion
    // below going red at the same time.
    ok(key(off.borderColor) === key(m.tokens['--text-3']),
      `[${theme}] the unchecked border is --text-3, the deliberate deviation from the system's ` +
      `--border-strong, which measures below the 3:1 floor in both themes (${key(off.borderColor)})`,
      { border: off.borderColor, textm3: m.tokens['--text-3'], borderStrong: m.tokens['--border-strong'] });
    const wouldBe = round2(contrastRatio(m.tokens['--border-strong'], off.backdrop[0] || [0, 0, 0, 1]));
    ok(wouldBe < FLOOR_NON_TEXT,
      `[${theme}] and the deviation is still NECESSARY — --border-strong would measure ` +
      `${wouldBe.toFixed(2)} here, under the 3:1 floor. If the token is ever fixed this reds, ` +
      'and the component should go back to following the system', wouldBe);
    ok(off.image === 'none' && on.image !== 'none',
      `[${theme}] the check glyph is painted only when checked (off: ${off.image}, on: ${on.image.slice(0, 30)}…)`,
      { off: off.image, on: on.image.slice(0, 60) });
    ok(ind.image !== 'none' && ind.image !== on.image,
      `[${theme}] INDETERMINATE paints its own glyph, different from checked — "some selected" ` +
      'must not read as "all selected" beside a Delete button',
      { ind: ind.image.slice(0, 60), on: on.image.slice(0, 60) });
    ok(Math.abs(parseFloat(dis.opacity) - 0.45) < 0.001,
      `[${theme}] disabled computes opacity 0.45 — the design system's value, not one of the five ` +
      `others this tree uses (got ${dis.opacity})`, dis.opacity);
    ok(dis.cursor === 'not-allowed', `[${theme}] disabled computes cursor: not-allowed`, dis.cursor);
    ok(off.cursor === 'pointer', `[${theme}] an enabled box computes cursor: pointer`, off.cursor);
    ok(off.rect.w === off.rect.h && off.rect.w >= 15 && off.rect.w <= 17,
      `[${theme}] the default box is square at the system's 16px (${off.rect.w}x${off.rect.h})`, off.rect);
    ok(sm.rect.w < off.rect.w && sm.rect.w >= 12,
      `[${theme}] the compact variant is genuinely smaller (${sm.rect.w} vs ${off.rect.w})`,
      { sm: sm.rect.w, base: off.rect.w });
    ok(off.radius === '3px',
      `[${theme}] the radius is --radius-xs = 3px, per the system (got ${off.radius})`, off.radius);
    ok(off.boxShadow === 'none',
      `[${theme}] an unfocused box paints NO box-shadow — v3.24.2's rule, so nothing competes with ` +
      `the global :focus-visible ring (got ${off.boxShadow})`, off.boxShadow);

    section(`§5 — contrast, composited after cascade (${theme})`);

    // The glyph is the literal #fff inside the data: URI. Its background is
    // the checked fill, which is opaque --accent, so no compositing is needed
    // on this pair — stated rather than silently skipped.
    const glyph = round2(contrastRatio([255, 255, 255, 1], on.bg));
    console.log(`  · check glyph (#fff) on the --accent fill: ${glyph.toFixed(2)}`);
    ok(glyph >= FLOOR_NON_TEXT,
      `[${theme}] the check mark clears the 3:1 non-text floor against its own fill ` +
      `(${glyph.toFixed(2)})`, glyph);

    // The unchecked border against whatever is REALLY behind it, walked up
    // the tree and composited — not assumed to be --surface.
    const base = off.backdrop.length ? off.backdrop[0] : [0, 0, 0, 1];
    let flat = [base[0], base[1], base[2], 1];
    for (const layer of off.backdrop.slice(1)) flat = compositeOver(layer, flat);
    const border = round2(contrastRatio(compositeOver(off.borderColor, flat), flat));
    console.log(`  · unchecked border (--text-3) on its composited backdrop rgb(${flat.slice(0, 3).map(Math.round).join(',')}): ${border.toFixed(2)}`);
    ok(border >= FLOOR_NON_TEXT,
      `[${theme}] the unchecked border clears the 3:1 non-text floor against the surface actually ` +
      `behind it (${border.toFixed(2)}) — this is the box's ONLY visual presence when empty, so ` +
      'it is the ratio that decides whether an unticked consent gate can be seen at all',
      { ratio: border, backdrop: flat });

    // THE CLAIM THAT JUSTIFIES THE DEVIATION, measured rather than asserted.
    // The component's header argues the unchecked border must clear 3:1
    // because it is the control's ENTIRE visible presence — which is only
    // true if the --surface-inset fill contributes nothing. That is a
    // measurable claim, so it is measured; if the fill ever became a real
    // second cue, the argument for deviating from --border-strong weakens
    // and this line is where that shows up.
    const fill = round2(contrastRatio(compositeOver(off.bg, flat), flat));
    console.log(`  · unchecked --surface-inset fill against the same backdrop: ${fill.toFixed(2)}`);
    ok(fill < 1.2,
      `[${theme}] the unchecked FILL carries essentially nothing (${fill.toFixed(2)}) — which is ` +
      'why the border has to carry the control, and why the deviation from --border-strong is ' +
      'load-bearing rather than a preference', fill);

    results[theme].ratios = { glyph, border, fill };
  }

  // ── §4 PAINTED PIXELS ────────────────────────────────────────────────
  section('§4 — painted pixels agree with the computed model');

  await page.evaluate(function (port, t) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    document.documentElement.setAttribute('data-theme', t);
  }, PORT, 'dark');

  const onRect = results.dark.boxes['cbx-on'].rect;
  async function samplePixel(x, y) {
    const shot = await page.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x, y, width: 1, height: 1, scale: 1 },
      captureBeyondViewport: false,
    });
    const px = pixelAt(decodePng(Buffer.from(shot.data, 'base64')), 0, 0);
    return [px[0], px[1], px[2]];
  }

  const centre = await samplePixel(onRect.x + onRect.w / 2, onRect.y + onRect.h / 2);
  const corner = await samplePixel(onRect.x + 1.5, onRect.y + onRect.h - 2.5);
  const accent = results.dark.tokens['--accent'];
  console.log(`  · checked box: centre pixel rgb(${centre.join(',')})  corner pixel rgb(${corner.join(',')})  --accent rgb(${accent.slice(0, 3).map(Math.round).join(',')})`);

  const nearWhite = centre.every(c => c > 200);
  ok(nearWhite,
    `the CHECK MARK is genuinely painted — the pixel at the centre of a checked box is near-white ` +
    `rgb(${centre.join(',')}). A computed background-image proves the declaration parsed; this ` +
    'proves Chrome drew it', centre);
  const cornerIsAccent = corner.every((c, i) => Math.abs(c - accent[i]) < 26);
  ok(cornerIsAccent,
    `the FILL is genuinely painted — a pixel inside the box away from the glyph matches --accent ` +
    `to within 26/channel (got rgb(${corner.join(',')}) vs rgb(${accent.slice(0, 3).map(Math.round).join(',')}))`,
    { corner, accent });
  ok(!(nearWhite && cornerIsAccent && centre.join() === corner.join()),
    'CONTROL: the two samples are not the same pixel read twice — a screenshot clip that ignored ' +
    'its coordinates would return one colour for both and pass the two assertions above vacuously',
    { centre, corner });

  // ── §6 KEYBOARD AND LABEL ────────────────────────────────────────────
  section('§6 — keyboard and label, through Chrome\'s own input pipeline');

  // Focus the box before the compact one, then Tab: the NEXT focusable must
  // be the checkbox itself, i.e. it is in the tab order.
  const focusStart = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    document.getElementById('cbx-off').checked = false;
    document.getElementById('cbx-off').focus();
    return document.activeElement?.id || null;
  }, PORT);
  ok(focusStart === 'cbx-off', 'the checkbox can hold focus', focusStart);

  const ringInfo = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    const el = document.getElementById('cbx-off');
    const cs = getComputedStyle(el);
    return { shadow: cs.boxShadow, outline: cs.outlineStyle, radius: cs.borderTopLeftRadius,
             matchesFV: el.matches(':focus-visible') };
  }, PORT);
  ok(ringInfo.matchesFV,
    'a keyboard-focused checkbox matches :focus-visible (so the global ring is eligible at all)',
    ringInfo);
  ok(ringInfo.shadow !== 'none',
    `the focus ring is a REAL painted box-shadow, inherited from tokens/base.css's global rule — ` +
    `not declared locally, and not fought (got ${ringInfo.shadow})`, ringInfo);
  ok(ringInfo.radius === '3px',
    `focus does not change the box's SHAPE — base.css's global :focus-visible also sets ` +
    `border-radius: var(--radius-sm), and the component re-declares --radius-xs so a focused ` +
    `control still looks like the same control (got ${ringInfo.radius})`, ringInfo);

  await page.pressKey(' ');
  const afterSpace = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    return document.getElementById('cbx-off').checked;
  }, PORT);
  ok(afterSpace === true,
    'SPACE toggles it — dispatched through Input.dispatchKeyEvent, so this is the browser\'s own ' +
    'activation behaviour on a real input and not a handler we wrote', afterSpace);

  await page.pressKey(' ');
  const afterSecondSpace = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    return document.getElementById('cbx-off').checked;
  }, PORT);
  ok(afterSecondSpace === false, 'and Space toggles it back off', afterSecondSpace);

  const tabTarget = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    document.getElementById('cbx-lab-off').previousElementSibling === null;
    document.getElementById('cbx-off').focus();
    return true;
  }, PORT);
  void tabTarget;
  await page.pressKey('Tab');
  const afterTab = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    return document.activeElement?.id || null;
  }, PORT);
  ok(afterTab === 'cbx-on',
    `TAB moves from one checkbox to the next — every box is in the tab order, which is the ` +
    'property v3.24.2 found a hover-hidden control had lost entirely ' +
    `(landed on "${afterTab}")`, afterTab);

  // A REAL click on the LABEL TEXT, at viewport coordinates. If label
  // association were broken this lands on a <span> and nothing happens.
  const labelRect = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    document.getElementById('cbx-off').checked = false;
    const span = document.querySelector('#cbx-lab-off span');
    const r = span.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2,
             hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.tagName || null };
  }, PORT);
  ok(labelRect.hit === 'SPAN',
    `the point about to be clicked really is the label TEXT, not the box (elementFromPoint: ` +
    `${labelRect.hit}) — otherwise the next assertion proves nothing about label association`,
    labelRect);
  await page.click(labelRect.x, labelRect.y);
  const afterLabelClick = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    return document.getElementById('cbx-off').checked;
  }, PORT);
  ok(afterLabelClick === true,
    'clicking the LABEL TEXT toggles the box — the wrapping <label> association survived replacing ' +
    'the control\'s appearance', afterLabelClick);

  // And a real click on the box itself.
  const boxRect = results.dark.boxes['cbx-on'].rect;
  const boxHit = await page.evaluate(function (port, x, y) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    document.getElementById('cbx-on').checked = true;
    return document.elementFromPoint(x, y)?.id || null;
  }, PORT, boxRect.x + boxRect.w / 2, boxRect.y + boxRect.h / 2);
  ok(boxHit === 'cbx-on',
    `the box's own centre hit-tests to the box (elementFromPoint: ${boxHit}) — nothing overlays it`,
    boxHit);
  await page.click(boxRect.x + boxRect.w / 2, boxRect.y + boxRect.h / 2);
  const afterBoxClick = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    return document.getElementById('cbx-on').checked;
  }, PORT);
  ok(afterBoxClick === false, 'a real click on the box toggles it', afterBoxClick);

  // ── §7 A REAL SITE, INCLUDING THE CONSENT GATE ───────────────────────
  section('§7 — real sites rendered by real views (the probes are not the only instances)');

  await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    document.getElementById('cbx-rig')?.remove();
  }, PORT);

  const realSites = [];
  for (const view of ['chat', 'shared']) {
    const res = await page.evaluate(function (port, v) {
      if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
      const btn = document.querySelector(`#rail .rail-btn[data-view="${v}"]`);
      if (!btn) return { ok: false, reason: 'no rail button' };
      btn.click();
      return { ok: true };
    }, PORT, view);
    if (!res.ok) continue;
    await new Promise(r => setTimeout(r, 900));
    const found = await page.evaluate(function (port) {
      if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
      return [...document.querySelectorAll('input[type="checkbox"]')].map(el => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          id: el.id || null,
          cls: el.className,
          appearance: cs.appearance || cs.webkitAppearance,
          radius: cs.borderTopLeftRadius,
          w: Math.round(r.width), h: Math.round(r.height),
        };
      });
    }, PORT);
    for (const f of found) realSites.push({ view, ...f });
  }

  // THE CONSENT GATE. Open the real wizard from the real CTA and un-hide its
  // step-5 panel. No repo, no PAT, no validation call, no Save — nothing is
  // contributed anywhere; the panel's markup is rendered by wizardShellHtml
  // up front and is merely display:none until the user reaches step 5.
  // The Shared Brain view is behind a per-install feature flag, off in a fresh
  // fixture. Enabling it writes ONLY into the throwaway user-data dir and only
  // turns the UI on; it creates no connection and contributes nothing.
  await page.evaluate(async function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    const btn = document.getElementById('btn-sb-enable');
    if (btn) { btn.click(); return 'clicked'; }
    return 'no enable button';
  }, PORT);
  await new Promise(r => setTimeout(r, 1400));

  const gate = await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    const cta = [...document.querySelectorAll('button')]
      .find(b => /join|connect|create/i.test(b.textContent || '') && !b.disabled);
    if (!cta) return { ok: false, reason: 'no Shared Brain CTA on screen',
                        buttons: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).slice(0, 12) };
    cta.click();
    const panel = document.getElementById('sbw-panel-step-5');
    if (!panel) return { ok: false, reason: 'wizard did not render step 5' };
    panel.classList.remove('sbw-hidden');
    const el = document.getElementById('sbw-consent');
    if (!el) return { ok: false, reason: 'no #sbw-consent in the DOM' };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      ok: true,
      appearance: cs.appearance || cs.webkitAppearance,
      radius: cs.borderTopLeftRadius,
      bg: cs.backgroundColor,
      w: Math.round(r.width), h: Math.round(r.height),
      inLabel: !!el.closest('label'),
      labelText: (el.closest('label')?.textContent || '').trim().slice(0, 60),
    };
  }, PORT);

  ok(gate.ok, `the Shared Brain wizard opened and rendered its consent gate (${gate.reason || 'ok'})`, gate);
  if (gate.ok) {
    console.log(`  · #sbw-consent: appearance=${gate.appearance} radius=${gate.radius} ${gate.w}x${gate.h} label="${gate.labelText}"`);
    ok(gate.appearance === 'none',
      'THE CONSENT GATE renders as the component, not OS chrome — the control by which a user ' +
      'agrees to contribute their own knowledge to a Shared Brain, measured on the real element ' +
      'produced by the real wizard', gate);
    ok(gate.radius === '3px' && gate.w >= 15 && gate.w <= 17,
      `and it carries the component's geometry (${gate.w}x${gate.h} at ${gate.radius})`, gate);
    ok(gate.inLabel, 'it is still inside its <label>, so the sentence beside it stays clickable', gate);
    realSites.push({ view: 'shared(wizard)', id: 'sbw-consent', cls: 'cur-check',
                     appearance: gate.appearance, radius: gate.radius, w: gate.w, h: gate.h });
  }

  const bare = realSites.filter(s => s.appearance !== 'none');
  console.log(`  · ${realSites.length} real checkbox instance(s) reached: ${realSites.map(s => s.view + '/' + (s.id || s.cls.split(' ').pop())).join(', ')}`);
  ok(realSites.length >= 3,
    `at least three checkboxes rendered by REAL views were reached (${realSites.length}) — without ` +
    'this, every measurement above describes a probe instance that ships nowhere', realSites.length);
  ok(bare.length === 0,
    `every real instance computes appearance:none (${bare.length} bare)`,
    bare);
  ok(realSites.every(s => s.radius === '3px'),
    'every real instance carries the component\'s radius — this is the assertion that ties the ' +
    'probe measurements to shipping elements: if a view ever diverged from the probe, it reds here',
    realSites.map(s => ({ view: s.view, radius: s.radius })));

  // ── §7b THE ONE SITE THAT DIMS THE COMPONENT ─────────────────────────
  section('§7b — the chat row dims the component at rest, and that is measured, not assumed');

  /* views/chat.css sets `.chat-conv-check { opacity: 0.45 }` so an unticked
     conversation row stays visually quiet, and restores opacity 1 on :checked,
     :focus-visible and row :hover. That predates this component by several
     releases and is a deliberate, commented design decision — it is NOT
     changed here, because quieting unticked rows is the whole point of it and
     overriding another release's judgement under cover of a checkbox pass is
     not this change's business.

     But it does mean the component's measured 4.27 / 4.14 unchecked border is
     the COMPONENT's figure, not this site's resting figure, and saying "the
     unchecked border clears 3:1" without that caveat would be quoting a number
     from the wrong element. So the resting value is measured and REPORTED, and
     what is ASSERTED is the mitigation that makes it defensible: the three
     states that matter — the user has ticked it, the keyboard has reached it,
     or the pointer is on its row — all restore full opacity. If that reveal
     ever regressed, this row's checkbox would be permanently sub-floor and
     nothing else in the tree would notice. */
  // §7 ended on the Shared Brain view with the wizard open. Go back to Chat,
  // where this site lives, before measuring it.
  await page.evaluate(function (port) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    document.querySelector('#rail .rail-btn[data-view="chat"]')?.click();
  }, PORT);
  await new Promise(r => setTimeout(r, 1300));

  const dim = await page.evaluate(function (port, resolverSrc) {
    if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
    const resolve = (new Function('return ' + resolverSrc))()();
    const el = document.querySelector('.chat-conv-check');
    if (!el) return { ok: false };
    el.checked = false;
    const cs = getComputedStyle(el);
    let bg = null;
    let n = el.parentElement;
    while (n) { const c = resolve(getComputedStyle(n).backgroundColor); if (c[3] >= 1) { bg = c; break; } n = n.parentElement; }
    const rest = { opacity: parseFloat(cs.opacity), border: resolve(cs.borderTopColor), backdrop: bg };
    return { ok: true, rest,
             revealSelectors: [...document.styleSheets]
               .filter(s => (s.href || '').includes('views/chat.css'))
               .flatMap(s => { try { return [...s.cssRules]; } catch { return []; } })
               .filter(r => r.selectorText && /chat-conv-check/.test(r.selectorText) && /opacity:\s*1/.test(r.style?.cssText || ''))
               .map(r => r.selectorText) };
  }, PORT, RESOLVER.toString());

  /* THE SAME TRANSITION TRAP AS settleTheme, MET A SECOND TIME AND RECORDED
     BECAUSE IT LIES IN THE REASSURING DIRECTION IN ONE CASE AND THE ALARMING
     ONE IN THE OTHER. `.chat-conv-check` transitions `opacity`, so reading
     getComputedStyle in the same task as `el.checked = true` returns the value
     at t=0 — the OLD 0.45 — and the first draft of these two assertions went
     RED against correct, shipping CSS whose reveal rules the CSSOM scan on the
     line above had just found by name. The state change and the measurement
     therefore live in separate round trips with an animation settle between
     them, exactly as the theme flip does. */
  const settleOpacity = async (mutate) => {
    await page.evaluate(mutate, PORT);
    for (let i = 0; i < 30; i++) {
      const running = await page.evaluate(function (port) {
        if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
        return document.getAnimations().filter(a => a.playState === 'running').length;
      }, PORT);
      if (running === 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 120));
    return page.evaluate(function (port) {
      if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
      const el = document.querySelector('.chat-conv-check');
      return el ? parseFloat(getComputedStyle(el).opacity) : null;
    }, PORT);
  };

  if (dim.ok) {
    dim.checkedOpacity = await settleOpacity(function (port) {
      if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
      const el = document.querySelector('.chat-conv-check');
      el.blur(); el.checked = true;
    });
    /* THE FOCUS HALF NEEDS A REAL KEY PRESS, AND THE FIRST DRAFT'S FAILURE IS
       WORTH KEEPING. `el.focus()` alone left the opacity at 0.45 and the
       assertion went red against CSS that is correct: `:focus-visible` is not
       "this element has focus", it is "this element has focus AND the browser
       judges a focus indicator warranted", and Chrome's judgement keys on the
       last INTERACTION MODALITY. By this point in the sweep §6 has dispatched
       real mouse events, so the modality is pointer and programmatic focus
       does not qualify — which is correct behaviour, and exactly why §6's
       identical call DID match: nothing had clicked yet.
       So focus is moved with a real Tab, which both sets keyboard modality and
       is what the user this assertion is about actually does. */
    await page.evaluate(function (port) {
      if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
      const el = document.querySelector('.chat-conv-check');
      el.checked = false;
      const all = document.getElementById('chat-bulk-all');
      (all || el).focus();
    }, PORT);
    for (let i = 0; i < 6; i++) {
      await page.pressKey('Tab');
      const onCheck = await page.evaluate(function (port) {
        if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
        const a = document.activeElement;
        return !!(a && a.classList && a.classList.contains('chat-conv-check') && a.matches(':focus-visible'));
      }, PORT);
      if (onCheck) break;
    }
    dim.focusOpacity = await settleOpacity(function (port) {
      if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
      // No mutation — Tab already moved focus. Report which element holds it.
      void port;
    });
    dim.focusedIsCheck = await page.evaluate(function (port) {
      if (String(location.port) !== String(port)) throw new Error('origin guard: wrong port ' + location.port);
      const a = document.activeElement;
      return { cls: a ? a.className : null, fv: !!(a && a.matches && a.matches(':focus-visible')),
               opacity: a ? parseFloat(getComputedStyle(a).opacity) : null };
    }, PORT);
    if (dim.focusedIsCheck && dim.focusedIsCheck.opacity !== null) {
      dim.focusOpacity = dim.focusedIsCheck.opacity;
    }
  }

  ok(dim.ok, 'a real .chat-conv-check was on screen to measure', dim);
  if (dim.ok) {
    const bd = dim.rest.backdrop || [0, 0, 0, 1];
    const eff = [dim.rest.border[0], dim.rest.border[1], dim.rest.border[2], dim.rest.opacity];
    const restRatio = round2(contrastRatio(compositeOver(eff, bd), bd));
    console.log(`  · .chat-conv-check RESTING (opacity ${dim.rest.opacity}) border on its row: ${restRatio.toFixed(2)} — ` +
      `BELOW the ${FLOOR_NON_TEXT.toFixed(2)} floor, by the pre-existing dim, reported not asserted`);
    console.log(`  · reveal rules found: ${dim.revealSelectors.join(' | ') || '(none)'}`);
    ok(dim.rest.opacity < 1,
      `the resting dim is real and still in force (opacity ${dim.rest.opacity}) — if it were 1 this ` +
      'whole section would be measuring nothing', dim.rest.opacity);
    ok(dim.checkedOpacity === 1,
      'TICKING it restores full opacity, so a selected row is never sub-floor', dim.checkedOpacity);
    ok(dim.focusedIsCheck && /chat-conv-check/.test(dim.focusedIsCheck.cls || '') && dim.focusedIsCheck.fv,
      `a real Tab landed on a .chat-conv-check and it matches :focus-visible — otherwise the ` +
      'assertion below would be measuring some other element', dim.focusedIsCheck);
    ok(dim.focusOpacity === 1,
      'KEYBOARD FOCUS restores full opacity, so a user arriving by Tab sees the control at full ' +
      'contrast — the mitigation that makes the resting dim defensible rather than a defect',
      dim.focusOpacity);
    ok(dim.revealSelectors.some(s => /:hover/.test(s)),
      `a row :hover rule also restores it (${dim.revealSelectors.join(' | ')})`, dim.revealSelectors);
  }

  // ── console hygiene ──────────────────────────────────────────────────
  section('§8 — console hygiene');
  const errs = page.consoleErrors.filter(e => !/favicon/i.test(e));
  ok(errs.length === 0, `no console errors during the sweep (${errs.length})`, errs.slice(0, 5));

  // ── summary of the measured figures, for the record ──────────────────
  console.log('\n  MEASURED CONTRAST (composited after cascade, controls above):');
  for (const theme of ['dark', 'light']) {
    const r = results[theme].ratios;
    console.log(`    ${theme.padEnd(6)} check-on-fill ${r.glyph.toFixed(2)}   unchecked-border ${r.border.toFixed(2)}   (floor ${FLOOR_NON_TEXT.toFixed(2)})`);
  }
} finally {
  // Teardown runs even if setup threw. THEN VERIFIES IT WORKED — this repo
  // had five servers and six Chromes survive a run for 52 minutes because
  // "close() was called" was taken for "the process exited". Only this run's
  // own PIDs are ever signalled; no pattern, no port sweep, no pkill.
  if (page) { try { await page.close(); } catch { /* gone */ } }
  if (conn) { try { await conn.close(); } catch { /* gone */ } }
  try { await browser.close(); } catch { /* gone */ }
  try { await server.close(); } catch { /* gone */ }

  const pid = browser.pid;
  if (pid) {
    let alive = false;
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    if (alive) {
      // browser.js's close() has been observed not to reap reliably. Escalate
      // on the EXACT pid we spawned and say so, rather than leaving it.
      console.log(`  ! browser pid ${pid} survived close(); sending SIGKILL to that pid only`);
      try { process.kill(pid, 'SIGKILL'); } catch { /* raced */ }
      await new Promise(r => setTimeout(r, 300));
      let stillAlive = true;
      try { process.kill(pid, 0); } catch { stillAlive = false; }
      console.log(stillAlive ? `  ! browser pid ${pid} STILL alive after SIGKILL` : `  · browser pid ${pid} reaped`);
    }
  }
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
