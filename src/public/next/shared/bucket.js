// ═══════════════════════════════════════════════════════════════════════════
//  shared/bucket.js — THE WINDOW METER: the SEGMENTED depth bar (v3.70.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// Design rule 6, as amended in v3.70.0: a depth bar may be SEGMENTED — several
// shares of ONE named denominator, stacked in one bar. Two denominators here,
// and each bar says which it is drawing against:
//
//   THE WINDOW, TO SCALE   the whole context window (200K / 1M …). It holds
//                          the harness (hatched, "your estimate" — never
//                          measured, never summed into a measured figure),
//                          The Curator (violet), and free space.
//   THE CURATOR, ENLARGED  The Curator's part on its OWN scale: the fixed
//                          layers plus the reading-budget ceiling, so the
//                          budget shows as a dashed ROOM — empty, and labelled
//                          so, when nothing is read first. That empty room is
//                          what explains why every preset reads the same.
//
// It NEVER turns danger-toned: a window is not a budget the owner set, and
// the reading budget is a ceiling the store enforces, never over-run.
//
// ── THE API (pure functions, HTML strings, no DOM, no imports) ─────────────
//
//   The one input, `m`:
//   {
//     windowTokens:  1000000,            // the window size (> 0, else nothing renders)
//     harnessTokens: 120000 | null,      // the owner's estimate; null = Not set
//     layers: [                          // in drawing order; tokens are ≈ bytes / 4
//       { key: 'framing', label: 'framing',       tokens: 925 },
//       { key: 'brief',   label: 'brief',         tokens: 3500 },
//       { key: 'handoff', label: 'handoff',       tokens: 500 },
//       { key: 'journal', label: 'journal',       tokens: 1025 },
//       { key: 'index',   label: 'document list', tokens: 850 },
//       { key: 'read',    label: 'read first',    tokens: 0,
//         parts: [                       // OPTIONAL (v3.70.1): one per document,
//           { label: 'decisions-app',    // in delivery order; the enlargement
//             title: 'Decisions — app',  // draws each as its own segment and
//             tokens: 7200, page: 1 },   // marks where reply 2 begins
//         ] },
//     ],                                 // key ∈ LAYER_KEYS picks the colour;
//                                        // any other key draws as 'other'
//     budgetTokens:  16384,              // the reading-budget ceiling (read-first)
//     onDemand: { tokens: 47900, documents: 9 } | number | null,  // OUTSIDE the window
//     delivery: { replies: 2, replyTokens: 20000 } | null,
//     preview:  false,                   // true = a what-if, not saved
//   }
//
//   renderBucket(m)          the whole instrument: window bar, zoom lines,
//                            enlargement, legend, delivery line. Hosts that
//                            want the pieces call them one by one:
//   renderWindowBar(m)       head line + the window to scale + the token axis
//                            (+ the "harness not set" note when it is null)
//   renderZoomLink(m)        the dotted lines from the Curator's sliver down
//   renderEnlargement(m)     The Curator's part, enlarged, with the dashed room
//   renderLegend(m)          every layer with its figure, the harness, the
//                            room and the "on demand — outside the window" chip
//   renderDeliveryLine(m)    "Preview, not saved · … · N MCP replies" or
//                            "Delivered in N MCP replies …" ('' when neither)
//   bucketText(m)            THE TEXT ALTERNATIVE: { window, enlargement,
//                            delivery, onDemand, lines[] } — plain sentences.
//                            Each bar is role="img" with its sentence as the
//                            aria-label; the host's monitor stays the
//                            copyable text twin (design §2).
//   renderBucketText(m)      the same sentences as a visually-hidden <ul>,
//                            for a host that has no monitor beside the meter
//   bucketModel(m)           the normalised geometry the renderers draw
//                            (percentages, room, labels) — for tests and for
//                            the widget's gutter PNG
//   formatTokens(n)          "0" · "0.5k" · "6.9k" · "873k" · "1M" · "1.5M"
//
// ── ACCESSIBILITY: colour is never the only channel ────────────────────────
//   · every segment wide enough carries its name ON it; below ~560px of bar
//     the inline names drop (a container query in bucket.css) and the legend,
//     which ALWAYS lists every layer with its figure, carries them;
//   · the harness is a HATCH, the room and on-demand are DASHED outlines;
//   · each bar is role="img" with a full sentence; the head lines say "to
//     scale" and "enlarged" in words;
//   · The Curator's share of a 1M window can be a fraction of a pixel, so its
//     segment has a CSS min-width and the head line states the true figure.
//
// ── PER-DOCUMENT SEGMENTS (v3.70.1, the planner) ───────────────────────────
//   A 'read' layer may carry `parts`. The enlargement then splits that layer
//   into one segment per document — the SAME violet step, thin separators —
//   each labelled on the bar when it fits and ALWAYS in the legend with its
//   tokens. The parts share the layer's width in proportion to their tokens,
//   so the layer's own figure (and every other segment) is exactly what it is
//   without them. When the parts arrive in more than one MCP reply, the
//   segment that opens a reply is marked (`bk-page-start`) and a thin "reply
//   N" strip runs under the bar. A layer WITHOUT parts renders byte for byte
//   as v3.70.0 did.
//
// Every caller string is escaped; a layer KEY is looked up in a frozen table,
// never interpolated, so an unknown key yields the 'other' class.

