/**
 * WCAG contrast maths — PURE, dependency-free, and unit-testable in plain Node.
 *
 * WHY THIS IS A SEPARATE MODULE WITH ITS OWN CONTROLS
 * --------------------------------------------------
 * This repo's history records a contrast helper that reported 2.34 for an
 * element genuinely at 7.26, and another that read a badge at 1.90 because it
 * treated a TRANSLUCENT tint as opaque when composited it is 13.81. Both were
 * believed because nothing checked the helper itself.
 *
 * So: the maths lives here, alone, in functions that take plain numbers; and
 * `test-visual-contrast-math.js` pins it with controls that MUST hold —
 * an identical pair returns 1.00, black-on-white returns exactly 21, and a
 * translucent foreground composited over its real backdrop returns a
 * materially different number from the naive opaque reading.
 *
 * COLOUR PARSING IS DELIBERATELY NOT DONE HERE.
 * getComputedStyle can serialize a colour as rgb(), rgba(), color(srgb ...),
 * oklch(), lab(), or a named keyword, and that set grows with every Chrome
 * release. Rather than chase it, the harness resolves every colour IN THE PAGE
 * with a 1x1 canvas (`resolveColorInPage`), which is the browser's own colour
 * parser, and passes plain [r,g,b,a] tuples in here. `parseSimpleCssColor`
 * below exists only for tests and for reading a hex token out of a stylesheet;
 * it is NOT on the measurement path.
 */

/** sRGB 0-255 channel -> linear-light 0-1. WCAG 2.2 threshold (0.04045). */
function channelToLinear(c255) {
  const c = c255 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance of an OPAQUE colour.
 * @param {[number,number,number,number?]} rgba 0-255 channels; alpha ignored.
 */
export function relativeLuminance(rgba) {
  const [r, g, b] = rgba;
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/**
 * Source-over composite: paint `fg` (which may be translucent) onto `bg`
 * (which MUST be opaque) and return the opaque result.
 *
 * This is the step whose absence produced a 1.90 reading for a 13.81 element.
 * A tinted surface in this app is routinely `rgba(r,g,b,0.08)`; reading that
 * as if it were opaque is not a rounding error, it inverts the verdict.
 */
export function compositeOver(fg, bg) {
  const a = fg[3] === undefined ? 1 : fg[3];
  if (a >= 1) return [fg[0], fg[1], fg[2], 1];
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
}

/**
 * Flatten a stack of layers, back-to-front, onto an opaque base.
 * @param {Array<[number,number,number,number]>} layers front-most LAST.
 * @param {[number,number,number,number]} base must be opaque.
 */
export function flattenStack(layers, base) {
  let out = [base[0], base[1], base[2], 1];
  for (const layer of layers) out = compositeOver(layer, out);
  return out;
}

/**
 * WCAG contrast ratio between two OPAQUE colours. Range 1..21.
 * Callers must composite translucent colours first — this function cannot
 * tell that it was handed a lie, which is exactly why compositing is a
 * separate, separately-tested step.
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Round to 2dp the way the reports quote it. */
export const round2 = (n) => Math.round(n * 100) / 100;

/**
 * WCAG floors this project actually cites.
 *   4.5 — normal body text (1.4.3 AA)
 *   3.0 — large text (>=24px, or >=18.66px bold) AND non-text UI components (1.4.11)
 */
export const FLOOR_TEXT_AA = 4.5;
export const FLOOR_LARGE_TEXT = 3.0;
export const FLOOR_NON_TEXT = 3.0;

/** True when this font-size/weight qualifies as WCAG "large text". */
export function isLargeText(fontSizePx, fontWeight) {
  const w = Number(fontWeight) || 400;
  if (fontSizePx >= 24) return true;
  return w >= 700 && fontSizePx >= 18.66;
}

/** The floor a piece of TEXT must clear, given its size/weight. */
export function textFloorFor(fontSizePx, fontWeight) {
  return isLargeText(fontSizePx, fontWeight) ? FLOOR_LARGE_TEXT : FLOOR_TEXT_AA;
}

/**
 * FALLBACK parser — tests and stylesheet-token reading only, NOT the
 * measurement path (see the header). Handles #rgb/#rrggbb/#rrggbbaa,
 * rgb()/rgba() with comma or space syntax. Returns null on anything else,
 * deliberately, rather than guessing: a wrong colour silently produces a
 * wrong contrast verdict, and null is loud.
 */
export function parseSimpleCssColor(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];

  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    const exp = (c) => parseInt(c + c, 16);
    if (h.length === 3) return [exp(h[0]), exp(h[1]), exp(h[2]), 1];
    if (h.length === 4) return [exp(h[0]), exp(h[1]), exp(h[2]), exp(h[3]) / 255];
    if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
    if (h.length === 8) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255];
    return null;
  }

  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[,\/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const r = num(parts[0]), g = num(parts[1]), b = num(parts[2]);
    let a = 1;
    if (parts.length >= 4) a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if ([r, g, b, a].some((v) => Number.isNaN(v))) return null;
    return [r, g, b, a];
  }
  return null;
}
