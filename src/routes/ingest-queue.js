/**
 * Batch-ingest queue HTTP surface (Track 3). Mounted at /api/ingest-queue.
 *
 * See src/brain/ingest-queue.js for the correctness invariants this route
 * exists to expose safely: strict sequentiality, durable staging, 429-pauses-
 * not-fails, no auto-resumed spend. This file is transport only — every
 * decision of substance lives in the brain module.
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { tmpdir } from 'os';
import { unlink } from 'fs/promises';

import {
  isValidJobId,
  createJob,
  listJobs,
  getActiveJob,
  getJob,
  toWire,
  estimateIngestQueueCost,
  startOrResumeJob,
  requestPause,
  requestCancel,
  deleteJobEverything,
  subscribeToJob,
  scrubPaths,
} from '../brain/ingest-queue.js';
import { listDomains } from '../brain/files.js';

const router = Router();

const MAX_FILE_BYTES = 50 * 1024 * 1024;         // matches routes/ingest.js's single-file cap
const MAX_FILES_PER_BATCH = 100;
// multer enforces `fileSize` PER FILE only — there is no built-in cap on the
// total size of a multipart request, so 100 files x 50MB is a 2GB-plus,
// uncapped POST. Enforced explicitly in the route handler below, after
// multer has already accepted the individual files (413 + a plain message).
const MAX_TOTAL_BATCH_BYTES = 2 * 1024 * 1024 * 1024;

const upload = multer({
  dest: tmpdir(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES_PER_BATCH,
    // Same defense as routes/ingest.js's ingest multer instance — see the
    // long comment there (GHSA-72gw-mp4g-v24j / the v3.1.2 changelog entry).
    // multer 2.2.0 ships the field-nesting-depth CHECK but defaults the limit
    // to Infinity, so simply being on a patched multer version does nothing
    // by itself; the option must be set explicitly on EVERY multer instance.
    // v3.1.2's own changelog flags this exact gap: "a second upload route
    // does NOT inherit it" — this route is that second instance, and this
    // line is what closes it here too.
    fieldNestingDepth: 1,
  },
  fileFilter(req, file, cb) {
    const allowed = ['.txt', '.md', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    const err = new Error(`Unsupported file type: ${ext} — The Curator can ingest .txt, .md and .pdf files.`);
    err.curatorUserFacing = true;
    cb(err);
  },
});

/** Best-effort cleanup of multer's temp files on any early-return path. */
function cleanupTempFiles(files) {
  if (!Array.isArray(files)) return;
  for (const f of files) {
    if (f && f.path) unlink(f.path).catch(() => { /* best-effort */ });
  }
}

function requireJobId(req, res) {
  const jobId = req.params.jobId;
  if (!isValidJobId(jobId)) {
    res.status(400).json({ error: 'Invalid job id.' });
    return null;
  }
  return jobId;
}

/**
 * The single error chokepoint for this router.
 *
 * Two rules, both learned the hard way:
 *
 *   1. NEVER let a raw fs error reach the body verbatim. A create-time
 *      `ENAMETOOLONG` returned an HTTP 500 whose body carried BOTH the OS
 *      temp path and the staging path — on a real install, the user's home
 *      directory and their domains path. Every message now goes through
 *      `scrubPaths`, which keeps the basename and drops the location.
 *   2. An error with no `statusCode` is a bug in The Curator, not a
 *      description of the caller's request, so its raw text is not shown at
 *      all. Only errors this module deliberately raised (`statusErr`, which
 *      always sets `statusCode`) carry their own message through.
 */
function sendError(res, err, fallback) {
  const status = (err && err.statusCode) || 500;
  const message = (err && err.statusCode && err.message) ? err.message : fallback;
  const body = { error: scrubPaths(message) || fallback };
  if (err && err.activeJobId) body.activeJobId = err.activeJobId;
  res.status(status).json(body);
}

// ── POST /estimate — free, no file bytes, metadata only ─────────────────────

router.post('/estimate', async (req, res) => {
  try {
    const { domain, files } = req.body || {};
    if (!domain) return res.status(400).json({ error: 'domain is required' });
    const domains = await listDomains();
    if (!domains.includes(domain)) return res.status(400).json({ error: `Unknown domain: ${domain}` });
    if (!Array.isArray(files)) return res.status(400).json({ error: 'files must be an array of {name, size}' });

    const result = await estimateIngestQueueCost(domain, files);
    res.json(result);
  } catch (err) {
    console.error('[ingest-queue] estimate error:', err);
    sendError(res, err, 'Failed to estimate cost.');
  }
});

// ── POST / — create a batch job ──────────────────────────────────────────────

router.post('/', upload.array('files'), async (req, res) => {
  try {
    const { domain, overwrite, budgetUsd } = req.body || {};

    if (!domain) {
      cleanupTempFiles(req.files);
      return res.status(400).json({ error: 'domain is required' });
    }

    const totalBytes = (req.files || []).reduce((n, f) => n + (f.size || 0), 0);
    if (totalBytes > MAX_TOTAL_BATCH_BYTES) {
      cleanupTempFiles(req.files);
      return res.status(413).json({
        error: `This batch is ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB, over the ` +
               `${(MAX_TOTAL_BATCH_BYTES / 1024 / 1024 / 1024).toFixed(0)} GB per-batch limit. ` +
               `Split it into smaller batches and run them one after another.`,
      });
    }

    if (!req.files || req.files.length === 0) {
      cleanupTempFiles(req.files);
      return res.status(400).json({ error: 'No files provided.' });
    }

    const job = await createJob({
      domain,
      uploadedFiles: req.files,
      overwrite: overwrite === 'true' || overwrite === true,
      budgetUsd: budgetUsd !== undefined && budgetUsd !== null && budgetUsd !== '' ? Number(budgetUsd) : null,
    });
    res.json({ ok: true, jobId: job.jobId, job: toWire(job) });
  } catch (err) {
    cleanupTempFiles(req.files);
    console.error('[ingest-queue] create error:', err);
    sendError(res, err, 'Failed to create batch.');
  }
});

