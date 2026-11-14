/**
 * What a merge does to every link that names the page it deletes (2026-11-14).
 *
 * A Health merge keeps one page and deletes another, and every link to the deleted
 * page must then name the kept one. Until this module only `[[x]]` and `[[x|alias]]`
 * were repointed, so a foreign vault (Obsidian, Logseq, a plain markdown folder) was
 * left with links to a page that no longer exists in every other form it writes:
 *
 *   [[x#Heading]]  [[x#^block-id]]  [[x#Heading|alias]]  ![[x]]  [[x.md]]
 *   [text](x.md)  [text](../entities/x.md#anchor)  [text](my%20page.md)
 *   [text](<my page.md>)  [label]: entities/x.md   (a reference definition)
 *   an Obsidian canvas's file node ("file": "entities/x.md") and the links in its text cards
 *
 * Every one of them is repointed to the kept page with its heading, block and alias
 * kept as written. A heading or block that was only on the deleted page now sits on
 * the kept page under `## Merged from <slug>` (headings one level down, block ids
 * verbatim), so most still resolve; `anchorsUnresolved` counts the ones the kept page
 * shows no heading or block for, and the outcome says how many.
 *
 * WHAT IS NEVER EDITED: text in a code fence or in inline code (an example, not a
 * link), and nothing outside the link itself. Frontmatter is part of the page: a
 * property holding a link (`related: "[[x]]"`, `up: [[x]]`) is a link Obsidian shows
 * in the graph and in backlinks, so it is repointed like any other, and every other
 * byte of the frontmatter stays as it is (only the link's own characters change).
 * The caller decides which files are walked (no dot-folder: `.obsidian`, `.trash`,
 * `.git`), and every write goes through `writeFileAtomic`, so Health's Undo copies
 * each file first.
 *
 * WHICH LINKS NAME THE DELETED PAGE. The rules are the scan's and Obsidian's:
 *   [[s]]          the first of entities/s, concepts/s, summaries/s that exists
 *                  (scanWiki's order), so a link that reaches a DIFFERENT page of the
 *                  same name is left alone;
 *   [[folder/s]]   that folder only;
 *   (path.md)      relative to the linking page first, then from the wiki's root,
 *                  then, for a bare name, by file name when no other file has it.
 *
 * Pure: no file system. `health.js` reads and writes.
 */
import path from 'path';

const posix = path.posix;
const WIKI_FOLDERS = ['entities', 'concepts', 'summaries'];

/**
 * A page's text cut into the parts a link may be edited in (`code: false`) and the
 * parts it may not: code fences (`fenceRuns`) and inline code spans, CommonMark's
 * rule: a run of N backticks opens a span that the next run of exactly N closes, in
 * the same paragraph; a run with no partner is text, and a backslash escapes one.
 */
export function proseSegments(text, fenceRuns) {
  const out = [];
  for (const run of fenceRuns(String(text))) {
    if (run.fenced) { out.push({ text: run.text, code: true }); continue; }
    splitInlineCode(run.text, out);
  }
  return out;
}

