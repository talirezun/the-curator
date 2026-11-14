/**
 * EXISTING FACTS — what the wiki already says, shown to the model when a source
 * updates it (2026-11-14, owner goal: a brain must show how a company or a product
 * evolved over years: "how did revenue change 2024 to 2026", "what is the port now
 * and since which version").
 *
 * WHY. The page-writing step saw the existing pages' SLUGS only, never their text.
 * So a follow-up document (an architecture changelog, next year's annual report)
 * put its new values on its own summary, and the existing entity and concept pages
 * kept the old values: measured for v3.98.0, a changed port reached the product's
 * page in 1 of 9 runs. The model could not write "was 7103" about a page it had
 * never read, and had no reason to return a page it did not know it changed.
 *
 * WHAT. Deterministic and free (no model call): for a source that carries hard data
 * (`sourceHasHardData`, decided by the caller), pick the existing entity and concept
 * pages the source names or whose figure-bearing lines share the source's
 * identifiers and figures, and give the page-writing prompt a BOUNDED excerpt of
 * those lines (EXISTING_FACTS_MAX_CHARS in all), with one instruction: return each
 * page the source changes, and write only the new or changed facts as Key Facts
 * lines carrying their version or period and the source; never restate or remove
 * the old ones. The merge already keeps such a line (a new figure is new:
 * page-merge.js `isMostlyNew`) and never deletes the old one (exact-name reuse
 * never overwrites), so the page ends up holding both: the history.
 *
 * Never part of a prose source's prompt: the caller sends '' and every builder is
 * then byte-identical to before.
 *
 * This module reads files and never writes; diagnostics go to stderr only (it is
 * reachable from the MCP child, whose stdout is JSON-RPC).
 */
import { readFile } from 'fs/promises';
import path from 'path';

/** The whole block (header, excerpts and instructions) is at most this many characters. */
export const EXISTING_FACTS_MAX_CHARS = 4000;
/** Of which the excerpted page lines take at most this much. */
export const EXISTING_FACTS_EXCERPT_CHARS = 3000;
export const EXISTING_FACTS_MAX_PAGES = 6;
export const EXISTING_FACTS_MAX_LINES_PER_PAGE = 8;
export const EXISTING_FACTS_MAX_LINE_CHARS = 240;
/** Page bodies read at most, most likely first (a 3,500-page domain reads in well under a second). */
export const EXISTING_FACTS_MAX_READ = 3000;

const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have how if in into is it '
  + 'its may might more most no not of on or our so some such than that the their them then there these they this those '
  + 'to us was we were what when where which while who why will with would you your also both each very just only over '
  + 'under about between through within without per via using use used uses make makes made one two new now still '
  + 'year years page pages source wiki').split(' '));

const singular = (t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
function slugTokens(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean).map(singular);
}

/** A number as a comparable token: separators dropped, a bare year or one digit is no anchor. */
function numberAnchors(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\d[\d,.  ]*\d|\d/g)) {
    let n = m[0].replace(/[,  ]/g, '').replace(/\.$/, '');
    if (n.replace(/\D/g, '').length < 2) continue;
    if (/^(19|20)\d\d$/.test(n)) continue;
    out.add(n);
  }
  return out;
}

/**
 * Identifiers. On a page line: inline code spans and words joined by - _ . / (risk-svc,
 * ORDERS_RISK_TIMEOUT_MS). In the SOURCE only the distinctive ones count: code spans,
 * and joined words that carry an underscore, a slash or a digit, so a plain English
 * compound ("real-time", "end-to-end") written in both is never evidence.
 */