export const LAYER_KEYS = Object.freeze(['framing', 'brief', 'handoff', 'journal', 'index', 'read']);

/** The bar width, in CSS px, below which inline segment names drop to the
 *  legend (bucket.css's container query uses the same figure). A label is
 *  only placed ON a segment if it would fit at this width. */
export const LABEL_MIN_BAR_PX = 560;
/** At or above this bar width a LONGER label may replace the short one
 *  (bucket.css swaps them with the same container-query figure). */
export const LABEL_WIDE_BAR_PX = 880;
/** How many documents the legend names one by one before "+ N more". */
export const LEGEND_PARTS_MAX = 12;
const CHAR_PX = 6.8;     // 11px IBM Plex Mono advance, measured ≈ 6.6
const LABEL_PAD_PX = 14;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A count of tokens: a finite number ≥ 0, else 0. */
function num(n) {
  const v = typeof n === 'number' ? n : Number.NaN;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Percentage with at most 4 decimals, as a CSS-safe string. */
function pct(v) {
  const r = Math.round(v * 10000) / 10000;
  return String(r);
}

export function formatTokens(n) {
  const v = num(n);
  if (v === 0) return '0';
  if (v >= 1e6) {
    const m = Math.round(v / 1e5) / 10;
    return (Number.isInteger(m) ? String(m) : m.toFixed(1)) + 'M';
  }
  if (v >= 1e5) return Math.round(v / 1000) + 'k';
  const k = Math.round(v / 100) / 10;
  if (k >= 100) return Math.round(v / 1000) + 'k';
  if (k >= 10 && Number.isInteger(k)) return k + 'k';   // "20k", not "20.0k"
  return (k === 0 ? '0.1' : k.toFixed(1)) + 'k';
}

function share(part, whole) {
  if (!(whole > 0)) return 0;
  const p = (part / whole) * 100;
  return p < 0.05 && part > 0 ? p.toFixed(2) + '%' : (Math.round(p * 10) / 10).toFixed(1) + '%';
}

/** Would `text` fit on a segment of `widthPct` percent of a `barPx` bar? */
function fits(text, widthPct, barPx) {
  return (widthPct / 100) * barPx >= text.length * CHAR_PX + LABEL_PAD_PX;
}
/** The first candidate that fits at `barPx`, or '' (the legend carries it). */
function pickAt(candidates, widthPct, barPx) {
  for (const c of candidates) if (c && fits(c, widthPct, barPx)) return c;
  return '';
}
/** A segment's two labels: `short` fits a 560px bar, `wide` an 880px one
 *  (it equals `short` when nothing longer fits). Both '' = legend only. */
function pickLabel(candidates, widthPct) {
  const short = pickAt(candidates, widthPct, LABEL_MIN_BAR_PX);
  const wide = pickAt(candidates, widthPct, LABEL_WIDE_BAR_PX) || short;
  return { short, wide };
}
/** The label markup: one span, or a wide/short pair the container swaps. */
function labelHtml(lab) {
  if (!lab.wide) return '';
  if (lab.wide === lab.short) return '<span>' + escapeHtml(lab.short) + '</span>';
  return '<span class="bk-l-wide">' + escapeHtml(lab.wide) + '</span>'
    + (lab.short ? '<span class="bk-l-short">' + escapeHtml(lab.short) + '</span>' : '');
}

function onDemandOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return num(v) > 0 ? { tokens: num(v), documents: null } : null;
  if (typeof v === 'object') {
    const t = num(v.tokens);
    const d = Number.isInteger(v.documents) && v.documents >= 0 ? v.documents : null;
    if (t === 0 && !d) return null;
    return { tokens: t, documents: d };
  }
  return null;
}

