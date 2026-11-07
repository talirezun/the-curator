/**
 * src/routes/health.js
 *
 * Wiki Health API — exposed in the UI as the "Health" tab.
 *
 *   GET  /api/health                    — server ping (ok, version)
 *   GET  /api/health/:domain            — scan wiki, return issue report
 *   POST /api/health/:domain/fix        — apply one fix     body: { type, issue }
 *   POST /api/health/:domain/fix-all    — apply all of type body: { type }
 *   POST /api/health/:domain/index/plan — preview an index.md rebuild (read-only, v3.83.0)
 *   POST /api/health/:domain/index/apply — apply it              body: { basis }
 */
import { Router } from 'express';
import { readFileSync } from 'fs';
import { isDomainReadonly, assertKnownDomain, readSchema, extractDomainDisplayName } from '../brain/files.js';
import { scanWiki, fixIssue, AUTO_FIXABLE, planIndexRebuild, applyIndexRebuild, collapseRepeatedLinks, MERGE_NOT_RELATED, MERGE_NOT_RELATED_MESSAGE } from '../brain/health.js';
import {
  suggestBrokenLinkTarget,
  suggestOrphanHomes,
  estimateSemanticDuplicateScan,
  scanSemanticDuplicates,
  semanticScanStatus,
  semanticRememberedPairs,
  semanticLastFigures,
  estimateBrokenLinkFix,
  planBrokenLinkFixes,
  estimateOrphanRescue,
  planOrphanRescue,
  describeHealthRun,
  estimateCompareAll,
  semanticFamilies,
  semanticFamilyFacts,
} from '../brain/health-ai.js';
import {
  startCompareAll,
  pauseCompareAll,
  resumeCompareAll,
  stopCompareAll,
  compareAllStatus,
  beginManualScan,
  refuseIfCompareAllRunning,
} from '../brain/duplicate-job.js';
import { describeRun } from '../brain/ai-run.js';
import { forgetDuplicateChecks } from '../brain/duplicate-checks.js';
import { previewSemanticDuplicateMerge, semanticMergeBasisNow, fixSemanticDuplicatesBatch, applyBrokenLinkFixes, applyOrphanRescue, fixAllSafe } from '../brain/health.js';
import { getProviderInfo } from '../brain/llm.js';
import { getAiHealthSettings, setAiHealthSettings, DEFAULT_AI_HEALTH } from '../brain/config.js';
import { addDismissal, removeDismissal, listDismissed } from '../brain/health-dismissed.js';
import { domainPath } from '../brain/files.js';
import { recordHealthSummary } from '../brain/health-summary.js';
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
//
// v3.67.0, ADDITIVE: both shapes gain `runsOn` — describeRun({job:
// 'wiki-health'}) with no token figures. It is the RESTING-STATE source of the
// no-key signal (contract §1.13): a button that has no estimate yet reads
// `runsOn.needsKey` from here rather than from a 400 it has not asked for.
router.get('/ai-available', (_req, res) => {
  const runsOn = describeRun({ job: 'wiki-health' });
  try {
    const info = getProviderInfo();
    res.json({ available: true, provider: info.provider, model: info.model, runsOn });
  } catch (err) {
    res.json({ available: false, reason: err.message, runsOn });
  }
});

