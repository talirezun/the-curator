/**
 * ── THE EXPLAINER: ONE SHAPE FOR EVERY ⓘ (v3.71.0) ─────────────────────────
 *
 * An ⓘ panel's BODY, rendered from one entry of shared/explainers.js. The
 * mark, the panel and the delegated listener are unchanged — they are
 * shared/text.js's, exactly as before (in flow, Escape closes and returns
 * focus to the ⓘ, the entrance plays only on the press, an open panel
 * survives a re-render). This module decides only what is INSIDE the panel:
 *
 *   head    the ⓘ glyph + the thing's name, as the screen names it
 *   lead    one plain sentence (≤ 20 words)
 *   visual  optional, exactly one of: frame · flow · meter · table · steps
 *   points  0–3, one icon each (≤ 12 words each)
 *   foot    an optional "Try" sentence, and ONE link card to the user guide
 *
 * ── THE API (views call these; nothing else) ───────────────────────────────
 *
 *   renderExplainer(key, opts?) → string (HTML)
 *       The panel body for EXPLAINERS[key]. `opts.here` —
 *       'second-brain' | 'shared-brain' | 'agent-memory' — overrides which
 *       framing node is marked "you are here" (only matters for a `frame`
 *       entry; the entry's own `visual.here` is the default). THROWS on an
 *       unknown key, like docsUrl(): a typo is a blank screen in development,
 *       never a silently empty ⓘ in production.
 *
 *   explainerMark(id, key, opts?) → { btn, panel }
 *       The whole affordance for a block, a row or a step head:
 *       renderInfoMark(id, EXPLAINERS[key].label, renderExplainer(key, opts),
 *       { html: true }). Same ids, same listener, same two fragments.
 *
 *   explainerLabel(key) → string
 *       The entry's ⓘ accessible name. For a VIEW HEADER, whose name
 *       renderViewHeader derives itself ("About " + title), pass the body:
 *         renderViewHeader({ title, info: renderExplainer('context.page'),
 *                            infoHtml: true })
 *
 * Adoption is one line per call site. The HTML carries its own classes
 * (`xp-…`, shared/explainer.css); `.tx-vh-panel:has(> .xp)` drops the old
 * panel padding so the explainer's head can run edge to edge.
 *
 * ── ESCAPE-FIRST, AND WHY THAT IS THE WHOLE SECURITY STORY ────────────────
 *
 * Every string from the copy file is escaped BEFORE the two micro-markup
 * rules (`**x**` → <b>, `` `x` `` → <code>) run over the escaped text, the
 * shape shared/markdown.js uses. So the copy file can never inject markup,
 * and the only attributes emitted are ones built here from constants: the
 * link's href comes from docs-links.js's frozen map via docsUrl(), never from
 * the entry. An unbalanced `**` stays literal rather than opening a tag.
 *
 * ── NO CONTROL INSIDE THE PANEL, EXCEPT THE ONE LINK ──────────────────────
 *
 * text.js's listener toggles on the BUTTON; a control inside the panel would
 * be reachable only after that press. The guide card is the single focusable
 * element, so Tab goes ⓘ → the card → the page, and Escape pressed ON the
 * card closes the panel and returns focus to the ⓘ (the existing
 * document-level Escape handler already does this; test-explainer-kit.js
 * drives it). "Try" is a sentence naming a control on the page, never a
 * button.
 *
 * ── WHY IT CARRIES ITS OWN GLYPHS ─────────────────────────────────────────
 *
 * app.js's icon() cannot be imported here (app.js touches `document` at
 * module scope, so nothing importing it runs in an offline suite), so the
 * glyph table lives below. Each glyph marked REUSE names its source, and
 * test-explainer-kit.js proves the path is BYTE-EQUAL to it — the same
 * device test-shared-block.js uses for the ⓘ glyph copies. Glyphs marked NEW
 * are drawn to the same grammar: 24-unit viewBox, currentColor stroke 1.7,
 * round caps and joins, aria-hidden. An icon never carries meaning alone —
 * the point's words do.
 *
 * Imports: three import-free modules (explainers.js, docs-links.js, text.js),
 * so this runs headless.
 */

import { EXPLAINERS, FRAMING } from './explainers.js';
import { docsUrl } from './docs-links.js';
import { renderInfoMark } from './text.js';

/**
 * name → { src, body }. `src` is where a REUSE glyph is copied from
 * ('app.js:ICON_BODY.<name>', 'views/memory.js:pencil', 'shared/age.js:clock')
 * or 'new'. The test lifts each source and compares bytes.
 */