/** A read layer's documents: `[{label, title, tokens, page}]`, or null when
 *  there are none (the layer then draws as one segment, as in v3.70.0). */
function partsOf(v) {
  if (!Array.isArray(v)) return null;
  const out = v.filter((p) => p && typeof p === 'object' && typeof p.label === 'string' && p.label.trim())
    .slice(0, 400)
    .map((p) => ({
      label: p.label.trim(),
      title: typeof p.title === 'string' && p.title.trim() ? p.title.trim() : p.label.trim(),
      tokens: num(p.tokens),
      page: Number.isInteger(p.page) && p.page > 0 ? p.page : 1,
    }));
  return out.length ? out : null;
}

/**
 * The normalised geometry. Pure; every renderer below draws from it.
 * @returns {null | object} null when there is no window to draw against.
 */
export function bucketModel(m) {
  if (!m || typeof m !== 'object') return null;
  const windowTokens = num(m.windowTokens);
  if (windowTokens === 0) return null;
  const harnessSet = m.harnessTokens !== null && m.harnessTokens !== undefined && num(m.harnessTokens) > 0;
  const harness = harnessSet ? num(m.harnessTokens) : 0;

  const layers = (Array.isArray(m.layers) ? m.layers : [])
    .filter((l) => l && typeof l === 'object')
    .map((l) => {
      const out = {
        key: LAYER_KEYS.includes(l.key) ? l.key : 'other',
        label: typeof l.label === 'string' && l.label.trim() ? l.label.trim() : (LAYER_KEYS.includes(l.key) ? l.key : 'other'),
        tokens: num(l.tokens),
      };
      const parts = out.key === 'read' ? partsOf(l.parts) : null;
      return parts ? { ...out, parts } : out;
    });
  const curator = layers.reduce((a, l) => a + l.tokens, 0);
  const readTokens = layers.filter((l) => l.key === 'read').reduce((a, l) => a + l.tokens, 0);
  const fixed = curator - readTokens;
  const budget = num(m.budgetTokens);

  // ── The window, to scale ────────────────────────────────────────────────
  const used = harness + curator;
  const over = Math.max(0, used - windowTokens);
  const scale = Math.max(windowTokens, used);      // an over-full window squeezes, never overflows
  const harnessPct = (harness / scale) * 100;
  const curatorPct = (curator / scale) * 100;
  const free = Math.max(0, windowTokens - used);
  const freePct = Math.max(0, 100 - harnessPct - curatorPct);

  // ── The enlargement: fixed layers + the reading-budget ceiling ──────────
  const room = Math.max(0, budget - readTokens);
  const zoomDenom = fixed + Math.max(budget, readTokens);
  const zoomLayers = layers.map((l) => {
    const w = zoomDenom > 0 ? (l.tokens / zoomDenom) * 100 : 0;
    const base = { ...l, pct: w, text: pickLabel([l.label + ' ' + formatTokens(l.tokens)], w) };
    if (!l.parts) return base;
    // The parts SHARE the layer's width by their own tokens, so the layer
    // keeps its exact figure whatever each document's rounding.
    const sum = l.parts.reduce((a, p) => a + p.tokens, 0);
    let at = 0;
    const parts = l.parts.map((p, i) => {
      const pw = sum > 0 ? (p.tokens / sum) * w : 0;
      const part = { ...p, pct: pw, at, pageStart: i > 0 && p.page !== l.parts[i - 1].page,
        text: pickLabel([p.label + ' ' + formatTokens(p.tokens), p.label], pw) };
      at += pw;
      return part;
    });
    return { ...base, parts };
  });
  // Where each reply's documents sit on the enlarged bar — only when the
  // documents arrive in more than one reply. Reply 1 also carries the fixed
  // layers, so it runs from the bar's start.
  const readZoom = zoomLayers.find((l) => l.parts);
  let pages = null;
  if (readZoom) {
    const offset = zoomLayers.slice(0, zoomLayers.indexOf(readZoom)).reduce((a, l) => a + l.pct, 0);
    const seen = [];
    for (const p of readZoom.parts) {
      const last = seen[seen.length - 1];
      if (!last || last.page !== p.page) seen.push({ page: p.page, from: offset + p.at, to: offset + p.at + p.pct, first: p.label });
      else last.to = offset + p.at + p.pct;
    }
    if (seen.length > 1) {
      seen[0].from = 0;
      pages = seen.map((x) => ({ ...x, pct: x.to - x.from, text: pickLabel(['reply ' + x.page], x.to - x.from) }));
    }
  }
  const roomPct = zoomDenom > 0 ? (room / zoomDenom) * 100 : 0;
  let roomState;                                    // 'unused' | 'left' | 'full' | 'none'
  if (budget === 0) roomState = 'none';
  else if (readTokens === 0) roomState = 'unused';
  else if (room > 0) roomState = 'left';
  else roomState = 'full';
  // v3.76.0: "≈" like every other token figure on this meter — the budget is
  // set in bytes and shown as bytes ÷ 4, an estimate like the rest.
  const roomWords = roomState === 'unused'
    ? 'reading budget ≈' + formatTokens(budget) + ' — unused: nothing is read first'
    : roomState === 'left' ? 'budget left ≈' + formatTokens(room) : '';
  const roomText = roomState === 'unused'
    ? pickLabel([roomWords, 'budget ≈' + formatTokens(budget) + ' — unused', 'unused'], roomPct)
    : roomState === 'left' ? pickLabel([roomWords, '≈' + formatTokens(room) + ' left'], roomPct) : { short: '', wide: '' };

  return {
    windowTokens, harnessSet, harness, curator, used, over, free,
    harnessPct, curatorPct, freePct,
    harnessText: harnessSet ? pickLabel(['harness ≈' + formatTokens(harness) + ' · your estimate', 'harness ≈' + formatTokens(harness), 'harness'], harnessPct) : { short: '', wide: '' },
    freeText: pickLabel(['free ≈' + formatTokens(free), '≈' + formatTokens(free)], freePct),
    layers: zoomLayers, pages, readTokens, fixed, budget, room, roomPct, roomState, roomWords, roomText,
    onDemand: onDemandOf(m.onDemand),
    delivery: m.delivery && typeof m.delivery === 'object' && Number.isInteger(m.delivery.replies) && m.delivery.replies > 0
      ? { replies: m.delivery.replies, replyTokens: num(m.delivery.replyTokens) || 20000 } : null,
    preview: m.preview === true,
  };
}

