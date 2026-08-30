/**
 * The visual harness orchestrator.
 *
 * WHAT THIS EXISTS FOR
 * --------------------
 * Every offline suite in this repo says the same thing in its own header:
 * nothing here measures real rendering, layout or contrast. That gap is not
 * theoretical — it let a stylesheet ship STYLED BUT NEVER LOADED for a whole
 * release, let a fixed panel SWALLOW CLICKS on primary buttons in six views,
 * and let form controls sit frozen at the UA default font-size against the
 * app's own text-size setting. Each was invisible to a fully green suite.
 *
 * This runs the real server on an ephemeral port, drives a real browser over
 * CDP, and measures what the browser actually did.
 *
 * SEE README.md for the ENFORCED / NOT ENFORCED contract. Read it before
 * trusting a green run.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';

import { launchBrowser, findBrowser } from './browser.js';
import { CdpConnection, CdpPage } from './cdp.js';
import { startIsolatedServer } from './server.js';
import { decodePng, pixelAt } from './png.js';
import { contrastRatio, textFloorFor, round2 } from './contrast.js';
import * as probes from './probes.js';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HARNESS_DIR, '..', '..');
const NEXT_HTML = path.join(REPO_ROOT, 'src', 'public', 'next', 'index.html');

/**
 * Block until the page has stopped fetching and had a moment to render.
 * Network activity is observed through CdpPage.responses, which the harness
 * already records; `idleMs` of silence plus a render settle is the signal.
 */
async function waitQuiet(page, { idleMs = 500, maxMs = 8000, settleMs = 250 } = {}) {
  const start = Date.now();
  let last = page.responses.length;
  let quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    await delay(80);
    if (page.responses.length !== last) { last = page.responses.length; quietSince = Date.now(); }
    else if (Date.now() - quietSince >= idleMs) break;
  }
  await delay(settleMs);        // let the post-fetch render and enter animation land
}

export const VIEWPORT = { width: 1280, height: 860 };   // the size this repo's browser passes have always used
export const THEMES = ['dark', 'light'];
const MAX_TEXT_PER_VIEW = 400;
const MAX_BACKDROP_SAMPLES = 24;
/** Chrome's composite rounds slightly differently from ours; ±2/channel. */
const PIXEL_TOLERANCE = 2;

/** Expected content-type family per extension. */
const EXPECTED_TYPE = {
  '.css': /(^|[^-\w])text\/css/,
  '.js': /javascript|ecmascript/,
  '.mjs': /javascript|ecmascript/,
  '.svg': /image\/svg/,
  '.png': /image\/png/,
  '.woff': /font/, '.woff2': /font/,
  '.ico': /icon|image/,
};

/** Every same-origin asset the shell references, straight out of index.html. */
export function shellAssetRefs() {
  const html = readFileSync(NEXT_HTML, 'utf8');
  const refs = new Set();
  const re = /\b(?:href|src)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const v = m[1].trim();
    if (!v || v.startsWith('#') || v.startsWith('data:') || /^https?:/i.test(v)) continue;
    refs.add(v);
  }
  return [...refs].sort();
}

/**
 * HTTP-LEVEL REACHABILITY.
 *
 * An OFFLINE suite already diffs .css files on disk against the <link> tags,
 * and another asserts every ref is root-absolute and exists on disk. Neither
 * issues a request. That matters here specifically because the SPA catch-all
 * answers ANY unmatched path with `200 text/html` — so a missing or misnamed
 * asset does NOT 404, and checking the status code alone proves nothing.
 * Content-type is the discriminator.
 */
export async function checkAssetsOverHttp(origin) {
  const results = [];
  for (const ref of shellAssetRefs()) {
    const url = new URL(ref, origin).toString();
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    let status = 0, ctype = '', error = null;
    try {
      const r = await fetch(url);
      status = r.status;
      ctype = r.headers.get('content-type') || '';
      await r.arrayBuffer();
    } catch (e) { error = String(e && e.message || e); }

    const expect = EXPECTED_TYPE[ext] || null;
    const typeOk = expect ? expect.test(ctype) : true;
    const servedAsShell = /text\/html/.test(ctype) && ext && ext !== '.html';
    results.push({
      ref, status, ctype, ext,
      ok: !error && status === 200 && typeOk,
      servedAsShell,                 // the SPA catch-all answered — asset is MISSING
      typeChecked: !!expect,
      error,
    });
  }
  return results;
}

