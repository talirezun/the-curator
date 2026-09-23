// src/brain/ai-jobs.js — the AI-jobs registry for Node (v3.67.0).
//
// The data lives in the SERVED tree, src/public/next/shared/ai-jobs.js, because
// views read it and src/brain is not served; this file re-exports it so server
// code and suites import from the brain like everything else. One table, two
// doors — the same shape as src/brain/identity-palette.js.
export {
  AI_JOBS,
  AI_UNROUTED,
  buildLaneJobs,
  aiJob,
} from '../public/next/shared/ai-jobs.js';
