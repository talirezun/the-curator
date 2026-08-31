/**
 * Self-diagnostics routes (v3.0.1-beta.23) — backs the Settings "System Check"
 * panel.
 *
 *   GET  /api/diagnostics/quick      — FREE local checks (no network, no API
 *                                      call).
 *   POST /api/diagnostics/live       — OPT-IN: one tiny LLM call (~a fraction
 *                                      of a cent). POST so the beta.20
 *                                      cross-origin guard applies and the
 *                                      frontend gates it behind an explicit
 *                                      cost confirmation.
 *   POST /api/diagnostics/reveal-log — opens the app's own log file in
 *                                      Finder/Explorer. Same execFile('open',
 *                                      ['-R', path]) shape as the existing
 *                                      POST /api/mcp/reveal-config — no shell
 *                                      interpretation, and nothing
 *                                      user-supplied reaches it (the path is
 *                                      resolved server-side via
 *                                      src/brain/logger.js, never taken from
 *                                      the request). macOS-only, same as its
 *                                      sibling; not registered as a write
 *                                      (it changes nothing on disk).
 */
import express from 'express';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { runQuickDiagnostics, runLiveApiCheck } from '../brain/diagnostics.js';
import { getLogFilePath } from '../brain/logger.js';

const router = express.Router();

router.get('/quick', async (_req, res) => {
  try {
    const result = await runQuickDiagnostics();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/live', async (_req, res) => {
  try {
    const result = await runLiveApiCheck();
    res.json(result);
  } catch (err) {
    // runLiveApiCheck is designed not to throw, but stay defensive.
    res.status(500).json({ error: err.message });
  }
});

router.post('/reveal-log', (_req, res) => {
  const logPath = getLogFilePath();
  // Same shape as POST /api/mcp/reveal-config: execFile (no shell), reveal
  // the file if it exists, otherwise its parent directory — a fresh install
  // that has never logged anything still has somewhere to point Finder at.
  const fileExists = existsSync(logPath);
  const args = fileExists ? ['-R', logPath] : [path.dirname(logPath)];
  execFile('open', args, (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, revealed: fileExists ? logPath : path.dirname(logPath) });
  });
});

export default router;