/**
 * POSITIVE CONTROL for the check above. Requests a path that certainly does
 * not exist and requires it to come back as the SPA shell. If this ever stops
 * holding, `servedAsShell` has stopped meaning "missing asset" and the whole
 * reachability check has quietly become decorative.
 */
export async function assetDetectorControl(origin) {
  const url = new URL('/next/__visual_harness_definitely_missing__.css', origin).toString();
  const r = await fetch(url);
  const ctype = r.headers.get('content-type') || '';
  await r.arrayBuffer();
  return {
    url, status: r.status, ctype,
    fires: r.status === 200 && /text\/html/.test(ctype),
  };
}

/** Grade one view's text against the WCAG floor its own size/weight implies. */
export function gradeContrast(textEntries) {
  const out = [];
  for (const t of textEntries) {
    const ratio = contrastRatio(t.fg, t.bg);
    const floor = textFloorFor(t.fontSize, t.fontWeight);
    out.push({
      key: t.key, sample: t.sample,
      fontSize: t.fontSize, fontWeight: t.fontWeight,
      ratio: round2(ratio), floor,
      pass: ratio >= floor,
      // `uncertain` means the modelled backdrop is not something we can stand
      // behind (a gradient, filter, blend mode or transparent ancestor is in
      // the chain). These are REPORTED but never ratcheted as verdicts.
      uncertain: !!t.bgUncertain || !!t.bgAssumed,
      uncertainWhy: t.bgUncertainWhy || (t.bgAssumed ? 'no opaque ancestor' : null),
      bgAssumed: !!t.bgAssumed,
      fg: t.fg.map(v => Math.round(v)), bg: t.bg.map(v => Math.round(v)),
    });
  }
  return out;
}

/** Capture one painted pixel as [r,g,b,a]. */
async function paintedPixel(page, x, y) {
  const { data } = await page.send('Page.captureScreenshot', {
    format: 'png', clip: { x, y, width: 1, height: 1, scale: 1 }, captureBeyondViewport: false,
  });
  return pixelAt(decodePng(Buffer.from(data, 'base64')), 0, 0);
}

/**
 * Run the whole sweep. Returns a plain, JSON-serialisable report.
 * @returns {Promise<object|{skipped:true, reason:string}>}
 */
