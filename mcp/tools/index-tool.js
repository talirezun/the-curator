/**
 * get_index — a domain's page catalogue, in two views (v3.83.0).
 *
 *  view "index" (default) — index.md, the rows with one-line descriptions.
 *  view "pages"           — a compact list built from the FILES ON DISK
 *                           (slug, type, title, created/date/source where the
 *                           page records them); complete even when index.md
 *                           has fallen behind.
 *
 * WHY PAGED, AND WHY 60 KB. A large index.md arrived as one string: 146 KB on
 * the maintainer's largest wiki today, ~614 KB once Health rebuilds it. Claude
 * Code moves any reply over ~25k tokens into a file the model may never read,
 * and over 400 KB the dispatcher's guard (index.js enforceSizeLimit) TRUNCATES
 * a string reply mid-row. The bound is on the WHOLE serialised reply
 * (`JSON.stringify(reply, null, 2)`, which is exactly what the dispatcher
 * sends), measured, not estimated. 60 KB, not get_project_context's 80 KB:
 * that one is sized at 4 bytes/token, and index markdown tokenises denser —
 * ingest budgets it at 3 chars/token (src/brain/ingest.js) — so 61,440 B is
 * ≈ 20.5k tokens worst case, under 25k.
 *
 * COMPATIBILITY. A small index (≤ INDEX_PAGE_BYTES) requested with no `type`
 * and no `page` is returned as the raw markdown string, BYTE-IDENTICAL to every
 * release before this one. Only an index too big for one reply, or a request
 * that asks for a view, filter or page, gets the structured shape.
 *
 * Every row appears on exactly one page, never split and never reordered; each
 * page is valid markdown on its own (a table row is always preceded by its
 * table's header, and by its section heading when the index is sectioned).
 * Page N re-runs the same deterministic plan over the same input, so the union
 * of the pages is the index exactly; `basis` changes when the input does.
 *
 * READ-ONLY: no refuseIfReadonly, no invalidateGraph — reads are allowed on
 * Shared Brain mirrors. Nothing here writes to stdout.
 */
import { createHash } from 'node:crypto';
import { isValidDomain } from '../util.js';
import { buildGraph } from '../graph.js';
import {
  parseIndex, resolveTarget, indexCoverage, buildInventory, INDEX_SECTIONS,
  INDEX_TABLE_HEADER, INDEX_TABLE_SEPARATOR,
} from '../../src/brain/wiki-index.js';

/** Upper bound, in bytes, of one get_index reply as the dispatcher serialises it. */
export const INDEX_PAGE_BYTES = 60 * 1024;

const VIEWS = ['index', 'pages'];
const TYPES = INDEX_SECTIONS.map((s) => s.type);              // entity, concept, summary (any order)
const TYPE_ENUM = ['entity', 'concept', 'summary'];
const FOLDER_OF_TYPE = new Map(INDEX_SECTIONS.map((s) => [s.type, s.folder]));

const PAGES_NOTE =
  'created and date are the dates The Curator ingested the source, not when it was written; ' +
  'source is the original file name. Link entities and concepts as [[slug]] and summaries as [[summaries/slug]].';