export const GLYPHS = Object.freeze({
  // ── reuse ──
  book: { src: 'app.js:ICON_BODY.book', body: '<path d="M4 4.8A1.8 1.8 0 0 1 5.8 3H12v18H5.8A1.8 1.8 0 0 1 4 19.2z"/><path d="M20 4.8A1.8 1.8 0 0 0 18.2 3H12v18h6.2a1.8 1.8 0 0 0 1.8-1.8z"/>' },
  sparkles: { src: 'app.js:ICON_BODY.sparkles', body: '<path d="M12 3l1.6 4.9L18.5 9l-4.9 1.6L12 15.5l-1.6-4.9L5.5 9l4.9-1.6z"/><path d="M19 3.2v3.1M20.6 4.75h-3.1"/><path d="M5 17v2.3M6.15 18.15H3.85"/>' },
  layers: { src: 'app.js:ICON_BODY.layers', body: '<path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17.5 9 5 9-5"/>' },
  agent: { src: 'app.js:ICON_BODY.cpu', body: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/><rect x="10" y="10" width="4" height="4" rx="0.8"/><path d="M9 3v2.3M15 3v2.3M9 18.7V21M15 18.7V21M3 9h2.3M3 15h2.3M18.7 9H21M18.7 15H21"/>' },
  refresh: { src: 'app.js:ICON_BODY.refresh', body: '<path d="M20 11a8 8 0 0 0-14.5-4.5M4 4.5V9h4.5"/><path d="M4 13a8 8 0 0 0 14.5 4.5M20 19.5V15h-4.5"/>' },
  search: { src: 'app.js:ICON_BODY.search', body: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>' },
  folder: { src: 'app.js:ICON_BODY.folder', body: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' },
  lock: { src: 'app.js:ICON_BODY.lock', body: '<rect x="5" y="10.4" width="14" height="9.1" rx="1.8"/><path d="M8 10.4V7.6a4 4 0 0 1 8 0v2.8"/>' },
  check: { src: 'app.js:ICON_BODY.checkAlt', body: '<path d="M20 6 9 17 4 12"/>' },
  pencil: { src: 'views/memory.js:pencil', body: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/>' },
  clock: { src: 'shared/age.js:clock', body: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>' },
  info: { src: 'shared/text.js:INFO_GLYPH', body: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>' },
  // ── new, same grammar ──
  external: { src: 'new', body: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>' },
  file: { src: 'new', body: '<path d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13.5 3.5v4h4"/><path d="M9 12.5h6M9 16h4"/>' },
  grow: { src: 'new', body: '<path d="M4 16.5 12 20l8-3.5"/><path d="M4 12.5 12 16l8-3.5"/><path d="M12 3.5v7M8.5 7h7"/>' },
  start: { src: 'new', body: '<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M4 12h11M11 8l4 4-4 4"/>' },
  repo: { src: 'new', body: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="8" r="2"/><path d="M6.5 7.5v9M17.5 10c0 4-11 2.5-11 6.5"/>' },
  window: { src: 'new', body: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 8.5h18"/><path d="M6 6.5h.01M8.5 6.5h.01"/>' },
  gauge: { src: 'new', body: '<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-5"/><path d="M4 19.5h16"/>' },
  harness: { src: 'new', body: '<rect x="3.5" y="8" width="17" height="11.5" rx="1.8"/><path d="M9 8V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v2"/><path d="M3.5 13h17"/><path d="M10.5 13v2h3v-2"/>' },
  computer: { src: 'new', body: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.4"/><path d="M2.5 19h19"/>' },
  // The freshness reading: a solid dot beside a dashed ring. NOT app.js's
  // `dot` (a single filled circle used as a status marker) — the name is the
  // copy's, the drawing is new.
  dot: { src: 'new', body: '<circle cx="7.5" cy="12" r="3.2"/><circle cx="17" cy="12" r="3.6" stroke-dasharray="2.2 2"/>' },
});

/** The five visual types a copy entry may ask for. */
export const VISUAL_TYPES = Object.freeze(['frame', 'flow', 'meter', 'table', 'steps']);

/** Framing node ids, in their one order. */
export const FRAME_NODES = Object.freeze(FRAMING.nodes.map((n) => n.id));

// Same five characters as shared/text.js and shared/docs-links.js.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** One glyph as inline SVG. An unknown name THROWS — the test holds every name. */
export function glyph(name, size) {
  if (!Object.prototype.hasOwnProperty.call(GLYPHS, name)) {
    throw new Error('explainer: unknown icon "' + String(name) + '"');
  }
  const px = size || 16;
  return '<svg class="xp-svg" width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true" focusable="false">' + GLYPHS[name].body + '</svg>';
}

/**
 * Copy text → HTML. ESCAPE FIRST, then `**x**` → <b>x</b> and `` `x` `` →
 * <code>x</code> over the escaped string. Neither pattern can match across
 * the other's delimiters or produce an attribute, so the output's only tags
 * are <b> and <code>.
 */
export function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

function entryFor(key) {
  if (!Object.prototype.hasOwnProperty.call(EXPLAINERS, key)) {
    throw new Error('explainer: unknown key "' + String(key) + '"');
  }
  return EXPLAINERS[key];
}

// ── The visuals ────────────────────────────────────────────────────────────

function renderFrame(here) {
  const nodes = FRAMING.nodes.map((n, i) => {
    const on = n.id === here;
    return '<li class="xp-node' + (on ? ' is-here' : '') + '"' + (on ? ' aria-current="true"' : '') + '>' +
      '<span class="xp-node-top"><span class="xp-node-n" aria-hidden="true">' + (i + 1) + '</span>' +
      '<span class="xp-node-name">' + escapeHtml(n.name) + '</span></span>' +
      '<span class="xp-node-sub">' + escapeHtml(n.places) + '</span>' +
      '<span class="xp-node-line">' + escapeHtml(n.line) + '</span>' +
      (on ? '<span class="xp-here">you are here</span>' : '') +
    '</li>';
  }).join('');
  return '<div class="xp-well xp-frame">' +
    '<p class="xp-well-cap">' + glyph('folder', 13) + escapeHtml(FRAMING.caption) + '</p>' +
    '<ol class="xp-nodes" aria-label="How The Curator fits together">' + nodes + '</ol>' +
  '</div>';
}

function renderFlow(v) {
  return '<div class="xp-well">' +
    (v.caption ? '<p class="xp-well-cap">' + escapeHtml(v.caption) + '</p>' : '') +
    '<ol class="xp-flow"' + (v.caption ? '' : ' aria-label="In order"') + '>' +
      v.steps.map((s) => '<li>' + inline(s) + '</li>').join('') +
    '</ol></div>';
}

function renderSteps(v) {
  return '<div class="xp-well">' +
    (v.caption ? '<p class="xp-well-cap">' + escapeHtml(v.caption) + '</p>' : '') +
    '<ol class="xp-steps">' + v.steps.map((s) => '<li>' + inline(s) + '</li>').join('') + '</ol>' +
  '</div>';
}

function cell(c) {
  if (c && typeof c === 'object') {
    return '<span class="xp-who">' + glyph(c.icon, 12) + inline(c.text) + '</span>';
  }
  return inline(c);
}

function renderTable(v, title) {
  const head = Array.isArray(v.head)
    ? '<thead><tr>' + v.head.map((h) => '<th scope="col">' + escapeHtml(h) + '</th>').join('') + '</tr></thead>'
    : '';
  const body = v.rows.map((r) =>
    '<tr><th scope="row">' + cell(r[0]) + '</th>' +
      r.slice(1).map((c, i) =>
        // At narrow width the table stacks; the column name rides along as a
        // data attribute CSS prints, so a stacked cell keeps its meaning.
        '<td' + (Array.isArray(v.head) && v.head[i + 1] ? ' data-col="' + escapeHtml(v.head[i + 1]) + '"' : '') +
        '>' + cell(c) + '</td>').join('') +
    '</tr>').join('');
  return '<div class="xp-well xp-well-t"><table class="xp-tbl">' +
    '<caption class="xp-sr">' + escapeHtml(v.caption || title) + '</caption>' +
    head + '<tbody>' + body + '</tbody></table></div>';
}

/**
 * A SCHEMATIC of the context window — not a measurement, and it says so.
 * Step ④'s real meter is the reading; this one teaches the parts, drawn with
 * the same layer tokens (the harness hatched, The Curator's part in violet
 * lightness steps, the unused reading budget dashed), so it never implies
 * "wrong". Proportions are fixed, not the project's.
 */
const METER_SEGMENTS = ['harness', 'framing', 'brief', 'handoff', 'journal', 'index', 'read', 'room', 'free'];
function renderMeter() {
  // Proportions live in explainer.css (one flex value per segment class), so
  // no style attribute is emitted.
  const bar = METER_SEGMENTS.map((k) => '<span class="xp-m xp-m-' + k + '"></span>').join('');
  const lab = (k, icon, name, sub) =>
    '<span class="xp-ml xp-ml-' + k + '">' +
      '<span class="xp-ml-name">' + (icon ? glyph(icon, 12) : '') + escapeHtml(name) + '</span>' +
      '<span class="xp-ml-sub">' + escapeHtml(sub) + '</span></span>';
  return '<div class="xp-well xp-meter">' +
    '<p class="xp-well-cap">' + glyph('window', 13) + 'Your context window — schematic, not to scale</p>' +
    '<div class="xp-m-bar" role="img" aria-label="Schematic, not to scale: your agent’s own harness, ' +
      'then The Curator’s part — the brief, the Handoff and read first documents — then unused reading budget, ' +
      'then free space for the work.">' + bar + '</div>' +
    '<div class="xp-m-labels" aria-hidden="true">' +
      lab('harness', 'harness', 'Harness', 'your estimate') +
      lab('curator', 'layers', 'The Curator', 'brief · Handoff · read first') +
      lab('room', 'gauge', 'Budget room', 'unused') +
      lab('free', '', 'Free', 'for the work') +
    '</div></div>';
}

function renderVisual(v, here, title) {
  if (!v) return '';
  switch (v.type) {
    case 'frame': return renderFrame(here);
    case 'flow': return renderFlow(v);
    case 'meter': return renderMeter();
    case 'table': return renderTable(v, title);
    case 'steps': return renderSteps(v);
    default: throw new Error('explainer: unknown visual "' + String(v.type) + '"');
  }
}

// ── The body ───────────────────────────────────────────────────────────────

/**
 * @param {string} key  a key of EXPLAINERS
 * @param {{here?: 'second-brain'|'shared-brain'|'agent-memory'}} [opts]
 * @returns {string} HTML — the panel body
 */
export function renderExplainer(key, opts) {
  const e = entryFor(key);
  const o = opts || {};
  const here = FRAME_NODES.indexOf(o.here) !== -1 ? o.here : (e.visual && e.visual.here) || null;
  const points = (e.points || []).map((p) =>
    '<li><span class="xp-ic">' + glyph(p.icon, 18) + '</span><span class="xp-pt">' + inline(p.text) + '</span></li>'
  ).join('');
  const heading = e.guide.heading;
  const tryHtml = e.try
    ? '<p class="xp-try">' + glyph('sparkles', 14) +
        '<span><b class="xp-try-k">Try</b> ' + inline(e.try) + '</span></p>'
    : '';
  const card =
    '<a class="xp-guide" href="' + escapeHtml(docsUrl(e.guide.key)) + '" target="_blank" rel="noopener noreferrer"' +
      ' aria-label="' + escapeHtml('User guide: ' + heading + ' (opens in your browser)') + '">' +
      '<span class="xp-guide-ic">' + glyph('book', 18) + '</span>' +
      '<span class="xp-guide-tx">' +
        '<span class="xp-guide-eb">User guide</span>' +
        '<span class="xp-guide-t">' + escapeHtml(heading) + '</span>' +
        '<span class="xp-guide-sub">Opens in your browser</span>' +
      '</span>' +
      '<span class="xp-guide-ext">' + glyph('external', 14) + '</span>' +
    '</a>';
  return '<div class="xp" data-explainer="' + escapeHtml(key) + '">' +
    '<p class="xp-head">' + glyph('info', 14) + '<span>' + escapeHtml(e.title) + '</span></p>' +
    '<p class="xp-lead">' + inline(e.lead) + '</p>' +
    renderVisual(e.visual, here, e.title) +
    (points ? '<ul class="xp-pts" role="list">' + points + '</ul>' : '') +
    '<div class="xp-foot' + (tryHtml ? '' : ' xp-foot-solo') + '">' + tryHtml + card + '</div>' +
  '</div>';
}

/** The entry's ⓘ accessible name. */
export function explainerLabel(key) {
  return entryFor(key).label;
}

/**
 * The ⓘ + its explainer panel, for a block, a row or a step head.
 * @param {string} id   stable DOM id for the panel (the button gets id + '-btn')
 * @param {string} key  a key of EXPLAINERS
 * @param {{here?: string}} [opts]
 * @returns {{btn: string, panel: string}}
 */
export function explainerMark(id, key, opts) {
  const e = entryFor(key);
  return renderInfoMark(id, e.label, renderExplainer(key, opts), { html: true });
}
