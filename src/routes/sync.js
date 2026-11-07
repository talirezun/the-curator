import { Router } from 'express';
import {
  isConfigured, getStatus, getBackupReport, getRemoteStatus, remoteErrorMessage, setup, preflightSetup, syncRefusalOf,
  SETUP_MODES, push, pull, sync, disconnect, friendlyError,
} from '../brain/sync.js';
import { noteRemoteStatus } from '../brain/tray-summary.js';
import { hasActiveWrites, conflictResponse } from '../brain/write-registry.js';
// v3.76.0: a pull can bring domains this Mac has never seen — record their
// identity colour (src/brain/domain-identity.js). Never throws.
import { recordDomainIdentities } from '../brain/domain-identity.js';
// v3.89.2: one sync at a time, and a record of it that outlives the request
// that started it — see src/brain/sync-job.js for the measured report.
import { runSyncJob, getSyncJob, SyncBusyError } from '../brain/sync-job.js';

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

// A second start while a sync is running is REFUSED, never run beside the
// first (two concurrent syncs race each other's refs, and the loser used to
// tell the user it "stopped early" — read as "cancelled").
function busyResponse(res, err) {
  return res.status(409).json({ error: err.message, code: err.code, running: err.running });
}
const JOB_OPTS = { describeError: (err) => friendlyError(err) || err.message };

// The running job and the last finished one. Read by the Sync view when it
// mounts and while it waits on a run it did not start (a reload, another
// view's Sync button). Local and instant: no repository call.
router.get('/job', (req, res) => {
  res.json(getSyncJob());
});

router.get('/status', async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// What is and is not in the backup: read by the Sync page. Local (no fetch) and
// writes nothing, so it needs no guard, but it walks the folder, which is why it
// is its own route and not part of /status, which the rail badge polls.
router.get('/backup-report', async (req, res) => {
  try {
    res.json(await getBackupReport());
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) || err.message });
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
    const payload = await getRemoteStatus();
    // Feed the menubar widget's observation cache from the check the sync
    // badge is ALREADY making. brain/sync.js exposes no non-fetching
    // accessor — getRemoteStatus() is "cache hit ? return : git fetch", and
    // maxAgeMs: 0 does not help because remoteCacheTtl returns 0 for a
    // successful payload, so the freshness test fails and it fetches. So the
    // tray does not read that cache; it renders whatever a completed check
    // last reported. This line is what keeps that observation warm, and it
    // adds NO fetch of its own — a second fetch site is the recorded
    // incident where the user's own pull aborted 11 times out of 12.
    noteRemoteStatus(payload);
    res.json(payload);
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

/**
 * NON-DESTRUCTIVE preview of what connecting would do — the count that has
 * to reach the user BEFORE they click Connect.
 *
 * A POST, not a GET, and that is not a style choice: it carries a GitHub PAT
 * in the body. A GET would put the token in a URL, where it lands in the
 * server's own request handling, in browser history, and in anything that
 * logs a path. It is also POST so the cross-origin guard in server.js
 * applies — the guard covers mutating METHODS, and while this route mutates
 * nothing, a page in another tab must not be able to drive an authenticated
 * GitHub fetch on the user's token.
 *
 * Guarded on the same grounds as /setup: it reads the whole domains work-tree
 * to produce its number, so an ingest landing mid-assessment would make that
 * number describe a folder that no longer exists. A 409 the user can retry is
 * better than a wrong count on the screen that decides whether files are
 * overwritten.
 */
router.post('/preflight', guardConcurrent('check sync'), async (req, res) => {
  try {
    const { repoUrl, token } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });
    if (!token)   return res.status(400).json({ error: 'token is required' });
    res.json(await preflightSetup(repoUrl, token));
  } catch (err) {
    res.status(500).json({ ok: false, error: friendlyError(err) || err.message });
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
    const { repoUrl, token, mode, confirmOverwrite, leaveOut } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });
    if (!token)   return res.status(400).json({ error: 'token is required' });
    if (!SETUP_MODES.includes(mode))
      return res.status(400).json({ error: `mode must be one of ${SETUP_MODES.join(', ')}` });

    // `confirmOverwrite` is the ONLY way to reach setup()'s destructive
    // branch, and it is compared with === true rather than coerced. A
    // truthy-string check would let `"false"` through, which is exactly the
    // shape v3.30.0 refused for `safeToQuit`. A client that does not send
    // the field — curl, an older frontend, the pre-redesign shell that used
    // to be reachable at /old before it was deleted in v3.41.0 (/old now
    // just redirects to /) — therefore CANNOT overwrite anything; it gets
    // the refusal instead. That was always the point: a frozen connect form
    // that cannot be taught a new dialog means the safety has to live on
    // this side of the wire, and that still holds for any client today.
    const result = await runSyncJob('setup', async () => {
      const r = await setup(repoUrl, token, mode, { confirmOverwrite: confirmOverwrite === true, leaveOut });
      await recordDomainIdentities();
      return r;
    }, JOB_OPTS);
    // `success` is about the backup, not the connection: a folder that was left
    // out because it has its own git history was NOT backed up. Connected, and
    // said so, but never a plain success.
    res.json({ success: !result.partial, ...result, ...(await getStatus()) });
  } catch (err) {
    if (err instanceof SyncBusyError) return busyResponse(res, err);
    // A REFUSAL IS NOT A CRASH. setup()'s guards raise a written sentence
    // plus a machine-readable code and the numbers behind it; answering 409
    // with all three lets the UI render a decision panel instead of a red
    // error box, which is the difference between "you cannot do that" and
    // "here is what to do instead". 500 stays for everything unrecognised.
    const refusal = syncRefusalOf(err);
    if (refusal) return res.status(409).json({ error: refusal.message, ...refusal });
    res.status(500).json({ error: friendlyError(err) || err.message });
  }
});

router.post('/push', guardConcurrent('push to sync'), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'Sync is not configured' });
    res.json(await runSyncJob('push', () => push(), JOB_OPTS));
  } catch (err) {
    if (err instanceof SyncBusyError) return busyResponse(res, err);
    res.status(500).json({ error: friendlyError(err) || err.message });
  }
});

router.post('/pull', guardConcurrent('pull from sync'), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'Sync is not configured' });
    const pulled = await runSyncJob('pull', async () => {
      const r = await pull();
      await recordDomainIdentities();
      return r;
    }, JOB_OPTS);
    res.json(pulled);
  } catch (err) {
    if (err instanceof SyncBusyError) return busyResponse(res, err);
    res.status(500).json({ error: friendlyError(err) || err.message });
  }
});

router.post('/sync', guardConcurrent('sync'), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'Sync is not configured' });
    const synced = await runSyncJob('sync', async () => {
      const r = await sync();
      await recordDomainIdentities();
      return r;
    }, JOB_OPTS);
    res.json(synced);
  } catch (err) {
    if (err instanceof SyncBusyError) return busyResponse(res, err);
    res.status(500).json({ error: friendlyError(err) || err.message });
  }
});

router.delete('/disconnect', guardConcurrent('disconnect sync'), async (req, res) => {
  try {
    await runSyncJob('disconnect', () => disconnect(), JOB_OPTS);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof SyncBusyError) return busyResponse(res, err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
