/**
 * wiki-index.js — index.md as DATA (v3.83.0).
 *
 * One module owns how index.md is read, how its rows resolve to pages on disk,
 * how missing rows are added after a write, and how a full rebuild is composed.
 * Ingest, compile and the MCP's compile_to_wiki all add rows through
 * `ensurePagesInIndex`; Health's rebuild composes through `rebuildIndexText`.
 *
 * Rules this module keeps (see CONTRACT v3.83.0 §2, §4):
 *
 *  • DETERMINISTIC, never an LLM. The same index text + the same files + the
 *    same date always give the same bytes.
 *  • CANONICAL-PATH coverage. A row covers the file its link resolves to by the
 *    Health rule (health.js — bare `[[x]]` → entities/x.md, else concepts/x.md;
 *    `[[summaries/x]]` → summaries/x.md), never by basename. A summary and a
 *    concept that share a slug are two pages and need two rows.
 *  • Rows sort by `compareSlugs` — UTF-16 code units, case-folded first — and
 *    NEVER `localeCompare`: two machines with different locales would write
 *    different files and churn Personal Sync.
 *  • An existing row's description is kept byte-for-byte (after trim).
 *  • `ensureRowsInIndex` only ADDS rows: it never removes, reorders or edits an
 *    existing row, and it is idempotent (a second call returns `text: null`).
 *
 * The pure part has no fs import. The fs wrapper at the bottom reads through
 * files.js. Reachable from mcp/ — this module NEVER writes to stdout.
 */

import { readdir, readFile, realpath } from 'fs/promises';
import path from 'path';
import { localDateStamp } from './local-date.js';
import {
  wikiPath, readIndex, writePage, readSchema, extractDomainDisplayName,
} from './files.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const INDEX_TABLE_HEADER = '| Page | Type | Summary |';
export const INDEX_TABLE_SEPARATOR = '|------|------|---------|';
export const INDEX_DESCRIPTION_MAX = 160;
export const INDEX_SECTIONS = Object.freeze([
  Object.freeze({ folder: 'summaries', type: 'summary', heading: '## Summaries' }),
  Object.freeze({ folder: 'entities',  type: 'entity',  heading: '## Entities' }),
  Object.freeze({ folder: 'concepts',  type: 'concept', heading: '## Concepts' }),
]);

const SECTION_BY_FOLDER = new Map(INDEX_SECTIONS.map((s) => [s.folder, s]));
const FOLDER_ORDER = new Map(INDEX_SECTIONS.map((s, i) => [s.folder, i]));
const SAMPLE_MAX = 10;

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Sanitise free text for one markdown table cell: pipe/CR/LF → space,
 *  whitespace collapsed, trimmed, capped at INDEX_DESCRIPTION_MAX code units
 *  without splitting a surrogate pair. */