// ── GET / — list jobs (history), most recent first ──────────────────────────

router.get('/', async (req, res) => {
  try {
    const jobs = await listJobs();
    res.json({ ok: true, jobs: jobs.map(toWire) });
  } catch (err) {
    console.error('[ingest-queue] list error:', err);
    sendError(res, err, 'Failed to list batches.');
  }
});

// ── GET /active — cheap, safe to poll ────────────────────────────────────────

router.get('/active', async (req, res) => {
  try {
    const job = await getActiveJob();
    res.json({ ok: true, job: job ? toWire(job) : null });
  } catch (err) {
    console.error('[ingest-queue] active error:', err);
    sendError(res, err, 'Failed to read active batch.');
  }
});

// ── GET /:jobId ───────────────────────────────────────────────────────────────

router.get('/:jobId', async (req, res) => {
  const jobId = requireJobId(req, res);
  if (!jobId) return;
  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json({ ok: true, job: toWire(job) });
  } catch (err) {
    console.error('[ingest-queue] get error:', err);
    sendError(res, err, 'Failed to read batch.');
  }
});

// ── GET /:jobId/stream — SSE, supports multiple concurrent listeners ────────

router.get('/:jobId/stream', async (req, res) => {
  const jobId = requireJobId(req, res);
  if (!jobId) return;

  const job = await getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  // Full snapshot on connect — the client renders the server's snapshot, it
  // never derives state itself (see the module docblock's design rule).
  send({ type: 'job', job: toWire(job) });

  const unsubscribe = subscribeToJob(jobId, (event) => send(event));

  req.on('close', () => { unsubscribe(); });
});

// ── POST /:jobId/start — start or resume ─────────────────────────────────────

router.post('/:jobId/start', async (req, res) => {
  const jobId = requireJobId(req, res);
  if (!jobId) return;
  try {
    const job = await startOrResumeJob(jobId);
    res.json({ ok: true, job: toWire(job) });
  } catch (err) {
    console.error('[ingest-queue] start error:', err);
    sendError(res, err, 'Failed to start batch.');
  }
});

// ── POST /:jobId/pause ────────────────────────────────────────────────────────

router.post('/:jobId/pause', async (req, res) => {
  const jobId = requireJobId(req, res);
  if (!jobId) return;
  try {
    const job = await requestPause(jobId);
    res.json({ ok: true, job: toWire(job) });
  } catch (err) {
    console.error('[ingest-queue] pause error:', err);
    sendError(res, err, 'Failed to pause batch.');
  }
});

// ── POST /:jobId/cancel ───────────────────────────────────────────────────────

router.post('/:jobId/cancel', async (req, res) => {
  const jobId = requireJobId(req, res);
  if (!jobId) return;
  try {
    const job = await requestCancel(jobId);
    res.json({ ok: true, job: toWire(job) });
  } catch (err) {
    console.error('[ingest-queue] cancel error:', err);
    sendError(res, err, 'Failed to cancel batch.');
  }
});

// ── DELETE /:jobId ────────────────────────────────────────────────────────────

router.delete('/:jobId', async (req, res) => {
  const jobId = requireJobId(req, res);
  if (!jobId) return;
  try {
    await deleteJobEverything(jobId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ingest-queue] delete error:', err);
    sendError(res, err, 'Failed to delete batch.');
  }
});

// ── Error-handling middleware (4-arg — Express error-handler arity) ─────────
//
// Mirrors routes/ingest.js's own middleware exactly: a multer rejection
// (bad extension, over-size file, too many files, the nested-field DoS
// guard) must return JSON, never Express's default HTML error page — the
// frontend always does `await res.json()` on this router's responses.
router.use((err, req, res, next) => {
  console.error('[ingest-queue] upload error:', err);

  if (res.headersSent) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Upload failed unexpectedly.' })}\n\n`);
      res.end();
    }
    return;
  }

  const isMulterError = err instanceof multer.MulterError;

  if (isMulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'One of those files is too large (max 50 MB each). Split it into smaller documents and try again.',
    });
  }
  if (isMulterError && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({
      error: `Too many files in one batch (max ${MAX_FILES_PER_BATCH}). Split it into smaller batches.`,
    });
  }
  if (isMulterError) {
    return res.status(400).json({ error: 'Upload rejected: ' + err.message });
  }
  if (err.curatorUserFacing === true) {
    return res.status(400).json({ error: scrubPaths(err.message) });
  }

  // Named OS causes get an accurate message. The single catch-all below used
  // to blame disk space for everything that reached here, which sent a user
  // whose batch contained one unparseable FILENAME off to check their free
  // space — while the other 15 valid files in that batch were discarded.
  // (Files that reach `createJob` are now isolated per item and no longer
  // abort the batch; this path is for failures during the upload parse
  // itself, where the request never becomes a usable file list at all.)
  const code = err && err.code;
  if (code === 'ENOSPC') {
    return res.status(507).json({ error: 'Upload failed — the disk is full. Free up space and try again.' });
  }
  if (code === 'ENAMETOOLONG') {
    return res.status(400).json({ error: 'Upload failed — one of those filenames is too long for this system. Rename it and try again.' });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return res.status(500).json({ error: 'Upload failed — The Curator does not have permission to write its temporary files.' });
  }

  res.status(400).json({
    error: 'Upload failed — that upload could not be read. This is usually one unusual filename ' +
           '(non-printable characters, or an extremely long name); rename the file and try again.',
  });
});

export default router;
