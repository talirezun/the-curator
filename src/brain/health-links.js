/**
 * Links and code for Wiki health (2026-11-14): what counts as code, and what a merge
 * does to every link that names the page it deletes.
 *
 * ── ONE IDEA OF "INSIDE CODE" ──────────────────────────────────────────────
 * `codeSegments` is the one detector. The scan (health.js `scanWikiUncached`), the
 * broken-link and folder-prefix repairs, the AI broken-link plan and a merge's
 * repoint all use it, so a link written as code is neither counted nor rewritten
 * anywhere. Code is, by CommonMark's rules as far as a link is concerned:
 *   • a fenced block (``` or ~~~, the same rule as files.js `fenceRuns`);
 *   • an indented block: lines indented 4 spaces or a tab after a blank line, unless
 *     they continue a list item (a list's indented paragraphs are text);
 *   • an inline span: a run of N backticks closed by the next run of exactly N, inside
 *     one block. A span never crosses a blank line, a new list item, a heading, a
 *     quote line or a table row, nor a table cell's `|`; a backslash escapes one
 *     backtick; a run with no partner is text. So one stray backtick never swallows
 *     the links after it.
 * Frontmatter is text (a property can hold a link), never code.
 *
 * ── WHAT A MERGE REPOINTS ──────────────────────────────────────────────────
 *   [[x]] [[x|a]] [[x\|a]] (a table's alias) [[x#Heading]] [[x#^block]] ![[x…]] [[x.md]]
 *   [[folder/x]]  [t](x.md) [t](x) [t](../entities/x.md#a) [t](x.md "title")
 *   [t](my%20page.md) [t](<my page.md>)  [label]: x.md (also inside a > quote)
 *   an Obsidian canvas's file node and the links in its text cards
 * with the heading, block and alias kept as written. A heading or block that was only
 * on the deleted page now sits on the kept page under `## Merged from <slug>`
 * (headings one level down, block ids verbatim); `anchorsUnresolved` counts the links
 * whose heading or block the kept page does not show.
 *
 * WHICH LINKS NAME THE DELETED PAGE. The page a link REACHES is decided first, and only
 * a link that reaches the deleted page changes:
 *   [[s]]          the first of entities/s, concepts/s, summaries/s that exists (the
 *                  scan's order); when none has that exact name, a page whose name
 *                  differs only by case or Unicode form (NFC/NFD) is reached, as
 *                  Obsidian does, if exactly one does;
 *   [[folder/s]]   that folder, by the same exact-then-case rule;
 *   (path)         relative to the linking page, then from the wiki's root, then, for a
 *                  bare name, by file name when only one file has it; `.md` optional.
 * The new link reaches the kept page too: a bare `[[keep]]` would reach another page
 * when an earlier folder has that name, so it is written `[[folder/keep]]` then.
 *
 * NEVER EDITED: code (above), URLs and other schemes, footnotes, the dot-folders the
 * caller does not walk. Frontmatter links are repointed (Obsidian resolves them in the
 * graph and backlinks); every other byte of the frontmatter stays. Pure: no file
 * system; `health.js` reads and writes, through `writeFileAtomic`, so Undo copies it.
 */
import path from 'path';
import { fenceRuns } from './files.js';

const posix = path.posix;
const WIKI_FOLDERS = ['entities', 'concepts', 'summaries'];

// ── Code ────────────────────────────────────────────────────────────────────

const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const INDENTED_RE = /^(?: {4}|\t)/;
const BLANK_RE = /^[ \t]*\r?\n?$/;
// A line that begins a new block for inline spans: a span never crosses it.
const BLOCK_START_RE = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|#{1,6}(?:[ \t]|$)|>|\|)/;
const TABLE_ROW_RE = /^[ \t]*\|/;

/**
 * The text cut into code and not code, in order, every byte once.
 * @returns {Array<{text: string, code: boolean}>}
 */
