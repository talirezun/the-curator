/**
 * Graph builder — parses a domain's wiki into a structured knowledge graph.
 *
 * This is the layer that makes "full context of the second brain" real:
 * beyond raw markdown, it exposes frontmatter (tags, type), outgoing [[wikilinks]],
 * and incoming backlinks — so a frontier LLM can reason about the topology of
 * the user's knowledge, not just retrieve pages.
 *
 * Cached in-process for the life of one MCP server invocation.
 * Claude Desktop spawns a fresh process per session, so the cache is naturally
 * scoped to a single conversation.
 */

const graphCache = new Map();   // domain → { builtAt, fileCount, nodes, edges, tags }
const CACHE_TTL_MS = 10 * 60_000;   // 10 min — Claude Desktop spawns a fresh process per session,
                                    // so within-session files rarely change; this avoids the cost
                                    // of re-reading hundreds of .md files on every tool call.

/**
 * Drop the cached graph for `domain` (or every domain when called with no
 * argument), so the next buildGraph() re-reads the wiki from disk.
 *
 * WHY THIS EXISTS, AND WHY THE FILE-COUNT CHECK BELOW IS NOT ENOUGH.
 *
 * The cache had a file-count invalidation and it was UNREACHABLE: the TTL
 * early-return fired first and returned the stale graph without ever calling
 * listWikiFiles, so the count comparison two lines later could only run in the
 * one case where the TTL had already expired — i.e. where the graph was being
 * rebuilt anyway. For the whole 10-minute window the graph was frozen.
 *
 * That window is exactly the life of a Claude Desktop conversation, and the
 * MCP is a READ+WRITE surface: compile_to_wiki and fix_wiki_issue change the
 * wiki through src/brain/*, entirely outside this module. So "save this to my
 * wiki" followed by "now show me that page" read a graph built before the
 * write and truthfully reported the page as absent.
 *
 * The count check is now reachable (see below) but it is a BACKSTOP, not the
 * fix: a compile that UPDATES existing pages leaves the count identical, and
 * a create-plus-delete nets to zero. Only an explicit invalidation after a
 * known write is correct, which is what this function is for. Every MCP tool
 * that mutates the wiki must call it — the mutators are the `refuseIfReadonly`
 * call sites across mcp/tools/**.
 */
export function invalidateGraph(domain) {
  if (typeof domain === 'string' && domain) graphCache.delete(domain);
  else graphCache.clear();
}

/** Test-only: how many domains are currently cached. */
export function __cachedDomains() {
  return [...graphCache.keys()].sort();
}

