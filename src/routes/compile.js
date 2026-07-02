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
