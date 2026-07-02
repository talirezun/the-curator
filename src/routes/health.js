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
import { listDomains, isDomainReadonly } from '../brain/files.js';
import { scanWiki, fixIssue, AUTO_FIXABLE } from '../brain/health.js';
import {
  suggestBrokenLinkTarget,
  suggestOrphanHomes,
  estimateSemanticDuplicateScan,
  scanSemanticDuplicates,
  estimateBrokenLinkFix,
  planBrokenLinkFixes,
  estimateOrphanRescue,
  planOrphanRescue,
} from '../brain/health-ai.js';
import { previewSemanticDuplicateMerge, fixSemanticDuplicatesBatch, applyBrokenLinkFixes, applyOrphanRescue, fixAllSafe } from '../brain/health.js';
import { getProviderInfo } from '../brain/llm.js';
import { getAiHealthSettings, setAiHealthSettings } from '../brain/config.js';
import { addDismissal, removeDismissal, listDismissed } from '../brain/health-dismissed.js';
import { domainPath } from '../brain/files.js';
import {
  registerWrite,
  acquireFileLock,
  isUpdateInProgress,
  conflictResponse,
} from '../brain/write-registry.js';

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

// v3.0.2: mutating Health endpoints refuse read-only Shared Brain
// mirrors (Decision 7) — a "fix" applied to a mirror is silently overwritten
// on the next Pull. Scanning mirrors stays allowed (read-only, and useful to
// spot conflict markers). This matches the promise docs/shared-brain-user-guide.md
// has made since beta.1 ("Fix buttons are disabled on the shared-<slug> domain").
async function assertWritableDomain(domain) {
  await assertDomain(domain);
  if (await isDomainReadonly(domain)) {
    const err = new Error(
      `Domain "${domain}" is a read-only Shared Brain mirror — fixes here would be ` +
      `overwritten on the next Pull. Fix the issue in your personal contributing domain, ` +
      `then push contributions from the Sync tab.`
    );
    err.status = 400;
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
    await assertWritableDomain(domain);
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

// ── Bulk AI broken-link fix (v3.0.1-beta.16) ─────────────────────────────────

// Estimate (no LLM): how many broken links, how many resolve for free vs need AI.
router.get('/:domain/broken-links/estimate', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    try { getProviderInfo(); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    const est = await estimateBrokenLinkFix(domain);
    res.json({ ok: true, ...est });
  } catch (err) {
    console.error('[broken-links estimate]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Plan (READ-ONLY, but makes LLM calls): deterministic pre-pass + AI batches.
// SSE: start | progress | batch-error | done | error. Returns the full plan.
router.post('/:domain/broken-links/plan', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    try { getProviderInfo(); }
    catch (err) { return res.status(400).json({ error: err.message }); }
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event) => { res.write(`event: ${event.type}\n`); res.write(`data: ${JSON.stringify(event)}\n\n`); };

  try {
    await planBrokenLinkFixes(req.params.domain, {}, send);
  } catch (err) {
    send({ type: 'error', error: err.message, code: err.code });
  } finally {
    res.end();
  }
});

// Apply (DESTRUCTIVE): writes the plan to disk. Write-lock + registry like
// fix-all/merge-batch; SSE progress.
const MAX_BROKEN_LINK_PLAN = 20000;
router.post('/:domain/broken-links/apply', async (req, res) => {
  const { domain } = req.params;
  try { await assertWritableDomain(domain); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

  const plan = (req.body && Array.isArray(req.body.plan)) ? req.body.plan : null;
  if (!plan || plan.length === 0) return res.status(400).json({ error: 'Missing plan[] to apply' });
  if (plan.length > MAX_BROKEN_LINK_PLAN) return res.status(400).json({ error: `Plan too large (${plan.length}); cap is ${MAX_BROKEN_LINK_PLAN}.` });

  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse(`fix broken links in "${domain}"`);
    return res.status(status).json(body);
  }
  const releaseRegistry = registerWrite(domain, 'broken-links-apply');
  const releaseFileLock = await acquireFileLock(domainPath(domain), { op: 'broken-links-apply' });
  if (!releaseFileLock) {
    releaseRegistry();
    return res.status(409).json({ error: `Another process is already writing to "${domain}" (file lock held).`, conflict: 'file_lock' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event) => { res.write(`event: ${event.type}\n`); res.write(`data: ${JSON.stringify(event)}\n\n`); };

  try {
    send({ type: 'start', actions: plan.length });
    const result = await applyBrokenLinkFixes(domain, plan, (p) => send({ type: 'progress', ...p }));
    send({ type: 'done', ...result });
  } catch (err) {
    console.error('[broken-links apply]', err);
    send({ type: 'error', error: err.message });
  } finally {
    try { await releaseFileLock(); } catch { /* best-effort */ }
    releaseRegistry();
    res.end();
  }
});

// ── Bulk AI orphan rescue (v3.0.1-beta.17) ───────────────────────────────────

router.get('/:domain/orphans/estimate', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    try { getProviderInfo(); } catch (err) { return res.status(400).json({ error: err.message }); }
    const est = await estimateOrphanRescue(domain);
    res.json({ ok: true, ...est });
  } catch (err) {
    console.error('[orphans estimate]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:domain/orphans/plan', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    try { getProviderInfo(); } catch (err) { return res.status(400).json({ error: err.message }); }
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event) => { res.write(`event: ${event.type}\n`); res.write(`data: ${JSON.stringify(event)}\n\n`); };
  try {
    await planOrphanRescue(req.params.domain, {}, send);
  } catch (err) {
    send({ type: 'error', error: err.message, code: err.code });
  } finally {
    res.end();
  }
});

const MAX_ORPHAN_PLAN = 20000;
router.post('/:domain/orphans/apply', async (req, res) => {
  const { domain } = req.params;
  try { await assertWritableDomain(domain); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

  const plan = (req.body && Array.isArray(req.body.plan)) ? req.body.plan : null;
  if (!plan || plan.length === 0) return res.status(400).json({ error: 'Missing plan[] to apply' });
  if (plan.length > MAX_ORPHAN_PLAN) return res.status(400).json({ error: `Plan too large (${plan.length}); cap is ${MAX_ORPHAN_PLAN}.` });

  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse(`rescue orphans in "${domain}"`);
    return res.status(status).json(body);
  }
  const releaseRegistry = registerWrite(domain, 'orphan-rescue-apply');
  const releaseFileLock = await acquireFileLock(domainPath(domain), { op: 'orphan-rescue-apply' });
  if (!releaseFileLock) {
    releaseRegistry();
    return res.status(409).json({ error: `Another process is already writing to "${domain}" (file lock held).`, conflict: 'file_lock' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event) => { res.write(`event: ${event.type}\n`); res.write(`data: ${JSON.stringify(event)}\n\n`); };
  try {
    send({ type: 'start', actions: plan.length });
    const result = await applyOrphanRescue(domain, plan, (p) => send({ type: 'progress', ...p }));
    send({ type: 'done', ...result });
  } catch (err) {
    console.error('[orphans apply]', err);
    send({ type: 'error', error: err.message });
  } finally {
    try { await releaseFileLock(); } catch { /* best-effort */ }
    releaseRegistry();
    res.end();
  }
});

// One-click "Fix all safe issues" — runs every deterministic auto-fix type in a
// single locked pass (v3.0.1-beta.17). Write-op + file lock like fix-all.
router.post('/:domain/fix-all-safe', async (req, res) => {
  const { domain } = req.params;
  // Validate the domain BEFORE acquiring the lock / mkdir — otherwise a bogus
  // domain manufactures a ghost directory + .write-lock on disk (audit H1).
  try { await assertWritableDomain(domain); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse(`bulk-fix domain "${domain}"`);
    return res.status(status).json(body);
  }
  const releaseRegistry = registerWrite(domain, 'health-fix-all-safe');
  const releaseFileLock = await acquireFileLock(domainPath(domain), { op: 'health-fix-all-safe' });
  if (!releaseFileLock) {
    releaseRegistry();
    return res.status(409).json({ error: `Another process is already writing to "${domain}" (file lock held).`, conflict: 'file_lock' });
  }
  try {
    const result = await fixAllSafe(domain);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[health fix-all-safe]', err);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    try { await releaseFileLock(); } catch { /* best-effort */ }
    releaseRegistry();
  }
});

// Batch-merge a caller-supplied list of semantic-duplicate pairs over SSE
// (v3.0.1-beta.15). Powers the "Merge all high-confidence" button. The
// frontend sends the exact pairs to merge (already filtered to high
// confidence); the server validates each pair inside fixSemanticDuplicate.
// Registered as a write op + file lock like fix-all so a concurrent
// sync/update/delete refuses with 409. Streams one `progress` event per pair
// plus a final `done`.
const MAX_BATCH_MERGE_PAIRS = 2000;
router.post('/:domain/semantic-dupes/merge-batch', async (req, res) => {
  const { domain } = req.params;
  try {
    await assertWritableDomain(domain);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const rawPairs = (req.body && Array.isArray(req.body.pairs)) ? req.body.pairs : null;
  if (!rawPairs || rawPairs.length === 0) {
    return res.status(400).json({ error: 'Missing pairs[] to merge' });
  }
  if (rawPairs.length > MAX_BATCH_MERGE_PAIRS) {
    return res.status(400).json({ error: `Too many pairs (${rawPairs.length}); cap is ${MAX_BATCH_MERGE_PAIRS}.` });
  }
  // Defense in depth: drop anything that isn't a plain object before it reaches
  // fixSemanticDuplicate (which validates slugs/folders anyway, but this keeps
  // the contract clean and avoids logging noise on malformed items).
  const pairs = rawPairs.filter(p => p && typeof p === 'object' && !Array.isArray(p));
  if (pairs.length === 0) {
    return res.status(400).json({ error: 'No valid pair objects in pairs[]' });
  }

  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse(`batch-merge duplicates in "${domain}"`);
    return res.status(status).json(body);
  }
  const releaseRegistry = registerWrite(domain, 'semantic-dupes-merge-batch');
  const releaseFileLock = await acquireFileLock(domainPath(domain), { op: 'semantic-dupes-merge-batch' });
  if (!releaseFileLock) {
    releaseRegistry();
    return res.status(409).json({
      error: `Another process is already writing to "${domain}" (file lock held).`,
      conflict: 'file_lock',
    });
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
    send({ type: 'start', total: pairs.length });
    const result = await fixSemanticDuplicatesBatch(domain, pairs, (p) => {
      send({ type: 'progress', ...p });
    });
    send({ type: 'done', ...result });
  } catch (err) {
    console.error('[semantic-dupes merge-batch]', err);
    send({ type: 'error', error: err.message });
  } finally {
    try { await releaseFileLock(); } catch { /* best-effort */ }
    releaseRegistry();
    res.end();
  }
});

router.post('/:domain/fix-all', async (req, res) => {
  // v3.0.1-beta.8: register fix-all as a write op so concurrent
  // sync/update/delete can refuse with 409. Single-fix endpoint
  // (POST /:domain/fix) is sub-second and intentionally NOT registered —
  // adding noise to fast paths doesn't help anyone.
  const { domain } = req.params;
  // Validate domain + body BEFORE acquiring the lock / mkdir (audit H1) so a
  // bogus domain or malformed body never manufactures a ghost directory.
  try { await assertWritableDomain(domain); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  const { type } = req.body || {};
  if (!type)                  return res.status(400).json({ error: 'Missing type' });
  if (!AUTO_FIXABLE.has(type)) return res.status(400).json({ error: `Type "${type}" is review-only.` });
  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse(`bulk-fix domain "${domain}"`);
    return res.status(status).json(body);
  }
  const releaseRegistry = registerWrite(domain, 'health-fix-all');
  const releaseFileLock = await acquireFileLock(domainPath(domain), { op: 'health-fix-all' });
  if (!releaseFileLock) {
    releaseRegistry();
    return res.status(409).json({
      error: `Another process is already writing to "${domain}" (file lock held).`,
      conflict: 'file_lock',
    });
  }
  try {
    const result = await fixIssue(domain, type, null);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[health fix-all]', err);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    try { await releaseFileLock(); } catch { /* best-effort */ }
    releaseRegistry();
  }
});

// ── Dismissal store (v2.5.1) ──────────────────────────────────────────────────
// Persists "skip" decisions so the same false positives don't re-surface on
// every Health scan. Stored as JSONL inside the wiki/ folder so dismissals
// sync across machines via the existing GitHub sync (the wiki/ folder is
// already git-tracked).

const DISMISSIBLE_TYPES = new Set([
  'brokenLinks',
  'orphans',
  'folderPrefixLinks',
  'crossFolderDupes',
  'hyphenVariants',
  'missingBacklinks',
  'semanticDupe',
]);

router.get('/:domain/dismissed', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    const records = await listDismissed(domain);
    res.json({ ok: true, records });
  } catch (err) {
    console.error('[health dismissed list]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:domain/dismiss', async (req, res) => {
  try {
    const { domain } = req.params;
    const { type, issue } = req.body || {};
    if (!type) return res.status(400).json({ error: 'Missing type' });
    if (!DISMISSIBLE_TYPES.has(type)) {
      return res.status(400).json({ error: `Type "${type}" cannot be dismissed.` });
    }
    if (!issue || typeof issue !== 'object') {
      return res.status(400).json({ error: 'Missing issue' });
    }
    await assertDomain(domain);
    const result = await addDismissal(domain, type, issue);
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json(result);
  } catch (err) {
    console.error('[health dismiss]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:domain/undismiss', async (req, res) => {
  try {
    const { domain } = req.params;
    const { type, issue } = req.body || {};
    if (!type) return res.status(400).json({ error: 'Missing type' });
    if (!DISMISSIBLE_TYPES.has(type)) {
      return res.status(400).json({ error: `Type "${type}" cannot be un-dismissed.` });
    }
    if (!issue || typeof issue !== 'object') {
      return res.status(400).json({ error: 'Missing issue' });
    }
    await assertDomain(domain);
    const result = await removeDismissal(domain, type, issue);
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json(result);
  } catch (err) {
    console.error('[health undismiss]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