function splitInlineCode(t, out) {
  let i = 0;
  let from = 0;
  const push = (end, code) => { if (end > from) out.push({ text: t.slice(from, end), code }); from = end; };
  while (i < t.length) {
    if (t.charCodeAt(i) !== 96) { i++; continue; }
    let bs = 0;
    for (let k = i - 1; k >= 0 && t[k] === '\\'; k--) bs++;
    let n = 0;
    while (t.charCodeAt(i + n) === 96) n++;
    if (bs % 2 === 1) { i += 1; continue; }     // an escaped backtick is text; the rest of its run is looked at again
    let j = i + n;
    let close = -1;
    while (j < t.length) {
      if (t.charCodeAt(j) === 96) {
        let m = 0;
        while (t.charCodeAt(j + m) === 96) m++;
        if (m === n) { close = j; break; }
        j += m;
        continue;
      }
      // A blank line ends the paragraph, and with it any open span.
      if (t[j] === '\n' && /^\n[ \t]*\n/.test(t.slice(j, j + 64))) break;
      j++;
    }
    if (close === -1) { i += n; continue; }
    push(i, false);
    i = close + n;
    push(i, true);
  }
  push(t.length, false);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** A path written into a markdown link, encoded the way the old one was. */
function encodeMdPath(p, encodedNonAscii) {
  return p.split('/').map((seg) => {
    if (encodedNonAscii) return encodeURIComponent(seg).replace(/%2E/gi, '.');
    return seg.replace(/[%\s()<>#?\[\]]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  }).join('/');
}

/** Heading and block-id text, compared as a reader would: case, spaces, hyphens and punctuation aside. */
const anchorKey = (s) => safeDecode(String(s)).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Would `anchor` (`#Heading`, `#Parent#Child`, `#^block-id`) find something on this
 * page? A heading anywhere outside a code fence, at any level, or a block id at a
 * line's end.
 */
export function anchorResolves(pageText, anchor, fenceRuns) {
  let a = String(anchor || '').replace(/^#+/, '');
  if (!a) return true;
  const outside = fenceRuns(String(pageText)).filter((r) => !r.fenced).map((r) => r.text).join('');
  if (a.startsWith('^')) {
    const id = a.slice(1).trim();
    return new RegExp(`(^|\\s)\\^${escapeRe(id)}[ \\t]*$`, 'm').test(outside);
  }
  const parts = a.split('#').filter(Boolean);
  const want = anchorKey(parts[parts.length - 1]);
  if (!want) return true;
  for (const m of outside.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    if (anchorKey(m[1]) === want) return true;
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
 *   (`entities/x.md`), the retired ones included; null treats nothing else as existing
 * @param {string} [o.wikiDir]  absolute; lets a canvas whose vault root is above the
 *   wiki (`"file": "wiki/entities/x.md"`) be recognised
 * @param {Function} o.fenceRuns
 * @param {Function} [o.dedup]  (before, after) → after, run once on a page's text
 * @returns {null | {apply(text, rel): {text, links, anchors}, applyCanvas(text, rel): {text, links, anchors}}}
 */
export function makeRetiredLinkRewriter(o) {
  const { retired, keepSlug, keepFolder, fenceRuns } = o;
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
  const existing = o.existing instanceof Set ? o.existing : new Set([...goneRels, keepRel]);
  const has = (rel) => existing.has(rel);
  const dedup = typeof o.dedup === 'function' ? o.dedup : (_b, a) => a;

  // Which page does a bare [[s]] reach? The scan's order, then a summary.
  const bareTarget = (s) => {
    for (const f of WIKI_FOLDERS) if (has(`${f}/${s}.md`)) return `${f}/${s}.md`;
    return null;
  };
  // A bare [[s]] to a retired page is repointed when s is what reaches it. When none
  // of the three exist (the caller passed no inventory), a retired slug still counts.
  const bareRetired = (s) => {
    const t = bareTarget(s);
    return t ? goneRels.has(t) : gone.some((g) => g.slug === s);
  };

  // ── [[...]] ────────────────────────────────────────────────────────────────
  // `[^\S\n]*` (whitespace except a newline) where the scan's own `.trim()` lets it
  // stand: `[[ x ]]` and `[[x |a]]` are live links to the scan, `[[x\n]]` is not.
  const WS = '[^\\S\\n]*';
  const slugAlt = [...new Set(gone.map((g) => g.slug))].map(escapeRe).join('|');
  const wikiRe = new RegExp(
    `\\[\\[${WS}(?:(entities|concepts|summaries)/)?(${slugAlt})(\\.md)?${WS}(#[^\\]|\\n]*)?${WS}(\\|[^\\]\\n]+)?\\]\\]`, 'g');
  const keepLink = keepFolder === 'summaries' ? `summaries/${keepSlug}` : keepSlug;

  const rewriteWiki = (seg, stats) => seg.replace(wikiRe, (whole, folder, slug, md, anchor, alias) => {
    const target = folder ? (goneRels.has(`${folder}/${slug}.md`) ? `${folder}/${slug}.md` : null)
      : (bareRetired(slug) ? 'bare' : null);
    if (!target) return whole;
    stats.links++;
    const a = anchor ? anchor.replace(/[^\S\n]+$/, '') : '';
    if (a && a !== '#') stats.anchors.push(a);
    return `[[${keepLink}${md || ''}${a}${alias || ''}]]`;
  });

  // ── markdown links and reference definitions ───────────────────────────────
  const basenameCount = new Map();
  for (const rel of existing) {
    if (goneRels.has(rel)) continue;
    const b = posix.basename(rel);
    basenameCount.set(b, (basenameCount.get(b) || 0) + 1);
  }
  const goneByBasename = new Map();
  for (const g of gone) {
    const b = `${g.slug}.md`;
    goneByBasename.set(b, goneByBasename.has(b) ? null : g.rel); // two retired of one name: neither by name
  }

  /** The new destination for `dest`, written from the page at `fromRel`, or null. */
  const retarget = (dest, fromRel, stats) => {
    const angle = dest.startsWith('<') && dest.endsWith('>');
    const inner = angle ? dest.slice(1, -1) : dest;
    if (!inner || /^[a-z][a-z0-9+.-]*:/i.test(inner)) return null;   // a URL, mailto:, obsidian://
    const hashAt = inner.indexOf('#');
    const rawPath = hashAt === -1 ? inner : inner.slice(0, hashAt);
    const anchor = hashAt === -1 ? '' : inner.slice(hashAt);
    if (!rawPath) return null;                                        // #anchor on this page
    const decoded = angle ? rawPath : safeDecode(rawPath);
    if (!/\.md$/i.test(decoded)) return null;
    const absolute = decoded.startsWith('/');
    const p = absolute ? decoded.slice(1) : decoded;
    const fromDir = posix.dirname(fromRel || 'x');
    let style = null;
    if (!absolute) {
      const rel = posix.normalize(posix.join(fromDir, p));
      if (!rel.startsWith('../')) {
        if (goneRels.has(rel)) style = 'relative';
        else if (has(rel)) return null;
      }
    }
    if (!style) {
      const root = posix.normalize(p);
      if (goneRels.has(root)) style = 'root';
      else if (has(root)) return null;
    }
    if (!style && !p.includes('/')) {
      const g = goneByBasename.get(p);
      if (g && !basenameCount.has(p)) style = 'bare';
    }
    if (!style) return null;
    let next;
    if (style === 'relative') next = posix.relative(fromDir, keepRel) || posix.basename(keepRel);
    else if (style === 'root') next = (absolute ? '/' : '') + keepRel;
    else next = (basenameCount.get(posix.basename(keepRel)) || 0) <= 1 ? posix.basename(keepRel) : keepRel;
    stats.links++;
    if (anchor && anchor !== '#') stats.anchors.push(anchor);
    if (next === p && !absolute) return dest;                         // already names the kept file
    const written = angle ? next : encodeMdPath(next, /%[89a-f][0-9a-f]/i.test(rawPath));
    return angle ? `<${written}${anchor}>` : `${written}${anchor}`;
  };

  const inlineRe = /(\]\()([ \t]*)(<[^<>\n]*>|[^\s()<>]+)((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*\))/g;
  const refRe = /^([ ]{0,3}\[[^\]\n]+\]:[ \t]*)(<[^<>\n]*>|\S+)/gm;
  const rewriteMd = (seg, fromRel, stats) => seg
    .replace(inlineRe, (whole, open, sp, dest, rest) => {
      const n = retarget(dest, fromRel, stats);
      return n === null ? whole : `${open}${sp}${n}${rest}`;
    })
    .replace(refRe, (whole, head, dest) => {
      const n = retarget(dest, fromRel, stats);
      return n === null ? whole : `${head}${n}`;
    });

  const rewriteText = (text, fromRel, stats) => proseSegments(text, fenceRuns)
    .map((s) => (s.code ? s.text : rewriteMd(rewriteWiki(s.text, stats), fromRel, stats)))
    .join('');

  const apply = (text, fromRel) => {
    const stats = { links: 0, anchors: [] };
    const before = String(text);
    const after = rewriteText(before, fromRel, stats);
    return { text: after === before ? before : dedup(before, after), links: stats.links, anchors: stats.anchors };
  };

  // ── Obsidian canvas ────────────────────────────────────────────────────────
  // Paths in a canvas are from the vault's root, which may be the wiki or a folder
  // above it: `wiki/entities/x.md` is the same page when the wiki folder is `wiki`.
  const wikiTail = o.wikiDir ? path.resolve(o.wikiDir).split(path.sep).filter(Boolean) : [];
  const canvasPrefix = (file) => {
    for (const g of gone) {
      if (file === g.rel) return '';
      if (file.endsWith('/' + g.rel)) {
        const prefix = file.slice(0, -g.rel.length);           // ends with '/'
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
    // The anchors a file node carries, for the count; the edit itself is on the text.
    for (const node of doc.nodes) {
      if (node && typeof node.file === 'string' && canvasPrefix(node.file) !== null
        && typeof node.subpath === 'string' && node.subpath && node.subpath !== '#') stats.anchors.push(node.subpath);
    }
    // Each "file" and "text" string is replaced where it stands, so the rest of the
    // canvas (its layout, its order, its escapes) keeps every byte.
    const after = before.replace(/("(file|text)"[ \t\r\n]*:[ \t\r\n]*)("(?:[^"\\\n]|\\.)*")/g, (whole, head, key, literal) => {
      let value;
      try { value = JSON.parse(literal); } catch { return whole; }
      if (typeof value !== 'string') return whole;
      let next = value;
      if (key === 'file') {
        const prefix = canvasPrefix(value);
        if (prefix === null) return whole;
        stats.links++;
        next = prefix + keepRel;
      } else {
        next = rewriteText(value, fromRel, stats);
      }
      return next === value ? whole : head + JSON.stringify(next);
    });
    return { text: after, links: stats.links, anchors: stats.anchors };
  };

  return { apply, applyCanvas, keepRel, goneRels };
}
