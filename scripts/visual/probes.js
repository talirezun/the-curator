/**
 * In-page probes. Each function here is STRINGIFIED and evaluated inside the
 * browser, so every one must be self-contained: no closure over module scope,
 * no imports, no shared helpers. That is a constraint, not an oversight.
 *
 * ORIGIN GUARD — read this before adding a probe.
 * The browser on this machine is SHARED between agents, and this repo has
 * already had one agent's measurement silently land on another agent's server
 * (and one screenshot capture another agent's view entirely). So EVERY probe
 * takes `expectPort` and THROWS if `location.port` does not match, and throws
 * if `innerWidth` is 0 (a hidden/zero-sized tab, where geometry and
 * `elementFromPoint` are meaningless). A measurement that cannot prove which
 * page it came from is not recorded at all.
 */

/** Selector for "things a user can click or focus". */
export const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="switch"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * The whole per-view measurement, in ONE page round-trip.
 *
 * Returns { guard, stylesheets, controls, text, typography, geometry }.
 * Colour resolution goes through a 1x1 canvas — the browser's OWN colour
 * parser — rather than a regex over whatever getComputedStyle serialized,
 * because that serialization already spans rgb()/rgba()/color()/oklch()/lab()
 * and grows with each Chrome release. A parser that silently mis-reads one
 * form produces a confident wrong contrast number, which is precisely the
 * failure this harness exists to stop.
 */
