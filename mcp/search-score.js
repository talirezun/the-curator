/**
 * Relevance ranking for the MCP's full-text search (search_wiki, search_cross_domain).
 *
 * WHY (2026-11-14). Both tools scored a page by the RAW number of times each query
 * term occurred in it as a SUBSTRING, plus 3 for a slug substring and 2 for a tag
 * substring. Measured on six real domains: a score that grows with raw counts grows
 * with page SIZE, so big hub pages won (an AgentLink query ranked a page about a
 * different product first); "ai" matched "chain"; a word on every page ("what",
 * "file") counted as much as the rare word that names what was asked about.
 *
 * THE SCORE, per query, over the domain's own pages (nothing stored, no index):
 *   - TERMS are the query's distinct words (runs of letters and digits, lower-cased).
 *     The page's words are split the same way (`end-to-end` is three words).
 *   - WHOLE WORD: for a term found c > 0 times as a word of slug + body,
 *     (1 + ln c) × idf, idf = ln(1 + (N − df + 0.5) / (df + 0.5)) over the domain's N
 *     pages. The tenth mention adds far less than the first; a word on every page
 *     adds almost nothing.
 *   - PREFIX, at a quarter of that weight (PREFIX_WEIGHT): a term of PREFIX_MIN (4)
 *     letters or more also matches the page's words that START with it ("encrypt"
 *     finds "encryption", "auth" finds "authentication"); a trailing "e" is dropped
 *     for this ("paginate" finds "pagination"). Its own idf is over the pages holding
 *     any such word. So a whole-word match outweighs a prefix match of the same count.
 *   - NAME: +3 when a term is a word of the slug, +2 a word of a tag (a quarter of
 *     that for a prefix of one). Flat, NOT scaled by idf (scaling them dropped a page
 *     named exactly by the query out of the top 5).
 *   - EXACT NAME FIRST: a page whose slug words or title words are the query's words
 *     (one trailing "s" per word ignored: "smart contract" names `smart-contracts.md`)
 *     ranks above every page that is not — a separate sort key, never a bonus.
 *   - ORDER: exact name, then the UNROUNDED score, ties in the graph's page order.
 *     Only the returned `score` is rounded, for display.
 *
 * WHICH PAGES MATCH: a page holding a term as a whole word or (4+ letters) as the
 * start of a word, in slug, body or tags. A term inside a word ("ai" in "chain",
 * "agent" in "subagent") no longer matches; a short term (under 4 letters) matches
 * whole words only ("ai" does not find "aim").
 *
 * VERSIONS: "0.4.11", "v1.0", "gpt-5.6" stay one term (see COMPOUND_RE below).
 *
 * CROSS-DOMAIN (`weight`): each domain's scores depend on its own page count and word
 * frequencies, so search_cross_domain merges on score ÷ max(weight, 1), where weight is the
 * score a page would get for one plain mention of every term in THAT domain (Σ idf).
 * Merged on raw scores, a large domain buried a small one; merged on score relative
 * to each domain's best, every domain's best came first whatever its strength (the
 * first six results were one per domain in 129 of 158 audited queries).
 *
 * Measured on 507 labelled questions (300 + an independent audit's 158 + 49 built
 * from pages chat stops loading), agent-style keyword queries, top-5: search_wiki
 * 276 → 434, search_cross_domain 134 → 365; see docs/dev/decisions-agents.md.
 *
 * Pure and synchronous; never writes to stdout (it is reachable from mcp/).
 */

const WORD_RE = /[\p{L}\p{N}]+/gu;
const SLUG_BONUS = 3;
const TAG_BONUS = 2;
const PREFIX_MIN = 4;
const PREFIX_WEIGHT = 0.25;

/** A string's words, lower-cased, in order (duplicates kept). */
export function words(s) {
  return String(s ?? '').toLowerCase().match(WORD_RE) || [];
}

// VERSION AND NUMBER TOKENS. Letters and digits joined by "." or "-" with at least
// one digit ("0.4.11", "v1.0", "3.5", "gpt-5.6", "claude-opus-4.7") are ALSO kept
// whole, so a query naming a version matches only the pages that hold that version.
// Split into words alone, "0.4.11" became 0, 4 and 11 and matched every page with a
// 4 in it (measured: 91 version strings that occur on 1-3 pages, top-1 88 → 36).
// A page's text yields its words AND every run of 2+ joined pieces that holds a
// digit ("gemini-3.5-flash" also yields "gemini-3.5", "3.5" and "3.5-flash").
const COMPOUND_RE = /[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)+/gu;
const HAS_DIGIT = /\p{N}/u;
function compoundMatches(lower) {
  return (lower.match(COMPOUND_RE) || []).filter(m => HAS_DIGIT.test(m));
}
/** True for a whole version/number token ("0.4.11", "gpt-5.6"). */
export function isCompound(term) {
  return term.includes('.') || term.includes('-');
}
/** A string's indexable tokens: its words plus its version/number tokens. */
export function tokens(s) {
  const lower = String(s ?? '').toLowerCase();
  const out = lower.match(WORD_RE) || [];
  for (const m of compoundMatches(lower)) {
    // Every contiguous run of 2+ of its pieces that holds a digit, so "gpt-5.6-sol"
    // also yields "gpt-5.6" and "5.6", "v3.17.x" yields "v3.17", and a leading "v"
    // is optional ("v0.2.0" is also found as "0.2.0").
    const parts = m.split(/([.-])/);           // pieces at even indexes, separators at odd
    const n = Math.min((parts.length + 1) / 2, 10);
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      const run = parts.slice(2 * a, 2 * b + 1).join('');
      if (HAS_DIGIT.test(run)) { out.push(run); if (/^v\d/.test(run)) out.push(run.slice(1)); }  // "v0.2.0" is also "0.2.0"
    }
  }
  return out;
}