function identifierAnchors(text, { strict = false } = {}) {
  const out = new Set();
  const s = String(text);
  for (const m of s.matchAll(/`([^`\n]{4,80})`/g)) out.add(m[1].trim().toLowerCase());
  for (const m of s.matchAll(/(?<![\w/-])[A-Za-z][\w]*(?:[-_./][\w]+)+/g)) {
    const id = m[0].toLowerCase().replace(/[.]+$/, '');
    // A bare version (v1.4, 2.0.1) names no particular thing: every product has one.
    if (id.length < 4 || /^(e\.g|i\.e)$/.test(id) || /^v?\d+(\.\d+)+$/.test(id)) continue;
    if (strict && !/[_/]|\d/.test(id)) continue;
    out.add(id);
  }
  return out;
}

function wordSet(text) {
  return new Set(slugTokens(String(text).replace(/\[\[([^\]|]*\/)?([^\]|]+)(\|[^\]]+)?\]\]/g, ' $2 '))
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOP.has(w)));
}

/** How often each existing page's name occurs in the source, as a whole-word run. */
export function nameMentions(text, existingFiles) {
  const src = slugTokens(text);
  const at = new Map();
  src.forEach((t, i) => { if (!at.has(t)) at.set(t, []); at.get(t).push(i); });
  const out = new Map();
  for (const folder of ['entities', 'concepts']) {
    const files = existingFiles && Array.isArray(existingFiles[folder]) ? existingFiles[folder] : [];
    for (const f of files) {
      if (typeof f !== 'string') continue;
      const slug = f.replace(/\.md$/, '');
      const name = slugTokens(slug);
      if (!name.length || name.join('').length < 4) continue;
      let n = 0;
      for (const i of at.get(name[0]) || []) {
        let ok = true;
        for (let j = 1; j < name.length; j++) if (src[i + j] !== name[j]) { ok = false; break; }
        if (ok) n++;
      }
      out.set(`${folder}/${slug}.md`, n);
    }
  }
  return out;
}

const LINK_SECTION_RE = /^(related|entities mentioned|concepts introduced or referenced|sources?|see also|backlinks)$/i;

/**
 * The lines of a page that carry a figure or an identifier, outside frontmatter,
 * headings, code fences and link sections. Each with the section it sits in.
 */
export function figureLines(content) {
  const lines = String(content || '').split('\n');
  let i = 0;
  if (lines[0] === '---') { i = 1; while (i < lines.length && lines[i] !== '---') i++; i++; }
  const out = [];
  let section = '';
  let fence = false;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const h = raw.match(/^#{1,6}\s+(.*?)\s*$/);
    if (h) { section = h[1]; continue; }
    if (LINK_SECTION_RE.test(section.trim())) continue;
    const line = raw.trim();
    if (!line || /^(Type|Tags|Source|Date Ingested|Aliases?)\s*:/i.test(line)) continue;
    if (/^\|[\s|:-]+\|$/.test(line)) continue;              // a table's separator row
    if (!/\d|`/.test(line)) continue;                        // not a figure or an identifier
    if (/^[-*]\s*\[\[[^\]]+\]\]\s*(—|-|:|$)/.test(line) && !/\d/.test(line.replace(/\[\[[^\]]*\]\]/g, ''))) continue;
    out.push({ line, section, keyFacts: /^key (facts|figures)\b/i.test(section.trim()) });
  }
  return out;
}

/**
 * Pick the excerpt. Pure: `pages` is [{ path, content }], `mentions` a Map from
 * nameMentions. Returns [{ path, lines: [string] }] within the budgets above, best
 * first; [] when nothing relates.
 *
 * A line scores 3 per identifier it shares with the source, 2 per number, and 1 per
 * content word (at most 3 words). A page qualifies when the source names it, or when
 * its lines share at least one distinctive identifier with the source (shared numbers
 * or words alone are not evidence). Its lines are kept when they score at
 * least 2, Key Facts lines first; a page the source names but whose lines score
 * lower still shows its first Key Facts lines, so the model sees what it says.
 */
export function selectExistingFacts(text, pages, mentions = new Map()) {
  const ids = identifierAnchors(text, { strict: true });
  const nums = numberAnchors(text);
  const words = wordSet(text);
  const scored = [];
  for (const p of pages) {
    if (!p || typeof p.path !== 'string' || typeof p.content !== 'string') continue;
    const named = mentions.get(p.path) || 0;
    let idHits = 0;
    const lines = figureLines(p.content).map((l, order) => {
      const lid = identifierAnchors(l.line);
      const ln = numberAnchors(l.line);
      const lw = wordSet(l.line);
      const sid = [...lid].filter((x) => ids.has(x)).length;
      const sn = [...ln].filter((x) => nums.has(x)).length;
      const sw = Math.min(3, [...lw].filter((x) => words.has(x)).length);
      idHits += sid;
      return { ...l, order, score: 3 * sid + 2 * sn + sw };
    });
    if (!lines.length) continue;
    // Unnamed, a page needs a shared identifier: shared numbers and words alone are
    // common to unrelated documents (measured: a price list and an operating plan
    // matched a payments platform's pages on "250", "10" and "30 minutes").
    if (!named && idHits < 1) continue;
    let keep = lines.filter((l) => l.score >= 2);
    if (!keep.length && named) keep = lines.filter((l) => l.keyFacts).slice(0, 3);
    if (!keep.length) continue;
    keep = keep.sort((a, b) => (b.keyFacts - a.keyFacts) || (b.score - a.score) || (a.order - b.order))
      .slice(0, EXISTING_FACTS_MAX_LINES_PER_PAGE)
      .sort((a, b) => a.order - b.order);
    const pageScore = 4 * Math.min(named, 3) + keep.reduce((n, l) => n + l.score, 0);
    scored.push({ path: p.path, named: named > 0 ? 1 : 0, score: pageScore, lines: keep.map((l) => clip(l.line)) });
  }
  // A page the source names comes first: it is the subject, whatever its lines score.
  scored.sort((a, b) => b.named - a.named || b.score - a.score || a.path.localeCompare(b.path));
  const out = [];
  let used = 0;
  for (const s of scored) {
    if (out.length >= EXISTING_FACTS_MAX_PAGES) break;
    const lines = [];
    let cost = s.path.length + 2;
    for (const l of s.lines) {
      if (used + cost + l.length + 1 > EXISTING_FACTS_EXCERPT_CHARS) break;
      lines.push(l); cost += l.length + 1;
    }
    if (!lines.length) continue;
    used += cost;
    out.push({ path: s.path, lines });
  }
  return out;
}

