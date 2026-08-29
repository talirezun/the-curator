/**
 * Shared utilities for MCP tools.
 *
 * The storage adapter is the ultimate chokepoint for path traversal, but we also
 * validate/normalise slugs and domain names at the tool layer so that invalid
 * input returns a clean error instead of a silent "not found".
 */

/**
 * Loose slug check — the characters a Curator wiki filename can legitimately
 * contain. Rejects anything that could be used for traversal, shell escapes,
 * or oddball unicode mischief.
 *
 * INTERIOR DOTS ARE LEGITIMATE (v3.9.1). Before that, this refused every dot,
 * and the guard was over-reaching against the very data the wiki holds: 67
 * distinct real pages in the maintainer's own domains carry a version number or
 * a hostname in the slug — `claude-sonnet-3.5`, `gemini-2.5-flash`,
 * `industry-5.0`, `apache-2.0-license`, `express.js`, `warmwind.space`. The
 * failure was silent and self-contradictory: `search_wiki` and `get_index`
 * ADVERTISED those slugs, and every slug-taking sibling (`get_node`,
 * `get_backlinks`, `get_connected_nodes`, `get_summary`, `get_raw_source`) then
 * refused them with "Slugs are lowercase alphanumerics, hyphens, or
 * underscores" — 77 pages discoverable but unreadable, and `get_raw_source`
 * broken for 100% of the summaries that actually had their source on disk.
 *
 * What the dot must NEVER buy is a path component. Three refusals below carry
 * that, and they are belt-and-braces rather than the primary defence: the real
 * chokepoints stay `resolveInsideBase` in mcp/storage/local.js (reads) and
 * `resolveInsideWiki` in src/brain/*.js (raw-source), which canonicalise with
 * path.resolve and refuse anything landing outside the base. This function
 * deliberately does NOT add a second containment check — two hand-maintained
 * copies of one guard is what produced the v3.2.0 CRITICAL.
 *
 * NOT ENFORCED — stated so nobody reads this as "every real slug now works".
 * Measured against the maintainer's six real domains, this takes the rejected
 * set from 73 of 4,751 distinct slugs down to 8. The 8 that remain are NOT
 * dot-related and are deliberately untouched:
 *   - 3 carry non-ASCII diacritics (`petar-urdešić`, `snežana-ilić`,
 *     `françois-chollet`). Widening to non-ASCII is a separate risk decision
 *     (NFC/NFD normalisation, look-alike characters) and is not made here.
 *   - 3 contain literal spaces (`document analysis`, `risk management`,
 *     `google- Gemini`). A space cannot be normalised into a match either,
 *     because the node map is keyed on the on-disk filename.
 *   - 2 exceed the 200-character cap. Both are LLM-runaway page titles of ~230
 *     characters; the cap is doing its job and is not the defect.
 *
 * Measured, not assumed, about this regex (see scripts/test-mcp-e2e.js §6):
 *  - JS `$` without the `m` flag does NOT match before a trailing newline
 *    (that is Python's behaviour) — `"abc\n"` is refused.
 *  - `/[a-z]/i` WITHOUT the `u` flag does not case-fold non-ASCII, so U+017F
 *    (long s) and U+212A (Kelvin sign) are refused rather than folding to ASCII.
 *  - Percent-encoded (`%2e%2e`) and unicode look-alike dots (U+2024, U+FF0E)
 *    are refused by the character class, not by a decode step.
 */
const SLUG_CHARS_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function isValidSlug(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 200) return false;
  // Character class refuses path separators, NUL, control characters,
  // whitespace, and every non-ASCII code point. A leading dot is refused by
  // the `^[a-z0-9]` anchor, so dotfiles can never be addressed as slugs.
  if (!SLUG_CHARS_RE.test(s)) return false;
  // No real slug contains `..`; refusing it means a dot can never be assembled
  // into a parent-directory segment even if a future caller concatenates
  // without going through a chokepoint.
  if (s.includes('..')) return false;
  // A trailing dot is not a real slug either, and on Windows a trailing dot is
  // stripped by the filesystem — `foo.` and `foo` would name the same file.
  if (s.endsWith('.')) return false;
  return true;
}

/**
 * Domain slugs are STRICTER than page slugs — deliberately, and this is a split
 * rather than the alias it used to be.
 *
 * A domain is the OUTER path segment of every wiki path (`<domain>/wiki/...`),
 * so it is the one worth keeping maximally narrow. And unlike page slugs there
 * is no legitimate case to serve: `generateUniqueSlug` in src/brain/files.js
 * reduces a user's display name to `[a-z0-9-]` before creating the folder, so
 * the app CANNOT produce a dotted domain, and none of the six real domains has
 * one. Widening domains alongside slugs would repeat, in the opposite
 * direction, the mistake this release fixes: a guard that does not match the
 * legitimate case in front of it.
 *
 * Underscore stays permitted only because it always has — narrowing it is a
 * behaviour change with no reported motivation.
 */
