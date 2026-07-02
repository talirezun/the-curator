import { Router } from 'express';
import { listDomains, createDomain, deleteDomain, renameDomain, getDomainStats, generateUniqueSlug, isDomainReadonly } from '../brain/files.js';
import { isConfigured } from '../brain/sync.js';
import { isDomainActive, conflictResponse } from '../brain/write-registry.js';

const router = Router();

// GET /api/domains — list all domains
router.get('/', async (req, res) => {
  try {
    const domains = await listDomains();
    // v3.0.2: also report which domains are read-only Shared Brain
    // mirrors so the UI can exclude them from write-target dropdowns
    // (ingest). Additive field — older clients ignore it.
    const readonlyDomains = [];
    for (const d of domains) {
      if (await isDomainReadonly(d)) readonlyDomains.push(d);
    }
    res.json({ domains, readonlyDomains });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/domains/:domain/stats — domain stats (MUST be before /:domain handlers)
router.get('/:domain/stats', async (req, res) => {
  try {
    const stats = await getDomainStats(req.params.domain);
    res.json(stats);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/domains — create a new domain
router.post('/', async (req, res) => {
  try {
    const { displayName, description = '', template = 'generic' } = req.body;
    if (!displayName?.trim()) {
      return res.status(400).json({ error: 'displayName is required' });
    }
    const validTemplates = ['tech', 'business', 'personal', 'generic'];
    if (!validTemplates.includes(template)) {
      return res.status(400).json({ error: 'Invalid template' });
    }

    const slug = await generateUniqueSlug(displayName.trim());
    await createDomain(slug, displayName.trim(), description.trim(), template);
    res.status(201).json({ slug, displayName: displayName.trim() });
  } catch (err) {
    const status = err.message.includes('already exists') || err.message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// PUT /api/domains/:domain — rename a domain
router.put('/:domain', async (req, res) => {
  try {
    const oldSlug = req.params.domain;
    const { displayName } = req.body;
    if (!displayName?.trim()) {
      return res.status(400).json({ error: 'displayName is required' });
    }

    const newSlug = await generateUniqueSlug(displayName.trim(), oldSlug);

    if (newSlug === oldSlug) {
      // Only display name changed, not slug — just update the display name in files
      await renameDomain(oldSlug, oldSlug, displayName.trim());
      return res.json({ oldSlug, newSlug: oldSlug, displayName: displayName.trim(), syncWarning: false });
    }

    await renameDomain(oldSlug, newSlug, displayName.trim());
    res.json({ oldSlug, newSlug, displayName: displayName.trim(), syncWarning: isConfigured() });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('already exists') || err.message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// DELETE /api/domains/:domain — delete a domain
router.delete('/:domain', async (req, res) => {
  // v3.0.1-beta.8: refuse to delete a domain that has an active write
  // operation. The `rm -rf` of the domain folder would race the ingest's
  // writePage calls and produce undefined behaviour.
  if (isDomainActive(req.params.domain)) {
    const { status, body } = conflictResponse(`delete domain "${req.params.domain}"`);
    return res.status(status).json(body);
  }
  try {
    await deleteDomain(req.params.domain);
    res.json({ deleted: true, syncWarning: isConfigured() });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
