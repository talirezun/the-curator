/**
 * Relevance ranking for the MCP's full-text search (search_wiki, search_cross_domain).
 *
 * WHY (2026-11-14). Both tools scored a page by the RAW number of times each query
 * term occurred in it as a SUBSTRING, plus 3 for a slug substring and 2 for a tag
 * substring. Three things followed, all measured on six real domains:
 *   - a score that grows with raw counts grows with page SIZE, so big hub pages won
 *     (an AgentLink query ranked a page about a different product first);
 *   - a substring is not a word: "ai" matched "chain", "the" matched "other";
 *   - a word on every page ("what", "file") counted exactly as much as the rare
 *     word that names what was asked about.
 * On a labelled set of 300 questions (the page that holds each answer known), the
 * answer page was in the top 5 for 182 of 300 agent-style keyword queries.
 *
 * THE SCORE, per query, over the domain's own pages (nothing stored, no index):
 *   - TERMS are the query's words: runs of letters and digits, lower-cased, each
 *     counted once (`terms`). A term matches a WHOLE WORD of the page, never part of
 *     one; the page's words are split the same way (so `end-to-end` is three words).
 *   - BODY: for each term found c > 0 times in the slug + body, (1 + ln c) × idf,
 *     where idf = ln(1 + (N − df + 0.5) / (df + 0.5)) over the domain's N pages, df
 *     of which hold the term. The tenth mention adds far less than the first, and a
 *     word on every page adds almost nothing.
 *   - NAME: +3 when a term is a word of the slug, +2 when it is a word of a tag —
 *     the same fixed bonuses as before, NOT scaled by idf (measured: scaling them
 *     dropped a page named exactly by the query out of the top 5).
 *   - EXACT NAME FIRST: a page whose slug words or title words are exactly the
 *     query's words (`mcp` → `mcp.md`, "Smart Contracts" → `smart-contracts.md`)
 *     ranks above every page that is not. This is a separate sort key, not a
 *     bonus, so no score can outrank it and no weighting changes it.
 *   - ORDER: exact name, then score, both compared UNROUNDED; ties keep the graph's
 *     page order (a stable sort). Only the returned `score` is rounded, for display.
 *
 * WHICH PAGES MATCH changed with whole-word matching, deliberately: a page matches
 * when a term is a whole word of its slug + body, a word of its slug, or a word of
 * a tag. A page that held a term only inside a longer word ("agent" inside
 * "agents", "ai" inside "chain") no longer matches. No plural folding: measured on
 * the same set it was not net-positive (top-5 256 vs 259 without it).
 *
 * Measured with this score on the same set: top-5 259 of 300 (was 182), MRR 0.701
 * (was 0.456), better or equal in every domain; whole-question queries 218 of 300
 * in the top 5 (was 56).
 *
 * Pure and synchronous; never writes to stdout (it is reachable from mcp/).
 */

const WORD_RE = /[\p{L}\p{N}]+/gu;
const SLUG_BONUS = 3;
const TAG_BONUS = 2;

/** A string's words, lower-cased, in order (duplicates kept). */
export function words(s) {
  return String(s ?? '').toLowerCase().match(WORD_RE) || [];
}

/** The query's terms: its distinct words, in first-seen order. */
export function terms(query) {
  return [...new Set(words(query))];
}

// Per-node word counts, computed once per node object. The graph caches its nodes
// (mcp/graph.js), so a node object is reused across queries until the graph is
// rebuilt, and a rebuilt graph brings new objects (the old entries are collected).
const _profiles = new WeakMap();
function profile(node) {
  let p = _profiles.get(node);
  if (!p) {
    const tf = new Map();
    for (const w of words(String(node.slug ?? '') + '\n' + String(node.body ?? ''))) tf.set(w, (tf.get(w) || 0) + 1);
    const slugWords = words(node.slug);
    const titleMatch = /^#{1,3}\s+(.+)/m.exec(String(node.body ?? ''));
    p = {
      tf,
      slugWords: new Set(slugWords),
      tagWords: new Set((node.tags || []).flatMap(t => words(t))),
      slugKey: slugWords.join(' '),
      titleKey: titleMatch ? words(titleMatch[1]).join(' ') : '',
    };
    _profiles.set(node, p);
  }
  return p;
}

/**
 * Rank `nodes` (graph nodes: { slug, body, tags, … }) for `query`.
 * Returns [{ node, score, exact }] for every matching node, best first.
 * `score` is unrounded; `exact` is true when the page's slug or title is the query.
 */
export function rankNodes(nodes, query) {
  const all = [...nodes];
  const t = terms(query);
  if (t.length === 0 || all.length === 0) return [];
  const profiles = all.map(profile);
  const N = all.length;
  const idf = t.map(term => {
    let df = 0;
    for (const p of profiles) if (p.tf.has(term)) df++;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  });
  const queryKey = words(query).join(' ');

  const out = [];
  for (let j = 0; j < all.length; j++) {
    const p = profiles[j];
    let score = 0;
    let matched = false;
    for (let i = 0; i < t.length; i++) {
      const c = p.tf.get(t[i]) || 0;
      if (c > 0) { matched = true; score += (1 + Math.log(c)) * idf[i]; }
      if (p.slugWords.has(t[i])) { matched = true; score += SLUG_BONUS; }
      if (p.tagWords.has(t[i])) { matched = true; score += TAG_BONUS; }
    }
    if (!matched) continue;
    const exact = queryKey !== '' && (p.slugKey === queryKey || p.titleKey === queryKey);
    out.push({ node: all[j], score, exact, order: j });
  }
  out.sort((a, b) => (b.exact - a.exact) || (b.score - a.score) || (a.order - b.order));
  return out.map(({ node, score, exact }) => ({ node, score, exact }));
}

/** The score as the tools return it. */
export function displayScore(score) {
  return Math.round(score * 100) / 100;
}