/**
 * The query's terms, distinct, in first-seen order: each version/number token
 * whole (its words are NOT also terms), then the remaining words.
 */
export function terms(query) {
  const lower = String(query ?? '').toLowerCase();
  const whole = compoundMatches(lower);
  const rest = lower.replace(COMPOUND_RE, m => (HAS_DIGIT.test(m) ? ' ' : m));
  return [...new Set([...whole, ...(rest.match(WORD_RE) || [])])];
}

// A NAME key for the exact-name rule: the words in order, each with one trailing
// "s" dropped when the word is longer than 3 letters, so "smart contract" names
// `smart-contracts.md` and "agents" names `agent.md`. Used ONLY to decide the
// exact-name tier; matching and scoring never fold a word.
function nameKey(ws) {
  return ws.map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)).join(' ');
}

// Per-node word counts, computed once per node object. The graph caches its nodes
// (mcp/graph.js), so a node object is reused across queries until the graph is
// rebuilt, and a rebuilt graph brings new objects (the old entries are collected).
const _profiles = new WeakMap();
function profile(node) {
  let p = _profiles.get(node);
  if (!p) {
    const tf = new Map();
    for (const w of tokens(String(node.slug ?? '') + '\n' + String(node.body ?? ''))) tf.set(w, (tf.get(w) || 0) + 1);
    const slugWords = words(node.slug);
    const titleMatch = /^#{1,3}\s+(.+)/m.exec(String(node.body ?? ''));
    p = {
      tf,
      slugWords: new Set(tokens(node.slug)),
      tagWords: new Set((node.tags || []).flatMap(t => tokens(t))),
      slugKey: nameKey(slugWords),
      titleKey: titleMatch ? nameKey(words(titleMatch[1])) : '',
    };
    _profiles.set(node, p);
  }
  return p;
}

// The domain's vocabulary (sorted distinct words), cached on the first node object
// of the node list (a rebuilt graph brings new node objects) and re-made when the
// page count differs.
const _vocab = new WeakMap();
function vocabOf(all, profiles) {
  const hit = _vocab.get(all[0]);
  if (hit && hit.n === all.length) return hit.words;
  const set = new Set();
  for (const p of profiles) for (const w of p.tf.keys()) set.add(w);
  for (const p of profiles) for (const w of p.slugWords) set.add(w);
  for (const p of profiles) for (const w of p.tagWords) set.add(w);
  const words = [...set].sort();
  _vocab.set(all[0], { n: all.length, words });
  return words;
}
function wordsWithPrefix(vocab, prefix) {
  let lo = 0, hi = vocab.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (vocab[m] < prefix) lo = m + 1; else hi = m; }
  const out = [];
  for (let k = lo; k < vocab.length && vocab[k].startsWith(prefix); k++) if (vocab[k] !== prefix) out.push(vocab[k]);
  return out;
}

/**
 * Rank `nodes` (graph nodes: { slug, body, tags, … }) for `query`.
 * Returns [{ node, score, exact }] for every matching node, best first.
 * `score` is unrounded; `exact` is true when the page's slug or title is the query.
 */
export function rankNodes(nodes, query) {
  return rankNodesWithMeta(nodes, query).hits;
}

/** rankNodes plus `weight`: the score a page would get for one plain mention of every term. */
export function rankNodesWithMeta(nodes, query) {
  const all = [...nodes];
  const t = terms(query);
  if (t.length === 0 || all.length === 0) return { hits: [], weight: 0 };
  const profiles = all.map(profile);
  const N = all.length;
  const idfOf = (df) => Math.log(1 + (N - df + 0.5) / (df + 0.5));
  const idf = t.map(term => {
    let df = 0;
    for (const p of profiles) if (p.tf.has(term)) df++;
    return idfOf(df);
  });
  const vocab = vocabOf(all, profiles);
  const pre = t.map(term => {
    if (term.length < PREFIX_MIN || isCompound(term)) return [];
    // A trailing "e" is dropped from the prefix ("paginate" also finds "pagination").
    const stem = term.length >= 5 && term.endsWith('e') ? term.slice(0, -1) : term;
    return wordsWithPrefix(vocab, stem).filter(w => w !== term);
  });
  const preCount = (p, i) => { let c = 0; for (const w of pre[i]) c += p.tf.get(w) || 0; return c; };
  const preIdf = t.map((term, i) => {
    if (!pre[i].length) return 0;
    let df = 0;
    for (const p of profiles) if (preCount(p, i) > 0) df++;
    return idfOf(df);
  });
  const queryKey = nameKey(words(query));

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
      if (pre[i].length) {
        const cp = preCount(p, i);
        if (cp > 0) { matched = true; score += PREFIX_WEIGHT * (1 + Math.log(cp)) * preIdf[i]; }
        if (!p.slugWords.has(t[i]) && pre[i].some(w => p.slugWords.has(w))) { matched = true; score += PREFIX_WEIGHT * SLUG_BONUS; }
        if (!p.tagWords.has(t[i]) && pre[i].some(w => p.tagWords.has(w))) { matched = true; score += PREFIX_WEIGHT * TAG_BONUS; }
      }
    }
    if (!matched) continue;
    const exact = queryKey !== '' && (p.slugKey === queryKey || p.titleKey === queryKey);
    out.push({ node: all[j], score, exact, order: j });
  }
  out.sort((a, b) => (b.exact - a.exact) || (b.score - a.score) || (a.order - b.order));
  const weight = idf.reduce((a, x) => a + x, 0);
  return { hits: out.map(({ node, score, exact }) => ({ node, score, exact })), weight };
}

/** The score as the tools return it. */
export function displayScore(score) {
  return Math.round(score * 100) / 100;
}