function clip(line) {
  const l = line.replace(/^[-*+]\s+/, '');
  return l.length > EXISTING_FACTS_MAX_LINE_CHARS ? `${l.slice(0, EXISTING_FACTS_MAX_LINE_CHARS - 1)}…` : l;
}

/** The block as it goes in the prompt. '' for an empty selection. */
export function renderExistingFactsBlock(selection, originalName) {
  if (!Array.isArray(selection) || !selection.length) return '';
  const label = String(originalName || 'this source').replace(/\.[^.]+$/, '');
  const body = selection.map((s) => `${s.path}\n${s.lines.map((l) => `  - ${l}`).join('\n')}`).join('\n\n');
  const block = `EXISTING PAGES THIS SOURCE UPDATES — the wiki already has these pages. Below is what each one currently says that relates to this source (an excerpt, not the whole page):

${body}

For each page above whose facts this source changes or adds to:
- Return that page, at the same path, in your reply.
- In its "## Key Facts" section write ONLY what is new or changed, each line with the version, date or period it applies to and this source, and the earlier value when it changed (e.g. "As of v2.1 (${label}): \`search-api\` listens on port 9310 (was 9300)", "2025 revenue: €4.2M (2024: €3.6M)").
- Do not repeat a fact that is unchanged, and do not remove or rewrite an old one: the earlier lines stay on the page as the record of how it changed.
Leave out a page above that this source does not change.`;
  return block.length <= EXISTING_FACTS_MAX_CHARS ? block : block.slice(0, EXISTING_FACTS_MAX_CHARS);
}

/** The short line for the outline prompt: which existing pages to plan. '' for none. */
export function renderExistingFactsOutlineNote(selection) {
  if (!Array.isArray(selection) || !selection.length) return '';
  return `EXISTING PAGES THIS SOURCE UPDATES — this source changes or adds facts to these existing pages; include each one it changes in your outline, at the same path: ${selection.map((s) => s.path).join(', ')}`;
}

/**
 * Read the candidate pages and pick the excerpt. Never throws; [] on any failure.
 * @param {string} wikiDir
 * @param {{entities: string[], concepts: string[]}} existingFiles  the FULL on-disk lists
 * @param {string} text  the source text
 */
export async function existingFactsFor(wikiDir, existingFiles, text) {
  try {
    const mentions = nameMentions(text, existingFiles);
    const srcWords = wordSet(text);
    const candidates = [...mentions.keys()].map((p) => {
      const slugWords = slugTokens(path.basename(p, '.md'));
      return { path: p, named: mentions.get(p) || 0, overlap: slugWords.filter((w) => srcWords.has(w)).length };
    }).sort((a, b) => b.named - a.named || b.overlap - a.overlap || a.path.localeCompare(b.path))
      .slice(0, EXISTING_FACTS_MAX_READ);
    if (!candidates.length) return [];
    const pages = [];
    for (const c of candidates) {
      try { pages.push({ path: c.path, content: await readFile(path.join(wikiDir, c.path), 'utf8') }); } catch { /* gone or unreadable: skipped */ }
    }
    return selectExistingFacts(text, pages, mentions);
  } catch (err) {
    console.error(`[ingest] existing facts not read: ${String(err && err.message || err).slice(0, 160)}`);
    return [];
  }
}