// ── The text alternative ──────────────────────────────────────────────────
export function bucketText(m) {
  const g = bucketModel(m);
  if (!g) return null;
  const W = formatTokens(g.windowTokens);
  const pre = g.preview ? 'Preview, not saved: ' : '';
  const win = pre + 'A ' + W + '-token window, drawn to scale: '
    + (g.harnessSet ? 'harness about ' + formatTokens(g.harness) + ' (your estimate, not measured), ' : '')
    + 'The Curator about ' + formatTokens(g.curator) + ' tokens (measured, ' + share(g.curator, g.windowTokens) + '), '
    + (g.over > 0 ? 'over the window by about ' + formatTokens(g.over) + '.' : 'about ' + formatTokens(g.free) + ' free.')
    + (g.harnessSet ? '' : ' Harness not set: your agent\'s own system prompt, tools and instructions also use this window.');
  const parts = g.layers.map((l) => l.label + ' ' + formatTokens(l.tokens)
    + (l.parts ? ' (' + l.parts.map((p) => p.label + ' ' + formatTokens(p.tokens)).join(', ') + ')' : ''));
  let budgetWords;
  if (g.roomState === 'none') budgetWords = 'no reading budget (index only).';
  else if (g.roomState === 'unused') budgetWords = 'reading budget ≈' + formatTokens(g.budget) + ', unused: nothing is read first.';
  else if (g.roomState === 'left') budgetWords = 'reading budget ≈' + formatTokens(g.budget) + ', ≈' + formatTokens(g.room) + ' left.';
  else budgetWords = 'reading budget ≈' + formatTokens(g.budget) + ', full.';
  const enl = pre + 'The Curator\'s part, enlarged to its own scale: about ' + formatTokens(g.curator) + ' tokens'
    + (parts.length ? ' — ' + parts.join(', ') : '') + '; ' + budgetWords
    + (g.pages ? ' ' + g.pages.slice(1).map((x) => 'Reply ' + x.page + ' starts with ' + x.first + '.').join(' ') : '');
  const delivery = deliveryWords(g);
  const od = g.onDemand
    ? 'On demand, outside the window: '
      + (g.onDemand.documents !== null ? g.onDemand.documents + ' document' + (g.onDemand.documents === 1 ? '' : 's') + ', ' : '')
      + 'about ' + formatTokens(g.onDemand.tokens) + ' tokens, opened only when a task needs them.'
    : '';
  return { window: win, enlargement: enl, delivery, onDemand: od, lines: [win, enl, delivery, od].filter(Boolean) };
}