export const getIndexDefinition = {
  name: 'get_index',
  description:
    'Get a domain\'s page catalogue. view: "index" (the default) returns the wiki\'s index.md — one row per page ' +
    'with a one-line description; use it to see what pages are ABOUT. view: "pages" returns a compact list built ' +
    'from the files on disk — slug, type, title and, where the page records them, created, date and source. ' +
    'created and date are when The Curator INGESTED the source, not when it was written or published, and source ' +
    'is the original file name; for an authoring date, read the summary or its raw source (get_raw_source). ' +
    'Use view: "pages" to ground [[wikilinks]] before any write, and whenever you need EVERY page ' +
    '("list my sources", a timeline): it is complete even when index.md has fallen behind, which ' +
    'scan_wiki_health reports as indexDrift. Narrow either view with type: "entity", "concept" or "summary" ' +
    '(type: "summary" lists the domain\'s sources). Link entities and concepts as [[slug]] and summaries as ' +
    '[[summaries/slug]]. A large reply arrives in PAGES of at most ≈20k tokens: while `continuation` is present, ' +
    'call again with the same arguments plus its `page`, and do not compose links from a partial list; if ' +
    '`basis` changes between pages the wiki changed — start again from page 1. A small index requested with no ' +
    'type or page is returned as plain markdown, exactly as before.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'Domain slug (from list_domains)' },
      view: {
        type: 'string',
        enum: VIEWS,
        default: 'index',
        description: "'index' (default): index.md rows with one-line descriptions. 'pages': a compact list built from the files on disk — complete even when index.md lags.",
      },
      type: {
        type: 'string',
        enum: TYPE_ENUM,
        description: "Only pages of this type, resolved against the files on disk. 'summary' lists the domain's sources.",
      },
      page: {
        type: 'integer',
        minimum: 1,
        description: 'Page to fetch, from 1 (default); `continuation` names the next.',
      },
    },
    required: ['domain'],
  },
};

// ── argument validation (nothing is read until these pass) ───────────────────

function refuse(reason, error) { return { ok: false, reason, error }; }

function parsePageArg(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: 1, given: false };
  const n = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 1) {
    return {
      ok: false,
      error: `\`page\` is a whole number from 1 (got ${String(JSON.stringify(raw)).slice(0, 40)}). Call without it for page 1.`,
    };
  }
  return { ok: true, value: n, given: true };
}

function pageOutOfRange(page, of, domain, what) {
  return {
    ok: false,
    reason: 'page-out-of-range',
    pages: of,
    error: `The ${what} for '${domain}' arrives in ${of} page${of === 1 ? '' : 's'}; there is no page ${page}. `
      + (of === 1 ? 'Everything is in the reply you get without `page`.' : `Ask for a page from 1 to ${of}.`),
  };
}

const bytesOf = (obj) => Buffer.byteLength(JSON.stringify(obj, null, 2), 'utf8');
const sha12 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);
/** Bytes a string adds INSIDE a JSON string literal (escapes counted). */
const jsonStrBytes = (s) => Buffer.byteLength(JSON.stringify(s), 'utf8') - 2;

/**
 * Greedy, deterministic page plan. `cost(i, isFirstOnPage)` estimates the bytes
 * item i adds; `render(slice, page, of)` builds the real reply. The plan is
 * VERIFIED by rendering every page and measuring it; if any page is over the
 * limit the item budget is lowered by the overshoot and the plan re-cut. An
 * item too large for any page sits alone on its own page (never split).
 */
function planPages(n, cost, overhead, render) {
  let budget = INDEX_PAGE_BYTES - overhead;
  for (let attempt = 0; attempt < 32; attempt++) {
    const cuts = [];        // [start, end) per page
    let start = 0;
    while (start < n || cuts.length === 0) {
      let used = 0, end = start;
      while (end < n) {
        const c = cost(end, end === start);
        if (end > start && used + c > budget) break;
        used += c; end++;
      }
      cuts.push([start, end]);
      if (end >= n) break;
      start = end;
    }
    const of = cuts.length;
    let worst = 0;
    const replies = cuts.map(([s, e], i) => {
      const r = render(s, e, i + 1, of);
      worst = Math.max(worst, bytesOf(r) - INDEX_PAGE_BYTES);
      return r;
    });
    // A page that holds ONE item cannot shrink further; accept it as is.
    const shrinkable = cuts.some(([s, e], i) => e - s > 1 && bytesOf(replies[i]) > INDEX_PAGE_BYTES);
    if (worst <= 0 || !shrinkable) return replies;
    budget -= worst + 64;
  }
  throw new Error('get_index: could not plan pages within the reply bound');
}

// ── the page inventory, from the graph's collision-safe `pages` array ────────

async function pageList(domain, storage) {
  const graph = await buildGraph(domain, storage);
  return Array.isArray(graph.pages) ? graph.pages : [];
}