export function codeSegments(text) {
  const src = String(text);
  const out = [];
  const push = (t, code) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.code === code && code) last.text += t;
    else out.push({ text: t, code });
  };
  // Frontmatter: text, cut into lines so a stray backtick in a value stays in its line.
  let body = src;
  const fm = src.match(/^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/);
  if (fm) {
    for (const line of fm[0].split(/(?<=\n)/)) inlineSpans(line, push);
    body = src.slice(fm[0].length);
  }
  let unit = '';               // the prose lines of one block, searched for inline spans together
  let unitIsTable = false;
  const flush = () => { if (unit) { inlineSpans(unit, push, unitIsTable); unit = ''; } unitIsTable = false; };
  let prevBlank = true;
  let inList = false;
  let inIndented = false;
  for (const run of fenceRuns(body)) {
    if (run.fenced) { flush(); push(run.text, true); prevBlank = false; inIndented = false; continue; }
    for (const line of run.text.split(/(?<=\n)/)) {
      const blank = BLANK_RE.test(line);
      if (inIndented && (blank || INDENTED_RE.test(line))) { push(line, true); prevBlank = blank; continue; }
      inIndented = false;
      if (blank) { flush(); unit = line; flush(); prevBlank = true; continue; }
      if (INDENTED_RE.test(line) && prevBlank && !inList) {
        flush(); push(line, true); inIndented = true; prevBlank = false; continue;
      }
      if (LIST_ITEM_RE.test(line)) inList = true;
      else if (prevBlank && !INDENTED_RE.test(line)) inList = false;
      const table = TABLE_ROW_RE.test(line);
      if (BLOCK_START_RE.test(line) || table || unitIsTable) flush();
      unitIsTable = table;
      unit += line;
      prevBlank = false;
    }
  }
  flush();
  return out;
}

/** Inline code spans in one block (`table`: a row, whose `|` also ends a span). */
function inlineSpans(t, push, table = false) {
  let i = 0;
  let from = 0;
  const emit = (end, code) => { if (end > from) push(t.slice(from, end), code); from = end; };
  while (i < t.length) {
    if (t.charCodeAt(i) !== 96) { i++; continue; }
    let bs = 0;
    for (let k = i - 1; k >= 0 && t[k] === '\\'; k--) bs++;
    if (bs % 2 === 1) { i += 1; continue; }        // an escaped backtick is text
    let n = 0;
    while (t.charCodeAt(i + n) === 96) n++;
    let j = i + n;
    let close = -1;
    while (j < t.length) {
      const c = t.charCodeAt(j);
      if (c === 96) {
        let m = 0;
        while (t.charCodeAt(j + m) === 96) m++;
        if (m === n) { close = j; break; }
        j += m;
        continue;
      }
      if (table && c === 124 && t[j - 1] !== '\\') break;   // a cell ends here
      j++;
    }
    if (close === -1) { i += n; continue; }
    emit(i, false);
    i = close + n;
    emit(i, true);
  }
  emit(t.length, false);
}

/** The text outside code, pieces joined by a newline so no link forms across a gap. */
export function withoutCode(text) {
  return codeSegments(text).filter((s) => !s.code).map((s) => s.text).join('\n');
}

/** `text.replace(re, fn)` outside code only. */
export function replaceOutsideCode(text, re, fn) {
  return codeSegments(text).map((s) => (s.code ? s.text : s.text.replace(re, fn))).join('');
}

// ── Anchors ─────────────────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }
const anchorKey = (s) => safeDecode(String(s)).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Would `anchor` (`#Heading`, `#Parent#Child`, `#^block-id`) find something on this
 * page? A heading at any level outside code, or a block id at a line's end.
 */
export function anchorResolves(pageText, anchor) {
  const a = String(anchor || '').replace(/^#+/, '');
  if (!a) return true;
  const outside = codeSegments(String(pageText)).filter((s) => !s.code).map((s) => s.text).join('\n');
  if (a.startsWith('^')) return new RegExp(`(^|\\s)\\^${escapeRe(a.slice(1).trim())}[ \\t]*\\r?$`, 'm').test(outside);
  const parts = a.split('#').filter(Boolean);
  const want = anchorKey(parts[parts.length - 1]);
  if (!want) return true;
  for (const m of outside.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*\r?$/gm)) if (anchorKey(m[1]) === want) return true;
  return false;
}

// ── The merge's rewriter ─────────────────────────────────────────────────────

/** Names compared the way Obsidian finds a page: case and Unicode form aside. */
const looseKey = (s) => String(s).normalize('NFC').toLowerCase();