function deliveryWords(g) {
  const replies = g.delivery ? g.delivery.replies : null;
  const rWord = replies === null ? '' : replies + ' MCP repl' + (replies === 1 ? 'y' : 'ies');
  if (g.preview) {
    return 'Preview, not saved · ≈' + formatTokens(g.curator) + ' tokens · '
      + share(g.curator, g.windowTokens) + ' of ' + formatTokens(g.windowTokens)
      + (rWord ? ' · ' + rWord : '');
  }
  if (!g.delivery) return '';
  return 'Delivered in ' + rWord + ' of at most ≈' + formatTokens(g.delivery.replyTokens) + ' tokens each';
}

export function renderBucketText(m) {
  const t = bucketText(m);
  if (!t) return '';
  return '<ul class="bk-text visually-hidden">' + t.lines.map((s) => '<li>' + escapeHtml(s) + '</li>').join('') + '</ul>';
}

// ── The renderers ─────────────────────────────────────────────────────────
function head(label, scaleWord, figureHtml, preview) {
  return '<div class="bk-head">'
    + '<span class="bk-label">' + escapeHtml(label) + '</span>'
    + '<span class="bk-scale">' + escapeHtml(scaleWord) + '</span>'
    + (preview ? '<span class="bk-preview">preview</span>' : '')
    + (figureHtml ? '<span class="bk-figure">' + figureHtml + '</span>' : '')
    + '</div>';
}

function axis(windowTokens) {
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => formatTokens(windowTokens * f));
  ticks[ticks.length - 1] += ' tokens';
  return '<div class="bk-axis" aria-hidden="true">' + ticks.map((t) => '<span>' + escapeHtml(t) + '</span>').join('') + '</div>';
}