function inventoryFrom(pages) {
  const lists = { entities: [], concepts: [], summaries: [] };
  for (const p of pages) if (lists[p.folder]) lists[p.folder].push(p.path.slice(p.folder.length + 1));
  return buildInventory(lists);
}

// ── handler ──────────────────────────────────────────────────────────────────

export async function getIndexHandler(args, storage) {
  const { domain } = args || {};
  if (!isValidDomain(domain)) return `Invalid domain name "${domain}". Use list_domains.`;

  const view = args?.view === undefined || args?.view === null ? 'index' : args.view;
  if (!VIEWS.includes(view)) {
    return refuse('invalid-argument', `\`view\` is "index" or "pages" (got ${String(JSON.stringify(view)).slice(0, 40)}).`);
  }
  const type = args?.type === undefined || args?.type === null ? null : args.type;
  if (type !== null && !TYPES.includes(type)) {
    return refuse('invalid-argument', `\`type\` is "entity", "concept" or "summary" (got ${String(JSON.stringify(type)).slice(0, 40)}). Omit it for every page.`);
  }
  const pageArg = parsePageArg(args?.page);
  if (!pageArg.ok) return refuse('invalid-argument', pageArg.error);

  if (view === 'pages') return pagesView(domain, type, pageArg.value, storage);
  return indexView(domain, type, pageArg, storage);
}

// ── view "index" ─────────────────────────────────────────────────────────────

