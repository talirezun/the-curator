/**
 * POST /api/compile/conversation — v2.5.0
 *
 * Compiles a saved conversation into wiki pages. Streams progress as
 * Server-Sent Events (mirrors the ingest route so the frontend can reuse
 * the same streaming primitive).
 *
 * Request body: { domain, conversationId }
 * Stream events:
 *   { type: 'progress', pct, message }
 *   { type: 'wait', pct, message }     — emitted during slow LLM waits
 *   { type: 'done', title, pagesWritten, changes }
 *   { type: 'error', message }
 *   { type: 'refused', reason }        — short conversation, missing data, etc.
 */

import { Router } from 'express';
import { compileConversation } from '../brain/compile.js';
import { estimateCompileCost } from '../brain/compile-estimate.js';
import { listDomains, domainPath, isDomainReadonly } from '../brain/files.js';
import {
  registerWrite,
  acquireFileLock,
  isUpdateInProgress,
  conflictResponse,
} from '../brain/write-registry.js';

const router = Router();

// Conversation IDs are server-generated UUIDs (see brain/chat.js). Reject
// anything that doesn't match the canonical 8-4-4-4-12 hex shape — defends
// against path-traversal via crafted IDs reaching readConversation().
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/compile/estimate?domain=<slug>&conversationId=<uuid>
 *
 * What one Compile to Wiki would cost, before spending anything. v3.27.0.
 *
 * ── A READ ROUTE, AND EVERY WORD OF THAT IS LOAD-BEARING ────────────────────
 * It writes nothing, so it is NOT registered with the write-registry, does NOT
 * take the domain's file lock, and is NOT refused while an update is in flight.
 * A user who is being told "an update is running" is exactly the user who wants
 * to know what the button below will cost, and a 409 here would buy nothing:
 * the POST still refuses, so no spend can slip through.
 *
 * It also makes NO LLM call. `estimateCompileCost` reads the conversation, the
 * schema and two directory listings and does arithmetic; there is no code path
 * from here to a provider. An offline suite asserts that behaviourally by
 * poisoning the LLM module's exports and requiring this to still answer.
 *
 * VALIDATION MIRRORS THE POST BELOW, in the same order and with the same
 * wording, so the estimate and the compile cannot disagree about what is even
 * addressable. The three refusals the COMPILE ITSELF owns — not found, too
 * short, already compiled — are not duplicated here at all: they come back as
 * `{compilable: false, refusal}` from the one `precheckCompile` both sides run.
 *
 * 200 body:
 *   { ok, compilable, refusal, provider, model,
 *     conversation: { title, userTurns, messageCount, transcriptChars, summaryPath },
 *     domainContext: { entityPages, conceptPages, promptChars },
 *     estimate: { inputTokensLow/High, outputTokensLow/High, usdLow, usdHigh,
 *                 priceKnown, costUnknown, tokenizerFactor, basis },
 *     warnings: [] }
 *
 * `usdLow`/`usdHigh` are NULL — never 0 — whenever `priceKnown` is false, and
 * `costUnknown` names WHICH of the three reasons applies
 * ('no-provider' | 'free-model' | 'no-price').
 */
router.get('/estimate', async (req, res) => {
  const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
  const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : '';

  if (!domain) return res.status(400).json({ error: 'domain is required' });
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return res.status(400).json({ error: 'Invalid conversationId' });
  }

  const domains = await listDomains();
  if (!domains.includes(domain)) {
    return res.status(400).json({ error: `Unknown domain: ${domain}` });
  }

  // The mirror refusal is reported as a REFUSAL rather than an HTTP error, so
  // the caller renders the same "this cannot be compiled" surface it renders
  // for a too-short conversation instead of an exception. The POST still
  // answers 400 for the same case; that asymmetry is deliberate — one is a
  // question, the other is an attempt.
  if (await isDomainReadonly(domain)) {
    return res.json({
      ok: true,
      compilable: false,
      refusal:
        `Domain "${domain}" is a read-only Shared Brain mirror. ` +
        `Compile into your personal opted-in domain instead, then push contributions from the Sync tab.`,
      provider: null, model: null, conversation: null, domainContext: null,
      estimate: null, warnings: [],
    });
  }

  try {
    res.json(await estimateCompileCost(domain, conversationId));
  } catch (err) {
    console.error('[compile] estimate error:', err);
    res.status(500).json({ error: 'Failed to estimate compile cost.' });
  }
});

router.post('/conversation', async (req, res) => {
  const { domain, conversationId } = req.body || {};

  if (!domain) return res.status(400).json({ error: 'domain is required' });
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return res.status(400).json({ error: 'Invalid conversationId' });
  }

  const domains = await listDomains();
  if (!domains.includes(domain)) {
    return res.status(400).json({ error: `Unknown domain: ${domain}` });
  }

  // v3.0.2: refuse compiles into read-only Shared Brain mirrors —
  // matches the MCP compile_to_wiki guard (Decision 7). Direct writes to a
  // mirror don't propagate and are overwritten on the next Pull.
  if (await isDomainReadonly(domain)) {
    return res.status(400).json({
      error: `Domain "${domain}" is a read-only Shared Brain mirror. ` +
             `Compile into your personal opted-in domain instead, then push contributions from the Sync tab.`,
    });
  }

  // v3.0.1-beta.8: refuse if the app updater is mid-flight (matches the
  // ingest-route guard).
  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse('compile a conversation');
    return res.status(status).json(body);
  }

  // ── Switch to Server-Sent Events streaming ───────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // v3.0.1-beta.8: same write-registry + file-lock dance as ingest. Compile
  // writes via the same writePage chokepoint, so it gets the same coverage
  // against concurrent sync/update/delete.
  const releaseRegistry = registerWrite(domain, 'compile');
  const releaseFileLock = await acquireFileLock(domainPath(domain), { op: 'compile' });
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
    const result = await compileConversation(domain, conversationId, ({ pct, message }) => {
      emit({ type: 'progress', pct, message });
    });

    if (!result.ok) {
      // Refusals (too-short conversation, not found) are not errors — they're
      // the normal "nothing to compile" outcome. Errors come from LLM failures.
      if (result.reason) {
        emit({ type: 'refused', reason: result.reason });
      } else {
        emit({ type: 'error', message: result.error || 'Compilation failed' });
      }
      return;
    }

    emit({
      type: 'done',
      title: result.title,
      pagesWritten: result.pagesWritten,
      changes: result.changes,
      // Non-fatal notes (e.g. large conversation → concise/summary-only
      // fallback). Empty on a normal compile (v3.0.1-beta.27).
      warnings: result.warnings || [],
    });
  } catch (err) {
    console.error('Compile error:', err);
    emit({ type: 'error', message: err.message });
  } finally {
    try { await releaseFileLock(); } catch { /* best-effort */ }
    releaseRegistry();
    res.end();
  }
});

export default router;
