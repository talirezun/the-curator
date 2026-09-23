// ═══════════════════════════════════════════════════════════════════════════
//  src/routes/reading-plan.js — "Suggest a reading plan" (v3.67.0)
//
//  GET  /api/reading-plan/:domain/:project/estimate
//       → {ok, documentCount, inputChars, budgetBytes, budgetSource, runsOn}
//         200 even with no key: `runsOn.needsKey` is how the view knows to
//         disable "✨ Suggest with AI" (never hide it) and show its door.
//  POST /api/reading-plan/:domain/:project/suggest      body {arm:'free'|'ai'}
//       → {ok, arm, budgetBytes, budgetSource, setBudgetSuggested, proposals,
//          totals, dropped, notes, runsOn?, spent?}
//         arm 'ai' with no key → 400 {ok:false, reason:'needs_key', runsOn}
//
//  A PREFIX OF ITS OWN (/api/reading-plan), so no route-collision analysis
//  against /api/memory's many shapes is needed (CONTRACT-v3.67.0 §3.3).
//
//  NEITHER ROUTE WRITES. A proposal is applied by the owner in the Context
//  view through the existing PATCH routes. Both still refuse a Shared Brain
//  mirror with the memory router's wording: a proposal could not be applied
//  there, so offering one would be a promise the next click breaks.
//
//  Not a write, so no write-registry guard; the server's cross-origin guard
//  already covers the POST (a paid AI call from a foreign page is refused).
// ═══════════════════════════════════════════════════════════════════════════

import { Router } from 'express';
import { listDomains, isDomainReadonly } from '../brain/files.js';
import { isSafeSegment } from '../brain/working-state.js';
import { estimateReadingPlan, suggestReadingPlan } from '../brain/reading-plan.js';

const router = Router();

// TEST-ONLY seam: a fake generateText for the AI arm (null in production), the
// memory router's __setWorkingStateStoreForTest pattern.
let llmOverride = null;
export function __setReadingPlanLlmForTest(fn) { llmOverride = typeof fn === 'function' ? fn : null; }

/** Store refusal reason → HTTP status + wire reason (snake_case, as /api/memory). */
const REFUSAL = new Map([
  ['unknown-project', [404, 'project_not_found']],
  ['unknown-state-project', [404, 'project_not_found']],
  ['invalid-state-project', [400, 'invalid_project']],
  ['invalid-project', [400, 'invalid_project']],
  ['unsafe-path', [400, 'unsafe_path']],
  ['manifest-unreadable', [409, 'manifest_unreadable']],
  ['needs-key', [400, 'needs_key']],
  ['ai-failed', [502, 'ai_failed']],
  ['ai-unusable', [502, 'ai_unusable']],
]);

function refuse(res, out, domain, project) {
  const [status, reason] = REFUSAL.get(out?.reason) || [500, out?.reason || 'io'];
  const body = { ok: false, reason, domain, project, error: out?.message || 'The reading plan could not be made.' };
  if (out && out.runsOn) body.runsOn = out.runsOn;
  if (out && out.spent) body.spent = out.spent;
  return res.status(status).json(body);
}

/** Domain real, not a mirror, project name usable. Runs before any read. */
async function gate(req, res) {
  const { domain, project } = req.params;
  if (!(await listDomains()).includes(domain)) {
    res.status(404).json({ ok: false, reason: 'unknown_domain', error: `Unknown domain: ${domain}` });
    return null;
  }
  if (await isDomainReadonly(domain)) {
    res.status(403).json({
      ok: false,
      reason: 'readonly',
      error: `"${domain}" is a read-only Shared Brain mirror. Projects and briefs live in your own `
        + 'domains; a mirror is rebuilt from the collective on the next Pull and local writes are lost, '
        + 'so a reading plan could not be applied there.',
    });
    return null;
  }
  if (typeof project !== 'string' || !isSafeSegment(project)) {
    res.status(400).json({ ok: false, reason: 'invalid_project', error: `"${project}" is not a usable project name.` });
    return null;
  }
  return { domain, project };
}

router.get('/:domain/:project/estimate', async (req, res) => {
  try {
    const g = await gate(req, res);
    if (!g) return;
    const out = await estimateReadingPlan(g.domain, g.project);
    if (!out || out.ok !== true) return refuse(res, out, g.domain, g.project);
    res.json({
      ok: true,
      documentCount: out.documentCount,
      inputChars: out.inputChars,
      budgetBytes: out.budgetBytes,
      budgetSource: out.budgetSource,
      runsOn: out.runsOn,
    });
  } catch (err) {
    console.error('Reading-plan estimate error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const SUGGEST_BODY_FIELDS = new Set(['arm']);

router.post('/:domain/:project/suggest', async (req, res) => {
  try {
    const g = await gate(req, res);
    if (!g) return;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const extra = Object.keys(body).filter((k) => !SUGGEST_BODY_FIELDS.has(k));
    if (extra.length) {
      return res.status(400).json({
        ok: false, reason: 'unexpected_fields', fields: extra.slice(0, 10),
        error: `This route accepts only \`arm\`. It was also sent: ${extra.slice(0, 10).join(', ')}.`,
      });
    }
    if (body.arm !== 'free' && body.arm !== 'ai') {
      return res.status(400).json({
        ok: false, reason: 'invalid_arm',
        error: 'Send `{ arm: "free" }` for the suggestion without AI, or `{ arm: "ai" }` to ask your AI model.',
      });
    }
    const out = await suggestReadingPlan(g.domain, g.project, {
      arm: body.arm,
      ...(llmOverride ? { generateText: llmOverride } : {}),
    });
    if (!out || out.ok !== true) return refuse(res, out, g.domain, g.project);
    res.json(out);
  } catch (err) {
    console.error('Reading-plan suggest error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