export function collectReport(expectPort, interactiveSelector, maxText) {
  // ── origin + sanity guard ────────────────────────────────────────────
  if (String(location.port) !== String(expectPort)) {
    throw new Error(`origin guard: measuring port ${location.port}, expected ${expectPort}`);
  }
  if (!window.innerWidth || !window.innerHeight) {
    throw new Error(`origin guard: viewport is ${window.innerWidth}x${window.innerHeight}`);
  }

  const cvs = document.createElement('canvas');
  cvs.width = 1; cvs.height = 1;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });

  /** Any CSS colour -> [r,g,b,a(0..1)], using the browser's own parser. */
  function toRGBA(css) {
    if (!css) return [0, 0, 0, 0];
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0,0,0,0)';
    try { ctx.fillStyle = css; } catch { return null; }
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }

  function over(fg, bg) {
    const a = fg[3];
    if (a >= 1) return [fg[0], fg[1], fg[2], 1];
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
  }

  /**
   * The opaque colour actually behind `el`, by walking ancestors and
   * compositing every translucent layer. `assumed` is true when NOTHING in
   * the chain was opaque — reported rather than papered over with a guess.
   */
  function backdropOf(el) {
    const stack = [];
    let node = el, opaque = null, opaqueAt = null;
    // The model composites background-COLOUR. If anything in the chain paints
    // by another mechanism -- a gradient or image, a filter, a blend mode, or
    // a partially transparent ancestor -- the modelled backdrop is a guess.
    // It is FLAGGED rather than silently reported as fact: a contrast number
    // nobody can stand behind is exactly what this harness exists to stop
    // being produced, and producing one of our own would be the same defect
    // in a new place.
    let uncertain = false, uncertainWhy = null;
    while (node) {
      const ncs = getComputedStyle(node);
      if (!uncertain) {
        if (ncs.backgroundImage !== 'none') { uncertain = true; uncertainWhy = 'background-image/gradient'; }
        else if (ncs.filter !== 'none') { uncertain = true; uncertainWhy = 'filter'; }
        else if (ncs.backdropFilter && ncs.backdropFilter !== 'none') { uncertain = true; uncertainWhy = 'backdrop-filter'; }
        else if (ncs.mixBlendMode && ncs.mixBlendMode !== 'normal') { uncertain = true; uncertainWhy = 'mix-blend-mode'; }
        else if (node !== el && parseFloat(ncs.opacity) < 1) { uncertain = true; uncertainWhy = 'ancestor opacity'; }
      }
      const c = toRGBA(ncs.backgroundColor);
      if (c && c[3] > 0) {
        if (c[3] >= 1) { opaque = c; opaqueAt = key(node); break; }
        stack.push(c);
      }
      node = node.parentElement;
    }
    let assumed = false;
    if (!opaque) { opaque = [255, 255, 255, 1]; assumed = true; }
    // stack is front-to-back; composite back-to-front onto the opaque base.
    let out = opaque;
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return { rgba: out, assumed, opaqueAt, uncertain, uncertainWhy };
  }

  /** A stable-ish identity for an element: survives re-renders, no free text. */
  function key(el) {
    if (!el || !el.tagName) return '(none)';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    // Positional discriminator so N siblings with the same classes differ.
    const p = el.parentElement;
    if (p) {
      const sibs = [...p.children].filter(c => c.tagName === el.tagName);
      if (sibs.length > 1) s += `:nth(${sibs.indexOf(el) + 1})`;
    }
    return s;
  }

  function label(el) {
    const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 60);
  }

  // ── 1. STYLESHEETS: did they actually LOAD, with rules? ───────────────
  // An existing OFFLINE suite already diffs .css files on disk against the
  // <link> tags in index.html. What it CANNOT see is a sheet that is linked,
  // is served 200, and still applies nothing — because the SPA catch-all
  // answered with text/html and the browser refused it as a stylesheet.
  // `cssRules.length` is the only thing that distinguishes those.
  const linkEls = [...document.querySelectorAll('link[rel~="stylesheet"]')];
  const sheetByHref = new Map();
  for (const s of document.styleSheets) {
    let rules = -1, err = null;
    try { rules = s.cssRules ? s.cssRules.length : 0; } catch (e) { err = String(e && e.name || e); }
    sheetByHref.set(s.href || '(inline)', { rules, err, disabled: !!s.disabled });
  }
  const stylesheets = linkEls.map(l => {
    const href = l.href;
    const got = sheetByHref.get(href) || null;
    return {
      href: href.replace(location.origin, ''),
      inCssom: !!got,
      rules: got ? got.rules : 0,
      disabled: got ? got.disabled : false,
      error: got ? got.err : 'link present but no stylesheet object (load failed or wrong MIME)',
    };
  });

  // ── 2. OCCLUSION: what is ACTUALLY on top at each control's centre? ────
  // Comparing bounding boxes is what missed a panel swallowing clicks on
  // primary buttons across six views. elementFromPoint is the only thing that
  // answers the question the user experiences.
  const controls = [];
  for (const el of document.querySelectorAll(interactiveSelector)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const entry = { key: key(el), label: label(el), w: Math.round(r.width), h: Math.round(r.height) };
    if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') {
      entry.state = 'not-rendered';
      controls.push(entry); continue;
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) {
      entry.state = 'offscreen';
      controls.push(entry); continue;
    }
    const hit = document.elementFromPoint(cx, cy);
    // A control the app has DELIBERATELY made unclickable is not occluded.
    // `.btn[disabled]` sets `pointer-events: none`, so elementFromPoint
    // correctly returns whatever is underneath. Reporting that as "a panel is
    // swallowing your clicks" would be a false positive on every disabled
    // button in the app -- and a harness that cries wolf is one people learn
    // to ignore, which is how the real occlusion bug survived.
    //
    // The distinction is kept, not collapsed: `pointer-events: none` on a
    // control that is NOT disabled gets its own state, because that is a
    // genuine "looks clickable, is not" defect.
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') {
      entry.state = 'disabled';
      entry.pointerEvents = cs.pointerEvents;
    } else if (cs.pointerEvents === 'none') {
      entry.state = 'pointer-events-none';
    } else if (!hit) {
      entry.state = 'no-hit';
    } else if (hit === el || el.contains(hit)) {
      entry.state = 'reachable';
      entry.pointerEvents = cs.pointerEvents;
    } else {
      entry.state = 'occluded';
      entry.occludedBy = key(hit);
      entry.occluderLabel = label(hit);
      // Name the nearest positioned ancestor of the occluder — in practice
      // that is the overlay/panel a human needs to go and look at.
      let a = hit;
      while (a && a !== document.body && getComputedStyle(a).position === 'static') a = a.parentElement;
      entry.occluderLayer = a ? key(a) : '(body)';
      entry.occluderZ = a ? getComputedStyle(a).zIndex : 'auto';
    }
    controls.push(entry);
  }

  // ── 3. TEXT: computed size/weight/colour + composited contrast ─────────
  const text = [];
  let textTotal = 0;
  for (const el of document.querySelectorAll('body *')) {
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
    if (!own.trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    textTotal++;
    if (text.length >= maxText) continue;
    const fgRaw = toRGBA(cs.color);
    if (!fgRaw) continue;
    // Start the backdrop walk at the element ITSELF, not its parent.
    // Found by the in-browser contrast control: a planted div with
    // `background:#808080; color:#808080` measured 5.06:1 instead of 1.00,
    // because the walk began at the parent and never saw the element's own
    // background. That is wrong for every badge, button, chip and tinted box
    // in the app -- i.e. exactly the elements this project has already
    // mis-measured once (a badge read at 1.90 that is 13.81 composited).
    // A transparent element is still skipped by the alpha test inside
    // backdropOf, so ordinary text is unaffected.
    const back = backdropOf(el);
    const fg = over(fgRaw, back.rgba);
    text.push({
      key: key(el),
      sample: own.replace(/\s+/g, ' ').trim().slice(0, 40),
      fontSize: Math.round(parseFloat(cs.fontSize) * 100) / 100,
      fontWeight: cs.fontWeight,
      fg, bg: back.rgba,
      bgAssumed: back.assumed,
      bgUncertain: back.uncertain,
      bgUncertainWhy: back.uncertainWhy,
      // Geometry is carried so the baseline can show a caller WHERE a colour
      // changed, and so a future probe can sample real paint at this point.
      at: [Math.round(r.left + Math.min(6, r.width / 2)), Math.round(r.top + r.height / 2)],
    });
  }

  // ── 4. TYPOGRAPHY HISTOGRAM ───────────────────────────────────────────
  // Distinct (tag, font-size, weight) triples with counts. This is the shape
  // that makes a frozen font-size visible: you cannot grep for an ABSENT
  // declaration, but you can see that `button` sits at 13.33px while
  // everything else moved.
  const typo = {};
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    const k = `${el.tagName.toLowerCase()}|${Math.round(parseFloat(cs.fontSize) * 100) / 100}|${cs.fontWeight}`;
    typo[k] = (typo[k] || 0) + 1;
  }

  // ── 5. GEOMETRY ───────────────────────────────────────────────────────
  const de = document.documentElement;
  const geometry = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    docScrollWidth: de.scrollWidth,
    docClientWidth: de.clientWidth,
    horizontalOverflow: de.scrollWidth > de.clientWidth,
    bodyScrollHeight: document.body.scrollHeight,
    theme: de.getAttribute('data-theme') || '(system)',
    fontScale: getComputedStyle(de).getPropertyValue('--font-scale').trim(),
    booted: !!window.__curatorBooted,
  };

  return {
    guard: { port: location.port, href: location.href, innerWidth: window.innerWidth },
    stylesheets, controls, text, textTotal, typography: typo, geometry,
  };
}

