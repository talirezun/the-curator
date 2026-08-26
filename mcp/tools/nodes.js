import { buildGraph } from '../graph.js';
import { isValidDomain, isValidSlug, resolveNodeSlug } from '../util.js';

export const getNodeDefinition = {
  name: 'get_node',
  description:
    'Get the full content of a wiki page by slug, enriched with structured metadata: ' +
    'type (entity/concept/summary), tags, outgoing [[wikilinks]] (with the section each ' +
    'appears in), and backlinks (pages that link to this one). This is the primary tool ' +
    'for pulling a single piece of knowledge with its full graph context.',
  inputSchema: {
    type: 'object',
    properties: {
      slug:   { type: 'string', description: 'Page slug — the filename without ".md", exactly as get_index or search_wiki reports it. Interior dots are legitimate, e.g. "andrej-karpathy", "transformer-architecture", "claude-sonnet-3.5".' },
      domain: { type: 'string', description: 'Domain slug' },
    },
    required: ['slug', 'domain'],
  },
};

/**
 * SHAPE refusal, and it must not be mistaken for "page not found".
 *
 * The string this replaces said "Slugs are lowercase alphanumerics, hyphens, or
 * underscores" — wrong on TWO counts against the validator it was describing.
 * `SLUG_CHARS_RE` carries the `i` flag, so uppercase has always passed; and
 * v3.9.1 widened it to permit an interior dot, which is what made the sentence
 * actively harmful rather than merely imprecise: it is the release note's own
 * quoted symptom, left in the tree by the fix. A model reading it concludes the
 * dot was the problem, and the only repair it can see is to retry with a
 * dot-free slug it made up — i.e. exactly the guess-a-nearby-page behaviour
 * SKILL.md §6 forbids, on a corpus where `claude-sonnet-4.5` and
 * `claude-sonnet-3.5` are different pages.
 *
 * So this states the real rule, and then names the recovery explicitly, because
 * "invalid" alone leaves retry-with-a-guess as the obvious next move.
 */
export async function getNodeHandler({ slug, domain }, storage) {
  if (!isValidDomain(domain)) return `Invalid domain name "${domain}". Use list_domains.`;
  if (!isValidSlug(slug))     return `Invalid slug "${slug}" — this is a SHAPE error, not "page not found". A slug is a page filename without ".md": ASCII letters, digits, hyphens, underscores, and interior dots ("claude-sonnet-3.5" is valid). It may not contain spaces, "/", "..", a leading or trailing dot, or non-ASCII characters. Do NOT retry with a slug you guessed — get the exact slug from get_index or search_wiki.`;

  const graph = await buildGraph(domain, storage);
  const resolved = resolveNodeSlug(slug, graph.nodes);
  if (!resolved) {
    return `Page "${slug}" not found in domain "${domain}". Use search_wiki or get_index to find the correct slug.`;
  }
  const node = graph.nodes.get(resolved);

  return {
    slug: node.slug,
    path: node.path,
    type: node.type,
    tags: node.tags,
    source: node.source,
    created: node.created,
    date: node.date,
    outgoing_links: node.outgoing,
    outgoing_count: node.outgoing.length,
    backlinks: node.backlinks,
    backlink_count: node.backlinks.length,
    body: node.body,
  };
}