export function renderWindowBar(m) {
  const g = bucketModel(m);
  if (!g) return '';
  const t = bucketText(m);
  const W = formatTokens(g.windowTokens);
  const figure = g.harnessSet
    ? '≈' + escapeHtml(formatTokens(g.used)) + ' in use · ' + escapeHtml(share(g.used, g.windowTokens))
      + ' · of which The Curator ≈' + escapeHtml(formatTokens(g.curator)) + ' (' + escapeHtml(share(g.curator, g.windowTokens)) + ')'
    : 'The Curator ≈' + escapeHtml(formatTokens(g.curator)) + ' · ' + escapeHtml(share(g.curator, g.windowTokens)) + ' of ' + escapeHtml(W);
  let segs = '';
  if (g.harnessSet) {
    segs += '<div class="bk-seg bk-harness" style="width:' + pct(g.harnessPct) + '%" title="harness ≈' + escapeHtml(formatTokens(g.harness)) + ' · your estimate">'
      + labelHtml(g.harnessText) + '</div>';
  }
  segs += '<div class="bk-seg bk-curator" style="width:' + pct(g.curatorPct) + '%" title="The Curator ≈' + escapeHtml(formatTokens(g.curator)) + ' · measured"></div>';
  segs += '<div class="bk-seg bk-free" title="free ≈' + escapeHtml(formatTokens(g.free)) + '">'
    + labelHtml(g.freeText) + '</div>';
  return '<div class="bk-window' + (g.preview ? ' is-preview' : '') + '">'
    + head('Your context window at the start of a session', 'to scale', figure, g.preview)
    + (g.harnessSet ? '' : '<p class="bk-note bk-harness-unset"><span class="bk-sw bk-sw-harness" aria-hidden="true"></span>'
      + 'Harness not set. Your agent\'s own system prompt, tools and instructions also use this window — set an estimate to see them.</p>')
    + '<div class="bk-bar" role="img" aria-label="' + escapeHtml(t.window) + '">' + segs + '</div>'
    + axis(g.windowTokens)
    + (g.over > 0 ? '<p class="bk-note">Over the window by ≈' + escapeHtml(formatTokens(g.over)) + ' tokens at the start of a session.</p>' : '')
    + '</div>';
}

export function renderZoomLink(m) {
  const g = bucketModel(m);
  if (!g) return '';
  const a = pct(g.harnessPct);
  const b = pct(g.harnessPct + g.curatorPct);
  return '<div class="bk-zoom" aria-hidden="true"><svg preserveAspectRatio="none" viewBox="0 0 100 22">'
    + '<path d="M' + a + ' 0 L0 22 M' + b + ' 0 L100 22" /></svg></div>';
}

export function renderEnlargement(m) {
  const g = bucketModel(m);
  if (!g) return '';
  const t = bucketText(m);
  let segs = '';
  for (const l of g.layers) {
    if (l.tokens === 0) continue;
    if (l.parts) {
      for (const p of l.parts) {
        segs += '<div class="bk-seg bk-ly bk-ly-' + l.key + ' bk-part' + (p.pageStart ? ' bk-page-start' : '')
          + '" style="width:' + pct(p.pct) + '%" title="' + escapeHtml(p.title + ' ≈' + formatTokens(p.tokens)
            + (g.pages ? ' · reply ' + p.page : '')) + '">'
          + labelHtml(p.text) + '</div>';
      }
      continue;
    }
    segs += '<div class="bk-seg bk-ly bk-ly-' + l.key + '" style="width:' + pct(l.pct) + '%" title="' + escapeHtml(l.label + ' ≈' + formatTokens(l.tokens)) + '">'
      + labelHtml(l.text) + '</div>';
  }
  if (g.roomState === 'unused' || g.roomState === 'left') {
    segs += '<div class="bk-seg bk-room' + (g.roomState === 'unused' ? ' is-unused' : '') + '" style="width:' + pct(g.roomPct) + '%" title="' + escapeHtml(g.roomWords) + '">'
      + labelHtml(g.roomText) + '</div>';
  }
  return '<div class="bk-enlarged' + (g.preview ? ' is-preview' : '') + '">'
    + head('The Curator’s part, enlarged', 'enlarged', 'to its own scale: the fixed layers plus your reading budget', g.preview)
    + '<div class="bk-bar bk-bar-zoom" role="img" aria-label="' + escapeHtml(t.enlargement) + '">' + segs + '</div>'
    + (g.pages ? pagesStrip(g.pages) : '')
    + '</div>';
}

