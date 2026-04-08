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
  try {
    const { domain, overwrite } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain is required' });

    const domains = await listDomains();
    if (!domains.includes(domain)) {
      return res.status(400).json({ error: `Unknown domain: ${domain}` });
    }

    if (!req.file) return res.status(400).json({ error: 'file is required' });

    // ── Duplicate check ───────────────────────────────────────────────────
    const existingPath = path.join(rawPath(domain), req.file.originalname);
    if (existsSync(existingPath) && overwrite !== 'true') {
      return res.status(409).json({
        duplicate: true,
        filename: req.file.originalname,
        message: `"${req.file.originalname}" has already been ingested into this domain.`,
      });
    }

    const result = await ingestFile(
      domain,
      req.file.path,
      req.file.originalname,
      overwrite === 'true'
    );

    res.json({
      success: true,
      title: result.title,
      pagesWritten: result.pagesWritten,
      wasOverwrite: overwrite === 'true',
    });
  } catch (err) {
    console.error('Ingest error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