export function cellSafe(s) {
  let out = String(s ?? '')
    .replace(/[|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > INDEX_DESCRIPTION_MAX) {
    let cut = INDEX_DESCRIPTION_MAX;
    const c = out.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut -= 1; // never leave a lone high surrogate
    out = out.slice(0, cut).trim();
  }
  return out;
}

/** Order two slugs: case-folded UTF-16 code units, ties by raw code units.
 *  Locale-independent by construction (`toLowerCase`, `<`), never `localeCompare`. */
export function compareSlugs(a, b) {
  const sa = String(a), sb = String(b);
  const la = sa.toLowerCase(), lb = sb.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/** Split a canonical page path ('entities/x.md') → { folder, name, slug } or null. */
function splitCanon(canonPath) {
  if (typeof canonPath !== 'string') return null;
  const i = canonPath.indexOf('/');
  if (i < 0) return null;
  const folder = canonPath.slice(0, i);
  const name = canonPath.slice(i + 1);
  if (!SECTION_BY_FOLDER.has(folder)) return null;
  if (!name.endsWith('.md') || name.length <= 3 || name.includes('/') || name.includes('\\')) return null;
  return { folder, name, slug: name.slice(0, -3) };
}

/** The wikilink target for a canonical path: 'x' for entities/concepts, 'summaries/x' for summaries. */
export function linkFor(canonPath) {
  const c = splitCanon(canonPath);
  if (!c) throw new Error(`linkFor: not a canonical page path: ${canonPath}`);
  return c.folder === 'summaries' ? `summaries/${c.slug}` : c.slug;
}

function rowLine(link, type, description) {
  return `| [[${link}]] | ${type} | ${description} |`;
}

/** One index row for a canonical path; the description is made cell-safe. */
export function rowFor(canonPath, description) {
  const c = splitCanon(canonPath);
  if (!c) throw new Error(`rowFor: not a canonical page path: ${canonPath}`);
  return rowLine(linkFor(canonPath), SECTION_BY_FOLDER.get(c.folder).type, cellSafe(description));
}

/** Can a page with this slug be written as `[[slug]]`? No leading/trailing
 *  whitespace, and none of | [ ] # ^ CR LF. */
export function isLinkableSlug(slug) {
  if (typeof slug !== 'string' || slug === '') return false;
  if (slug !== slug.trim()) return false;
  return !/[|[\]#^\r\n]/.test(slug);
}

const nfc = (s) => String(s).normalize('NFC');

// ── Inventory ────────────────────────────────────────────────────────────────

/**
 * Build the page inventory from the three folders' FILENAMES (incl. `.md`).
 *
 * @returns {{
 *   byFolder: { entities: Map, concepts: Map, summaries: Map },  // NFC slug → entry
 *   paths: string[],          // every ADDRESSABLE page, section order then compareSlugs
 *   all: string[],            // every .md file given
 *   unlinkable: string[],     // canonical paths whose slug cannot be a wikilink
 *   unaddressable: string[],  // concepts/x where entities/x exists (bare [[x]] → entity),
 *                             // or an NFC twin of an earlier file in the same folder
 * }}
 */
export function buildInventory({ entities = [], concepts = [], summaries = [] } = {}) {
  const input = { entities, concepts, summaries };
  const byFolder = { entities: new Map(), concepts: new Map(), summaries: new Map() };
  const all = [];
  const unlinkable = [];
  const unaddressable = [];
  const entriesByFolder = {};

  for (const { folder } of INDEX_SECTIONS) {
    const names = [...new Set((input[folder] || [])
      .filter((n) => typeof n === 'string' && n.endsWith('.md') && n.length > 3
        && !n.includes('/') && !n.includes('\\')))];
    names.sort((a, b) => compareSlugs(a.slice(0, -3), b.slice(0, -3)));
    entriesByFolder[folder] = [];
    for (const name of names) {
      const slug = name.slice(0, -3);
      const p = `${folder}/${name}`;
      all.push(p);
      if (!isLinkableSlug(slug)) { unlinkable.push(p); continue; }
      const key = nfc(slug);
      if (byFolder[folder].has(key)) { unaddressable.push(p); continue; }
      const entry = { folder, name, slug, key, path: p, addressable: true };
      byFolder[folder].set(key, entry);
      entriesByFolder[folder].push(entry);
    }
  }
  // A concept whose bare link resolves to an entity can never be named by a bare row.
  for (const entry of entriesByFolder.concepts) {
    if (byFolder.entities.has(entry.key)) {
      entry.addressable = false;
      unaddressable.push(entry.path);
    }
  }
  const paths = [];
  for (const { folder } of INDEX_SECTIONS) {
    for (const e of entriesByFolder[folder]) if (e.addressable) paths.push(e.path);
  }
  return { byFolder, paths, all, unlinkable, unaddressable };
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const stripCR = (l) => (l.endsWith('\r') ? l.slice(0, -1) : l);
const SEPARATOR_RE = /^\|[\s|:-]*-[\s|:-]*$/;
const INDEX_HEADER_RE = /^\|\s*Page\s*\|\s*Type\s*\|\s*Summary\s*\|?\s*$/i;
const HEADING2_RE = /^## /;

function findUnescapedPipe(s, from = 0) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '|') return i;
  }
  return -1;
}

/** Parse one line as a page row, or null. A page row's FIRST cell is exactly one wikilink. */
function parseRowLine(line) {
  const m = /^\|\s*\[\[/.exec(line);
  if (!m) return null;
  const start = m[0].length;
  const close = line.indexOf(']]', start);
  if (close < 0) return null;
  const inner = line.slice(start, close);
  if (inner.includes('[[') || inner.includes('\n')) return null;
  let k = close + 2;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  if (k < line.length && line[k] !== '|') return null; // the first cell holds more than one link

  let before = inner;
  let alias = null;
  const sep = inner.indexOf('|');
  if (sep >= 0) {
    alias = inner.slice(sep + 1);
    before = inner.slice(0, sep);
    if (before.endsWith('\\')) before = before.slice(0, -1); // `[[x\|y]]` — the table-escaped alias
  }
  let anchor = null;
  const h = before.indexOf('#');
  if (h >= 0) { anchor = before.slice(h + 1); before = before.slice(0, h); }
  const target = before.trim();
  if (!target) return null;

  let typeCell = '';
  let description = '';
  if (k < line.length) {
    const rest = line.slice(k + 1);
    const p = findUnescapedPipe(rest);
    if (p < 0) {
      typeCell = rest.trim();
    } else {
      typeCell = rest.slice(0, p).trim();
      let d = rest.slice(p + 1).replace(/\s+$/, '');
      if (d.endsWith('|') && !d.endsWith('\\|')) d = d.slice(0, -1); // the optional closing pipe
      description = d.trim();
    }
  }
  return { target, typeCell, description, alias, anchor };
}

/**
 * Parse index.md text. PURE.
 * @returns {{
 *   lines: string[],                       // CR-stripped
 *   title: { line: number, text: string } | null,
 *   lastUpdated: { line: number } | null,
 *   sectioned: boolean,
 *   rows: Array<{ line, target, typeCell, description, alias, anchor }>,
 *   blocks: Array<{ start, end, heading: number|null, headingText: string|null,
 *                   absorbable: boolean, sectionFolder: string|null }>,
 *   pageTableLines: Set<number>,           // page rows + header/separator lines of page tables
 * }}
 */
export function parseIndex(text) {
  const raw = typeof text === 'string' ? text : '';
  const lines = raw === '' ? [] : raw.split('\n').map(stripCR);
  const rows = [];
  const rowAt = new Map();
  for (let i = 0; i < lines.length; i++) {
    const r = parseRowLine(lines[i]);
    if (r) { const row = { line: i, ...r }; rows.push(row); rowAt.set(i, row); }
  }

  // Table runs: consecutive lines starting with '|'. Page rows are absorbed
  // wherever they are; a run's header/separator lines only when the run is a
  // page table (nothing but page rows, separators and a header).
  const pageTableLines = new Set(rowAt.keys());
  for (let i = 0; i < lines.length;) {
    if (!lines[i].startsWith('|')) { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].startsWith('|')) j++;
    let hasRow = false, allPage = true, headerOk = false;
    for (let x = i; x < j; x++) {
      if (rowAt.has(x)) { hasRow = true; continue; }
      if (SEPARATOR_RE.test(lines[x])) continue;
      if (x === i && i + 1 < j && SEPARATOR_RE.test(lines[i + 1])) {
        if (INDEX_HEADER_RE.test(lines[x])) headerOk = true;
        continue;
      }
      allPage = false;
    }
    if (allPage && (hasRow || headerOk)) for (let x = i; x < j; x++) pageTableLines.add(x);
    i = j;
  }

  // Blocks: the preamble, then one per `## ` heading.
  const blocks = [];
  let cur = { start: 0, heading: null, headingText: null };
  for (let i = 0; i < lines.length; i++) {
    if (HEADING2_RE.test(lines[i])) {
      cur.end = i;
      blocks.push(cur);
      cur = { start: i, heading: i, headingText: lines[i].trim() };
    }
  }
  cur.end = lines.length;
  blocks.push(cur);

  const sectionHeadings = new Map(INDEX_SECTIONS.map((s) => [s.heading, s.folder]));
  const takenSections = new Set();
  for (const b of blocks) {
    let absorbable = b.heading !== null;
    if (absorbable) {
      for (let i = b.start + 1; i < b.end; i++) {
        if (lines[i].trim() === '' || pageTableLines.has(i)) continue;
        absorbable = false; break;
      }
    }
    b.absorbable = absorbable;
    const folder = absorbable ? sectionHeadings.get(b.headingText) : undefined;
    b.sectionFolder = folder && !takenSections.has(folder) ? folder : null;
    if (b.sectionFolder) takenSections.add(folder);
  }

  const pre = blocks[0];
  let title = null, lastUpdated = null;
  for (let i = pre.start; i < pre.end; i++) {
    if (!title && /^# /.test(lines[i]) && !pageTableLines.has(i)) title = { line: i, text: lines[i] };
    if (!lastUpdated && /^Last updated:/.test(lines[i])) lastUpdated = { line: i };
  }

  return {
    lines, title, lastUpdated,
    sectioned: blocks.some((b) => b.sectionFolder),
    rows, blocks, pageTableLines,
  };
}

// ── Resolution and coverage ──────────────────────────────────────────────────

/**
 * Resolve a row's link target to a page on disk (the Health rule + two repoints).
 *   summaries/x → summaries/x.md
 *   x           → entities/x.md, else concepts/x.md, else (repoint) summaries/x.md
 *   entities/x, concepts/x → the BARE canonical in entities/ then concepts/ (repoint to [[x]])
 * No fuzzy or hyphen matching — that is Health's broken-link job.
 * @returns {{ path: string|null, link: string|null, repointed: boolean }}
 */
export function resolveTarget(target, inventory) {
  const none = { path: null, link: null, repointed: false };
  if (typeof target !== 'string' || !inventory) return none;
  const t = target.trim();
  if (!t) return none;
  const { byFolder } = inventory;
  const bare = (slug) => byFolder.entities.get(nfc(slug)) || byFolder.concepts.get(nfc(slug)) || null;
  const slash = t.indexOf('/');
  if (slash >= 0) {
    const folder = t.slice(0, slash);
    const rest = t.slice(slash + 1);
    if (!rest || rest.includes('/')) return none;
    if (folder === 'summaries') {
      const e = byFolder.summaries.get(nfc(rest));
      return e ? { path: e.path, link: t, repointed: false } : none;
    }
    if (folder === 'entities' || folder === 'concepts') {
      const e = bare(rest);
      return e ? { path: e.path, link: rest, repointed: true } : none;
    }
    return none;
  }
  const e = bare(t);
  if (e) return { path: e.path, link: t, repointed: false };
  const s = byFolder.summaries.get(nfc(t));
  if (s) return { path: s.path, link: `summaries/${t}`, repointed: true };
  return none;
}

function folderOf(p) { return p.slice(0, p.indexOf('/')); }
function slugOfPath(p) { return p.slice(p.indexOf('/') + 1, -3); }
function comparePaths(a, b) {
  const fa = FOLDER_ORDER.get(folderOf(a)), fb = FOLDER_ORDER.get(folderOf(b));
  if (fa !== fb) return fa - fb;
  return compareSlugs(slugOfPath(a), slugOfPath(b));
}

/**
 * Which pages does the index cover, by CANONICAL PATH? PURE.
 * @returns {{ covered: Map<string, number>, resolved: Map<string, {row, link, repointed}>,
 *   missing: string[], stale: Row[], duplicates: Row[], repointable: Row[],
 *   unlinkable: string[], unaddressable: string[], typeCellsWrong: number, aliasesDropped: number }}
 *  `missing` is in section order (Summaries, Entities, Concepts) then compareSlugs.
 *  `typeCellsWrong` and `aliasesDropped` count the KEPT (first, covering) rows only.
 */
export function indexCoverage(parsed, inventory) {
  const covered = new Map();
  const resolved = new Map();
  const stale = [], duplicates = [], repointable = [];
  let typeCellsWrong = 0, aliasesDropped = 0;
  for (const row of parsed.rows) {
    const res = resolveTarget(row.target, inventory);
    if (!res.path) { stale.push(row); continue; }
    if (covered.has(res.path)) { duplicates.push(row); continue; }
    covered.set(res.path, row.line);
    resolved.set(res.path, { row, link: res.link, repointed: res.repointed });
    if (res.repointed) repointable.push(row);
    if (row.typeCell !== SECTION_BY_FOLDER.get(folderOf(res.path)).type) typeCellsWrong++;
    if (row.alias !== null || row.anchor !== null) aliasesDropped++;
  }
  const missing = inventory.paths.filter((p) => !covered.has(p)).sort(comparePaths);
  return {
    covered, resolved, missing, stale, duplicates, repointable,
    unlinkable: [...inventory.unlinkable], unaddressable: [...inventory.unaddressable],
    typeCellsWrong, aliasesDropped,
  };
}

// ── Descriptions ─────────────────────────────────────────────────────────────

function splitFrontmatter(content) {
  const text = String(content ?? '').replace(/^﻿/, '');
  const lines = text.split('\n').map(stripCR);
  let title = null;
  let bodyStart = 0;
  if (lines.length && lines[0].trim() === '---') {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === '---') {
        for (let x = 1; x < j; x++) {
          const m = /^title:\s*(.*)$/.exec(lines[x]);
          if (m) {
            const v = m[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim();
            if (v) { title = v; break; }
          }
        }
        bodyStart = j + 1;
        break;
      }
    }
  }
  return { title, body: lines.slice(bodyStart) };
}

function cleanInline(s) {
  return s
    .replace(/\[\[([^\]]*?)\]\]/g, (_, inner) => {
      const sep = inner.indexOf('|');
      if (sep >= 0) return inner.slice(sep + 1);
      const h = inner.indexOf('#');
      return h >= 0 ? inner.slice(0, h) : inner;
    })
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) → text
    .replace(/\[\[|\]\]/g, '')                // no wikilink survives, even a broken one
    .replace(/\*\*|__|`/g, '')
    .replace(/\\$/, '');                      // a trailing backslash would escape the cell's pipe
}

// "Dr." / "e.g." / "J." do not end a sentence.
const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'sr', 'jr', 'vs', 'etc',
  'e.g', 'i.e', 'inc', 'ltd', 'co', 'no', 'fig', 'approx', 'vol', 'ed', 'cf', 'al']);
function endsWithAbbreviation(cut) {
  const m = /(?:^|[\s(])([A-Za-z](?:[A-Za-z.]*[A-Za-z])?)\.$/.exec(cut);
  if (!m) return false;
  const w = m[1];
  return (w.length === 1 && /[A-Z]/.test(w)) || ABBREVIATIONS.has(w.toLowerCase());
}

/** Over the cap → cut at the last word boundary and end with an ellipsis (≤ the cap). */
function fitDescription(s) {
  const v = cellSafe(s);
  const full = String(s ?? '').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (full.length <= INDEX_DESCRIPTION_MAX) return v;
  const room = v.slice(0, INDEX_DESCRIPTION_MAX - 1);
  const sp = room.lastIndexOf(' ');
  const head = (sp >= 80 ? room.slice(0, sp) : room).replace(/[\s,;:.\-–—]+$/, '');
  return cellSafe(head + '\u2026');
}

function firstSentence(body) {
  for (const raw of body) {
    let l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#')) continue;                                // any heading
    if (/^(Type|Tags|Source|Date Ingested):/i.test(l)) continue;     // Curator inline metadata
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(l)) continue;                 // a horizontal rule
    if (l.startsWith('|')) continue;                                // a table line
    l = l.replace(/^(?:[-*+]\s+|>\s*|\d+\.\s+)+/, '');              // list / quote markers
    l = cleanInline(l).replace(/\s+/g, ' ').trim();
    if (!l) continue;
    const re = /[.!?] /g;
    let m;
    while ((m = re.exec(l)) !== null) {
      const cut = l.slice(0, m.index + 1);
      if (cut.length >= 20 && !endsWithAbbreviation(cut)) return cut;
    }
    return l;
  }
  return '';
}

function firstH1(body) {
  for (const l of body) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) return cleanInline(m[1]).trim();
  }
  return '';
}

/**
 * A one-line description for an index row, derived from the page itself — no LLM.
 * Curator frontmatter carries no `title:` (injectFrontmatter writes type/source/
 * date/tags/created only), so the H1 and the first body sentence do the work;
 * a `title:` from a user-supplied pre-formatted page is honoured.
 *   summaries:          title: → first H1 → first body sentence
 *   entities/concepts:  first body sentence → title: → first H1 → ''
 * Headings of every level are skipped (an `## Overview` heading never leaks in).
 * The result is cellSafe: no `|`, no newline, ≤ INDEX_DESCRIPTION_MAX, no `[[`.
 */
export function deriveDescription(content, canonPath) {
  const { title, body } = splitFrontmatter(content);
  const isSummary = typeof canonPath === 'string' && canonPath.startsWith('summaries/');
  const t = title ? cleanInline(title).trim() : '';
  const order = isSummary
    ? [() => t, () => firstH1(body), () => firstSentence(body)]
    : [() => firstSentence(body), () => t, () => firstH1(body)];
  for (const f of order) {
    const v = fitDescription(f());
    if (v) return v;
  }
  return '';
}

// ── Composition ──────────────────────────────────────────────────────────────

function rowSortKey(target) {
  const t = String(target).trim();
  const m = /^(summaries|entities|concepts)\/(.*)$/.exec(t);
  return m ? m[2] : t;
}

function titleLine(opts) {
  const name = opts && typeof opts.displayName === 'string' && opts.displayName.trim()
    ? opts.displayName.trim() : '';
  return name ? `# Wiki Index — ${name}` : '# Wiki Index';
}

function sectionLines(section, rowLines) {
  return [section.heading, '', INDEX_TABLE_HEADER, INDEX_TABLE_SEPARATOR, ...rowLines];
}

/** Push `src` onto `out`, collapsing runs of blank lines and dropping leading blanks. */
function pushCollapsed(out, src) {
  for (const l of src) {
    const blank = l.trim() === '';
    if (blank && (out.length === 0 || out[out.length - 1].trim() === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

function normaliseEntries(entries) {
  const byPath = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !splitCanon(e.canonPath)) continue;
    const desc = typeof e.description === 'string' ? e.description : null;
    const prev = byPath.get(e.canonPath);
    if (!prev) byPath.set(e.canonPath, { canonPath: e.canonPath, description: desc });
    else if (!prev.description && desc) prev.description = desc;
  }
  return [...byPath.values()];
}

function linkKey(target) {
  const t = nfc(String(target).trim());
  const m = /^(entities|concepts)\/(.*)$/.exec(t);
  return m ? m[2] : t;
}

/**
 * Add a row for every entry whose page the index does not already cover. PURE.
 *
 * entries: [{ canonPath, description }]  (description null/'' → empty cell)
 * opts:    { today, displayName, inventory? }
 *   With `opts.inventory` (the fs wrapper always passes it) coverage is by
 *   canonical path exactly as Health counts it, and an entry whose page is not
 *   on disk, unlinkable or unaddressable is skipped. Without it, an entry is
 *   covered when a row already carries its link (`[[x]]`, `[[entities/x]]`,
 *   `[[concepts/x]]` all count for x; `[[summaries/x]]` only for the summary),
 *   and only unlinkable slugs are skipped.
 *
 * Insert position: sectioned index → sorted position inside its section's table
 * (the section is created, in INDEX_SECTIONS order, if absent); legacy single
 * table → after its last row; no table → a fresh sectioned body appended; ''
 * → a full header plus the sectioned body. The first `Last updated:` line is
 * set to `opts.today` only when rows are added. Existing lines are never
 * edited, removed or reordered (CRLF files keep their line endings).
 *
 * @returns {{ text: string|null, added: string[] }}  text null ⇒ nothing to add
 */
export function ensureRowsInIndex(indexText, entries, opts = {}) {
  const text = typeof indexText === 'string' ? indexText : '';
  const today = opts.today || localDateStamp();
  const inventory = opts.inventory || null;
  const list = normaliseEntries(entries);

  const parsed = parseIndex(text);
  let isCovered;
  let skip;
  if (inventory) {
    const cov = indexCoverage(parsed, inventory);
    const onDisk = new Set(inventory.paths); // addressable + linkable only
    isCovered = (p) => cov.covered.has(p);
    skip = (p) => !onDisk.has(p);
  } else {
    const keys = new Set(parsed.rows.map((r) => linkKey(r.target)));
    isCovered = (p) => keys.has(nfc(linkFor(p)));
    skip = (p) => !isLinkableSlug(splitCanon(p).slug);
  }
  const toAdd = list.filter((e) => !skip(e.canonPath) && !isCovered(e.canonPath));
  if (toAdd.length === 0) return { text: null, added: [] };
  toAdd.sort((a, b) => comparePaths(a.canonPath, b.canonPath));
  const added = toAdd.map((e) => e.canonPath);
  const rowOf = (e) => rowFor(e.canonPath, e.description || '');
  const groups = new Map(INDEX_SECTIONS.map((s) => [s.folder, []]));
  for (const e of toAdd) groups.get(folderOf(e.canonPath)).push(e);

  const freshBody = () => {
    const out = [];
    for (const s of INDEX_SECTIONS) {
      if (out.length) out.push('');
      out.push(...sectionLines(s, groups.get(s.folder).map(rowOf)));
    }
    return out;
  };

  // 1. Nothing there yet → a whole new index.
  if (text.trim() === '') {
    const out = [titleLine(opts), `Last updated: ${today}`, '', ...freshBody()];
    return { text: out.join('\n') + '\n', added };
  }

  const rawLines = text.split('\n');
  const cr = text.includes('\r\n') ? '\r' : '';
  const L = (s) => s + cr;
  const inserts = []; // { at, lines } — applied bottom-up
  const insertAt = (at, lines) => inserts.push({ at, lines: lines.map(L), seq: inserts.length });
  const lines = parsed.lines;
  const lastNonBlank = (from, to) => {
    for (let i = to - 1; i >= from; i--) if (lines[i].trim() !== '') return i;
    return from;
  };

  if (parsed.sectioned) {
    // 2. Sectioned → each row into its section's table at its sorted position.
    for (const s of INDEX_SECTIONS) {
      const group = groups.get(s.folder);
      if (!group.length) continue;
      const block = parsed.blocks.find((b) => b.sectionFolder === s.folder);
      if (block) {
        const rows = parsed.rows.filter((r) => r.line > block.start && r.line < block.end);
        if (rows.length) {
          const lastRow = rows[rows.length - 1].line;
          for (const e of group) {
            const slug = splitCanon(e.canonPath).slug;
            const next = rows.find((r) => compareSlugs(rowSortKey(r.target), slug) > 0);
            insertAt(next ? next.line : lastRow + 1, [rowOf(e)]);
          }
        } else {
          let anchor = -1;
          for (let i = block.start + 1; i < block.end; i++) if (parsed.pageTableLines.has(i)) anchor = i;
          if (anchor >= 0) insertAt(anchor + 1, group.map(rowOf));
          else insertAt(block.start + 1, ['', INDEX_TABLE_HEADER, INDEX_TABLE_SEPARATOR, ...group.map(rowOf)]);
        }
      } else {
        const order = FOLDER_ORDER.get(s.folder);
        const later = parsed.blocks.find((b) => b.sectionFolder && FOLDER_ORDER.get(b.sectionFolder) > order);
        const fresh = sectionLines(s, group.map(rowOf));
        if (later) {
          const needBlankBefore = later.heading > 0 && lines[later.heading - 1].trim() !== '';
          insertAt(later.heading, [...(needBlankBefore ? [''] : []), ...fresh, '']);
        } else {
          const earlier = [...parsed.blocks].reverse()
            .find((b) => b.sectionFolder && FOLDER_ORDER.get(b.sectionFolder) < order);
          insertAt(lastNonBlank(earlier.start, earlier.end) + 1, ['', ...fresh]);
        }
      }
    }
  } else if (parsed.pageTableLines.size > 0) {
    // 3. Legacy single table → after the last page-table line (today's behaviour).
    const last = Math.max(...parsed.pageTableLines);
    insertAt(last + 1, toAdd.map(rowOf));
  } else {
    // 4. Text but no table → a fresh sectioned body after the existing text.
    const body = text.replace(/\s+$/, '');
    const out = body.split('\n');
    const luIdx = out.findIndex((l) => /^Last updated:.*$/.test(stripCR(l)));
    if (luIdx >= 0) out[luIdx] = L(`Last updated: ${today}`);
    return { text: [...out, L(''), ...freshBody().map(L)].join('\n') + '\n', added };
  }

  inserts.sort((a, b) => (b.at - a.at) || (b.seq - a.seq));
  for (const ins of inserts) rawLines.splice(ins.at, 0, ...ins.lines);
  // Found again in the final array: an insertion may sit above it.
  const luIdx = rawLines.findIndex((l) => /^Last updated:.*$/.test(stripCR(l)));
  if (luIdx >= 0) rawLines[luIdx] = L(`Last updated: ${today}`);
  return { text: rawLines.join('\n'), added };
}

/**
 * Compose the rebuilt index.md (CONTRACT §2.3). PURE.
 *
 * indexText:     the current index.md text, or null when the file does not exist
 * inventory:     buildInventory(...) of the pages on disk
 * derivedByPath: Map<canonPath, description> for MISSING pages (absent ⇒ '')
 * opts:          { today, displayName }
 * @returns {{ text: string, summary: object, samples: object }}
 */
export function rebuildIndexText(indexText, inventory, derivedByPath, opts = {}) {
  const exists = typeof indexText === 'string';
  const text = exists ? indexText : '';
  const today = opts.today || localDateStamp();
  const derived = derivedByPath instanceof Map ? derivedByPath : new Map();
  const parsed = parseIndex(text);
  const cov = indexCoverage(parsed, inventory);
  const { lines } = parsed;

  // Rows, per section.
  const bySection = new Map(INDEX_SECTIONS.map((s) => [s.folder, []]));
  let keepDescriptions = 0, deriveDescriptions = 0, emptyDescriptions = 0;
  const addSamples = [];
  const addByFolder = { entities: 0, concepts: 0, summaries: 0 };
  for (const p of inventory.paths) {
    const folder = folderOf(p);
    const hit = cov.resolved.get(p);
    let link, description;
    if (hit) {
      link = hit.link;
      description = hit.row.description;
      if (description) keepDescriptions++;
    } else {
      link = linkFor(p);
      description = cellSafe(derived.get(p) || '');
      if (description) deriveDescriptions++;
      addByFolder[folder]++;
    }
    if (!description) emptyDescriptions++;
    bySection.get(folder).push({ path: p, link, description, isNew: !hit });
  }
  for (const list of bySection.values()) {
    list.sort((a, b) => compareSlugs(rowSortKey(a.link), rowSortKey(b.link)) || compareSlugs(a.path, b.path));
  }

  // Preamble prose: block 0 minus title, Last updated and page-table lines.
  const pre = parsed.blocks[0];
  const prose = [];
  for (let i = pre.start; i < pre.end; i++) {
    if (parsed.title && i === parsed.title.line) continue;
    if (parsed.lastUpdated && i === parsed.lastUpdated.line) continue;
    if (parsed.pageTableLines.has(i)) continue;
    prose.push(lines[i]);
  }
  const preamble = pushCollapsed([], prose);

  // Preserved blocks: any `## ` block with content other than page tables and blanks.
  const kept = [];
  for (const b of parsed.blocks) {
    if (b.heading === null || b.absorbable) continue;
    const src = [];
    for (let i = b.start; i < b.end; i++) if (!parsed.pageTableLines.has(i)) src.push(lines[i]);
    const block = pushCollapsed([], src);
    if (block.length) kept.push(block);
  }

  const out = [parsed.title ? parsed.title.text : titleLine(opts), `Last updated: ${today}`];
  if (preamble.length) out.push('', ...preamble);
  for (const s of INDEX_SECTIONS) {
    const typ = s.type;
    out.push('', ...sectionLines(s, bySection.get(s.folder).map((r) => rowLine(r.link, typ, r.description))));
    for (const r of bySection.get(s.folder)) {
      if (r.isNew && addSamples.length < SAMPLE_MAX) addSamples.push({ path: r.path, description: r.description });
    }
  }
  for (const block of kept) out.push('', ...block);
  const rebuilt = out.join('\n') + '\n';

  const rowsAfter = inventory.paths.length;
  const preservedProseLines = [...preamble, ...kept.flat()].filter((l) => l.trim() !== '').length;
  const add = addByFolder.entities + addByFolder.concepts + addByFolder.summaries;
  const summary = {
    indexExists: exists,
    rowsBefore: parsed.rows.length,
    rowsAfter,
    bytesBefore: Buffer.byteLength(text, 'utf8'),
    bytesAfter: Buffer.byteLength(rebuilt, 'utf8'),
    add,
    addByFolder,
    removeStale: cov.stale.length,
    mergeDuplicates: cov.duplicates.length,
    repoint: cov.repointable.length,
    aliasesDropped: cov.aliasesDropped,
    typeCellsCorrected: cov.typeCellsWrong,
    keepDescriptions,
    deriveDescriptions,
    emptyDescriptions,
    unlinkable: cov.unlinkable.length,
    unaddressable: cov.unaddressable.length,
    preservedProseLines,
  };
  const samples = {
    add: addSamples,
    removeStale: cov.stale.slice(0, SAMPLE_MAX).map((r) => ({ target: r.target, description: r.description })),
    unlinkable: cov.unlinkable.slice(0, SAMPLE_MAX),
    unaddressable: cov.unaddressable.slice(0, SAMPLE_MAX),
  };
  return { text: rebuilt, summary, samples };
}

/**
 * Turn an ingest/compile result into ensure-entries. PURE.
 * pages[i] produced writeRecords[i] (`[{ originalPath, record }]`); every
 * non-null record of ANY status counts — an updated or unchanged page that
 * is missing from the index gets its row too. index.md / log.md excluded.
 * @returns {Array<{ canonPath: string, description: string|null }>}
 */
export function indexEntriesFrom(pages, writeRecords) {
  const out = [];
  const seen = new Map();
  const recs = Array.isArray(writeRecords) ? writeRecords : [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i] && recs[i].record;
    if (!rec || !splitCanon(rec.canonPath)) continue;
    const page = Array.isArray(pages) ? pages[i] : null;
    const description = cellSafe(page && page.summary) || null;
    const prev = seen.get(rec.canonPath);
    if (prev) { if (!prev.description && description) prev.description = description; continue; }
    const entry = { canonPath: rec.canonPath, description };
    seen.set(rec.canonPath, entry);
    out.push(entry);
  }
  return out;
}

// ── Fs wrapper ───────────────────────────────────────────────────────────────

function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Flat readdir of entities/, concepts/, summaries/ — `*.md` files only (a
 * directory named x.md is not a page; a symlink resolving outside the wiki is
 * skipped, as health.js's listMd does). Missing folders read as empty.
 */
export async function readPageInventory(domain) {
  const wikiDir = wikiPath(domain);
  let realWiki;
  try { realWiki = await realpath(wikiDir); } catch { return buildInventory({}); }
  const lists = {};
  for (const { folder } of INDEX_SECTIONS) {
    lists[folder] = [];
    const dir = path.join(wikiDir, folder);
    let realDir;
    try { realDir = await realpath(dir); } catch { continue; }
    if (!isInside(realWiki, realDir)) continue;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.name.endsWith('.md') || e.isDirectory()) continue;
      if (e.isSymbolicLink()) {
        try {
          const target = await realpath(path.join(dir, e.name));
          if (!isInside(realWiki, target)) continue;
        } catch { continue; }
      } else if (!e.isFile()) continue;
      lists[folder].push(e.name);
    }
  }
  return buildInventory(lists);
}

/**
 * Make sure every entry's page has a row in index.md. Used after every
 * ingest, compile and compile_to_wiki write.
 *  1. re-reads index.md NOW (a write since the caller's own read is kept);
 *  2. reads each page that needs a row and has no description, deriving one;
 *  3. ensureRowsInIndex with the on-disk inventory (canonical-path coverage);
 *  4. writes through writePage and returns its change record — or null when
 *     nothing was added (no write at all).
 * opts: { today = localDateStamp(), displayName }
 */
export async function ensurePagesInIndex(domain, entries, opts = {}) {
  const list = normaliseEntries(entries);
  if (list.length === 0) return null;
  const today = opts.today || localDateStamp();
  const current = await readIndex(domain);
  const inventory = await readPageInventory(domain);
  const cov = indexCoverage(parseIndex(current), inventory);
  const onDisk = new Set(inventory.paths);
  const wikiDir = wikiPath(domain);
  for (const e of list) {
    if (e.description || !onDisk.has(e.canonPath) || cov.covered.has(e.canonPath)) continue;
    try {
      e.description = deriveDescription(await readFile(path.join(wikiDir, e.canonPath), 'utf8'), e.canonPath);
    } catch {
      e.description = '';
    }
  }
  let displayName = opts.displayName;
  if (!displayName && current.trim() === '') {
    try { displayName = extractDomainDisplayName(await readSchema(domain), domain); }
    catch { displayName = domain; }
  }
  const { text } = ensureRowsInIndex(current, list, { today, displayName, inventory });
  if (text === null) return null;
  return writePage(domain, 'index.md', text);
}
