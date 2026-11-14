import { buildGraph } from '../graph.js';
import { rankNodes, displayScore } from '../search-score.js';

export const searchCrossDefinition = {
  name: 'search_cross_domain',
  description:
    'Search for a query across ALL available domains simultaneously. Returns ranked ' +
    'results tagged with their domain of origin — use this to find connections between ' +
    'topics that span multiple knowledge areas. Each domain is ranked as search_wiki ' +
    'ranks it; the lists are merged by each result\'s score RELATIVE to its own ' +
    'domain\'s best, so a small domain is not buried under a large one. `score` is ' +
    'the per-domain score: compare it within a domain, not across domains.',
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

  // MERGING (2026-11-14). Each domain's scores are relative to that domain (its
  // own page count and word frequencies), so raw scores from two domains are not
  // comparable, and merging on them put a large domain's results above a small
  // domain's best. Results are merged on score relative to the domain's own best
  // (exact-name pages first), ties by raw score; the order is otherwise stable.
  const merged = [];
  for (const domain of domains) {
    const graph = await buildGraph(domain, storage);
    const ranked = rankNodes(graph.nodes.values(), query).slice(0, max_results_per_domain);
    const best = ranked.reduce((m, r) => Math.max(m, r.score), 0);
    for (const { node, score, exact } of ranked) {
      const firstIdx = node.body.toLowerCase().indexOf(terms[0]);
      const excerpt = firstIdx >= 0
        ? node.body.slice(Math.max(0, firstIdx - 60), firstIdx + 160).replace(/\s+/g, ' ').trim()
        : node.body.slice(0, 160).replace(/\s+/g, ' ').trim();
      merged.push({
        hit: { domain, slug: node.slug, type: node.type, tags: node.tags, score: displayScore(score), excerpt },
        exact, score, relative: best > 0 ? score / best : 0,
      });
    }
  }

  if (merged.length === 0) return `No results found for "${query}" across any domain.`;

  merged.sort((a, b) => (b.exact - a.exact) || (b.relative - a.relative) || (b.score - a.score));
  const all = merged.map(m => m.hit);
  return {
    query,
    domains_searched: domains,
    total_matches: all.length,
    results: all,
  };
}

