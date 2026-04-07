import { Router } from 'express';
import { readWikiPages, listDomains } from '../brain/files.js';

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

export default router;
