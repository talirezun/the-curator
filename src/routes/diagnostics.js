/**
 * Self-diagnostics routes (v3.0.1-beta.23) — backs the Settings "System Check"
 * panel.
 *
 *   GET  /api/diagnostics/quick  — FREE local checks (no network, no API call).
 *   POST /api/diagnostics/live   — OPT-IN: one tiny LLM call (~a fraction of a
 *                                  cent). POST so the beta.20 cross-origin guard
 *                                  applies and the frontend gates it behind an
 *                                  explicit cost confirmation.
 */
import express from 'express';
import { runQuickDiagnostics, runLiveApiCheck } from '../brain/diagnostics.js';

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

export default router;
