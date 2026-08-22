import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
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
      // Plain-English, actionable message — caught and turned into a JSON
      // 400 by the error-handling middleware below (never let this reach
      // Express's default HTML error page). Tagged curatorUserFacing so the
      // middleware relays it verbatim; only errors we ourselves construct
      // and vet get that treatment (see the middleware for why).
      const err = new Error(`Unsupported file type: ${ext} — The Curator can ingest .txt, .md and .pdf files.`);
      err.curatorUserFacing = true;
      cb(err);
    }
  },
});

router.post('/', upload.single('file'), async (req, res) => {
  // multer({dest: tmpdir()}) writes every upload to the OS temp dir at
  // req.file.path. ingestFile() only ever reads that path once, at the very
  // top of its own body, into a buffer that it then copies into raw/ — the
  // temp file is pure garbage the moment ingestFile has returned or thrown
  // (or, on any of the early-return validation paths below, the moment we
  // decide not to call ingestFile at all). Previously nothing ever unlinked
  // it, so every upload — including every rejected/duplicate one — leaked a
  // file into the OS temp dir forever.
  //
  // A single outer try/finally covers every exit path: the 400s, the 409
  // duplicate-file return, the readonly-domain refusal, the write-registry/
  // file-lock 409, the success path, and the error path. Cleanup is
  // best-effort only — a failed unlink must never fail the request.
  try {
    const { domain, overwrite } = req.body;

    // ── Validation (plain JSON responses before switching to SSE) ────────────
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

    // ── Duplicate check ──────────────────────────────────────────────────────
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

    // ── Switch to Server-Sent Events streaming ───────────────────────────────
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
  } finally {
    if (req.file && req.file.path) {
      try { await unlink(req.file.path); } catch { /* best-effort — temp dir cleanup only */ }
    }
  }
});

// ── Error-handling middleware ────────────────────────────────────────────────
// multer's own middleware (upload.single('file')) can reject a request BEFORE
// our route handler above ever runs — a fileFilter rejection (wrong
// extension) or a MulterError (e.g. LIMIT_FILE_SIZE, the 50MB cap) both call
// Express's next(err), which skips straight past the route handler to the
// nearest error-handling middleware. Without one registered, Express's
// DEFAULT handler renders an HTML page containing the raw error message and
// a full stack trace with absolute filesystem paths.
//
// That HTML then breaks the frontend outright: src/public/app.js's ingest
// flow does `const data = await res.json()` on the (non-streaming, since
// res.flushHeaders() is only called after validation passes — see above)
// response and throws on the malformed JSON, so the user sees a cryptic
// "Unexpected token '<'" instead of "unsupported file type" or "too large" —
// the same failure class already fixed once in v2.3.3 for a different route.
//
// Must be declared with all FOUR params (err, req, res, next) — that arity is
// how Express recognises an error-handling middleware — and registered AFTER
// the route so it only catches errors from this router's own stack.
router.use((err, req, res, next) => {
  // Full detail server-side only; the client only ever gets a friendly,
  // whitelisted message below — no stack trace, no absolute paths.
  console.error('Ingest upload error:', err);

  // v3.0.1-beta.8-style guardrail (see the ingest route above): if headers
  // were already flushed for an SSE response, we're mid-stream and MUST NOT
  // write a JSON body — that would corrupt the stream. In the current code
  // path multer errors always fire before flushHeaders() is called (upload
  // runs before any SSE setup), so this branch is defense-in-depth rather
  // than a path that's expected to trigger today.
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Upload failed unexpectedly.' })}\n\n`);
      res.end();
    }
    return;
  }

  const isMulterError = err instanceof multer.MulterError;

  // 413 Payload Too Large is the semantically correct status for the file
  // exceeding the 50MB cap; every other rejection here (unsupported
  // extension, or any other MulterError code) is a plain 400 — the request
  // itself was invalid, not a server fault.
  if (isMulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'That file is too large (max 50 MB). Split it into smaller documents and ingest each one.',
    });
  }

  if (isMulterError) {
    // Any other multer-level rejection (unexpected field, too many files,
    // etc.) comes from multer's own fixed errorMessages table — hardcoded
    // strings, never a filesystem path — so relaying err.message is safe.
    // Still the client's request shape being wrong, not a 500.
    return res.status(400).json({ error: 'Upload rejected: ' + err.message });
  }

  // Not a MulterError. WHITELIST, don't relay: only an error WE constructed
  // and explicitly marked curatorUserFacing (currently just fileFilter's
  // "unsupported file type" above) is safe to show verbatim. Anything else
  // reaching here — most concretely multer's DiskStorage._handleFile
  // propagating a raw Node fs error on a full disk or unwritable temp dir,
  // e.g. `ENOSPC: no space left on device, open '/var/folders/.../T/3f2a1c'`
  // — is NOT a MulterError and would otherwise leak an absolute filesystem
  // path straight to the client. Only relay what we've vetted; everything
  // else gets one generic, still-actionable message (full detail is already
  // console.error'd above for debugging).
  if (err.curatorUserFacing === true) {
    return res.status(400).json({ error: err.message });
  }

  res.status(400).json({
    error: 'Upload failed — the file could not be saved. Check available disk space and try again.',
  });
});

export default router;
