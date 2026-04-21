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
import {
  suggestBrokenLinkTarget,
  suggestOrphanHomes,
  estimateSemanticDuplicateScan,
  scanSemanticDuplicates,
} from '../brain/health-ai.js';
import { previewSemanticDuplicateMerge } from '../brain/health.js';
import { getProviderInfo } from '../brain/llm.js';
import { getAiHealthSettings, setAiHealthSettings } from '../brain/config.js';

const router = Router();

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url))
);

// Server ping — unchanged behavior
router.get('/', (_req, res) => res.json({ ok: true, version }));

// AI-availability probe — lets the frontend decide whether to show the
// "✨ Ask AI" button. No network call; purely a local check for a configured
// API key. Returns { available, provider, model } when ready, otherwise
// { available: false, reason }.
router.get('/ai-available', (_req, res) => {
  try {
    const info = getProviderInfo();
    res.json({ available: true, provider: info.provider, model: info.model });
  } catch (err) {
    res.json({ available: false, reason: err.message });
  }
});

// AI Health settings (cost ceiling, candidate-pair cap). Defined BEFORE
// `/:domain` so `ai-settings` isn't matched as a domain name.
router.get('/ai-settings', (_req, res) => {
  try { res.json(getAiHealthSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/ai-settings', (req, res) => {
  try {
    const { costCeilingTokens, semanticDupeMaxPairs } = req.body || {};
    const updated = setAiHealthSettings({ costCeilingTokens, semanticDupeMaxPairs });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// AI-assisted suggestion for a single issue. READ-ONLY: proposes a target but
// does NOT apply it — the UI passes the result back through /fix when the user
// clicks Apply. Phase 1 (v2.4.3) supports broken links; Phase 2 (v2.4.4) adds
// orphan-rescue. Response shape differs per type:
//   brokenLinks → { ok, target, rationale, confidence }
//   orphans     → { ok, candidates: [{target, description, confidence, rationale}, ...] }
router.post('/:domain/ai-suggest', async (req, res) => {
  try {
    const { domain } = req.params;
    const { type, issue } = req.body || {};
    if (!type)  return res.status(400).json({ error: 'Missing type' });
    if (!issue) return res.status(400).json({ error: 'Missing issue' });
    if (type !== 'brokenLinks' && type !== 'orphans') {
      return res.status(400).json({ error: `AI suggest not yet available for type "${type}"` });
    }
    await assertDomain(domain);
    // Surface "no API key" as a 400 with a clean message, not a 500.
    try { getProviderInfo(); }
    catch (err) { return res.status(400).json({ error: err.message }); }

    let result;
    if (type === 'brokenLinks') result = await suggestBrokenLinkTarget(domain, issue);
    else                        result = await suggestOrphanHomes(domain, issue);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[health ai-suggest]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Phase 3 (v2.4.5) — semantic near-duplicate detection ──────────────────
// The scan is a separate, explicit user action (not part of the regular
// /api/health/:domain scan), runs through its own endpoints below, and is
// gated by cost preview + cost ceiling.

// Estimate the cost of a semantic-duplicate scan BEFORE any LLM call. The UI
// uses this to render the confirm dialog.
router.get('/:domain/semantic-dupes/estimate', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    try { getProviderInfo(); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    const settings = getAiHealthSettings();
    const estimate = await estimateSemanticDuplicateScan(domain, settings.semanticDupeMaxPairs);
    res.json({ ok: true, ...estimate, costCeilingTokens: settings.costCeilingTokens });
  } catch (err) {
    if (err.code === 'DOMAIN_TOO_LARGE') return res.status(400).json({ error: err.message, code: err.code });
    console.error('[semantic-dupes estimate]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Run the real semantic-duplicate scan over SSE. Events stream as
//   event: start | progress | pair | batch-error | done | error
// matching the shape documented in docs/api-reference.md.
router.post('/:domain/semantic-dupes/scan', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    try { getProviderInfo(); }
    catch (err) { return res.status(400).json({ error: err.message }); }
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const settings = getAiHealthSettings();
    await scanSemanticDuplicates(
      req.params.domain,
      {
        maxPairs: settings.semanticDupeMaxPairs,
        costCeilingTokens: settings.costCeilingTokens,
      },
      send,
    );
  } catch (err) {
    send({ type: 'error', error: err.message, code: err.code });
  } finally {
    res.end();
  }
});

// Preview a semantic-duplicate merge — shows exactly which files will be
// modified, the merged content that will land on the kept page, and the
// count of link rewrites. READ-ONLY.
router.post('/:domain/semantic-dupes/preview', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    const issue = req.body && req.body.issue;
    if (!issue) return res.status(400).json({ error: 'Missing issue' });
    const preview = await previewSemanticDuplicateMerge(domain, issue);
    res.json({ ok: true, ...preview });
  } catch (err) {
    console.error('[semantic-dupes preview]', err);
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
