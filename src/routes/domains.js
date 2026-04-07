import { Router } from 'express';
import { listDomains } from '../brain/files.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const domains = await listDomains();
    res.json({ domains });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
