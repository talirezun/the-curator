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
//   renderAnswer(raw, { titles, citations, pages }) → { html, sources, mentions }
//     pages      m.citedPages (v3.76.0) — the cited strings the server found
//                to BE wiki pages; see pageTest below. mentions: the rest.
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
//   sourcesHtml(sources, mentions) → the Sources block ('' when there is
//                neither); the count is pages only, mentions listed apart
//   sourceByNumber(sources, n) → the entry, or null for anything that is not
//                one of its numbers (so a stray attribute cannot index
//                outside the list)
//   pageTypeOf(path) → { folder, type }
//
// Styling: shared/answer.css (the answer body, headings, quote, rule, the
// inline marker, the Sources block) and shared/page-chip.css (the ONE page
// chip, shared with the reader). Both linked from index.html.
import { renderMarkdown, escHtml, splitCitationParts } from './markdown.js';

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

// ── WHICH CITATIONS ARE PAGES (v3.76.0, truth audit F9) ──────────────────
// "SOURCES · 6 PAGES" was counting every `[source: …]` the model wrote, and
// four of the six were not pages at all: "Handoff State", "Catalogue", and a
// version list split in two. A mention is a PAGE only when it resolves to one:
//   · `pages` — the server's list of cited strings that ARE wiki pages
//     (`citedPages`, src/brain/chat.js, checked against the wiki it read).
//     When present it is the whole rule, strictly.
//     For an answer saved before v3.76.0 the view passes the server's
//     read-time check instead (`citedPagesNow`, GET /api/chat/:domain/:id).
//   · no `pages` at all (an older server): a mention the server gave a
//     TITLE (it only titles a real page) or one shaped like a page file — a
//     `.md` name with no spaces, optionally in a folder. Words ("handoff
//     state", "catalogue", "CLAUDE.md rows v3.69.0") are not presented as a
//     page.
// Everything that is not a page is kept, in its own list, as an UNVERIFIED
// MENTION — shown under the Sources, never numbered, never a button, never
// opened (there is no page to open).
const WIKI_PATH_RE = /^(?:[^/\s]+\/)*[^/\s]+\.md$/i;
function pageTest(opts) {
  if (Array.isArray(opts.pages)) {
    const set = new Set(opts.pages.filter((x) => typeof x === 'string'));
    return (key) => set.has(key);
  }
  const titles = opts.titles && typeof opts.titles === 'object' ? opts.titles : null;
  return (key) => (titles !== null && Object.hasOwn(titles, key)) || WIKI_PATH_RE.test(key);
}

export function renderAnswer(raw, opts) {
  const o = opts || {};
  const isPage = pageTest(o);
  const order = [];
  const index = new Map(); // a Map, not an object: paths are untrusted keys
  const mentions = [];
  const mentioned = new Set();
  const cite = (p) => {
    const key = String(p == null ? '' : p).trim();
    if (!key || key.length > 512) return 0;
    if (!isPage(key)) {
      if (!mentioned.has(key)) { mentioned.add(key); mentions.push(key); }
      return 0;
    }
    if (!index.has(key)) { order.push(key); index.set(key, order.length); }
    return index.get(key);
  };
  const html = renderMarkdown(raw, { cite });
  // The server's list, after the inline ones. Numbers are assigned here but
  // never shown inline — these pages were cited without a marker. Split by
  // the SAME rule the inline pass uses (splitCitationParts), so a comma inside
  // one mention never makes two.
  if (Array.isArray(o.citations)) {
    for (const c of o.citations) {
      if (typeof c !== 'string') continue;
      for (const part of splitCitationParts(c)) cite(part);
    }
  }
  const sources = order.map((path, i) => {
    const { folder, type } = pageTypeOf(path);
    return { n: i + 1, path, folder, type, title: sourceTitle(path, o.titles) };
  });
  return { html, sources, mentions };
}

// The bound and the `|| null` each cover the other — measured by mutation:
// removing either alone leaves scripts/test-next-answer.js §3 green, removing
// both turns it red. Both are kept; the bound states the rule.
export function sourceByNumber(sources, n) {
  const k = Number(n);
  if (!Array.isArray(sources) || !Number.isInteger(k) || k < 1 || k > sources.length) return null;
  return sources[k - 1] || null;
}

// 'other' reads "wiki page": it was "page", which made a screen reader say
// "page page" for a source outside the three folders.
const TYPE_WORD = Object.assign(Object.create(null), { entity: 'entity', concept: 'concept', summary: 'summary', other: 'wiki' });

// The Sources block. Every string that came from a page or a model goes
// through escHtml; the only attribute values are this file's own literals and
// the integer `n`. The chip's accessible name reads "Source 3: Servant
// leadership, concept page, concepts/servant-leadership.md" — the number and
// dot are aria-hidden (the number is spoken in words, the dot's meaning is
// the type word), and the path is visually hidden, never a `title=` tooltip.
export function sourcesHtml(sources, mentions) {
  const list = Array.isArray(sources) ? sources : [];
  const loose = Array.isArray(mentions) ? mentions.filter((m) => typeof m === 'string' && m) : [];
  if (list.length === 0 && loose.length === 0) return '';
  // THE COUNT IS PAGES, AND ONLY PAGES (v3.76.0, F9). With none resolved the
  // head says so rather than "0 pages" beside a list of mentions.
  const count = list.length === 0 ? 'no wiki page'
    : list.length + (list.length === 1 ? ' page' : ' pages');
  const mentionsHtml = loose.length
    ? '<div class="answer-mentions">'
      + escHtml(loose.length + (loose.length === 1 ? ' unverified mention' : ' unverified mentions')
        + ' — not a wiki page: ')
      + loose.map((m) => '<span class="answer-mention">' + escHtml(m) + '</span>').join(' · ')
      + '</div>'
    : '';
  sources = list;
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
      (chips ? '<div class="answer-sources-list">' + chips + '</div>' : '') +
      (legend ? '<div class="answer-legend" aria-hidden="true">' + legend + '</div>' : '') +
      mentionsHtml +
    '</section>'
  );
}
