// ═══════════════════════════════════════════════════════════════════════════
//  shared/ai-jobs.js — EVERY AI JOB THE APP RUNS, AS DATA (v3.67.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// One AI model runs every AI job; Chat alone may pick another model, per
// message, in the composer. This table is what makes that sentence checkable:
// Settings › Providers & keys › "Your AI model" derives its lede and its
// "Used by · N jobs" row from it, every run line names its job from it, and
// scripts/test-ai-run.js walks the code for every module that imports
// `generateText` and fails unless each one maps to a row here (or to
// AI_UNROUTED below). Adding an AI job means adding a row.
//
// ── WHY IT LIVES IN THE SERVED TREE ──────────────────────────────────────
// A view must read it, and `src/brain` is not served. So the data lives here
// (pure, zero imports, frozen) and `src/brain/ai-jobs.js` re-exports it for
// Node — the v3.66.0 identity-palette precedent. It must stay importable by
// an offline suite, so it imports nothing (app.js touches `document` at
// import time).
//
// ── THE COPY IS BINDING ──────────────────────────────────────────────────
// `label`, `startedFrom` and `costShown` are the acceptance picture's table,
// verbatim. `lane` is 'build' (the one model, Settings › Providers & keys ›
// block 2) or 'chat' (the composer's per-message picker). `mode` is the
// generateText response format the job asks for. `modules` are repository
// paths, relative, that call the model for this job.

const freezeRow = (r) => Object.freeze({ ...r, modules: Object.freeze([...r.modules]) });

export const AI_JOBS = Object.freeze([
  { id: 'ingest',       label: 'Ingest',                        startedFrom: 'Domains › ① Ingest',       lane: 'build', mode: 'json', costShown: 'before (batch) · after', modules: ['src/brain/ingest.js'] },
  { id: 'compile',      label: 'Compile to wiki',               startedFrom: 'Chat › Compile',           lane: 'build', mode: 'json', costShown: 'before · after',         modules: ['src/brain/compile.js'] },
  { id: 'wiki-health',  label: 'Wiki health',                   startedFrom: 'Domains › ⑤ Wiki health',  lane: 'build', mode: 'json', costShown: 'before · after',         modules: ['src/brain/health-ai.js'] },
  { id: 'shared-brain', label: 'Shared Brain push & synthesis', startedFrom: 'Domains › ④ Shared Brain', lane: 'build', mode: 'json', costShown: 'after (v3.67.1)',        modules: ['src/brain/sharedbrain-delta.js', 'src/brain/sharedbrain-synthesis.js'] },
  { id: 'reading-plan', label: 'Suggest a reading plan',        startedFrom: 'Context › ① Documents',    lane: 'build', mode: 'json', costShown: 'before · after',         modules: ['src/brain/reading-plan.js'] },
  { id: 'system-check', label: 'System check',                  startedFrom: 'Settings › General',       lane: 'build', mode: 'text', costShown: 'before',                 modules: ['src/brain/diagnostics.js'] },
  { id: 'chat',         label: 'Chat',                          startedFrom: 'Chat composer',            lane: 'chat',  mode: 'text', costShown: 'after',                  modules: ['src/brain/chat.js'] },
].map(freezeRow));

/**
 * Modules that import `generateText` but serve no live job. Named here, each
 * with its reason, so the census in scripts/test-ai-run.js stays total rather
 * than growing an ignore-list nobody reads. When one is removed, its row goes
 * in the same commit.
 */
export const AI_UNROUTED = Object.freeze([
  { module: 'src/brain/query.js', why: 'POST /api/query has no caller' },
  { module: 'src/brain/health-ai.js', functions: ['suggestBrokenLinkTarget', 'suggestOrphanHomes'], why: 'POST /api/health/:domain/ai-suggest has no /next caller' },
  { module: 'mcp/tools/compile.js', why: 'imports generateText and never calls it' },
].map((r) => Object.freeze(r.functions ? { ...r, functions: Object.freeze([...r.functions]) } : { ...r })));

/**
 * The jobs the ONE AI model runs — every row but Chat. Its length is the
 * "Used by · N jobs" figure, so the number on screen is derived, never typed.
 * @returns {ReadonlyArray<object>}
 */
export function buildLaneJobs() {
  return AI_JOBS.filter((j) => j.lane === 'build');
}

/**
 * One job by id, or null. An exact `===` scan: no object is ever indexed by
 * the caller's string, so `'__proto__'`, `'constructor'` and `'toString'`
 * resolve to null by construction.
 * @param {string} id
 * @returns {object|null}
 */
export function aiJob(id) {
  if (typeof id !== 'string') return null;
  for (const j of AI_JOBS) if (j.id === id) return j;
  return null;
}
