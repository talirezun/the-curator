import { Router } from 'express';
import {
  isConfigured, getStatus, setup, push, pull, sync, disconnect, friendlyError,
} from '../brain/sync.js';
import { hasActiveWrites, conflictResponse } from '../brain/write-registry.js';

const router = Router();

/**
 * v3.0.1-beta.8: refuse sync operations while any wiki write is in flight.
 * Sync runs git operations on the wiki repo — `git pull --no-rebase -X theirs`
 * can race writes in progress, and `git add -A` would snapshot a half-written
 * batch. Even with the atomic-write fix making torn files impossible, sync
 * pulling DURING an ingest produces nonsensical commit boundaries (half of a
 * source's pages on one side of the commit, half on the other).
 */
function guardConcurrent(action) {
  return (req, res, next) => {
    if (hasActiveWrites()) {
      const { status, body } = conflictResponse(action);
      return res.status(status).json(body);
    }
    next();
  };
}

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

router.post('/push', guardConcurrent('push to sync'), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'Sync is not configured' });
    res.json(await push());
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) || err.message });
  }
});

router.post('/pull', guardConcurrent('pull from sync'), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'Sync is not configured' });
    res.json(await pull());
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) || err.message });
  }
});

router.post('/sync', guardConcurrent('sync'), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'Sync is not configured' });
    res.json(await sync());
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) || err.message });
  }
});

router.delete('/disconnect', guardConcurrent('disconnect sync'), async (req, res) => {
  try {
    await disconnect();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