/**
 * Every element's computed font-size, keyed by identity. Run twice — once at
 * --font-scale 1 and once at the largest preset — and diff. An element whose
 * size does NOT move is frozen against the app's own text-size setting.
 *
 * This measures the defect DIRECTLY rather than scanning for a declaration.
 * A form control with no font-size rule at all takes the UA default and is
 * frozen; there is no declaration anywhere to grep for, which is exactly why
 * the class went undetected.
 */
export function measureFontSizes(expectPort) {
  if (String(location.port) !== String(expectPort)) {
    throw new Error(`origin guard: measuring port ${location.port}, expected ${expectPort}`);
  }
  if (!window.innerWidth) throw new Error('origin guard: zero-width viewport');
  const out = {};
  let i = 0;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
    if (!own.trim()) continue;                       // only text-bearing elements
    // The id belongs in the identity. Without it the font-scale control's own
    // planted element (`div#__vh_frozen`, no class) was correctly DETECTED as
    // frozen and then not recognised, because its key was a bare `N|div`.
    // An identity that cannot name the thing it found is barely a finding.
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    out[`${i++}|${tag}${id}${cls ? '.' + cls : ''}`] = Math.round(parseFloat(cs.fontSize) * 100) / 100;
  }
  return out;
}

/** Set the app's own text-scale variable, exactly the way the app does. */
export function setFontScale(expectPort, value) {
  if (String(location.port) !== String(expectPort)) {
    throw new Error(`origin guard: wrong port ${location.port}`);
  }
  document.documentElement.style.setProperty('--font-scale', String(value));
  return getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim();
}