// AI Health settings (cost ceiling, candidate-pair cap). Defined BEFORE
// `/:domain` so `ai-settings` isn't matched as a domain name.
//
// v3.72.1 (truth audit Settings F7 / tray-copy F4), ADDITIVE: `defaults` is
// config.js's DEFAULT_AI_HEALTH itself, so Settings' hint states the default
// from the ONE constant instead of a typed second copy ("Default 50,000 tokens"
// outlived the constant it copied). `defaultRunsOn` prices that default on the
// model that builds the wiki NOW, through the same `describeHealthRun` the
// scan's own confirm uses — never "≈ $0.01 on Gemini Flash Lite", a figure true
// for one model the scan may not run on.
async function aiSettingsPayload(settings) {
  let defaultRunsOn = null;
  try { defaultRunsOn = await describeHealthRun('semanticDupes', DEFAULT_AI_HEALTH.costCeilingTokens); }
  catch { defaultRunsOn = null; }
  return { ...settings, defaults: { ...DEFAULT_AI_HEALTH }, defaultRunsOn };
}
router.get('/ai-settings', async (_req, res) => {
  try { res.json(await aiSettingsPayload(getAiHealthSettings())); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/ai-settings', async (req, res) => {
  try {
    const { costCeilingTokens, semanticDupeMaxPairs } = req.body || {};
    const updated = setAiHealthSettings({ costCeilingTokens, semanticDupeMaxPairs });
    res.json(await aiSettingsPayload(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The domain allow-list is `assertKnownDomain` in files.js, imported above —
// NOT a local copy. It used to be four lines here and four more inline in
// routes/chat.js; the chat ones were simply absent from three of its four
// routes, which is how an unvalidated `:domain` reached path.join(). One
// function, one behaviour, nothing to drift.
const assertDomain = assertKnownDomain;

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
      `then push contributions from the Shared Brain view.`
    );
    err.status = 400;
    throw err;
  }
}

router.get('/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    const report = collapseRepeatedLinks(await scanWiki(domain));
    // v3.77: the scan's summary outlives this session — GET /api/domains/stats
    // serves it, so a restart does not turn every unopened domain back into
    // "Health not checked yet". Awaited (one small file write) so a stats read
    // that follows this response already sees it; never throws.
    await recordHealthSummary(domain, report);
    // v3.72.1, additive: how many dismissal RECORDS are on disk — what the
    // Dismissed list shows. `counts.dismissed` is a different figure (current
    // scan issues a dismissal hid; semantic Skips and records whose issue is
    // gone are not in it), and the view needs both.
    let dismissedRecords = null;
    try { dismissedRecords = (await listDismissed(domain)).length; } catch { dismissedRecords = null; }
    // `scannedAt` is when the wiki was READ, and a cache hit keeps the older one.
    // `checkedAt` is when it was last looked at, which a person pressing Rescan asks.
    const checkedAt = new Date().toISOString();
    res.json(dismissedRecords === null ? { ...report, checkedAt } : { ...report, dismissedRecords, checkedAt });
  } catch (err) {
    console.error('[health scan]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── THE MERGE GATE ───────────────────────────────────────────────────────────
//
// A semantic merge deletes a page. "Preview before Merge" used to be enforced only
// in the browser: POST /fix with no preview ever requested returned 200 and deleted
// the page. Now the route itself asks: is this the pair, this way round, with the
// text, that somebody compared? The comparison's `basis` (health.js) answers that.
//
// MERGE_BASIS_CLIENT_REQUIRED is THE switch for the landing order, and the only one.
//   false: the view of this release sends no basis yet. A merge with no basis passes
//          only if THIS SERVER issued, in a preview, the basis of the pages as they
//          are now, this way round. A merge that nobody previewed is refused either
//          way, so the hole is closed before the view changes. A client that previews
//          and then merges blind still passes, which is what `true` removes.
//   true:  the caller must send the basis. The view must send it first.
// scripts/test-merge-basis-gate.js goes red if this and the view disagree.
//
// Batch merge does not come through here and needs no basis: no one reads a preview
// of a batch, and fixSemanticDuplicatesBatch requires a spelling variant AND a
// remembered high-confidence answer about the openings on disk now. The MCP has its
// own gate in mcp/tools/health.js, bound to the same basis.
const MERGE_BASIS_CLIENT_REQUIRED = true;
let mergeBasisClientRequired = MERGE_BASIS_CLIENT_REQUIRED;

const MERGE_BASIS_MISSING_MESSAGE = 'This merge is not based on a comparison of the two pages as they are now, so nothing was changed. Compare them first, then merge.';
const MERGE_BASIS_STALE_MESSAGE = 'One of these pages changed since you compared them, or the page to keep is a different one now, so nothing was changed. Compare them again, then merge.';

const issuedBases = new Set(); // `${domain}|${basis}`, oldest first
const MAX_ISSUED_BASES = 500;
function noteIssuedBasis(domain, basis) {
  const key = `${domain}|${basis}`;
  issuedBases.delete(key);
  issuedBases.add(key);
  if (issuedBases.size > MAX_ISSUED_BASES) issuedBases.delete(issuedBases.values().next().value);
}

/**
 * Null when the merge may go ahead, else the refusal. Runs under the file lock, so
 * what it compares is what the merge reads. An invalid pair or a gone page has no
 * basis, and goes on to fixSemanticDuplicate's own refusal, which writes nothing.
 */
async function mergeBasisRefusal(domain, issue, basis) {
  const now = await semanticMergeBasisNow(domain, issue);
  if (now === null) return null;
  const sent = typeof basis === 'string' && basis ? basis : null;
  if (sent !== null) return sent === now ? null : { status: 409, code: 'MERGE_BASIS_STALE', error: MERGE_BASIS_STALE_MESSAGE };
  if (!mergeBasisClientRequired && issuedBases.has(`${domain}|${now}`)) return null;
  return { status: 409, code: 'MERGE_BASIS_MISSING', error: MERGE_BASIS_MISSING_MESSAGE };
}

/** Test seam: run the suite under each setting. Null puts the shipped constant back. */
export function __setMergeBasisClientRequiredForTest(value) {
  mergeBasisClientRequired = value === null ? MERGE_BASIS_CLIENT_REQUIRED : !!value;
}
export const __MERGE_BASIS_CLIENT_REQUIRED = MERGE_BASIS_CLIENT_REQUIRED;

// Fix ONE issue -- or, when `issue` is omitted, every issue of `type`.
//
// Guarded exactly like /:domain/fix-all below, because it can do exactly the
// same work. fixIssue() branches on its third argument (health.js:740): a
// truthy `issue` fixes that one issue, a falsy one runs the FULL bulk path --
// scanWiki() plus a fix for every issue of that type. This route passes
// `issue || null`, so a caller that POSTs {type} with no `issue` executes the
// identical bulk operation as /fix-all.
//
// The v3.0.1-beta.8 comment on /fix-all said this endpoint was "sub-second and
// intentionally NOT registered". That was true of the shape the UI sends and
// false of the shape the route accepts -- and it is not even reliably true of
// the single-issue path: fixSemanticDuplicate walks EVERY file in the domain
// (health.js:1152) to rewrite links before deleting the duplicate.
//
// Unreachable from the shipping UI in its bulk form, but reachable from a
// second tab, curl, or any non-UI caller -- and the MCP's own fix_wiki_issue
// already takes the file lock around the very same fixIssue() call
// (mcp/tools/health.js:217), so before this the cross-process caller was more
// careful than the app's own route.
router.post('/:domain/fix', async (req, res) => {
  const { domain } = req.params;
  const { type, issue, basis } = req.body || {};
  if (!type)                   return res.status(400).json({ error: 'Missing type' });
  if (!AUTO_FIXABLE.has(type)) return res.status(400).json({ error: `Type "${type}" is review-only.` });
  // Validate the domain BEFORE acquiring the lock / mkdir (audit H1) so a bogus
  // domain never manufactures a ghost directory + .write-lock on disk.
  try { await assertWritableDomain(domain); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse(`fix an issue in domain "${domain}"`);
    return res.status(status).json(body);
  }
  const releaseRegistry = registerWrite(domain, 'health-fix');
  const releaseFileLock = await acquireFileLock(domainPath(domain), { op: 'health-fix' });
  if (!releaseFileLock) {
    releaseRegistry();
    return res.status(409).json({
      error: `Another process is already writing to "${domain}" (file lock held).`,
      conflict: 'file_lock',
    });
  }
  try {
    if (type === 'semanticDupe' && issue) {
      const refusal = await mergeBasisRefusal(domain, issue, basis);
      if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code, fixed: 0 });
    }
    const result = await fixIssue(domain, type, issue || null);
    // A request the scan's rule does not support, not a page that happened to be
    // refused: the screen never sends one, because it sends what the scan listed.
    if (result.reason === MERGE_NOT_RELATED) {
      return res.status(409).json({ error: MERGE_NOT_RELATED_MESSAGE, code: MERGE_NOT_RELATED, fixed: 0 });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[health fix]', err);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    try { await releaseFileLock(); } catch { /* best-effort */ }
    releaseRegistry();
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
    res.json({
      ok: true, ...estimate, costCeilingTokens: settings.costCeilingTokens,
      // v3.72.1, additive: the max-pairs setting the estimate was cut to, so
      // the confirm can name the cap as the user's setting ("capped at your
      // 500-pair limit") rather than as a local pre-filter.
      maxPairs: settings.semanticDupeMaxPairs,
      // v3.67.0, additive: the run line, with the confirm's own dollars. Its tokens are the
      // ceiling's budget, which over-prices a pair; the dollars are the measured ones.
      runsOn: await (async () => {
        const run = await describeHealthRun('semanticDupes', estimate.estimatedTokens);
        return typeof estimate.estimatedUsd === 'number' && run && typeof run.usdHigh === 'number'
          ? { ...run, usdLow: estimate.estimatedUsd, usdHigh: estimate.estimatedUsd } : run;
      })(),
    });
  } catch (err) {
    if (err.code === 'DOMAIN_TOO_LARGE') return res.status(400).json({ error: err.message, code: err.code });
    console.error('[semantic-dupes estimate]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// What this machine already knows: coverage and the pairs found earlier and not
// yet decided, so the panel can open with them after a reload. No provider call.
// With nothing remembered it answers at once, so opening a domain nobody has
// scanned never derives the candidate list.
router.get('/:domain/semantic-dupes/status', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    // `?quick=1`: the remembered pairs alone, with no candidate pass, so coming
    // back to a large domain shows them at once while the figures are counted.
    const settings = getAiHealthSettings();
    if (req.query && req.query.quick) {
      return res.json({ ok: true, ...(await semanticRememberedPairs(domain)), ...(await semanticLastFigures(domain, settings.semanticDupeMaxPairs)) });
    }
    // `?reconcile=1`, when the panel opens: repeat the full pass if the list on hand
    // was filtered after a merge. It costs nothing when it was not.
    const reconcile = !!(req.query && req.query.reconcile);
    res.json({ ok: true, ...(await semanticScanStatus(domain, settings.semanticDupeMaxPairs, { reconcile })) });
  } catch (err) {
    if (err.code === 'DOMAIN_TOO_LARGE') return res.status(400).json({ error: err.message, code: err.code });
    console.error('[semantic-dupes status]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Forget which pairs have been checked in this domain, so the next scan starts
// over. The wiki and the dismissals are untouched, so this is allowed on a
// read-only mirror too: what it clears is this machine's, not the mirror's.
router.post('/:domain/semantic-dupes/forget', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    refuseIfCompareAllRunning(domain);
    await forgetDuplicateChecks(domain);
    res.json({ ok: true });
  } catch (err) {
    if (err && err.code === 'COMPARE_ALL_RUNNING') return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[semantic-dupes forget]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Run the real semantic-duplicate scan over SSE. Events stream as
//   event: start | progress | pair | batch-error | done | error
// matching the shape documented in docs/api-reference.md.
router.post('/:domain/semantic-dupes/scan', async (req, res) => {
  let releaseScan = () => {};
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    try { getProviderInfo(); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    releaseScan = beginManualScan(domain);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
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
    releaseScan();
    res.end();
  }
});

// ── Compare all remaining: one server job (src/brain/duplicate-job.js) ─────────

function sendJobError(res, err, label) {
  if (err && err.code && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.running ? { running: err.running } : {}) });
  }
  if (!err.status || err.status >= 500) console.error(label, err);
  return res.status(err.status || 500).json({ error: err.message });
}

// The confirm's figures: every pair not yet answered. No provider call and no write.
// `overCeiling` says this pass is larger than the per-run ceiling, which applies to one
// press of a button; the limit that binds here is the amount confirmed at start.
router.get('/:domain/semantic-dupes/compare-all/estimate', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    try { getProviderInfo(); }
    catch (err) { return res.status(400).json({ error: err.message, code: 'NO_PROVIDER' }); }
    const settings = getAiHealthSettings();
    const estimate = await estimateCompareAll(domain);
    res.json({
      ok: true, ...estimate,
      costCeilingTokens: settings.costCeilingTokens,
      overCeiling: estimate.estimatedTokens > settings.costCeilingTokens,
      stopMargin: 1.2,
      job: await compareAllStatus(domain),
      runsOn: describeRun({ job: 'wiki-health' }),
    });
  } catch (err) {
    if (err.code === 'DOMAIN_TOO_LARGE') return res.status(400).json({ error: err.message, code: err.code });
    sendJobError(res, err, '[compare-all estimate]');
  }
});

router.post('/:domain/semantic-dupes/compare-all/start', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertWritableDomain(domain);
    res.json({ ok: true, job: startCompareAll(domain, req.body) });
  } catch (err) { sendJobError(res, err, '[compare-all start]'); }
});

router.post('/:domain/semantic-dupes/compare-all/pause', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    res.json({ ok: true, job: await pauseCompareAll(domain) });
  } catch (err) { sendJobError(res, err, '[compare-all pause]'); }
});

router.post('/:domain/semantic-dupes/compare-all/resume', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertWritableDomain(domain);
    res.json({ ok: true, job: await resumeCompareAll(domain) });
  } catch (err) { sendJobError(res, err, '[compare-all resume]'); }
});

