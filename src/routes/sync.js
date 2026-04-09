import { Router } from 'express';
import {
  isConfigured, getStatus, setup, push, pull, disconnect, friendlyError,
} from '../brain/sync.js';

const router = Router();

router.get('/status', async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/setup', async (req, res) => {
  try {
    const { repoUrl, token, mode } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });
    if (!token)   return res.status(400).json({ error: 'token is required' });
    if (!['push', 'pull'].includes(mode))
      return res.status(400).json({ error: 'mode must be "push" or "pull"' });

    await setup(repoUrl, token, mode);
    res.json({ success: true, ...(await getStatus()) });
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) || err.message });
  }
});

router.post('/push', async (req, res) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'Sync is not configured' });
    res.json(await push());
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) || err.message });
  }
});

router.post('/pull', async (req, res) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'Sync is not configured' });
    res.json(await pull());
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) || err.message });
  }
});

router.delete('/disconnect', async (req, res) => {
  try {
    await disconnect();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
