import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { ingestFile } from '../brain/ingest.js';
import { listDomains, rawPath } from '../brain/files.js';

const router = Router();

const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter(req, file, cb) {
    const allowed = ['.txt', '.md', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Allowed: ${allowed.join(', ')}`));
    }
  },
});

router.post('/', upload.single('file'), async (req, res) => {
  const { domain, overwrite } = req.body;

  // ── Validation (plain JSON responses before switching to SSE) ──────────────
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const domains = await listDomains();
  if (!domains.includes(domain)) {
    return res.status(400).json({ error: `Unknown domain: ${domain}` });
  }

  if (!req.file) return res.status(400).json({ error: 'file is required' });

  // ── Duplicate check ────────────────────────────────────────────────────────
  const existingPath = path.join(rawPath(domain), req.file.originalname);
  if (existsSync(existingPath) && overwrite !== 'true') {
    return res.status(409).json({
      duplicate: true,
      filename: req.file.originalname,
      message: `"${req.file.originalname}" has already been ingested into this domain.`,
    });
  }

  // ── Switch to Server-Sent Events streaming ─────────────────────────────────
  // All validation passed — from here on we stream progress events to the client.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // Send headers immediately so the client opens the stream

  const emit = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await ingestFile(
      domain,
      req.file.path,
      req.file.originalname,
      overwrite === 'true',
      emit  // onProgress callback → emits {type, pct, message} events
    );

    emit({
      type: 'done',
      title: result.title,
      pagesWritten: result.pagesWritten,
      wasOverwrite: overwrite === 'true',
    });
  } catch (err) {
    console.error('Ingest error:', err);
    emit({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

export default router;