async function indexView(domain, type, pageArg, storage) {
  const content = await storage.readFile(`${domain}/wiki/index.md`);
  if (!content) return `No index found for domain "${domain}". Try list_domains first.`;

  // BYTE-IDENTICAL compatibility path: exactly the pre-v3.83.0 reply.
  if (type === null && !pageArg.given && Buffer.byteLength(content, 'utf8') <= INDEX_PAGE_BYTES) {
    return content;
  }

  const parsed = parseIndex(content);
  const { lines } = parsed;
  const pages = await pageList(domain, storage);
  const inventory = inventoryFrom(pages);
  const cov = indexCoverage(parsed, inventory);
  const indexHealth = (cov.missing.length || cov.stale.length)
    ? { missing_from_index: cov.missing.length, stale_rows: cov.stale.length }
    : null;
  const basis = sha12(content);

  // Context of every line: the table it sits in (header lines) and the `## `
  // heading of its block — what a page that starts mid-table must repeat.
  const ctxOf = lineContexts(parsed);

  // Items: unfiltered = every line (lossless); filtered = the prefix (title,
  // Last updated) + the rows that resolve to the type's folder.
  let items;
  if (type === null) {
    items = lines.map((text, i) => ({ text, line: i, isRow: false }));
    for (const r of parsed.rows) items[r.line].isRow = true;
    // A trailing '' from the final newline is not a line of content.
    if (items.length && items[items.length - 1].text === '' && content.endsWith('\n')) items.pop();
  } else {
    const folder = FOLDER_OF_TYPE.get(type);
    items = [];
    if (parsed.title) items.push({ text: parsed.title.text, line: parsed.title.line, isRow: false, prefix: true });
    if (parsed.lastUpdated) items.push({ text: lines[parsed.lastUpdated.line], line: parsed.lastUpdated.line, isRow: false, prefix: true });
    items.sort((a, b) => a.line - b.line);
    for (const r of parsed.rows) {
      const res = resolveTarget(r.target, inventory);
      if (res.path && res.path.startsWith(folder + '/')) items.push({ text: lines[r.line], line: r.line, isRow: true });
    }
  }
  const rowsTotal = items.filter((it) => it.isRow).length;

  // The lines a page must carry before item i when i is NOT preceded on the
  // page by its own context: [heading, '', header, separator] as they exist.
  const contextLines = (it) => {
    const c = ctxOf[it.line];
    if (!c || !it.isRow) return [];
    const out = [];
    if (c.heading !== null) out.push(lines[c.heading], '');
    if (c.header) out.push(...c.header.map((l) => lines[l]));
    else out.push(INDEX_TABLE_HEADER, INDEX_TABLE_SEPARATOR);
    return out;
  };
  const ctxKey = (it) => (it.isRow && ctxOf[it.line] ? ctxOf[it.line].key : null);

  /** Render items [s, e) as one page of markdown. */
  const renderContent = (s, e) => {
    const out = [];
    let cur = null;          // the context the last emitted line established
    for (let i = s; i < e; i++) {
      const it = items[i];
      if (type === null) {
        // Unfiltered: lines in document order. A page that starts INSIDE a
        // table (or mid-section) repeats the context once, at its top.
        if (i === s && s > 0) {
          const c = ctxOf[it.line];
          if (c && (it.isRow || lines[it.line].startsWith('|'))) {
            const startsAtHeader = c.header && c.header[0] === it.line;
            if (c.heading !== null && c.heading < it.line) out.push(lines[c.heading], '');
            if (!startsAtHeader) out.push(...contextLines({ ...it, isRow: true }).slice(c.heading !== null ? 2 : 0));
          }
        }
        out.push(it.text);
      } else {
        // Filtered: the prefix (title, Last updated — page 1 only, they sort
        // first), then rows, each run under its own heading + table header.
        if (it.isRow) {
          const k = ctxKey(it);
          if (k !== cur) {
            if (out.length && out[out.length - 1] !== '') out.push('');
            out.push(...contextLines(it));
            cur = k;
          }
        }
        out.push(it.text);
      }
    }
    return out.join('\n') + '\n';
  };

  const envelope = (page, of, contentText, s, e) => {
    const rowsOnPage = items.slice(s, e).filter((it) => it.isRow).length;
    const r = {
      ok: true, domain, view: 'index', type,
      page, of, rows_total: rowsTotal, rows_on_page: rowsOnPage,
      basis,
      content: contentText,
    };
    if (page < of) r.continuation = { page: page + 1, of, remaining: of - page };
    if (indexHealth) r.index_health = indexHealth;
    r.report = indexReport(page, of, rowsOnPage, rowsTotal, indexHealth, type);
    return r;
  };

  const overhead = bytesOf(envelope(Math.max(1, items.length), Math.max(1, items.length), '', 0, 0)) + 64;
  const cost = (i, first) => {
    const it = items[i];
    let c = jsonStrBytes(it.text) + 2;                   // the line + its "\n"
    if (first || (type !== null && it.isRow && (i === 0 || ctxKey(items[i - 1]) !== ctxKey(it)))) {
      for (const l of contextLines(it)) c += jsonStrBytes(l) + 2;
      c += 2;
    }
    return c;
  };
  const replies = planPages(items.length, cost, overhead,
    (s, e, page, of) => envelope(page, of, renderContent(s, e), s, e));
  const of = replies.length;
  if (pageArg.value > of) return pageOutOfRange(pageArg.value, of, domain, 'index');
  return replies[pageArg.value - 1];
}

/**
 * For every line inside a page table: { key, heading, header } — the table's
 * header line numbers ([header, separator]) when the table has them, and the
 * `## ` heading line of the enclosing block, or null.
 */
function lineContexts(parsed) {
  const { lines, blocks } = parsed;
  const out = new Array(lines.length).fill(null);
  const headingAt = new Array(lines.length).fill(null);
  for (const b of blocks) for (let i = b.start; i < b.end; i++) headingAt[i] = b.heading;
  const SEP = /^\|[\s|:-]*-[\s|:-]*$/;
  for (let i = 0; i < lines.length;) {
    if (!lines[i].startsWith('|')) { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].startsWith('|')) j++;
    const header = (i + 1 < j && SEP.test(lines[i + 1]) && !parsed.rows.some((r) => r.line === i)) ? [i, i + 1] : null;
    const heading = headingAt[i];
    const key = `${heading === null ? '-' : heading}:${i}`;
    for (let x = i; x < j; x++) out[x] = { key, heading, header };
    i = j;
  }
  return out;
}