/** Switch theme the way the app does (attribute on <html>). */
export function setTheme(expectPort, theme) {
  if (String(location.port) !== String(expectPort)) {
    throw new Error(`origin guard: wrong port ${location.port}`);
  }
  document.documentElement.setAttribute('data-theme', theme);
  return document.documentElement.getAttribute('data-theme');
}

/** Click a rail button to enter a view; returns the view actually active. */
export function gotoView(expectPort, view) {
  if (String(location.port) !== String(expectPort)) {
    throw new Error(`origin guard: wrong port ${location.port}`);
  }
  const btn = document.querySelector(`#rail .rail-btn[data-view="${view}"]`);
  if (!btn) return { ok: false, reason: `no rail button for "${view}"` };
  btn.click();
  const active = document.querySelector('#rail .rail-btn.active')?.getAttribute('data-view') || null;
  return { ok: true, active };
}

/** The list of views the rail actually offers — never a hardcoded list here. */
export function railViews(expectPort) {
  if (String(location.port) !== String(expectPort)) {
    throw new Error(`origin guard: wrong port ${location.port}`);
  }
  return [...document.querySelectorAll('#rail .rail-btn[data-view]')]
    .map(b => b.getAttribute('data-view'));
}

/**
 * Pick points whose painted pixel is UNAMBIGUOUSLY one element's composited
 * background, and report what our CSS-chain model says that pixel should be.
 * The harness then screenshots a 1x1 clip at each point and compares.
 *
 * This is the control on the contrast machinery itself. This project has
 * shipped a helper that read 2.34 for an element genuinely at 7.26 and another
 * that read a badge at 1.90 that is 13.81 composited. Both were believed
 * because the model was never checked against paint. Here it is.
 *
 * A point qualifies only when `elementFromPoint` returns the container itself
 * and the container has no direct text node, so no glyph can be under the
 * sample.
 */
