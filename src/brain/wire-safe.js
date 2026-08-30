/**
 * src/brain/wire-safe.js
 *
 * The primitives that stand between an in-process object and anything that
 * reaches HTTP: length-capped, path-scrubbed strings; validated numbers;
 * strict booleans.
 *
 * ── WHY THEY LIVE HERE AND NOT IN ingest-queue.js ───────────────────────────
 * They were written for the ingest queue's `toWire` (v3.3.0) and lived beside
 * it. `ingest-activity.js` (v3.24.0) needs exactly the same discipline for
 * exactly the same reason — it hands a record to HTTP that can carry an
 * `fs` error message, and a raw `fs` error embeds an absolute path, which on
 * a real install is the user's home directory and their cloud-storage layout.
 *
 * Copying the three functions was the obvious move and is the wrong one.
 * `wireStr` is not a formatting helper — it is the GUARD, the single place
 * that decides a string leaving this process has been scrubbed and bounded.
 * Two hand-maintained copies of a guard is this repo's named v3.2.0 CRITICAL
 * shape: the copies agree right up until one of them is edited.
 *
 * Importing them back out of `ingest-queue.js` was the other wrong move.
 * That module pulls in `llm.js`, `health.js` and `ingest.js`; `scrub-paths.js`
 * already records (in its own header) why dragging the queue into another
 * module's import graph is a hazard rather than a convenience.
 *
 * So the implementation MOVED here, unchanged, exactly as `scrubPaths` itself
 * moved out of `ingest-queue.js` for the same reason. `ingest-queue.js` now
 * imports these three; its `toWire` is byte-unchanged in behaviour, which is
 * what scripts/test-ingest-queue.js's end-to-end path-leak assertions prove.
 *
 * This module imports `scrub-paths.js` and NOTHING else, so it is safe to
 * pull into any graph — including the MCP child's, where a stray stdout write
 * corrupts JSON-RPC (v2.5.3).
 */

import { scrubPaths } from './scrub-paths.js';

/**
 * The default cap for a wire string.
 *
 * MOVED from ingest-queue.js unchanged. Its docblock there records the one
 * behaviour that depends on the exact value (a long `pausedMessage` is
 * truncated, which the H1 tripwire's assertions are written against), so the
 * constant is deliberately shared rather than re-picked per module.
 */
export const MAX_WIRE_STRING = 2000;

export function wireStr(v, max = MAX_WIRE_STRING) {
  // Anything that is not a string becomes null — a number or object landing
  // in a string slot is corrupt data, not something to pass through.
  if (typeof v !== 'string') return null;
  const scrubbed = scrubPaths(v);
  return scrubbed.length > max ? scrubbed.slice(0, max) + '… (truncated)' : scrubbed;
}

export function wireNum(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

export function wireBool(v) { return v === true; }
