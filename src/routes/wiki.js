import { Router } from 'express';
import { execFile } from 'child_process';
import { readWikiPages, listDomains, isDomainReadonly } from '../brain/files.js';
import { getWikiPage, listWikiInventory } from '../brain/wiki-read.js';
import { listProjects, listWorkingScopes } from '../brain/working-state.js';
import { sourceForSummary, hashRawSource } from '../brain/raw-store.js';

const router = Router();

router.get('/:domain', async (req, res) => {
  try {
    const { domain } = req.params;

    const domains = await listDomains();
    if (!domains.includes(domain)) {
      return res.status(404).json({ error: `Unknown domain: ${domain}` });
    }

    const pages = await readWikiPages(domain);
    res.json({ domain, pages });
  } catch (err) {
    console.error('Wiki error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/wiki/:domain/list
 *
 * Cheap, readdir-only inventory of every page in the domain's wiki — the
 * data source for a wiki-BROWSE list view. The third sibling next to
 * `GET /:domain` above (full content of every page — 14 MB on `articles`,
 * wrong shape for "what pages exist") and `GET /:domain/page` (open exactly
 * one already-known page — wrong shape for "list what I could open").
 *
 * Built on `listWikiInventory` in wiki-read.js, which itself is built on
 * health.js's gated `listMd` rather than a fresh readdir — see that
 * function's docblock for why a second hand-rolled inventory would silently
 * disagree with what `/page` can actually open (the same class of bug fixed
 * app-wide in the v3.2.0 audit).
 *
 * Response: `{domain, entries: [{slug, folder, path, title}], count, total,
 * truncated}`. `title` is derived from the slug only (no content read —
 * see listWikiInventory's docblock for that trade-off, spelled out
 * explicitly there). Capped at 20,000 entries; `truncated` says whether more
 * exist, `total` is the real (uncapped) count. Reads are allowed on
 * read-only Shared Brain mirror domains, matching `/page` — this route never
 * writes.
 *
 * `?include=memory` (v3.50.0) adds `{memory: [...], memoryCount, memoryTotal,
 * memoryTruncated}` — the domain's MEMORY pages, which are markdown too: each
 * project's standing brief and each work-stream's `current.md`. They are a
 * SEPARATE array, never folded into `entries`, so `count`/`total` keep meaning
 * "wiki pages" exactly as before. See memoryInventory below for the wire shape
 * and why it is opt-in. A memory `path` is NOT openable through
 * `GET /:domain/page` — that route resolves inside `wiki/` by design and
 * `state/` is its sibling; memory content is read through
 * `GET /api/memory/:domain/:project`.
 */
// ─────────────────────────────────────────────────────────────────────────
// MEMORY PAGES — the second kind of markdown a domain holds (v3.50.0)
//
// A domain's `state/` tree is markdown too: each project's standing brief
// (`project.md`) and each work-stream's handoff (`current.md`). Every one of
// them is a document the owner may want to READ, and until now the only route
// to any of them was the Agent memory screen, which is organised around
// resuming work rather than around browsing. The wiki list is where a person
// looks for "what documents are in this domain", so the memory pages are
// listed there too — as their OWN facet, never mixed into the wiki counts.
//
// ── WHY THIS LIVES IN THE ROUTE AND NOT IN wiki-read.js ──────────────────
// It is composition of two store functions into a wire shape, which is what
// routes do (src/routes/memory.js does exactly this). Putting it in
// wiki-read.js would mean importing working-state.js there — and
// working-state.js ALREADY imports `resolveInsideWiki` from wiki-read.js
// (working-state.js line ~177), so that would close a second import cycle
// through a module that also sits in the health.js <-> wiki-read.js cycle.
// The existing cycle is safe for a documented, checked reason (both crossing
// symbols are hoisted function declarations, neither called at module-eval
// time); a THIRD participant is a property nobody would be re-checking, and
// the composition does not need to be there.
//
// ── NEVER A FILE BODY ────────────────────────────────────────────────────
// This enumerates paths, exactly as the wiki inventory does. The content of
// a brief or a handoff is fetched from GET /api/memory/:domain/:project,
// which is the route that already owns reading, capping and sanitising it.
//
// ── THE WIRE SHAPE IS AN ALLOW-LIST ──────────────────────────────────────
// The store's rows carry journal-derived facts (headlines an agent wrote,
// harness names, model ids). None of that belongs in a page listing, and a
// spread would have shipped all of it. Nine named fields, and nothing else.
// ─────────────────────────────────────────────────────────────────────────

const MAX_MEMORY_ENTRIES = 2000;

function briefPathFor(isDefault, project) {
  return isDefault ? 'state/project.md' : `state/${project}/project.md`;
}
function handoffPathFor(isDefault, project, scope, machine) {
  const prefix = isDefault ? 'state/' : `state/${project}/`;
  return `${prefix}${scope}/${machine}/current.md`;
}

async function memoryInventory(domain) {
  const listed = await listProjects(domain);
  if (!listed || listed.ok !== true) {
    // A domain with no state tree at all is not an error — it is a domain
    // with no memory pages. The refusal reasons (an invalid domain name) are
    // already impossible here: the caller checked listDomains() first.
    return { entries: [], count: 0, total: 0, truncated: false };
  }

  const rows = Array.isArray(listed.projects) ? listed.projects : [];
  const entries = [];

  for (const row of rows) {
    const project = String(row.project == null ? '' : row.project);
    if (!project) continue;
    const isDefault = row.isDefaultProject === true;

    if (row.hasBrief === true) {
      entries.push({
        kind: 'brief',
        project,
        isDefaultProject: isDefault,
        scope: null,
        machine: null,
        path: briefPathFor(isDefault, project),
        title: `${project} · Standing brief`,
        savedAt: typeof row.briefUpdatedAt === 'string' ? row.briefUpdatedAt : null,
        bytes: typeof row.briefBytes === 'number' ? row.briefBytes : null,
      });
    }

    // ONE ROW PER (scope, machine). That pair IS the identity of a handoff —
    // the `<machine>` segment is load-bearing in the store (see the memory
    // invariants in CLAUDE.md), and collapsing two machines' handoffs under
    // one scope row would hide a file that exists on disk.
    const scoped = await listWorkingScopes(domain, isDefault ? {} : { project });
    const pairs = (scoped && scoped.ok === true && Array.isArray(scoped.scopes)) ? scoped.scopes : [];
    for (const pair of pairs) {
      const scope = String(pair.scope == null ? '' : pair.scope);
      const machine = String(pair.machine == null ? '' : pair.machine);
      if (!scope || !machine) continue;
      entries.push({
        kind: 'handoff',
        project,
        isDefaultProject: isDefault,
        scope,
        machine,
        path: handoffPathFor(isDefault, project, scope, machine),
        title: `${project} · ${scope} · ${machine}`,
        // The FILE's clock (`lastWriteAt`) and the AGENT's own clock
        // (`writtenAt`) are two different facts and the store keeps them
        // apart; the agent's is preferred where it exists, because git
        // rewrites mtime on checkout and a synced handoff would otherwise
        // date to the pull. A fact and its absence stay distinguishable:
        // null means "no usable clock", never "now".
        savedAt: (typeof pair.writtenAt === 'string' && pair.writtenAt)
          ? pair.writtenAt
          : (typeof pair.lastWriteAt === 'string' ? pair.lastWriteAt : null),
        bytes: typeof pair.bytes === 'number' ? pair.bytes : null,
      });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  const total = entries.length;
  const truncated = total > MAX_MEMORY_ENTRIES;
  return {
    entries: truncated ? entries.slice(0, MAX_MEMORY_ENTRIES) : entries,
    count: Math.min(total, MAX_MEMORY_ENTRIES),
    total,
    truncated,
  };
}

router.get('/:domain/list', async (req, res) => {
  try {
    const { domain } = req.params;

    const domains = await listDomains();
    if (!domains.includes(domain)) {
      return res.status(404).json({ error: `Unknown domain: ${domain}` });
    }

    const result = await listWikiInventory(domain);

    // OPT-IN, and the reason is cost. The wiki half is one readdir per
    // canonical folder; the memory half walks the project list and reads one
    // journal tail per (scope, machine) pair, which is bounded but is NOT
    // free. Every existing caller's response is byte-identical without the
    // flag, so nothing that does not want memory pays for them.
    const include = String(req.query.include == null ? '' : req.query.include)
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (include.includes('memory')) {
      const mem = await memoryInventory(domain);
      result.memory = mem.entries;
      result.memoryCount = mem.count;
      result.memoryTotal = mem.total;
      result.memoryTruncated = mem.truncated;
    }

    res.json(result);
  } catch (err) {
    console.error('Wiki list error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /api/wiki/:domain/page?path=entities/tali-rezun.md
 *
 * Returns exactly one page — frontmatter, title, raw body — plus every page
 * in the domain that links to it (backlinks). Built for the citation-chip
 * reader panel, which needs to open a single page without loading the whole
 * domain (GET /:domain above returns full content for every page — 14 MB on
 * the real `articles` domain, unusable for "open one page").
 *
 * `path` matches the exact string the app already hands out elsewhere (chat
 * citations, readWikiPages()'s `path` field): "folder/slug.md", no leading
 * slash. Reads are allowed on read-only Shared Brain mirror domains — only
 * writes are refused elsewhere in the app; this route never writes.
 */
router.get('/:domain/page', async (req, res) => {
  try {
    const { domain } = req.params;
    const { path: pagePath } = req.query;

    const domains = await listDomains();
    if (!domains.includes(domain)) {
      return res.status(404).json({ error: `Unknown domain: ${domain}` });
    }

    const page = await getWikiPage(domain, pagePath);
    const readonly = await isDomainReadonly(domain);
    res.json({ ...page, readonly });
  } catch (err) {
    console.error('Wiki page error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /api/wiki/:domain/source?path=summaries/foo.md
 *
 * "Which original document was this summary built from, and is it still on
 * this machine?" — Track 7 Part II.
 *
 * The `source:` frontmatter value is UNTRUSTED (LLM-authored, hand-editable,
 * arrives over sync). Every resolution goes through `resolveRawSource`, the
 * single chokepoint in raw-store.js — see its docblock for the ENFORCED /
 * NOT ENFORCED lists.
 *
 * `found: false` is a normal 200 response, not an error: an entity page has
 * no single source, a conversation-compiled summary has no source file, and
 * a raw file legitimately lives only on the machine that ingested it (raw/
 * is gitignored and does not sync). The reader panel asks this for whatever
 * page is open, so a 404 for "this is an entity" would be noise.
 *
 * `sha256` is opt-in (`?hash=1`) because hashing streams the whole file —
 * cheap on a 200 KB markdown file, seconds on the 126 MB PDF in the
 * maintainer's real articles domain. Never compute it on every reader open.
 *
 * NEVER returns an absolute path: the client has no use for one, and it
 * leaks the user's directory layout into a response that a future feature
 * might log or share.
 */
router.get('/:domain/source', async (req, res) => {
  try {
    const { domain } = req.params;
    const { path: pagePath, hash } = req.query;

    const domains = await listDomains();
    if (!domains.includes(domain)) {
      return res.status(404).json({ error: `Unknown domain: ${domain}` });
    }

    const result = await sourceForSummary(domain, pagePath);

    if (!result.found) {
      const { absPath, ...safe } = result;   // defensive: never leak a path
      return res.json({ ok: true, ...safe });
    }

    let sha256 = null;
    if (hash === '1' || hash === 'true') {
      sha256 = await hashRawSource(result.absPath);
    }

    return res.json({
      ok: true,
      found: true,
      page: result.page,
      filename: result.filename,
      bytes: result.bytes,
      mtime: result.mtime,
      sha256,
    });
  } catch (err) {
    console.error('Wiki source error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST /api/wiki/:domain/source/reveal   body: { path: "summaries/foo.md" }
 *
 * Reveal the original document in Finder.
 *
 * POST — not GET — so the server's existing cross-origin guard applies. This
 * endpoint causes a side effect on the user's desktop; a malicious page must
 * not be able to trigger it with a bare <img src>.
 *
 * THE SHARP EDGE: this hands a path to the OS. Three properties make that
 * safe, and all three must survive any future edit:
 *
 *   1. The client supplies a WIKI PAGE PATH, never a filesystem path. The
 *      absolute path is derived server-side, and only from
 *      resolveRawSource's output.
 *   2. `execFile` (not `exec`) — no shell, so the path is never word-split
 *      or interpreted, however exotic the filename. Real filenames in this
 *      repo contain spaces and parentheses.
 *   3. If containment fails, we REFUSE. Deliberately no "best effort" open
 *      of the parent directory (the fallback that routes/mcp.js's
 *      reveal-config uses for a config file it builds itself). Here the
 *      failure means the recorded source was hostile or escaping, and the
 *      correct answer to that is nothing at all.
 */
router.post('/:domain/source/reveal', async (req, res) => {
  try {
    const { domain } = req.params;
    const pagePath = req.body?.path;

    const domains = await listDomains();
    if (!domains.includes(domain)) {
      return res.status(404).json({ error: `Unknown domain: ${domain}` });
    }

    if (process.platform !== 'darwin') {
      return res.status(501).json({
        ok: false,
        error: 'Revealing a file in the file manager is only supported on macOS. ' +
               'Open your domain\'s raw/ folder manually to find the original.',
      });
    }

    const result = await sourceForSummary(domain, pagePath);
    if (!result.found) {
      return res.status(404).json({ ok: false, reason: result.reason, error: result.message });
    }

    // `result.absPath` came from resolveRawSource — lexically AND physically
    // contained in raw/, and lstat-confirmed a regular file.
    execFile('open', ['-R', result.absPath], (err) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, filename: result.filename });
    });
  } catch (err) {
    console.error('Wiki source reveal error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