export async function runSweep({ views = null, themes = THEMES, withOnboarding = false, controls = true, log = () => {} } = {}) {
  const binary = findBrowser();
  if (!binary) {
    return {
      skipped: true,
      reason: 'no Chromium-family browser found — set CURATOR_VISUAL_BROWSER to one, or install Chrome',
      searched: (await import('./browser.js')).browserCandidates(),
    };
  }

  const server = await startIsolatedServer({ withOnboarding });
  log(`server  ${server.origin}`);
  let browser = null, conn = null, page = null;
  try {
    browser = await launchBrowser();
    log(`browser ${browser.binary} (pid ${browser.pid})`);
    conn = await CdpConnection.connect(browser.wsUrl);
    page = await CdpPage.create(conn);
    await page.setViewport(VIEWPORT.width, VIEWPORT.height);

    const report = {
      meta: {
        recordedAt: new Date().toISOString(),
        viewport: VIEWPORT,
        withOnboarding,
        // Carried in the REPORT so assertions can prove each measurement came
        // from OUR server, but deliberately NOT in the baseline: the port is
        // ephemeral and moves every run.
        serverPort: String(server.port),
        // Deliberately NOT recorded into the baseline: browser version, OS,
        // server port. All three move for reasons that are not regressions.
      },
      assets: await checkAssetsOverHttp(server.origin),
      assetDetectorControl: await assetDetectorControl(server.origin),
      boot: null,
      views: {},
      fontScaleFrozen: null,
      backdropModelCheck: null,
    };

    await page.navigate(server.origin);
    // The shell sets window.__curatorBooted on app.js's last line; the boot
    // guard in index.html treats its absence as a fatal module failure. If it
    // never appears, every later measurement is of a broken app.
    let booted = false;
    for (let i = 0; i < 60; i++) {
      booted = await page.evaluate(() => !!window.__curatorBooted);
      if (booted) break;
      await delay(100);
    }
    report.boot = { booted, consoleErrors: [...page.consoleErrors] };
    // Network responses observed by the BROWSER (not our fetch): a second,
    // independent view of reachability that includes the JS module graph,
    // which index.html never mentions.
    report.networkResponses = page.responses
      .filter(r => r.url.startsWith(server.origin))
      .map(r => ({ path: r.url.slice(server.origin.length), status: r.status, mimeType: r.mimeType, type: r.type, failed: r.failed }))
      .sort((a, b) => a.path.localeCompare(b.path));

    if (!booted) {
      report.fatal = 'window.__curatorBooted never set — the shell did not boot; view measurements skipped';
      return report;
    }

    const railViews = await page.evaluate(probes.railViews, server.port);
    const targetViews = views && views.length ? views.filter(v => railViews.includes(v)) : railViews;
    report.meta.railViews = railViews;

    for (const theme of themes) {
      await page.evaluate(probes.setTheme, server.port, theme);
      for (const view of targetViews) {
        const nav = await page.evaluate(probes.gotoView, server.port, view);
        // WAIT FOR QUIET, DO NOT GUESS A DELAY. A fixed 450ms was measurably
        // too short: Domains fires a health scan and then cost estimates, and
        // two consecutive runs disagreed by two elements on how many contrast
        // failures it had. A baseline that jitters is a baseline people learn
        // to re-record without reading, which is worse than none.
        await waitQuiet(page);
        page.consoleErrors.length = 0;
        const r = await page.evaluate(probes.collectReport, server.port, probes.INTERACTIVE_SELECTOR, MAX_TEXT_PER_VIEW);
        await delay(120);
        report.views[`${view}|${theme}`] = {
          view, theme, nav,
          guard: r.guard,
          geometry: r.geometry,
          stylesheets: r.stylesheets,
          controls: r.controls,
          typography: r.typography,
          textTotal: r.textTotal,
          contrast: gradeContrast(r.text),
          consoleErrors: [...page.consoleErrors],
        };
        log(`  ${view.padEnd(9)} ${theme.padEnd(5)} ` +
            `${r.controls.filter(c => c.state === 'occluded').length} occluded, ` +
            `${gradeContrast(r.text).filter(c => !c.pass).length}/${r.text.length} contrast fails`);
      }
    }

    // ── Backdrop model vs PAINT ────────────────────────────────────────
    await page.evaluate(probes.setTheme, server.port, 'dark');
    await page.evaluate(probes.gotoView, server.port, targetViews[0]);
    await waitQuiet(page);
    const sampleRes = await page.evaluate(probes.backdropSamples, server.port, MAX_BACKDROP_SAMPLES);
    const samples = sampleRes.samples;
    const checked = [];
    for (const s of samples) {
      const painted = await paintedPixel(page, s.point[0], s.point[1]);
      const diff = Math.max(
        Math.abs(painted[0] - s.modelled[0]),
        Math.abs(painted[1] - s.modelled[1]),
        Math.abs(painted[2] - s.modelled[2]),
      );
      checked.push({ key: s.key, point: s.point, modelled: s.modelled, painted: painted.slice(0, 3).map(Math.round), diff, agrees: diff <= PIXEL_TOLERANCE });
    }
    report.backdropModelCheck = {
      tolerance: PIXEL_TOLERANCE,
      elementsConsidered: sampleRes.considered,
      samples: checked,
      agreed: checked.filter(c => c.agrees).length,
      total: checked.length,
    };

    // ── Font-scale freeze detection, ACROSS EVERY VIEW ─────────────────
    // Measure every text-bearing element at scale 1, then at the largest
    // preset, and report everything that DID NOT MOVE. A control with no
    // font-size rule of its own does not inherit one — form controls take the
    // browser's ~13.33px UA default and are frozen — and there is NO
    // declaration anywhere to grep for. Measuring the response is the only
    // way to see it.
    //
    // This runs per view, not once. Restricting it to the first view was a
    // real hole: the one instance this project has already confirmed lives in
    // Settings, which the chat-only version could never have reached.
    const frozen = [];
    let measuredTotal = 0, movedTotal = 0;
    for (const view of targetViews) {
      await page.evaluate(probes.gotoView, server.port, view);
      await waitQuiet(page);
      await page.evaluate(probes.setFontScale, server.port, 1);
      await delay(180);
      const before = await page.evaluate(probes.measureFontSizes, server.port);
      await page.evaluate(probes.setFontScale, server.port, 1.18);
      await delay(180);
      const after = await page.evaluate(probes.measureFontSizes, server.port);
      await page.evaluate(probes.setFontScale, server.port, 1);
      measuredTotal += Object.keys(before).length;
      for (const k of Object.keys(before)) {
        if (!(k in after)) continue;
        if (before[k] === after[k]) frozen.push({ view, key: k.replace(/^\d+\|/, ''), px: before[k] });
        else movedTotal++;
      }
    }
    report.fontScaleFrozen = {
      views: targetViews,
      measured: measuredTotal,
      moved: movedTotal,
      frozen,
    };

    // ── Detector controls: prove each check can FAIL, then restore ─────
    if (controls) {
      log('  running detector controls (planting each defect, then removing it)');
      report.detectorControls = await runDetectorControls(page, server.port, targetViews[0]);
      for (const c of report.detectorControls) {
        log(`    ${c.fired ? 'FIRES' : 'DID NOT FIRE'}  ${c.name}: ${c.detail}`);
      }
    }

    return report;
  } finally {
    // Teardown signals ONLY the processes this function spawned.
    try { if (page) await page.close(); } catch { /* ignore */ }
    try { if (conn) await conn.close(); } catch { /* ignore */ }
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    await server.close();
  }
}

