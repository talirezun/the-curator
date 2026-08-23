import { Router } from 'express';
import { readWikiPages, listDomains, isDomainReadonly } from '../brain/files.js';
import { getWikiPage } from '../brain/wiki-read.js';

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

export default router;