export async function buildGraph(domain, storage) {
  const cached = graphCache.get(domain);

  // Reachability, restated: the count is taken BEFORE any early return, so
  // the invalidation below can actually fire inside the TTL window. It uses
  // countWikiFiles — a dirent-only walk that never opens a file — because
  // listWikiFiles READS EVERY PAGE. Measured on a 3,000-file domain of
  // ~2.5 MB: listWikiFiles 173 ms p50, the dirent-only count 1.5 ms. Doing
  // the full listing on every tool call would not be an invalidation fix, it
  // would be the deletion of the cache. Adapters that predate countWikiFiles
  // fall back to the TTL alone rather than paying 173 ms per call.
  let currentCount = null;
  if (typeof storage.countWikiFiles === 'function') {
    currentCount = await storage.countWikiFiles(domain);
  }

  if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) {
    // Different file count ⇒ something wrote to the wiki ⇒ rebuild. A count
    // we could not take (null) is not evidence of change, so it keeps the
    // pre-existing TTL behaviour rather than thrashing the cache.
    if (currentCount === null || currentCount === cached.fileCount) return cached;
  }

  const files = await storage.listWikiFiles(domain);
  const nodes = new Map();   // slug → node
  const edges = [];          // { from, to, section }

  // Pass 1 — parse every file into a node with frontmatter + outgoing links
  for (const { path: filePath, content } of files) {
    // Skip non-page files (index.md, log.md) from the graph — they aren't wiki nodes
    const relLower = filePath.toLowerCase();
    if (relLower === 'index.md' || relLower === 'log.md') continue;

    const slug = slugFromPath(filePath);
    if (!slug) continue;

    const { frontmatter, body } = parseFrontmatter(content);
    const type = frontmatter.type
      || (filePath.startsWith('entities/') ? 'entity'
          : filePath.startsWith('concepts/') ? 'concept'
          : filePath.startsWith('summaries/') ? 'summary'
          : 'unknown');

    const tags = frontmatter.tags || [];
    const outgoing = extractOutgoingLinks(body);

    nodes.set(slug, {
      slug,
      path: filePath,
      type,
      tags,
      source: frontmatter.source || null,
      created: frontmatter.created || null,
      date: frontmatter.date || null,
      body,
      frontmatter,
      outgoing,             // array of { slug, section }
      backlinks: [],        // filled in Pass 2
    });
  }

  // Pass 2 — resolve outgoing links against the node map, build edges, fill backlinks
  for (const node of nodes.values()) {
    for (const { slug: targetSlug, section } of node.outgoing) {
      const resolved = resolveSlug(targetSlug, nodes);
      if (!resolved) continue;    // unresolved link — tracked via get_broken_links if we add it later
      edges.push({ from: node.slug, to: resolved, section });
      const target = nodes.get(resolved);
      if (target && !target.backlinks.some(b => b.slug === node.slug && b.section === section)) {
        target.backlinks.push({ slug: node.slug, section });
      }
    }
  }

  // Pass 3 — tag inventory
  const tagMap = new Map();   // tag → { tag, count, pages: Set }
  for (const node of nodes.values()) {
    for (const tag of node.tags) {
      let entry = tagMap.get(tag);
      if (!entry) { entry = { tag, count: 0, pages: new Set() }; tagMap.set(tag, entry); }
      entry.count += 1;
      entry.pages.add(node.slug);
    }
  }
  const tags = [...tagMap.values()]
    .map(t => ({ tag: t.tag, count: t.count, pages: [...t.pages].sort() }))
    .sort((a, b) => b.count - a.count);

  const graph = { builtAt: Date.now(), fileCount: files.length, nodes, edges, tags };
  graphCache.set(domain, graph);
  return graph;
}

/** Extract slug from a wiki file path like "entities/tali-rezun.md" → "tali-rezun". */
export function slugFromPath(filePath) {
  const m = filePath.match(/([^/]+)\.md$/);
  return m ? m[1] : null;
}

/**
 * Parse a markdown file's YAML frontmatter.
 * Handles the Curator's single-line `tags: [a, b, c]` format plus a few safe variants.
 */
export function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return { frontmatter: {}, body: content || '' };
  const end = content.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: content };

  const yaml = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, '');
  const fm = {};

  for (const line of yaml.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();

    if (key === 'tags') {
      // Parse [a, b, c] or a, b, c — the Curator always emits the bracket form.
      // Dedupe within a page (some older files have `tags: [x, x, y]`).
      const inner = value.replace(/^\[|\]$/g, '');
      const raw = inner.split(',').map(s => s.trim()).filter(Boolean);
      fm.tags = [...new Set(raw)];
    } else {
      fm[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter: fm, body };
}

/**
 * Extract all [[wikilinks]] from body text with the section they appear in.
 * Section is inferred from the most recent `## Heading` before the link.
 */
export function extractOutgoingLinks(body) {
  const out = [];
  const seen = new Set();
  const lines = body.split('\n');
  let currentSection = null;
  const linkRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

  for (const line of lines) {
    const h = line.match(/^##+\s+(.+?)\s*$/);
    if (h) currentSection = h[1].trim();

    let m;
    while ((m = linkRe.exec(line)) !== null) {
      const target = m[1].trim();
      // Normalise "summaries/foo" → "foo" (the slug-level target);
      // the source path tells us it lives in summaries/, we preserve that via the node lookup.
      const slugOnly = target.split('/').pop().toLowerCase().replace(/\s+/g, '-');
      const key = `${slugOnly}|${currentSection || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ slug: slugOnly, section: currentSection });
    }
  }
  return out;
}

/**
 * Resolve a raw link target against the node map. Tolerates the common
 * Curator mismatches: hyphen variants, title prefixes, article prefixes.
 */
function resolveSlug(target, nodes) {
  if (nodes.has(target)) return target;

  // normalise underscores, whitespace
  const norm = target.toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
  if (nodes.has(norm)) return norm;

  // strip common article prefixes
  const stripArticle = norm.replace(/^(the|a|an)-/, '');
  if (nodes.has(stripArticle)) return stripArticle;

  return null;
}
