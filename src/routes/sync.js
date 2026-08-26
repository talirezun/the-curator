import { Router } from 'express';
import {
  isConfigured, getStatus, getRemoteStatus, remoteErrorMessage, setup, push, pull, sync, disconnect, friendlyError,
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

/**
 * "How much is waiting on GitHub" — the two-machine question that
 * /status structurally cannot answer, because `git status --porcelain` only
 * ever sees this machine.
 *
 * SEPARATE FROM /status ON PURPOSE, and the separation is the design:
 * /status is local-only and instant, and the rail badge polls it on a 60s
 * timer plus every view change. This route runs a real `git fetch` against
 * GitHub, so folding it into /status would have put a network round-trip on
 * that hot path. Callers opt into the cost by choosing this URL.
 *
 * Never guarded by guardConcurrent — unlike its mutating siblings below, a
 * fetch writes only remote-tracking refs inside the git dir and cannot touch
 * a file under the domains folder, so it has nothing to race an in-flight
 * INGEST for. getRemoteStatus() explains the rest, including why a failure
 * comes back as behindFiles:null and never as a reassuring 0.
 *
 * CORRECTION — the paragraph above used to continue "so the worst a
 * collision can do is degrade this badge to unknown". That was measured and
 * it was false, in the direction that mattered: writing a remote-tracking
 * ref DOES race a concurrent pull, because pull() writes the same ref, and
 * the loser was the USER'S PULL — it aborted before merging in 11 of 12
 * runs against real git. guardConcurrent was never the right instrument
 * (it guards wiki writes, not git-internal ref writes) and is still not
 * added here; the fix is in brain/sync.js, where gitFetch() serialises
 * every fetch this process issues and pull() no longer treats its own
 * reporting fetch as fatal. Recorded rather than quietly reworded, because
 * a comment asserting a safety property the code does not have is what
 * stopped this being found earlier.
 */
router.get('/remote-status', async (req, res) => {
  try {
    res.json(await getRemoteStatus());
  } catch (err) {
    // getRemoteStatus() already converts a failed CHECK into a well-formed
    // "unknown" payload; reaching here means something outside that (e.g.
    // config unreadable). Answer in the same shape rather than a bare 500,
    // so a caller has exactly one contract to render.
    res.status(200).json({
      configured: true,
      remoteChecked: false,
      behindFiles: null,
      behindCommits: null,
      files: [],
      checkedAt: new Date().toISOString(),
      // Same rule as getRemoteStatus()'s own failure path, via the same
      // helper: map what is mappable, and never echo a raw git error on an
      // endpoint that is polled in the background — it embeds absolute paths
      // and, with a real remote, a credential-bearing URL. The sibling routes
      // below can afford `|| err.message` because their errors reach a user
      // who just clicked a button.
      remoteError: remoteErrorMessage(err),
    });
  }
});

// Guarded on the same grounds as its four siblings below: setup() runs
// `git add -A` + commit + push across the domains work-tree, so running it
// mid-ingest snapshots a half-written document — "half of a source's pages on
// one side of the commit, half on the other", exactly as guardConcurrent's
// docblock above describes. It was the only mutating route in this file
// without the middleware.
router.post('/setup', guardConcurrent('set up sync'), async (req, res) => {
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
