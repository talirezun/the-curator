/**
 * The hook activity log (v3.77.0) — what `my-curator hook` did, one line per
 * invocation, with NO content in it.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 * Measured 2026-09-26 on the maintainer's Mac: an Antigravity session with the
 * project-level `.agents/hooks.json` got the session-start injection (the agent
 * read back the brief's directive without calling `get_project_context`), but
 * at the end of the turn NO save reminder appeared. Probing the hook by hand
 * could only say what it would do for an id it had never seen. Whether
 * Antigravity called Stop at all, sent a differently named id, or ended the
 * loop for another reason was unknowable, because a hook left no trace. This
 * file is that trace.
 *
 * ── WHAT A LINE HOLDS, AND WHAT IT MAY NEVER HOLD ──────────────────────────
 *   ts        ISO time of the invocation
 *   harness   the `--harness` id
 *   event     the canonical event (session-start | stop | pre-compact | session-end)
 *   raw       the event word the harness command was installed with
 *   sid       the first 12 hex of sha256(conversation id) — enough to match a
 *             start to a stop, never the id itself
 *   idKey     WHICH payload field carried the id (`conversationId`, …) or null
 *   keys      the payload's TOP-LEVEL KEY NAMES, sorted, capped — never a value
 *   term      Antigravity's `terminationReason` when it is one of the documented
 *             words, else null (a free string never reaches the log)
 *   project   `domain/project` as resolved, or null — an identifier, the same
 *             one the usage log already records
 *   decision  inject | ask | none
 *   rung      the ladder rung that decided (stop/pre-compact), else null
 *   why       the ladder's own reason sentence, capped
 *   bound     how the stop window was bounded: marker | start-log | null
 *
 * NEVER: a prompt, a transcript path, a workspace path, a model's text, an
 * error message from the harness, or any payload value other than the one
 * whitelisted `terminationReason` word. `scripts/test-hook-log.js` plants a
 * sentinel in every value of a payload and asserts it never reaches the file.
 *
 * ── WHERE ──────────────────────────────────────────────────────────────────
 * `getHookLogPath()` in paths.js — user data, never `domains/`, never synced.
 * Rotated at MAX_HOOK_LOG_BYTES to one `.1` generation. READ as a union over
 * the same candidate folders as the usage log (`candidateUsageLogPaths`),
 * because a hook installed from a checkout writes the checkout's user-data
 * folder while the app reads its own — the v3.64.0 lesson.
 *
 * Writing never throws and never delays a hook by more than one append: a
 * hook that fails because its diary could not be written would be the diary
 * breaking the thing it records.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { getHookLogPath } from './paths.js';

export const MAX_HOOK_LOG_BYTES = 256 * 1024;
export const MAX_KEYS = 40;
export const MAX_WHY = 200;

/** The documented Stop termination words — the only payload VALUE ever logged. */
export const TERMINATION_WORDS = Object.freeze(['model_stop', 'max_steps_exceeded', 'error']);

/** The id → a short hash. Never the id. */
export function hashSessionId(id) {
  if (typeof id !== 'string' || !id) return null;
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

/** Top-level key NAMES only, sorted, capped, each one a plain identifier or `?`. */
export function payloadKeyNames(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.keys(payload)
    .map((k) => (/^[A-Za-z0-9_.-]{1,40}$/.test(k) ? k : '?'))
    .sort()
    .slice(0, MAX_KEYS);
}

function cleanWord(v, max = 80) {
  return typeof v === 'string' && v ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, max) : null;
}

/**
 * Build one line from what the hook knows. Pure — the caller passes the
 * payload and every value is either whitelisted or reduced here.
 */
export function buildHookLine({
  harness, event, raw, sessionId, idKey, payload, project, decision, rung, why, bound, now,
}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const term = typeof p.terminationReason === 'string' && TERMINATION_WORDS.includes(p.terminationReason)
    ? p.terminationReason : null;
  return {
    ts: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    harness: cleanWord(harness, 40),
    event: cleanWord(event, 20),
    raw: cleanWord(raw, 40),
    sid: hashSessionId(sessionId),
    idKey: cleanWord(idKey, 40),
    keys: payloadKeyNames(p),
    term,
    project: cleanWord(project, 200),
    decision: ['inject', 'ask', 'none'].includes(decision) ? decision : 'none',
    rung: Number.isInteger(rung) ? rung : null,
    why: cleanWord(why, MAX_WHY),
    bound: ['marker', 'start-log'].includes(bound) ? bound : null,
  };
}

