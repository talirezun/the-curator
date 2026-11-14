import { buildGraph } from '../graph.js';
import { rankNodesWithMeta, heldWholeTerms, displayScore } from '../search-score.js';

// A query word common in one domain gives that domain a near-zero weight, and the
// FLAT slug/tag bonuses divided by it put that domain's pages ahead of every
// other's (measured: "curator" had weight 0.30 in projects and its first five
// results were all projects pages; posts:the-curator fell 5 → 7). The divisor is
// never below 1 (floors 2 and 3 pushed another domain's own page down instead).
const WEIGHT_FLOOR = 1;

export const searchCrossDefinition = {
  name: 'search_cross_domain',
  description:
    'Search for a query across ALL available domains simultaneously. Returns ranked ' +
    'results tagged with their domain of origin — use this to find connections between ' +
    'topics that span multiple knowledge areas. Each domain is ranked as search_wiki ' +
    'ranks it; the lists are merged on each score divided by what one plain mention ' +
    'of every query word scores in that domain, so a small domain is not buried under ' +
    'a large one. `score` is the per-domain score: compare it within a domain, not ' +
    'across domains.',
  inputSchema: {
    type: 'object',
    properties: {
      query:                  { type: 'string', description: 'Search query' },
      max_results_per_domain: { type: 'number', description: 'Max results per domain (default 5)' },
    },
    required: ['query'],
  },
};

export async function searchCrossHandler({ query, max_results_per_domain = 5 }, storage) {
  const domains = await storage.listDomains();
  if (domains.length === 0) return 'No domains found.';

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 'Empty query.';

  // MERGING (2026-11-14). Each domain's scores depend on that domain's own page
  // count and word frequencies, so raw scores from two domains are not comparable
  // (merged raw, a large domain buried a small one), and score relative to each
  // domain's best put every domain's best first however weak it was (a round
  // robin). Results are merged on score / max(weight, 1) — weight being what one
  // plain mention of every query word scores in that domain (search-score.js) —
  // with exact-name pages first and ties by raw score.
  const merged = [];
  const graphs = [];
  for (const domain of domains) graphs.push([domain, await buildGraph(domain, storage)]);
  // Whole terms ("gpt-5.6", "$5,000") held by ANY domain never fall back to their
  // words in the others (search-score.js, rankNodesWithMeta).
  const held = new Set();
  for (const [, graph] of graphs) for (const t of heldWholeTerms(graph.nodes.values(), query)) held.add(t);
  for (const [domain, graph] of graphs) {
    const meta = rankNodesWithMeta(graph.nodes.values(), query, { held });
    const ranked = meta.hits.slice(0, max_results_per_domain);
    const weight = meta.weight;
    for (const { node, score, exact } of ranked) {
      const firstIdx = node.body.toLowerCase().indexOf(terms[0]);
      const excerpt = firstIdx >= 0
        ? node.body.slice(Math.max(0, firstIdx - 60), firstIdx + 160).replace(/\s+/g, ' ').trim()
        : node.body.slice(0, 160).replace(/\s+/g, ' ').trim();
      merged.push({
        hit: { domain, slug: node.slug, type: node.type, tags: node.tags, score: displayScore(score), excerpt },
        exact, score, norm: score / Math.max(weight, WEIGHT_FLOOR),
      });
    }
  }

  if (merged.length === 0) return `No results found for "${query}" across any domain.`;

  merged.sort((a, b) => (b.exact - a.exact) || (b.norm - a.norm) || (b.score - a.score));
  const all = merged.map(m => m.hit);
  return {
    query,
    domains_searched: domains,
    total_matches: all.length,
    results: all,
  };
}