function indexReport(page, of, rowsOnPage, rowsTotal, health, type) {
  const healthLine = health
    ? ` index.md is missing ${health.missing_from_index} page${health.missing_from_index === 1 ? '' : 's'} and has ${health.stale_rows} row${health.stale_rows === 1 ? '' : 's'} for pages that no longer exist; for a complete list call get_index with view: "pages".`
    : '';
  const what = type ? `${type} rows` : 'rows';
  if (of === 1) return `The whole index in one reply (${rowsOnPage} ${what}).${healthLine}`;
  if (page === 1) {
    return `PAGED: this index arrives in ${of} replies of at most ≈20k tokens each, so no harness moves it into a file. ` +
      `This is page 1 of ${of} (${rowsOnPage} of ${rowsTotal} ${what}). BEFORE you rely on it, call get_index again ` +
      `with the same arguments plus page: 2.${healthLine}`;
  }
  if (page === of) return `This is the LAST page (${of} of ${of}; ${rowsOnPage} of ${rowsTotal} ${what}).${healthLine}`;
  return `Page ${page} of ${of} (${rowsOnPage} of ${rowsTotal} ${what}). Call get_index again with the same arguments plus page: ${page + 1}.${healthLine}`;
}

// ── view "pages" ─────────────────────────────────────────────────────────────

async function pagesView(domain, type, page, storage) {
  const known = typeof storage.listDomains === 'function' ? await storage.listDomains() : null;
  if (Array.isArray(known) && !known.includes(domain)) {
    return refuse('unknown-domain', `Unknown domain: ${domain}. Available: ${known.join(', ') || '(none)'}`);
  }
  const all = await pageList(domain, storage);
  const folder = type ? FOLDER_OF_TYPE.get(type) : null;
  const list = (folder ? all.filter((p) => p.folder === folder) : all).map((p) => {
    const e = { slug: p.slug, type: p.type, title: p.title };
    if (p.created) e.created = p.created;
    if (p.date) e.date = p.date;
    if (p.source) e.source = p.source;
    return e;
  });
  const basis = sha12(all.map((p) => p.path).join('\n'));

  const envelope = (pg, of, s, e) => {
    const r = {
      ok: true, domain, view: 'pages', type,
      page: pg, of, pages_total: list.length, pages_on_page: e - s,
      basis,
      note: PAGES_NOTE,
      pages: list.slice(s, e),
    };
    if (pg < of) r.continuation = { page: pg + 1, of, remaining: of - pg };
    r.report = pagesReport(pg, of, e - s, list.length, type);
    return r;
  };
  // Each entry at depth 2 of the pretty-printed reply: its own pretty JSON,
  // indented 4 more per line, plus ",\n".
  const cost = (i) => {
    const t = JSON.stringify(list[i], null, 2);
    return Buffer.byteLength(t, 'utf8') + 4 * (t.split('\n').length) + 2;
  };
  const overhead = bytesOf(envelope(Math.max(1, list.length), Math.max(1, list.length), 0, 0)) + 64;
  const replies = planPages(list.length, cost, overhead, (s, e, pg, of) => envelope(pg, of, s, e));
  const of = replies.length;
  if (page > of) return pageOutOfRange(page, of, domain, 'page list');
  return replies[page - 1];
}

function pagesReport(page, of, onPage, total, type) {
  const what = type ? `${type} page${total === 1 ? '' : 's'}` : `page${total === 1 ? '' : 's'}`;
  if (of === 1) return `${total} ${what}, listed from the files on disk — complete, in one reply.`;
  if (page === 1) {
    return `PAGED: this list arrives in ${of} replies of at most ≈20k tokens each. This is page 1 of ${of} ` +
      `(${onPage} of ${total} ${what}). BEFORE you rely on it, call get_index again with the same arguments plus page: 2.`;
  }
  if (page === of) return `This is the LAST page (${of} of ${of}; ${onPage} of ${total} ${what}).`;
  return `Page ${page} of ${of} (${onPage} of ${total} ${what}). Call get_index again with the same arguments plus page: ${page + 1}.`;
}