/** Append one line. Never throws. Returns true when written. */
export function appendHookLine(line, file = getHookLogPath()) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (statSync(file).size >= MAX_HOOK_LOG_BYTES) renameSync(file, `${file}.1`);
    } catch { /* absent: nothing to rotate */ }
    appendFileSync(file, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch { return false; }
}

/** Every file this machine's hooks may be writing — the usage log's union rule. */
export async function hookLogFiles() {
  const primary = getHookLogPath();
  try {
    const { candidateUsageLogPaths } = await import('./mcp-usage.js');
    return candidateUsageLogPaths({ primary });
  } catch { return [primary]; }
}

/** Parsed lines from every candidate file (oldest generation first), sorted by time. */
export async function readHookLines(files = null) {
  const list = Array.isArray(files) ? files : await hookLogFiles();
  const lines = [];
  for (const file of list) {
    for (const f of [`${file}.1`, file]) {
      let text;
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      for (const raw of text.split('\n')) {
        const t = raw.trim();
        if (!t) continue;
        try {
          const j = JSON.parse(t);
          if (j && typeof j === 'object' && typeof j.ts === 'string' && typeof j.harness === 'string') lines.push(j);
        } catch { /* a malformed line is skipped */ }
      }
    }
  }
  lines.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { lines, files: list };
}

/**
 * The newest session-start this harness logged for this project, within
 * `withinMs` of `now` — the fallback bound for a Stop whose conversation id
 * matched no marker. Returns the ISO time or null.
 */
export function newestStartFor(lines, { harness, project, now = Date.now(), withinMs }) {
  let best = null;
  for (const l of lines) {
    // Only a start that INJECTED opens a window: Antigravity's PreInvocation
    // fires before every model call, and the repeats (decision `none`,
    // "already injected") are later than the real start — bounding from one
    // would shrink the window and miss a save made before it.
    if (l.harness !== harness || l.event !== 'session-start' || l.project !== project || l.decision !== 'inject') continue;
    const t = Date.parse(l.ts);
    if (!Number.isFinite(t) || t > now || now - t > withinMs) continue;
    if (best === null || t > best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

/**
 * Per harness: the newest start and the newest stop observed, with the stop's
 * decision and reason. `project` narrows to one project (null = all).
 */
export function summariseHookActivity(lines, { project = null } = {}) {
  const by = {};
  for (const l of lines) {
    if (project && l.project && l.project !== project) continue;
    const h = (by[l.harness] ||= { harness: l.harness, start: null, stop: null, starts: 0, stops: 0 });
    if (l.event === 'session-start') {
      h.starts++;
      if (!h.start || Date.parse(l.ts) >= Date.parse(h.start.at)) h.start = { at: l.ts, decision: l.decision, why: l.why || null };
    } else if (l.event === 'stop') {
      h.stops++;
      if (!h.stop || Date.parse(l.ts) >= Date.parse(h.stop.at)) {
        h.stop = { at: l.ts, decision: l.decision, rung: l.rung ?? null, why: l.why || null, term: l.term || null, bound: l.bound || null };
      }
    }
  }
  return by;
}

/**
 * The words a surface prints about one harness's hooks, from the log alone.
 * Pure. `installed` is whether a Curator hook file was found for it.
 */
export function hookEvidenceWords(summary, { installed }) {
  const s = summary || null;
  const out = [];
  if (s?.start) out.push(`start hook observed firing ${s.start.at.slice(0, 16).replace('T', ' ')} UTC`);
  if (s?.stop) {
    const when = s.stop.at.slice(0, 16).replace('T', ' ');
    out.push(s.stop.decision === 'ask'
      ? `stop hook observed firing ${when} UTC — asked for a save`
      : `stop hook observed firing ${when} UTC — did not ask: ${s.stop.why || 'no reason recorded'}`);
  }
  if (!out.length) out.push(installed ? 'installed, not yet observed firing' : 'not installed');
  return out;
}
