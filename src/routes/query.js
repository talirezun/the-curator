import { Router } from 'express';
import { queryDomain } from '../brain/query.js';
import { listDomains } from '../brain/files.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { domain, question } = req.body;

    if (!domain) return res.status(400).json({ error: 'domain is required' });
    if (!question) return res.status(400).json({ error: 'question is required' });

    const domains = await listDomains();
    if (!domains.includes(domain)) {
      return res.status(400).json({ error: `Unknown domain: ${domain}` });
    }

    const result = await queryDomain(domain, question);
    res.json(result);
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
