/**
 * src/routes/health.js
 *
 * Wiki Health API — exposed in the UI as the "Health" tab.
 *
 *   GET  /api/health                    — server ping (ok, version)
 *   GET  /api/health/:domain            — scan wiki, return issue report
 *   POST /api/health/:domain/fix        — apply one fix     body: { type, issue }
 *   POST /api/health/:domain/fix-all    — apply all of type body: { type }
 */
import { Router } from 'express';
import { readFileSync } from 'fs';
import { listDomains } from '../brain/files.js';
import { scanWiki, fixIssue, AUTO_FIXABLE } from '../brain/health.js';

const router = Router();

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url))
);

// Server ping — unchanged behavior
router.get('/', (_req, res) => res.json({ ok: true, version }));

async function assertDomain(domain) {
  const domains = await listDomains();
  if (!domains.includes(domain)) {
    const err = new Error(`Unknown domain: ${domain}`);
    err.status = 404;
    throw err;
  }
}

router.get('/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    const report = await scanWiki(domain);
    res.json(report);
  } catch (err) {
    console.error('[health scan]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:domain/fix', async (req, res) => {
  try {
    const { domain } = req.params;
    const { type, issue } = req.body || {};
    if (!type)                 return res.status(400).json({ error: 'Missing type' });
    if (!AUTO_FIXABLE.has(type)) return res.status(400).json({ error: `Type "${type}" is review-only.` });
    await assertDomain(domain);
    const result = await fixIssue(domain, type, issue || null);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[health fix]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:domain/fix-all', async (req, res) => {
  try {
    const { domain } = req.params;
    const { type } = req.body || {};
    if (!type)                 return res.status(400).json({ error: 'Missing type' });
    if (!AUTO_FIXABLE.has(type)) return res.status(400).json({ error: `Type "${type}" is review-only.` });
    await assertDomain(domain);
    const result = await fixIssue(domain, type, null);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[health fix-all]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
