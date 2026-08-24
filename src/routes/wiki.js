import { Router } from 'express';
import { execFile } from 'child_process';
import { readWikiPages, listDomains, isDomainReadonly } from '../brain/files.js';
import { getWikiPage } from '../brain/wiki-read.js';
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