export function backdropSamples(expectPort, limit) {
  if (String(location.port) !== String(expectPort)) {
    throw new Error(`origin guard: wrong port ${location.port}`);
  }
  if (!window.innerWidth) throw new Error('origin guard: zero-width viewport');

  const cvs = document.createElement('canvas');
  cvs.width = 1; cvs.height = 1;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  function toRGBA(css) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0,0,0,0)';
    try { ctx.fillStyle = css; } catch { return null; }
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  function over(fg, bg) {
    const a = fg[3];
    if (a >= 1) return [fg[0], fg[1], fg[2], 1];
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
  }
  function backdropOf(el) {
    const stack = [];
    let node = el, opaque = null;
    while (node) {
      const c = toRGBA(getComputedStyle(node).backgroundColor);
      if (c && c[3] > 0) { if (c[3] >= 1) { opaque = c; break; } stack.push(c); }
      node = node.parentElement;
    }
    let assumed = false;
    if (!opaque) { opaque = [255, 255, 255, 1]; assumed = true; }
    let out = opaque;
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return { rgba: out, assumed };
  }
  function key(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  }

  const out = [];
  let considered = 0;
  // Elements that paint their OWN content rather than a CSS background: an
  // SVG paints stroke/fill geometry, an <img>/<canvas>/<video> paints pixels.
  // The model composites background-COLOUR, so at a point inside one of these
  // the painted pixel is legitimately not what the model describes. Found by
  // this check firing on the rail icons -- and it is a SCOPE limit, not a
  // model error, so they are excluded rather than the tolerance being widened.
  const PAINTS_OWN_CONTENT = new Set(['IMG', 'CANVAS', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED']);
  for (const el of document.querySelectorAll('body *')) {
    if (out.length >= limit) break;
    considered++;
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;   // SVG/MathML
    if (PAINTS_OWN_CONTENT.has(el.tagName)) continue;
    let ownText = '';
    for (const n of el.childNodes) if (n.nodeType === 3) ownText += n.nodeValue;
    if (ownText.trim()) continue;                     // a glyph could be under us
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 1) continue;
    // The model composites background-COLOUR only. Where anything else paints
    // -- an image or gradient, a box-shadow, a filter -- the model is not
    // applicable and validating against it would report a false disagreement.
    // Skip rather than fudge; `eligible` in the report says how many survived.
    if (cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' || cs.filter !== 'none') continue;

    // Sample inside the FILL, clear of the border stroke and the corner curve.
    // Found by this check failing on `.rail-btn.active`: a fixed +3,+3 offset
    // on a 40x40 button with `border-radius: 9px` and a 1px border lands on
    // the rounded corner, where the painted pixel is the border/backdrop and
    // not the element's own background at all. The model was right; the SAMPLE
    // POINT was wrong -- which is the same shape of error as the contrast
    // helpers this project has already been misled by.
    const radius = Math.max(
      parseFloat(cs.borderTopLeftRadius) || 0,
      parseFloat(cs.borderTopRightRadius) || 0,
      parseFloat(cs.borderBottomLeftRadius) || 0,
    );
    const bw = Math.max(
      parseFloat(cs.borderTopWidth) || 0,
      parseFloat(cs.borderLeftWidth) || 0,
    );
    const inset = Math.ceil(Math.max(radius, bw) + 2);
    if (r.width < inset * 2 + 4 || r.height < inset * 2 + 4) continue;
    const x = Math.round(r.left + inset), y = Math.round(r.top + inset);
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
    if (document.elementFromPoint(x, y) !== el) continue;
    // elementFromPoint already excludes any element PAINTED over this point,
    // but an SVG only "hits" on its painted geometry -- a point inside an
    // icon's bbox but between its strokes returns the container while an
    // anti-aliased edge one pixel away is still ink. So exclude the whole
    // bbox of any self-painting descendant geometrically, rather than
    // excluding every container that happens to contain an icon (which
    // narrowed this control to 6 samples out of 103 candidates).
    let overlapsInk = false;
    for (const sub of el.querySelectorAll('svg, img, canvas, video')) {
      const sr = sub.getBoundingClientRect();
      if (x >= sr.left - 2 && x <= sr.right + 2 && y >= sr.top - 2 && y <= sr.bottom + 2) { overlapsInk = true; break; }
    }
    if (overlapsInk) continue;
    const b = backdropOf(el);
    if (b.assumed) continue;                          // nothing to validate against
    out.push({ key: key(el), point: [x, y], modelled: b.rgba.map(v => Math.round(v)) });
  }
  // `considered` makes it visible when the eligibility rules have narrowed so
  // far that the control is validating almost nothing -- a control that
  // rarely runs is barely a control.
  return { considered, samples: out };
}

/**
 * Survey every info affordance (`renderViewHeader`'s circled-i) on screen and
 * the panel each one claims to control.
 *
 * WHY THIS IS A BROWSER PROBE AND NOT A SOURCE SCAN
 * The static guard in test-next-view-header.js proves panel ids are UNIQUE.
 * It cannot prove the RIGHT PANEL OPENS, and in v3.24.0 those two came apart:
 * a sidebar header and a main header of the same view derived the same panel
 * id, `document.getElementById` returned the first in document order, and
 * clicking the MAIN mark opened the SIDEBAR's panel while the main panel sat
 * at 0x0 with `offsetParent === null`. Every attribute-level assertion passed
 * — `aria-expanded` flipped to "true" on the right button — while the prose
 * was unreachable by mouse, keyboard and screen reader alike. Only geometry
 * measured in a real browser separates those two states.
 *
 * IDENTITY, NOT COPY. Each mark records `ownHeaderPanelId`: the id of the
 * `.tx-vh-panel` that is a DOM descendant of the SAME `header.tx-vh`. That is
 * the invariant a caller asserts against, so this probe never needs to know
 * what any panel says. Pinning a sentence would make the suite fail on a copy
 * edit and pass on a re-collision the day someone reworded both panels alike.
 */
export function infoPanelSurvey(expectPort) {
  if (String(location.port) !== String(expectPort)) {
    throw new Error(`origin guard: measuring port ${location.port}, expected ${expectPort}`);
  }
  if (!window.innerWidth) throw new Error('origin guard: zero-width viewport');

  const headers = Array.prototype.slice.call(document.querySelectorAll('header.tx-vh'));
  // ADDRESS PANELS BY POSITION, NOT BY ID. Under the very defect this suite
  // exists to catch, two panels SHARE an id — so a lookup keyed on the id
  // returns whichever comes first in document order and cannot tell the two
  // apart. A `find(p => p.id === expected)` therefore reports the sidebar's
  // panel as the main header's own and passes while the bug is live: measured,
  // it read back the sidebar's 65-character prose for a main panel holding 231.
  // The NodeList index is unique by construction, so the behavioural assertion
  // keeps discriminating exactly where id-matching stops.
  const panelEls = Array.prototype.slice.call(document.querySelectorAll('div.tx-vh-panel'));
  const idxOf = (el) => {
    const h = el && el.closest ? el.closest('header.tx-vh') : null;
    return h ? headers.indexOf(h) : -1;
  };
  const regionOf = (el) => {
    const h = el && el.closest ? el.closest('header.tx-vh') : null;
    return h && h.classList.contains('tx-vh-sidebar') ? 'sidebar' : 'main';
  };

  // Duplicate ids are measured across the WHOLE document, not just headers.
  // The defect was a collision between two panels, but the same collision can
  // arrive from any other pair, and `getElementById` is document-wide.
  const allIds = Array.prototype.slice.call(document.querySelectorAll('[id]')).map((e) => e.id);
  const seen = Object.create(null);
  const dup = Object.create(null);
  for (const id of allIds) { if (seen[id]) dup[id] = true; seen[id] = true; }

  const marks = Array.prototype.slice.call(document.querySelectorAll('button.tx-vh-info')).map((b) => {
    const header = b.closest('header.tx-vh');
    const target = b.getAttribute('data-tx-info');
    // What getElementById ACTUALLY resolves to — the measured failure mode.
    const resolved = target ? document.getElementById(target) : null;
    const ownPanel = header ? header.querySelector('div.tx-vh-panel') : null;
    const titleEl = header ? header.querySelector('.tx-vh-title') : null;
    // TWO PRODUCERS EMIT THIS AFFORDANCE, not one. `renderViewHeader` in
    // shared/text.js derives its ids from the title (the collision-prone case),
    // and settings.js's local `infoMark` takes an explicit id and renders
    // OUTSIDE any header — beside the build-lane chip. Both are driven by the
    // same delegated listener, so both are in scope here. A survey that
    // recognised only header marks would have reported the standalone one as
    // broken forever, and would have said nothing at all if it really broke.
    //
    // What both producers share is the pairing convention `btn.id === panel.id
    // + '-btn'`, so the expected panel is derived from the header when there is
    // one (which is what pins the v3.24.0 shape) and from that convention when
    // there is not.
    const pairedId = /-btn$/.test(b.id) ? b.id.replace(/-btn$/, '') : null;
    const expectedPanelId = ownPanel ? ownPanel.id : pairedId;
    // Resolved by ELEMENT IDENTITY for a header mark; a standalone mark has no
    // header, so it falls back to first-id-match — which is unambiguous only
    // while ids are unique, and the document-wide uniqueness assertion is what
    // guarantees that. Stated so the weaker half is not mistaken for the strong one.
    const expectedPanelIdx = ownPanel
      ? panelEls.indexOf(ownPanel)
      : panelEls.findIndex(function (p) { return p.id === pairedId; });
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const onScreen = r.width > 0 && r.height > 0
      && cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
    let topAtCentre = 'off-screen';
    if (onScreen) {
      const hit = document.elementFromPoint(cx, cy);
      topAtCentre = !hit ? 'none'
        : (hit.closest && hit.closest('button.tx-vh-info') === b ? 'self'
          : hit.tagName + (hit.className ? '.' + String(hit.className).split(/\s+/)[0] : ''));
    }
    return {
      headerIdx: idxOf(b),
      producer: header ? 'view-header' : 'standalone',
      region: regionOf(b),
      title: titleEl ? (titleEl.textContent || '').trim() : null,
      btnId: b.id,
      target,
      ariaControls: b.getAttribute('aria-controls'),
      ariaExpanded: b.getAttribute('aria-expanded'),
      ownHeaderPanelId: ownPanel ? ownPanel.id : null,
      expectedPanelId,
      expectedPanelIdx,
      followsBtnIdConvention: pairedId !== null,
      // Only meaningful for a header mark; a standalone mark has no header to
      // be contained by, and `null` says so rather than reading as a failure.
      resolvesToPanelInSameHeader: header ? !!(resolved && header.contains(resolved)) : null,
      // The producer-independent form: whatever getElementById hands the click
      // handler must BE the panel this mark is paired with.
      resolvesToExpectedPanel: !!(resolved && expectedPanelId && resolved.id === expectedPanelId
        && resolved.classList && resolved.classList.contains('tx-vh-panel')),
      // aria-controls and data-tx-info must name the SAME panel; AT follows the
      // former while the click handler follows the latter, so a divergence
      // routes a screen reader and a mouse to different places.
      ariaMatchesTarget: b.getAttribute('aria-controls') === target,
      onScreen,
      topAtCentre,
      cx: Math.round(cx),
      cy: Math.round(cy),
    };
  });

  const panels = panelEls.map((p, idx) => {
    const r = p.getBoundingClientRect();
    return {
      idx,
      id: p.id,
      headerIdx: idxOf(p),
      region: regionOf(p),
      hidden: !!p.hidden,
      // `hidden` is the attribute the handler sets; offsetParent and the rect
      // are whether the user can SEE it. The v3.24.0 panel had hidden=false
      // and a 0x0 rect at the same time, so both are recorded.
      offsetParentNull: p.offsetParent === null,
      w: Math.round(r.width),
      h: Math.round(r.height),
      text: (p.textContent || '').trim().slice(0, 300),
    };
  });

  return {
    guard: { port: String(location.port) },
    headerCount: headers.length,
    dupIds: Object.keys(dup),
    marks,
    panels,
    // Which panels a USER can actually see right now. The suite asserts on
    // this set rather than on `hidden` alone.
    visiblePanelIds: panels.filter((p) => !p.hidden && !p.offsetParentNull && p.w > 0 && p.h > 0).map((p) => p.id),
    visiblePanelIdxs: panels.filter((p) => !p.hidden && !p.offsetParentNull && p.w > 0 && p.h > 0).map((p) => p.idx),
    expandedBtnIds: marks.filter((m) => m.ariaExpanded === 'true').map((m) => m.btnId),
    activeElement: document.activeElement
      ? (document.activeElement.id || document.activeElement.tagName) : null,
  };
}

/**
 * Scroll one info mark to the middle of the viewport and return its FRESH
 * centre, so a click is dispatched at coordinates measured after the scroll.
 *
 * Re-measuring is not defensive tidiness: opening a panel reflows the header,
 * and a survey taken before that reflow can put a later click on whatever slid
 * into the old coordinates. A click that lands somewhere else would still pass
 * an assertion written against `aria-expanded`.
 */
export function markGeometry(expectPort, btnId) {
  if (String(location.port) !== String(expectPort)) {
    throw new Error(`origin guard: measuring port ${location.port}, expected ${expectPort}`);
  }
  if (!window.innerWidth) throw new Error('origin guard: zero-width viewport');
  const b = document.getElementById(btnId);
  if (!b) return { found: false };
  if (b.scrollIntoView) b.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = b.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const onScreen = r.width > 0 && r.height > 0
    && cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
  const hit = onScreen ? document.elementFromPoint(cx, cy) : null;
  return {
    found: true,
    onScreen,
    cx: Math.round(cx),
    cy: Math.round(cy),
    topAtCentre: !onScreen ? 'off-screen'
      : (!hit ? 'none'
        : (hit.closest && hit.closest('button.tx-vh-info') === b ? 'self'
          : hit.tagName + (hit.className ? '.' + String(hit.className).split(/\s+/)[0] : ''))),
  };
}

/**
 * Plant one defect in the LIVE page, or undo it — the control on
 * `infoPanelSurvey`'s own detectors.
 *
 * A clean sweep is worth nothing until each detector has been shown to fire,
 * and this repo has shipped several guards that could not. Planting in the
 * running DOM (rather than mutating source) keeps the control inside the same
 * run that produces the verdict, so a detector that has quietly stopped
 * working cannot be reported as "no defects found".
 *
 * Restore state hangs off `window` because each probe is stringified
 * separately and shares no closure with the last one.
 */
export function mutateForControl(expectPort, kind) {
  if (String(location.port) !== String(expectPort)) {
    throw new Error(`origin guard: measuring port ${location.port}, expected ${expectPort}`);
  }
  if (!window.innerWidth) throw new Error('origin guard: zero-width viewport');
  const KEY = '__curatorInfoPanelControl';

  if (kind === 'restore') {
    const st = window[KEY];
    if (!st) return { restored: false, reason: 'nothing planted' };
    // NOT getElementById(st.id): the id is DUPLICATED by construction here, so
    // it returns the REAL panel (first in document order) and the planted clone
    // would survive the restore — contaminating every later view. That is the
    // very defect this control exists to plant, met inside its own cleanup.
    if (st.kind === 'dup-id') { const n = document.querySelector('[data-curator-control="1"]'); if (n) n.remove(); }
    if (st.kind === 'cross-header') { const b = document.getElementById(st.btnId); if (b) b.setAttribute('data-tx-info', st.prev); }
    if (st.kind === 'occlude') { const n = document.querySelector('[data-curator-control="overlay"]'); if (n) n.remove(); }
    if (st.kind === 'unhide') { const p = document.getElementById(st.id); if (p) p.hidden = true; }
    window[KEY] = null;
    return { restored: true, kind: st.kind };
  }

  const marks = Array.prototype.slice.call(document.querySelectorAll('button.tx-vh-info'));
  const panels = Array.prototype.slice.call(document.querySelectorAll('div.tx-vh-panel'));

  if (kind === 'dup-id') {
    if (!panels.length) return { planted: false, reason: 'no panel on screen' };
    // Clone an id that is currently UNIQUE. A control must introduce a NEW
    // defect: re-planting one the page already has changes nothing observable,
    // and the detector then reads as "did not fire" when the truth is "was
    // already true". Refusing with a reason says which of the two it is.
    const counts = Object.create(null);
    Array.prototype.slice.call(document.querySelectorAll('[id]')).forEach((e) => { counts[e.id] = (counts[e.id] || 0) + 1; });
    const target = panels.filter((p) => p.id && counts[p.id] === 1)[0];
    if (!target) return { planted: false, reason: 'no panel carries a unique id — the page already has the defect this control plants' };
    const id = target.id;
    const clone = document.createElement('div');
    clone.id = id;                       // the collision itself
    clone.dataset.curatorControl = '1';
    document.body.appendChild(clone);
    window[KEY] = { kind, id };
    return { planted: true, id };
  }
  if (kind === 'cross-header') {
    // Point a mark at a panel in a DIFFERENT header — the shape of the bug.
    // The foreign panel must be DISTINGUISHABLE from the mark's current target,
    // or the repoint is a no-op — which is exactly what happens on a page whose
    // ids have already collided. Same rule as dup-id above.
    let b = null, foreign = null;
    for (const m of marks) {
      const own = m.closest('header.tx-vh');
      if (!own) continue;
      const cand = panels.filter((p) => !own.contains(p) && p.id && p.id !== m.getAttribute('data-tx-info'))[0];
      if (cand) { b = m; foreign = cand; break; }
    }
    if (!b) return { planted: false, reason: 'no mark could be repointed at a DISTINCT panel in another header' };
    const own = b.closest('header.tx-vh');
    const prev = b.getAttribute('data-tx-info');
    b.setAttribute('data-tx-info', foreign.id);
    window[KEY] = { kind, btnId: b.id, prev };
    return { planted: true, btnId: b.id, pointedAt: foreign.id };
  }
  if (kind === 'occlude') {
    if (!marks.length) return { planted: false, reason: 'no mark on screen' };
    const r = marks[0].getBoundingClientRect();
    const o = document.createElement('div');
    o.dataset.curatorControl = 'overlay';
    o.style.cssText = 'position:fixed;z-index:99999;left:' + (r.left - 4) + 'px;top:' + (r.top - 4)
      + 'px;width:' + (r.width + 8) + 'px;height:' + (r.height + 8) + 'px;background:transparent';
    document.body.appendChild(o);
    window[KEY] = { kind };
    return { planted: true, btnId: marks[0].id };
  }
  if (kind === 'unhide') {
    if (!panels.length) return { planted: false, reason: 'no panel on screen' };
    panels[0].hidden = false;
    window[KEY] = { kind, id: panels[0].id };
    return { planted: true, id: panels[0].id };
  }
  return { planted: false, reason: `unknown kind ${kind}` };
}