/** The thin "reply N" strip under the enlarged bar — aria-hidden: the bar's
 *  own sentence says where each reply starts. */
function pagesStrip(pages) {
  return '<div class="bk-pages" aria-hidden="true">' + pages.map((x) => '<span class="bk-page'
    + (x.page > 1 ? ' is-later' : '') + '" style="left:' + pct(x.from) + '%;width:' + pct(x.pct) + '%">'
    + labelHtml(x.text) + '</span>').join('') + '</div>';
}

export function renderLegend(m) {
  const g = bucketModel(m);
  if (!g) return '';
  const it = (sw, words) => '<li class="bk-it"><span class="bk-sw ' + sw + '" aria-hidden="true"></span>' + words + '</li>';
  let out = '';
  for (const l of g.layers) {
    out += it('bk-ly-' + l.key, escapeHtml(l.label) + ' <b>' + escapeHtml(formatTokens(l.tokens)) + '</b>'
      + (l.parts ? ' · ' + l.parts.length + ' document' + (l.parts.length === 1 ? '' : 's') : ''));
    if (!l.parts) continue;
    // Every document, with its tokens — the names a narrow bar cannot print.
    const shown = l.parts.slice(0, LEGEND_PARTS_MAX);
    for (const p of shown) {
      out += '<li class="bk-it bk-it-part"><span class="bk-sw bk-ly-' + l.key + '" aria-hidden="true"></span>'
        + escapeHtml(p.label) + ' <b>' + escapeHtml(formatTokens(p.tokens)) + '</b>'
        + (g.pages ? ' · reply ' + p.page : '') + '</li>';
    }
    const rest = l.parts.slice(LEGEND_PARTS_MAX);
    if (rest.length) {
      out += '<li class="bk-it bk-it-part">+ ' + rest.length + ' more <b>'
        + escapeHtml(formatTokens(rest.reduce((a, p) => a + p.tokens, 0))) + '</b></li>';
    }
  }
  if (g.roomState === 'unused' || g.roomState === 'left') out += it('bk-sw-room', escapeHtml(g.roomWords));
  out += it('bk-sw-harness', g.harnessSet ? 'harness (your estimate) <b>' + escapeHtml(formatTokens(g.harness)) + '</b>' : 'harness — not set');
  out += it('bk-sw-free', 'free <b>' + escapeHtml(formatTokens(g.free)) + '</b>');
  if (g.onDemand) {
    out += it('bk-sw-ondemand', 'on demand — outside the window <b>'
      + escapeHtml(formatTokens(g.onDemand.tokens)) + '</b>'
      + (g.onDemand.documents !== null ? ' · ' + g.onDemand.documents + ' document' + (g.onDemand.documents === 1 ? '' : 's') : ''));
  }
  return '<ul class="bk-legend" aria-label="Legend">' + out + '</ul>';
}

export function renderDeliveryLine(m) {
  const g = bucketModel(m);
  if (!g) return '';
  const words = deliveryWords(g);
  if (!words) return '';
  if (g.preview) {
    const rest = words.slice('Preview, not saved'.length);
    return '<p class="bk-delivery is-preview"><b>Preview, not saved</b>' + escapeHtml(rest) + '</p>';
  }
  return '<p class="bk-delivery">' + escapeHtml(words) + '</p>';
}

export function renderBucket(m) {
  if (!bucketModel(m)) return '';
  return '<div class="bk">'
    + renderWindowBar(m) + renderZoomLink(m) + renderEnlargement(m) + renderLegend(m) + renderDeliveryLine(m)
    + '</div>';
}