router.post('/:domain/semantic-dupes/compare-all/stop', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    res.json({ ok: true, job: await stopCompareAll(domain) });
  } catch (err) { sendJobError(res, err, '[compare-all stop]'); }
});

// Read-only, and cheap enough to poll: it reads one small file.
router.get('/:domain/semantic-dupes/compare-all/status', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    res.json({ ok: true, job: await compareAllStatus(domain) });
  } catch (err) { sendJobError(res, err, '[compare-all status]'); }
});

// Open pairs grouped into families, stating what the AI really compared. READ-ONLY.
router.get('/:domain/semantic-dupes/families', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    const stay = req.query && typeof req.query.stay === 'string' ? req.query.stay : null;
    res.json({ ok: true, ...(await semanticFamilies(domain, { stay })) });
  } catch (err) {
    console.error('[semantic-dupes families]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// What a family walk states about the pages the view names: links, size, and every answer the AI
// gave between two of them. READ-ONLY, and a POST only because a long family's names do not fit a URL.
router.post('/:domain/semantic-dupes/family', async (req, res) => {
  try {
    const { domain } = req.params;
    await assertDomain(domain);
    const { pages, textOf } = req.body || {};
    res.json({ ok: true, ...(await semanticFamilyFacts(domain, pages, { textOf: typeof textOf === 'string' ? textOf : null })) });
  } catch (err) {
    if (!err.status) console.error('[semantic-dupes family]', err);
    res.status(err.status || 500).json({ error: err.message });
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
    const preview = await previewSemanticDuplicateMerge(domain, issue, { comparison: true });
    noteIssuedBasis(domain, preview.basis);
    res.json({ ok: true, ...preview });
  } catch (err) {
    // A pair whose page an earlier merge already deleted is a REFUSAL, not a
    // failure: nothing is wrong, this pair is simply already resolved. That
    // is the same refusal-vs-failure split the client's classifyDomainError
    // makes on 409, and a 500 here put a red "Could not build a preview"
    // under a card whose Merge button stayed gated behind "Preview required
    // before Merge" — a dead end with no action in it. Not logged as an
    // error either: it is an ordinary outcome of merging a version family.
    if (err && err.code === 'SEMANTIC_PAIR_STALE') {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        ...(err.missing ? { missing: err.missing } : {}),
      });
    }
    if (err && err.code === 'merge-would-lose-text') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
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
    res.json({ ok: true, ...est, runsOn: await describeHealthRun('brokenLinks', est.estimatedTokens) });
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
  // v3.9.1 — the EMPTY case is split from the MISSING case, and both messages
  // are written to be read by a person.
  //
  // An empty plan is not a malformed request: `planBrokenLinkFixes` legitimately
  // returns `plan: []` when every AI batch errored (each one hits `continue`
  // without pushing, deliberately, so a flaky provider can never bias the plan
  // toward stripping brackets). The 400 is KEPT as a backstop — the route can do
  // no work, and letting it through would mean taking the file lock and the
  // write registration to emit a "done" frame of zeros, which both frontends
  // would then render as a successful fix that never happened. But the refusal
  // is no longer the client's problem to explain: both frontends now recognise
  // an empty plan themselves and never send one (see runBrokenLinksPlan /
  // renderBrokenLinkPreview), so if this text ever reaches a screen it is a bug
  // report, and it should read like English rather than an internal assertion.
  if (!plan) return res.status(400).json({ error: 'This request carried no plan to apply. Build a plan first, then apply it.' });
  if (plan.length === 0) return res.status(400).json({ error: 'This plan is empty, so there is nothing to apply. Nothing was written.' });
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
    res.json({ ok: true, ...est, runsOn: await describeHealthRun('orphans', est.estimatedTokens) });
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
  // v3.9.1 — same split, same reasoning as /broken-links/apply above. The
  // orphan rescuer is CONSERVATIVE BY DESIGN: it returns no home unless there
  // is a genuine relationship, so `plan: []` is its most common outcome on a
  // domain whose last few orphans really have nowhere to go (measured on the
  // maintainer's own wiki in v3.0.1-beta.17: 391 of 604 placed, 213 left for
  // manual review). That is a correct result, not a failure — and it is the one
  // this refusal used to be reported to the user as "Missing plan[] to apply".
  if (!plan) return res.status(400).json({ error: 'This request carried no plan to apply. Build a plan first, then apply it.' });
  if (plan.length === 0) return res.status(400).json({ error: 'This plan is empty, so there is nothing to apply. Nothing was written.' });
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

// ── v3.83.0 — index.md rebuild: plan (read-only) → apply (guarded) ─────────
//
// Deterministic and free: no LLM call anywhere on either route. The plan is
// read-only; the apply RE-PLANS from disk under the domain's write lock and
// writes only when the fresh basis equals the one the user previewed — the
// client sends the basis and nothing else, so the server never writes text it
// was handed. `indexDrift` is deliberately NOT in AUTO_FIXABLE: /fix,
// /fix-all and /fix-all-safe can never reach index.md.

/** The domain's display name for a missing index title: CLAUDE.md "# Domain:". */
async function indexDisplayName(domain) {
  try { return extractDomainDisplayName(await readSchema(domain), domain); }
  catch { return domain; }
}

router.post('/:domain/index/plan', async (req, res) => {
  const { domain } = req.params;
  try {
    await assertWritableDomain(domain);
    const plan = await planIndexRebuild(domain, { displayName: await indexDisplayName(domain) });
    res.json({ ok: true, ...plan });
  } catch (err) {
    if (err && err.code === 'INDEX_UNREADABLE') {
      return res.status(409).json({ error: err.message, code: 'INDEX_UNREADABLE' });
    }
    if (!err.status || err.status >= 500) console.error('[health index plan]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

const INDEX_BASIS_RE = /^[0-9a-f]{64}$/;
router.post('/:domain/index/apply', async (req, res) => {
  const { domain } = req.params;
  // The mirror refusal comes FIRST (before body validation), like every other
  // writability-class route: a mirror is refused with its steer message
  // whatever the body says.
  try { await assertWritableDomain(domain); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  const basis = req.body && req.body.basis;
  if (typeof basis !== 'string' || !INDEX_BASIS_RE.test(basis)) {
    return res.status(400).json({ error: 'This request carried no preview to apply. Preview the index rebuild first, then apply it.' });
  }
  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse(`rebuild the index of domain "${domain}"`);
    return res.status(status).json(body);
  }
  const releaseRegistry = registerWrite(domain, 'index-rebuild-apply');
  const releaseFileLock = await acquireFileLock(domainPath(domain), { op: 'index-rebuild-apply' });
  if (!releaseFileLock) {
    releaseRegistry();
    return res.status(409).json({ error: `Another process is already writing to "${domain}" (file lock held).`, conflict: 'file_lock' });
  }
  try {
    const result = await applyIndexRebuild(domain, basis, { displayName: await indexDisplayName(domain) });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err && err.code === 'INDEX_PLAN_STALE') {
      return res.status(409).json({ error: err.message, code: 'INDEX_PLAN_STALE' });
    }
    if (err && err.code === 'INDEX_UNREADABLE') {
      return res.status(409).json({ error: err.message, code: 'INDEX_UNREADABLE' });
    }
    console.error('[health index apply]', err);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    try { await releaseFileLock(); } catch { /* best-effort */ }
    releaseRegistry();
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
// (v3.0.1-beta.15). Powers the "Merge N spelling variants" button. The frontend
// sends the exact pairs to merge; the server decides which of them may run
// (fixSemanticDuplicatesBatch: names are spelling variants AND a remembered
// high-confidence answer about the pages as they are now) and validates each
// pair inside fixSemanticDuplicate. An ineligible pair is reported, never run.
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

  // v3.9.1 — the THIRD route with the plan→apply shape, found by enumerating
  // every `Array.isArray(req.body.*)` read across src/routes rather than by
  // fixing the two the bug report named. Same split, same reasoning as the two
  // apply routes above.
  //
  // Measured difference from those two, and the reason this is a message change
  // and not a behaviour change: an EMPTY collection is not reachable here from
  // the frontend. /next re-derives the pair list at confirm time and shows
  // "Nothing left to merge…" without issuing a request; the pre-redesign shell
  // (deleted in v3.41.0 — /old now just redirects to /) used to freeze a list
  // its own `highConfidencePairs()` guard had already proven non-empty. So this
  // text is a backstop for scripted clients — which is exactly why it should
  // read as English rather than as an internal assertion.
  const rawPairs = (req.body && Array.isArray(req.body.pairs)) ? req.body.pairs : null;
  if (!rawPairs) {
    return res.status(400).json({ error: 'This request carried no pairs to merge. Scan for duplicates first, then merge.' });
  }
  if (rawPairs.length === 0) {
    return res.status(400).json({ error: 'No duplicate pairs were sent, so there is nothing to merge. Nothing was written.' });
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
  // sync/update/delete can refuse with 409.
  //
  // This comment used to add that the single-fix endpoint (POST /:domain/fix)
  // was "sub-second and intentionally NOT registered". That was wrong on both
  // counts and has been corrected: /fix accepts an omitted `issue` and then runs
  // this exact bulk path, and even its single-issue path can walk the whole
  // domain (fixSemanticDuplicate). /fix now carries the same three guards.
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
    // Refuse read-only Shared Brain mirrors, matching the MCP twin
    // (mcp/tools/dismissed.js:98). The dismissal store lives at
    // <domain>/wiki/.health-dismissed.jsonl — INSIDE the git-tracked, synced
    // wiki/ folder — so a dismissal recorded on a mirror is overwritten on the
    // next Pull exactly like a "fix" is. assertWritableDomain calls
    // assertDomain internally, so the 404-on-unknown-domain behaviour is
    // unchanged; this only adds the 400 refusal. It must stay AHEAD of
    // addDismissal(), whose writeRecords() mkdirs wiki/ before writing.
    await assertWritableDomain(domain);
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
    // Same rule as /dismiss above, and the same MCP parity
    // (mcp/tools/dismissed.js:160). removeDismissal REWRITES the whole JSONL
    // file, so on a mirror it destroys locally-visible dismissals that the
    // next Pull would restore anyway — a pure lose-lose.
    await assertWritableDomain(domain);
    const result = await removeDismissal(domain, type, issue);
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json(result);
  } catch (err) {
    console.error('[health undismiss]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