export function isValidDomain(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && /^[a-z0-9][a-z0-9_-]*$/i.test(s);
}

/**
 * Normalise an LLM-provided slug to its canonical form. Underscores → hyphens,
 * whitespace → hyphens, lowercased. Returns null for invalid shapes.
 */
export function normaliseSlug(s) {
  if (typeof s !== 'string' || !s) return null;
  const n = s.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
  return isValidSlug(n) ? n : null;
}

/**
 * Resolve a slug against a graph — tolerant of the few Curator-specific
 * canonical variants (hyphen form, article-prefix stripped). Returns the
 * matching node's slug, or null.
 */
export function resolveNodeSlug(raw, graphNodes) {
  if (typeof raw !== 'string' || !raw) return null;
  if (graphNodes.has(raw)) return raw;
  const norm = normaliseSlug(raw);
  if (norm && graphNodes.has(norm)) return norm;
  if (norm) {
    const stripped = norm.replace(/^(the|a|an)-/, '');
    if (stripped && graphNodes.has(stripped)) return stripped;
  }
  return null;
}

/**
 * Resolve a tool's `domain` argument with the v2.5.2 default-domain fallback.
 *
 * Used by every write tool (compile_to_wiki, scan_wiki_health, fix_wiki_issue,
 * dismiss_wiki_issue, undismiss_wiki_issue, get_health_dismissed,
 * scan_semantic_duplicates) so the resolution rule is consistent: explicit
 * arg → user's configured default → error.
 *
 * Returns either { value: <slug> } on success, or { error: "..." } when the
 * domain is missing, malformed, or not present on disk. Callers spread the
 * error directly into the tool response.
 */
export async function resolveDomainArg(args, storage, getDefaultDomain) {
  let domain = args?.domain;
  if (!domain) {
    domain = getDefaultDomain();
    if (!domain) {
      return { error: 'No domain specified and no default domain is configured. Call list_domains, then pass `domain` explicitly. Tip: the user can set a default in Settings → Default domain for MCP writes.' };
    }
  }
  if (!isValidDomain(domain)) {
    return { error: `Invalid domain: ${domain}` };
  }
  const all = await storage.listDomains();
  if (!all.includes(domain)) {
    return { error: `Unknown domain: ${domain}. Available: ${all.join(', ') || '(none)'}` };
  }
  return { value: domain };
}

/**
 * Refuse to write to a Shared Brain mirror domain.
 *
 * Per Decision 7 in docs/shared-brain-design.md, every Shared Brain mirror
 * (a `domains/shared-<slug>/` directory created by Phase 2C's
 * `ensureSharedDomainExists`) has `readonly: true` in its CLAUDE.md
 * frontmatter. Direct writes via MCP are silently lost: they don't
 * propagate to other contributors (no push path from a mirror) and they
 * get overwritten on the next pull. The contribution model requires
 * writes to originate from the user's PERSONAL opted-in domain.
 *
 * This helper is the chokepoint enforcing that contract for all MCP
 * write tools. It loads `isDomainReadonly` lazily so the import doesn't
 * fire when the MCP server runs without any Shared Brain configured.
 *
 * Returns null when the write is allowed. Returns a structured error
 * object — same shape as resolveDomainArg's error — when the write must
 * be refused. Callers spread it into the tool response.
 *
 * @param {string} domain  Already-validated domain slug from resolveDomainArg.
 * @returns {Promise<null | { ok: false, error: string }>}
 */
export async function refuseIfReadonly(domain) {
  // Lazy import — avoids loading src/brain/files.js until the first MCP
  // write tool actually fires. Keeps the MCP startup path lean.
  const { isDomainReadonly } = await import('../src/brain/files.js');
  if (await isDomainReadonly(domain)) {
    return {
      ok: false,
      error:
        `Domain '${domain}' is a read-only Shared Brain mirror. ` +
        `Direct writes here would not propagate to other contributors ` +
        `and would be overwritten on the next pull. To contribute, ` +
        `call this tool on your personal opted-in domain (e.g. 'work-ai'), ` +
        // LOCATION, verified against the shipping frontend rather than from
        // memory: the rail item is VIEW_META.shared.label === 'Shared Brain'
        // (src/public/next/app.js) and the button is "Push contributions"
        // (src/public/next/views/shared.js). Push moved out of Sync at the
        // v3.9.0 cutover, and views/sync.js now says so in as many words:
        // "Shared Brain pushes are managed in Shared Brain. This tab only
        // reports them." This string is MODEL-READ, so a stale location does
        // not merely misinform a reader — it sends an agent, and through it
        // the user, to a screen that cannot do the thing. v3.17.2 fixed this
        // same phrase at eight sites in the skills; this copy survived.
        `then run "Push contributions" from the Shared Brain view.`,
    };
  }
  return null;
}
