// Shared: a chat ANSWER — its Markdown with numbered citation markers, and the
// one Sources list under it (v3.72.0, DESIGN.md §5, decision M4).
//
// ── WHAT THIS REPLACES ───────────────────────────────────────────────────
// Every citation used to be printed TWICE: the raw path inline (a
// `.chat-citation-tag` holding "summaries/x.md" — or, for `[source: a.md,
// b.md]`, ONE tag holding the comma-joined string, which opened the reader on
// a path that does not exist) AND a title chip in `.chat-cite-row` under the
// answer. The shape every answer engine converged on is a SHORT marker inline
// and the full reference ONCE: numbered markers `¹ ²`, numbered in order of
// first appearance, a repeated source re-using its number, and one Sources
// list of page chips in the page-type colours. No raw path is on the face; it
// is in each control's visually-hidden text and in the reader's header.
//
// ── PURE, AND WHY ────────────────────────────────────────────────────────
// No DOM, no state, no fetch: text in, `{ html, sources }` out. The view
// (views/chat.js, package P3) paints `html` inside `.chat-answer`, paints
// `sourcesHtml(sources)` under it, and wires ONE delegated click that maps a
// clicked `[data-cite-n]` / `[data-source-n]` to `sourceByNumber(sources, n)`
// and opens that page's `path`. The path is resolved from THIS list by number,
// never read back out of the DOM, so nothing a page or a model wrote can
// repoint a marker (the reason the old M3 fix had to move the path into text).
//
// ── THE API P3 WIRES ─────────────────────────────────────────────────────
//   renderAnswer(raw, { titles, citations }) → { html, sources }
//     raw        the answer's Markdown (m.content)
//     titles     m.citationTitles (path → page title), optional
//     citations  m.citations (the server's list), optional — any path in it
//                that the text never cited inline is APPENDED to `sources`
//                after the inline ones, so the list never loses a page the
//                server recorded. Each entry is split on commas too (the
//                server's extraction keeps a comma list as ONE string).
//     sources    [{ n, path, folder, type, title }] — n from 1, in first-
//                appearance order; path RAW (unescaped); folder is
//                'entities' | 'concepts' | 'summaries' | null; type is
//                'entity' | 'concept' | 'summary' | 'other'.
//   sourcesHtml(sources) → the Sources block ('' when there are none)
//   sourceByNumber(sources, n) → the entry, or null for anything that is not
//                one of its numbers (so a stray attribute cannot index
//                outside the list)
//   pageTypeOf(path) → { folder, type }
//
// Styling: shared/answer.css (the answer body, headings, quote, rule, the
// inline marker, the Sources block) and shared/page-chip.css (the ONE page
// chip, shared with the reader). Both linked from index.html.
import { renderMarkdown, escHtml } from './markdown.js';

// Page type from the path's first segment — the same rule views/chat.js's
// folderOfPath and the reader's type chip use. Anything else is 'other'.
export function pageTypeOf(path) {
  const seg = String(path || '').split('/')[0];
  if (seg === 'entities') return { folder: 'entities', type: 'entity' };
  if (seg === 'concepts') return { folder: 'concepts', type: 'concept' };
  if (seg === 'summaries') return { folder: 'summaries', type: 'summary' };
  return { folder: null, type: 'other' };
}

// The chip label: the server's title for the path when it has one (an OWN
// property, so a path named `constructor` cannot read a function off the
// prototype), else the humanised basename — character-for-character the
// fallback views/chat.js's citationLabel/titleFromSlug has always shown, so a
// reopened old thread labels its sources exactly as before.
function sourceTitle(path, titles) {
  const p = String(path || '');
  if (titles && typeof titles === 'object' && Object.hasOwn(titles, p)) {
    const t = titles[p];
    if (typeof t === 'string' && t.trim()) return t.trim();
  }
  const slug = p.split('/').pop().replace(/\.md$/i, '');
  return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : p;
}

export function renderAnswer(raw, opts) {
  const o = opts || {};
  const order = [];
  const index = new Map(); // a Map, not an object: paths are untrusted keys
  const cite = (p) => {
    const key = String(p == null ? '' : p).trim();
    if (!key || key.length > 512) return 0;
    if (!index.has(key)) { order.push(key); index.set(key, order.length); }
    return index.get(key);
  };
  const html = renderMarkdown(raw, { cite });
  // The server's list, after the inline ones. Numbers are assigned here but
  // never shown inline — these pages were cited without a marker.
  if (Array.isArray(o.citations)) {
    for (const c of o.citations) {
      if (typeof c !== 'string') continue;
      for (const part of c.split(',')) cite(part);
    }
  }
  const sources = order.map((path, i) => {
    const { folder, type } = pageTypeOf(path);
    return { n: i + 1, path, folder, type, title: sourceTitle(path, o.titles) };
  });
  return { html, sources };
}

// The bound and the `|| null` each cover the other — measured by mutation:
// removing either alone leaves scripts/test-next-answer.js §3 green, removing
// both turns it red. Both are kept; the bound states the rule.
export function sourceByNumber(sources, n) {
  const k = Number(n);
  if (!Array.isArray(sources) || !Number.isInteger(k) || k < 1 || k > sources.length) return null;
  return sources[k - 1] || null;
}

const TYPE_WORD = Object.assign(Object.create(null), { entity: 'entity', concept: 'concept', summary: 'summary', other: 'page' });

// The Sources block. Every string that came from a page or a model goes
// through escHtml; the only attribute values are this file's own literals and
// the integer `n`. The chip's accessible name reads "Source 3: Servant
// leadership, concept page, concepts/servant-leadership.md" — the number and
// dot are aria-hidden (the number is spoken in words, the dot's meaning is
// the type word), and the path is visually hidden, never a `title=` tooltip.
export function sourcesHtml(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return '';
  const count = sources.length + (sources.length === 1 ? ' page' : ' pages');
  const present = new Set();
  let chips = '';
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    const type = Object.hasOwn(TYPE_WORD, s && s.type) ? s.type : 'other';
    present.add(type);
    const n = String(Number.isInteger(s.n) ? s.n : 0);
    chips +=
      '<button type="button" class="page-chip page-chip-' + type + '" data-source-n="' + n + '">' +
        '<span class="page-chip-n" aria-hidden="true">' + n + '</span>' +
        '<span class="page-chip-dot" aria-hidden="true"></span>' +
        '<span class="visually-hidden">Source ' + n + ': </span>' +
        '<span class="page-chip-label">' + escHtml(s.title) + '</span>' +
        '<span class="visually-hidden">, ' + TYPE_WORD[type] + ' page, ' + escHtml(s.path) + '</span>' +
      '</button>';
  }
  // The legend names only the types on screen, in the fixed order the rest
  // of the app uses. aria-hidden: each chip already says its type in words.
  let legend = '';
  for (const t of ['entity', 'concept', 'summary']) {
    if (present.has(t)) legend += '<span class="answer-legend-item"><span class="page-chip-dot page-chip-dot-' + t + '"></span>' + t + '</span>';
  }
  return (
    '<section class="answer-sources" aria-label="Sources">' +
      '<div class="answer-sources-head">Sources · ' + count + '</div>' +
      '<div class="answer-sources-list">' + chips + '</div>' +
      (legend ? '<div class="answer-legend" aria-hidden="true">' + legend + '</div>' : '') +
    '</section>'
  );
}