/**
 * POSITIVE CONTROLS, RUN IN THE REAL BROWSER AGAINST THE REAL APP.
 *
 * "A guard that cannot fail" is this project's single most recurring defect —
 * one shipped GREEN at 98/0 while the thing it guarded was fully reverted. So
 * the harness does not merely report a clean run; it first plants each defect
 * it claims to detect, confirms the detector FIRES, and removes it again.
 *
 * Every mutation here is a runtime DOM/CSSOM change in a throwaway browser
 * against a throwaway server. No file in src/ is touched, and each control
 * asserts the app is back to its prior reading afterwards — a control that
 * leaves damage behind would poison every measurement after it.
 */
export async function runDetectorControls(page, port, view = 'chat') {
  const out = [];
  await page.evaluate(probes.setTheme, port, 'dark');
  await page.evaluate(probes.gotoView, port, view);
  await waitQuiet(page);

  const collect = async () => page.evaluate(probes.collectReport, port, probes.INTERACTIVE_SELECTOR, MAX_TEXT_PER_VIEW);

  // ── Control 1: OCCLUSION ────────────────────────────────────────────
  // A full-viewport pointer-catching overlay is exactly the shape that
  // swallowed clicks on primary buttons across six views and was first
  // reported as a cosmetic text overlap.
  {
    const before = await collect();
    const baseOccluded = before.controls.filter(c => c.state === 'occluded').length;
    const baseReachable = before.controls.filter(c => c.state === 'reachable').length;
    await page.evaluate((p) => {
      if (String(location.port) !== String(p)) throw new Error('origin guard');
      const d = document.createElement('div');
      d.id = '__vh_overlay';
      d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.01);pointer-events:auto';
      document.body.appendChild(d);
    }, port);
    const during = await collect();
    const nowOccluded = during.controls.filter(c => c.state === 'occluded');
    await page.evaluate((p) => {
      if (String(location.port) !== String(p)) throw new Error('origin guard');
      document.getElementById('__vh_overlay')?.remove();
    }, port);
    const after = await collect();
    out.push({
      name: 'occlusion',
      fired: nowOccluded.length >= baseReachable && baseReachable > 0,
      detail: `${baseReachable} reachable -> ${nowOccluded.length} occluded under a full-viewport overlay` +
              (nowOccluded[0] ? `; named occluder: ${nowOccluded[0].occludedBy}` : ''),
      restored: after.controls.filter(c => c.state === 'occluded').length === baseOccluded,
    });
  }

  // ── Control 2: STYLESHEET LOADED BUT APPLYING NOTHING ───────────────
  // Repointed at a path that does not exist, so the SPA catch-all answers
  // 200 text/html and the browser refuses it as a stylesheet. This is the
  // styled-but-unloaded shape, reproduced through the real server.
  {
    const before = await collect();
    const baseDead = before.stylesheets.filter(s => !s.inCssom || s.rules === 0).length;
    const target = await page.evaluate((p) => {
      if (String(location.port) !== String(p)) throw new Error('origin guard');
      const links = [...document.querySelectorAll('link[rel~="stylesheet"]')];
      const l = links[links.length - 1];
      l.dataset.vhOriginal = l.getAttribute('href');
      l.setAttribute('href', '/next/__visual_harness_missing__.css');
      return l.dataset.vhOriginal;
    }, port);
    await delay(500);
    const during = await collect();
    const nowDead = during.stylesheets.filter(s => !s.inCssom || s.rules === 0);
    await page.evaluate((p) => {
      if (String(location.port) !== String(p)) throw new Error('origin guard');
      const l = document.querySelector('link[data-vh-original]');
      if (l) { l.setAttribute('href', l.dataset.vhOriginal); delete l.dataset.vhOriginal; }
    }, port);
    await delay(500);
    const after = await collect();
    out.push({
      name: 'dead-stylesheet',
      fired: nowDead.length > baseDead,
      detail: `repointed ${target} at a missing path: dead sheets ${baseDead} -> ${nowDead.length}`,
      restored: after.stylesheets.filter(s => !s.inCssom || s.rules === 0).length === baseDead,
    });
  }

  // ── Control 3: CONTRAST ─────────────────────────────────────────────
  // Grey text on the identical grey. Ratio must be exactly 1.00 — which is
  // also a live re-proof of the §1 anchor, this time through the browser's
  // own colour resolution and the ancestor-compositing walk rather than the
  // pure maths.
  {
    await page.evaluate((p) => {
      if (String(location.port) !== String(p)) throw new Error('origin guard');
      const d = document.createElement('div');
      d.id = '__vh_contrast';
      d.style.cssText = 'position:fixed;left:40px;top:300px;width:220px;height:40px;z-index:99998;background:#808080;color:#808080;font-size:14px';
      d.textContent = 'invisible text control';
      document.body.appendChild(d);
    }, port);
    await delay(150);
    const during = await collect();
    const graded = gradeContrast(during.text);
    const hit = graded.find(g => g.key.includes('__vh_contrast'));
    await page.evaluate((p) => {
      if (String(location.port) !== String(p)) throw new Error('origin guard');
      document.getElementById('__vh_contrast')?.remove();
    }, port);
    const after = await collect();
    out.push({
      name: 'contrast',
      fired: !!hit && hit.pass === false && hit.ratio === 1,
      detail: hit ? `planted grey-on-identical-grey measured ${hit.ratio}:1 against a ${hit.floor} floor -> ${hit.pass ? 'PASS (wrong)' : 'FAIL (correct)'}`
                  : 'planted element was not measured at all',
      restored: !gradeContrast(after.text).some(g => g.key.includes('__vh_contrast')),
    });
  }

  // ── Control 4: FONT-SCALE FREEZE ────────────────────────────────────
  // A hardcoded px font-size cannot respond to --font-scale. This is the
  // class you cannot grep for when the declaration is ABSENT entirely, and
  // measuring the response is the only way to see it.
  {
    await page.evaluate((p) => {
      if (String(location.port) !== String(p)) throw new Error('origin guard');
      const d = document.createElement('div');
      d.id = '__vh_frozen';
      d.style.cssText = 'position:fixed;left:40px;top:360px;width:220px;height:24px;z-index:99998;font-size:13.33px';
      d.textContent = 'frozen text control';
      document.body.appendChild(d);
    }, port);
    await page.evaluate(probes.setFontScale, port, 1);
    await delay(150);
    const b = await page.evaluate(probes.measureFontSizes, port);
    await page.evaluate(probes.setFontScale, port, 1.18);
    await delay(150);
    const a = await page.evaluate(probes.measureFontSizes, port);
    await page.evaluate(probes.setFontScale, port, 1);
    const frozenKeys = Object.keys(b).filter(k => k in a && b[k] === a[k]);
    const movedKeys = Object.keys(b).filter(k => k in a && b[k] !== a[k]);
    await page.evaluate((p) => {
      if (String(location.port) !== String(p)) throw new Error('origin guard');
      document.getElementById('__vh_frozen')?.remove();
    }, port);
    out.push({
      name: 'font-scale-freeze',
      fired: frozenKeys.some(k => k.includes('__vh_frozen')),
      detail: `planted a hardcoded 13.33px element: ${movedKeys.length} element(s) moved with --font-scale, ` +
              `${frozenKeys.length} did not, and the planted one is ${frozenKeys.some(k => k.includes('__vh_frozen')) ? 'among them' : 'MISSING from them'}`,
      restored: true,
    });
  }

  return out;
}
