import { buildGraph } from '../graph.js';
import { isValidDomain } from '../util.js';
import { rankNodes, displayScore } from '../search-score.js';

export const searchWikiDefinition = {
  name: 'search_wiki',
  description:
    'Full-text search across a domain\'s wiki. Returns ranked results enriched with ' +
    'each page\'s tags, outgoing link count, and backlink count — so you can ' +
    'prioritise hub nodes (highly connected pages) over isolated ones. Query words ' +
    'match whole words only (no partial words, no plural folding); a rare word ' +
    'counts for more than a common one, repeats count less each time, and a page ' +
    'whose slug or title is exactly the query ranks first.',
  inputSchema: {
    type: 'object',
    properties: {
      query:       { type: 'string', description: 'Search query (keywords)' },
      domain:      { type: 'string', description: 'Domain slug' },
      max_results: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['query', 'domain'],
  },
};

export async function searchWikiHandler({ query, domain, max_results = 10 }, storage) {
  if (!isValidDomain(domain)) return `Invalid domain name "${domain}". Use list_domains.`;
  const graph = await buildGraph(domain, storage);
  if (graph.nodes.size === 0) return `No wiki pages found in domain "${domain}".`;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 'Empty query.';

  const hits = [];
  for (const { node, score } of rankNodes(graph.nodes.values(), query)) {
    const firstIdx = node.body.toLowerCase().indexOf(terms[0]);
    const excerpt = firstIdx >= 0
      ? node.body.slice(Math.max(0, firstIdx - 80), firstIdx + 200).replace(/\s+/g, ' ').trim()
      : node.body.slice(0, 200).replace(/\s+/g, ' ').trim();

    hits.push({
      slug: node.slug,
      path: node.path,
      type: node.type,
      tags: node.tags,
      score: displayScore(score),
      outgoing_count: node.outgoing.length,
      backlink_count: node.backlinks.length,
      excerpt,
    });
  }

  // rankNodes returns the hits already ordered (exact name, then the unrounded
  // score, then page order); they are not re-sorted on the rounded score.
  const top = hits.slice(0, max_results);

  return {
    query,
    domain,
    total_matches: hits.length,
    returned: top.length,
    results: top,
  };
}