function encodeMdPath(p, encodedNonAscii) {
  return p.split('/').map((seg) => {
    if (encodedNonAscii) return encodeURIComponent(seg).replace(/%2E/gi, '.');
    return seg.replace(/[%\s()<>#?\[\]]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  }).join('/');
}

/** Is the `]` at `at` the end of a link text: an unclosed `[` before it, on its line? */
function closesLinkText(s, at) {
  let depth = 0;
  for (let k = at - 1; k >= 0; k--) {
    const c = s[k];
    if (c === '\n') return false;
    if (s[k - 1] === '\\') continue;
    if (c === ']') depth++;
    else if (c === '[') { if (depth === 0) return true; depth--; }
  }
  return false;
}

/**
 * The rewriter for one merge.
 *
 * @param {object} o
 * @param {Array<{folder:string, slug:string}>} o.retired  pages being deleted
 * @param {string} o.keepSlug
 * @param {string} o.keepFolder
 * @param {Set<string>|null} o.existing  every page in the wiki, wiki-relative posix
 *   (`entities/x.md`), the retired ones included
 * @param {string} [o.wikiDir]  absolute; lets a canvas whose vault root is above the
 *   wiki (`"file": "wiki/entities/x.md"`) be recognised
 * @param {Function} [o.dedup]  (before, after) → after, run once on a page's text
 */
export function makeRetiredLinkRewriter(o) {
  const { retired, keepSlug, keepFolder } = o;
  if (!Array.isArray(retired) || typeof keepSlug !== 'string' || !keepSlug) return null;
  const seen = new Set();
  const gone = [];
  for (const r of retired) {
    if (!r || typeof r.slug !== 'string' || !r.slug || typeof r.folder !== 'string') continue;
    const rel = `${r.folder}/${r.slug}.md`;
    if (seen.has(rel)) continue;
    seen.add(rel);
    gone.push({ folder: r.folder, slug: r.slug, rel });
  }
  if (gone.length === 0) return null;
  const goneRels = new Set(gone.map((g) => g.rel));
  const keepRel = `${keepFolder}/${keepSlug}.md`;
  const existing = o.existing instanceof Set ? new Set(o.existing) : new Set();
  for (const g of gone) existing.add(g.rel);
  existing.add(keepRel);
  const dedup = typeof o.dedup === 'function' ? o.dedup : (_b, a) => a;

  // Every page by its loose name, for a link written in another case or form.
  const byLoose = new Map();
  for (const rel of existing) {
    const k = looseKey(rel);
    if (!byLoose.has(k)) byLoose.set(k, []);
    byLoose.get(k).push(rel);
  }
  /** The page a wiki-relative path reaches: exactly, else the one page of that loose name. */
  const reach = (rel, pages = existing) => {
    if (pages.has(rel)) return rel;
    const list = (byLoose.get(looseKey(rel)) || []).filter((x) => pages.has(x));
    return list.length === 1 ? list[0] : null;
  };
  const reachBare = (slug, pages = existing) => {
    for (const f of WIKI_FOLDERS) if (pages.has(`${f}/${slug}.md`)) return `${f}/${slug}.md`;
    for (const f of WIKI_FOLDERS) { const r = reach(`${f}/${slug}.md`, pages); if (r) return r; }
    return null;
  };
  // After the delete: which name reaches the kept page.
  const after = new Set([...existing].filter((x) => !goneRels.has(x)));
  const keepWiki = keepFolder === 'summaries' || reachBare(keepSlug, after) !== keepRel
    ? `${keepFolder}/${keepSlug}` : keepSlug;

  // ── [[...]] ──────────────────────────────────────────────────────────────
  // The scan's own shape: a name up to | # ] or a newline, `.md` optional, a heading or
  // block, an alias (a table writes it `\|`, and an alias may run over lines).
  const wikiRe = /\[\[([^\]|#\n\\]+?)(\.md)?([^\S\n]*)(#[^\]|\n\\]*)?([^\S\n]*)(\\?\|[^\]]+)?\]\]/g;
  const rewriteWiki = (seg, stats) => seg.replace(wikiRe, (whole, target, md, _w1, anchor, _w2, alias) => {
    const name = target.trim();
    if (!name) return whole;
    let reached = null;
    const slash = name.indexOf('/');
    if (slash !== -1) {
      const folder = name.slice(0, slash);
      const slug = name.slice(slash + 1);
      if (!WIKI_FOLDERS.includes(folder) || !slug || slug.includes('/')) return whole;
      reached = reach(`${folder}/${slug}.md`);
    } else {
      reached = reachBare(name);
    }
    if (!reached || !goneRels.has(reached)) return whole;
    stats.links++;
    const a = anchor ? anchor.replace(/[^\S\n]+$/, '') : '';
    if (a && a !== '#') stats.anchors.push(a);
    return `[[${keepWiki}${md || ''}${a}${alias || ''}]]`;
  });

  // ── markdown links and reference definitions ─────────────────────────────
  const basenameCount = new Map();   // loose file name → pages left with it
  for (const rel of after) {
    const b = looseKey(posix.basename(rel));
    basenameCount.set(b, (basenameCount.get(b) || 0) + 1);
  }
  const goneByBasename = new Map();
  for (const g of gone) {
    const b = looseKey(`${g.slug}.md`);
    goneByBasename.set(b, goneByBasename.has(b) ? null : g.rel);
  }

  const retarget = (dest, fromRel, stats) => {
    const angle = dest.startsWith('<') && dest.endsWith('>');
    const inner = angle ? dest.slice(1, -1) : dest;
    if (!inner || /^[a-z][a-z0-9+.-]*:/i.test(inner) || inner.startsWith('//')) return null;
    const hashAt = inner.indexOf('#');
    const rawPath = hashAt === -1 ? inner : inner.slice(0, hashAt);
    const anchor = hashAt === -1 ? '' : inner.slice(hashAt);
    if (!rawPath || rawPath.includes('?')) return null;
    const decoded = angle ? rawPath : safeDecode(rawPath);
    let noExt = false;
    let file = decoded;
    if (!/\.md$/i.test(file)) {
      if (/\.[^/.]+$/.test(posix.basename(file))) return null;           // another kind of file
      file += '.md';
      noExt = true;
    }
    const absolute = file.startsWith('/');
    const p = absolute ? file.slice(1) : file;
    const fromDir = posix.dirname(fromRel || 'x');
    let style = null;
    if (!absolute) {
      const rel = posix.normalize(posix.join(fromDir, p));
      if (!rel.startsWith('../')) {
        const r = reach(rel);
        if (r && goneRels.has(r)) style = 'relative';
        else if (r) return null;
      }
    }
    if (!style) {
      const r = reach(posix.normalize(p));
      if (r && goneRels.has(r)) style = 'root';
      else if (r) return null;
    }
    if (!style && !p.includes('/')) {
      const k = looseKey(p);
      if (goneByBasename.get(k) && !basenameCount.has(k)) style = 'bare';
    }
    if (!style) return null;
    let next;
    if (style === 'relative') {
      next = posix.relative(fromDir, keepRel) || posix.basename(keepRel);
      if (p.startsWith('./') && !next.startsWith('../')) next = './' + next;   // as it was written
    } else if (style === 'root') next = (absolute ? '/' : '') + keepRel;
    else next = (basenameCount.get(looseKey(posix.basename(keepRel))) || 0) <= 1 ? posix.basename(keepRel) : keepRel;
    if (noExt) next = next.replace(/\.md$/i, '');
    stats.links++;
    if (anchor && anchor !== '#') stats.anchors.push(anchor);
    const written = angle ? next : encodeMdPath(next, /%[89a-f][0-9a-f]/i.test(rawPath));
    return angle ? `<${written}${anchor}>` : `${written}${anchor}`;
  };

  const inlineRe = /\]\(([ \t]*)(<[^<>\n]*>|[^\s()<>]+)((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\))/g;
  const refRe = /^((?:[ ]{0,3}>[ ]?)*[ ]{0,3}\[(?!\^)[^\]\n]+\]:[ \t]*)(<[^<>\n]*>|\S+)/gm;
  const rewriteMd = (seg, fromRel, stats) => seg
    .replace(inlineRe, (whole, sp, dest, rest, at, str) => {
      if (!closesLinkText(str, at)) return whole;                       // `a](x.md)` in a URL is no link
      const n = retarget(dest, fromRel, stats);
      return n === null ? whole : `](${sp}${n}${rest}`;
    })
    .replace(refRe, (whole, head, dest) => {
      const n = retarget(dest, fromRel, stats);
      return n === null ? whole : `${head}${n}`;
    });

  const rewriteText = (text, fromRel, stats) => codeSegments(text)
    .map((s) => (s.code ? s.text : rewriteMd(rewriteWiki(s.text, stats), fromRel, stats)))
    .join('');

  const apply = (text, fromRel) => {
    const stats = { links: 0, anchors: [] };
    const before = String(text);
    const out = rewriteText(before, fromRel, stats);
    return { text: out === before ? before : dedup(before, out), links: stats.links, anchors: stats.anchors };
  };

  // ── Obsidian canvas ──────────────────────────────────────────────────────
  // Paths are from the vault's root, which may be the wiki or a folder above it.
  const wikiTail = o.wikiDir ? path.resolve(o.wikiDir).split(path.sep).filter(Boolean) : [];
  const canvasPrefix = (file) => {
    for (const g of gone) {
      const lf = looseKey(file), lg = looseKey(g.rel);
      if (lf === lg && !after.has(file)) return '';
      if (lf.endsWith('/' + lg)) {
        const prefix = file.slice(0, file.length - g.rel.length);
        const segs = prefix.split('/').filter(Boolean);
        if (segs.length <= wikiTail.length && segs.every((s, k) => s === wikiTail[wikiTail.length - segs.length + k])) return prefix;
      }
    }
    return null;
  };
  const applyCanvas = (text, fromRel) => {
    const stats = { links: 0, anchors: [] };
    const before = String(text);
    let doc;
    try { doc = JSON.parse(before); } catch { return { text: before, links: 0, anchors: [] }; }
    if (!doc || !Array.isArray(doc.nodes)) return { text: before, links: 0, anchors: [] };
    for (const node of doc.nodes) {
      if (node && typeof node.file === 'string' && canvasPrefix(node.file) !== null
        && typeof node.subpath === 'string' && node.subpath && node.subpath !== '#') stats.anchors.push(node.subpath);
    }
    // Only a node's own "file" and "text" change, each string replaced where it stands,
    // so the rest of the canvas (layout, order, escapes, edges, metadata) keeps its bytes.
    const edits = [];
    jsonStrings(before, (p, start, end) => {
      if (p.length !== 3 || p[0] !== 'nodes' || typeof p[1] !== 'number' || (p[2] !== 'file' && p[2] !== 'text')) return;
      let value;
      try { value = JSON.parse(before.slice(start, end)); } catch { return; }
      let next = value;
      if (p[2] === 'file') {
        const prefix = canvasPrefix(value);
        if (prefix === null) return;
        stats.links++;
        next = prefix + keepRel;
      } else {
        next = rewriteText(value, fromRel, stats);
      }
      if (next !== value) edits.push([start, end, JSON.stringify(next)]);
    });
    let out = before;
    for (const [s, e, v] of edits.reverse()) out = out.slice(0, s) + v + out.slice(e);
    return { text: out, links: stats.links, anchors: stats.anchors };
  };

  return { apply, applyCanvas, keepRel, goneRels };
}

/**
 * Every string VALUE in a JSON text, with its path (keys and indices) and its offsets.
 * The text has already parsed, so this trusts its shape.
 */
function jsonStrings(t, onString) {
  let i = 0;
  const ws = () => { while (i < t.length && /\s/.test(t[i])) i++; };
  const str = () => { const s = i; i++; while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1; i++; return [s, i]; };
  const value = (p) => {
    ws();
    const c = t[i];
    if (c === '"') { const [s, e] = str(); onString(p, s, e); return; }
    if (c === '{') {
      i++; ws();
      if (t[i] === '}') { i++; return; }
      for (;;) {
        ws(); const [ks, ke] = str(); const key = JSON.parse(t.slice(ks, ke));
        ws(); i++;                                   // :
        value(p.concat(key));
        ws(); if (t[i] === ',') { i++; continue; }
        i++; return;                                 // }
      }
    }
    if (c === '[') {
      i++; ws();
      if (t[i] === ']') { i++; return; }
      for (let k = 0; ; k++) {
        value(p.concat(k));
        ws(); if (t[i] === ',') { i++; continue; }
        i++; return;                                 // ]
      }
    }
    while (i < t.length && !/[,\]}\s]/.test(t[i])) i++;
  };
  value([]);
}
