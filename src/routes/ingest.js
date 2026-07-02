import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { ingestFile } from '../brain/ingest.js';
import { listDomains, rawPath, domainPath, isDomainReadonly } from '../brain/files.js';
import {
  registerWrite,
  acquireFileLock,
  isUpdateInProgress,
  conflictResponse,
} from '../brain/write-registry.js';

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

  // v3.0.2: Shared Brain mirror domains are read-only (Decision 7).
  // Before this check only the MCP write tools refused — the app's own UI
  // would happily ingest into a mirror, and the next Pull silently
  // obliterated the pages.
  if (await isDomainReadonly(domain)) {
    return res.status(400).json({
      error: `Domain "${domain}" is a read-only Shared Brain mirror — it is updated by ` +
             `"Pull updates" in the Sync tab, and direct writes would be overwritten on the next pull. ` +
             `Ingest into your personal opted-in domain instead, then push contributions from the Sync tab.`,
    });
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

  // v3.0.1-beta.8: refuse to start a new ingest while the app updater is
  // running. The update flow does `git reset --hard` + `npm install` + a
  // process restart — none of which co-operates well with an in-flight ingest.
  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse('start a new ingest');
    return res.status(status).json(body);
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

  // v3.0.1-beta.8: register this ingest so concurrent /api/update,
  // /api/restart, /api/sync/*, and DELETE /api/domains/:slug can refuse
  // with 409 instead of racing the in-flight wiki writes. Wraps the call
  // in try/finally so the registry is released on EVERY exit path
  // (success, error, client disconnect — although the await completes
  // regardless of client state in the current architecture).
  //
  // Also takes a file-based write lock under <domain>/.write-lock so the
  // MCP child process (separate from this web-server process, spawned by
  // Claude Desktop) sees the in-flight state. The MCP's write tools
  // (compile_to_wiki, fix_wiki_issue) check isFileLocked() before writing.
  const releaseRegistry = registerWrite(domain, 'ingest');
  const releaseFileLock = await acquireFileLock(domainPath(domain), { op: 'ingest' });
  if (!releaseFileLock) {
    releaseRegistry();
    emit({
      type: 'error',
      message: `Another process is already writing to "${domain}" (file lock held). ` +
               `If this seems stuck, manually delete <domains>/${domain}/.write-lock and retry.`,
    });
    return res.end();
  }

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
      changes: result.changes,    // structured per-file change records (v2.5.0+)
      warnings: result.warnings || [],  // non-fatal issues (v3.0.1-beta.1)
      truncated: !!result.truncated,    // source-text was longer than 80k chars
      wasOverwrite: overwrite === 'true',
    });
  } catch (err) {
    console.error('Ingest error:', err);
    emit({ type: 'error', message: err.message });
  } finally {
    try { await releaseFileLock(); } catch { /* best-effort */ }
    releaseRegistry();
    res.end();
  }
});

export default router;
