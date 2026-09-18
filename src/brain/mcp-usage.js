/**
 * MCP tool-usage log (v3.60.0) — what your agents used, and when.
 *
 * The MCP is The Curator's most powerful surface and its least visible: 24
 * tools, driven from another application's window, leaving no trace in the app
 * at all. The per-domain `.mcp-write-log.jsonl` records WRITES only, so a
 * session that read the whole wiki and saved nothing left no record of having
 * happened. This module is the other half: one line per CALL, read or write.
 *
 * ── WHAT IS IN A LINE, AND WHAT NEVER WILL BE ───────────────────────────────
 *
 *   {"ts":"…","tool":"get_node","domain":"articles","ok":true,"refused":false,"ms":12}
 *
 * Those six keys, in that order, plus ONE optional seventh — `via` (v3.61.0),
 * whose only legal value is the literal `"self-test"` — and nothing else, EVER.
 * No arguments, no results, no file paths, no error text, no user prose. Two
 * reasons, and the second is the one that binds:
 *
 *   1. A search query, a slug, a conversation title or a handoff body is the
 *      user's content. This file is not a place for content. `search_wiki`'s
 *      `query` alone would turn the log into a record of what the user was
 *      thinking about, on disk, forever.
 *   2. The map this feeds is shown in the app as "kept on this machine only,
 *      no arguments or content logged". A claim made to a user in the product
 *      is a contract; `scripts/test-mcp-usage.js` asserts the line's key SET
 *      and that a call carrying a 10 KB argument still leaves a line under 200
 *      bytes, so the contract cannot rot by accident.
 *
 * The `tool` name is checked against a strict shape and replaced with
 * `"unknown"` otherwise — a caller can name any tool it likes over JSON-RPC,
 * and an unknown NAME is a user-supplied string. The domain is checked the
 * same way and dropped to `null` when it does not look like a slug.
 *
 * ── `via`, AND WHY IT IS A LITERAL RATHER THAN A STRING ──────────────────────
 *
 * `via: "self-test"` marks a line written by the app's own "Test all N tools"
 * run (`src/brain/mcp-exercise.js`), so a tile lit by that run is never read as
 * agent use. It arrives as the environment variable `CURATOR_MCP_VIA` on the
 * child, and an environment variable is a string somebody supplied — so the
 * ONLY value this module will ever write is the exact literal, matched with
 * `===`. Anything else, including a 10 KB value, leaves the field ABSENT.
 *
 * ABSENT means "an MCP client", never "an agent": nothing in this file can know
 * which client made a call, and a field that claimed to would be a fabrication.
 *
 * A self-test line is deliberately NOT counted toward
 * `sessions.lastBootstrapAt` / `lastSaveAt`. A self-test is not a session
 * start and did not save anyone's handoff, and those two readings are the one
 * strip the whole memory layer exists for — a false reading there is worse than
 * no reading.
 *
 * ── BEST-EFFORT, AND WHAT THAT COSTS ────────────────────────────────────────
 *
 * `appendUsage` never throws to its caller and is never awaited by the
 * dispatch handler: a tool call must not get slower, and must not fail,
 * because an observability file could not be written. The price, stated rather
 * than hidden: an append still in flight when the MCP child process exits is
 * LOST, and an unwritable log loses every line (with one stderr line per
 * process, never more — a message repeated per call would itself be the
 * defect, and stdout belongs to JSON-RPC framing; see the MCP stdout
 * discipline note in CLAUDE.md).
 *
 * ── SIZE ────────────────────────────────────────────────────────────────────
 *
 * At ~130 bytes a line, MAX_LOG_BYTES (1 MB) is ~8,000 calls. On overflow the
 * file is renamed to `<path>.1`, keeping exactly one previous generation, so
 * the feature is bounded at ~2 MB on disk and ~2 MB to parse. `logStartedAt`
 * is read from the OLDEST file present, which is what lets the map say "not
 * used since this log began" with a real age instead of the word "never".
 *
 * Appends are O_APPEND writes of ~130 bytes, well under PIPE_BUF, so two
 * processes appending concurrently interleave lines but never corrupt one.
 */

import { appendFile, rename, stat, readFile } from 'fs/promises';
import { getMcpUsageLogPath } from './paths.js';

/** Rotate at this size; one previous generation is kept as `<path>.1`. */
export const MAX_LOG_BYTES = 1024 * 1024;

/**
 * The line's keys, in emission order. The guard compares against this array.
 *
 * The first six are ALWAYS present. `via` is the one optional key and is
 * emitted last, so a line without it is byte-identical to every line written
 * before v3.61.0 — see LINE_KEYS_ALWAYS, which is what a reader should compare
 * an ordinary line against.
 */
export const LINE_KEYS = ['ts', 'tool', 'domain', 'ok', 'refused', 'ms', 'via'];

/** The six keys every line carries. `LINE_KEYS` minus the optional `via`. */
export const LINE_KEYS_ALWAYS = LINE_KEYS.slice(0, 6);

/** The only value `via` may ever hold. Matched with `===`, never a pattern. */
export const VIA_SELF_TEST = 'self-test';

/** The environment variable the app's exercise run sets on the MCP child. */
export const VIA_ENV_VAR = 'CURATOR_MCP_VIA';

/** Default recency window for `count7d`. */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What a tool name may look like. Anything else is logged as `unknown`.
 *
 * 32 characters: the longest real name is `scan_semantic_duplicates` at 24, so
 * this leaves eight characters of headroom for a tool nobody has written yet.
 *
 * It was 40 until v3.61.0, and the eight characters were given up to keep the
 * 200-byte ceiling a PROOF once `via` joined the line (see MAX_LINE_BYTES).
 * The trade is one-directional and cheap: a tool name over 32 characters is
 * logged as `unknown` — which is already what happens to a name over 40, and
 * to every name of any length that is not shaped like an identifier.
 */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * What a domain slug may look like. Deliberately a LOCAL copy rather than an
 * import of `mcp/util.js`'s isValidDomain: `src/brain/` must not depend on
 * `mcp/` (the dependency runs the other way), and this check exists to keep a
 * user string out of a file, not to decide whether a domain is addressable.
 *
 * It is NARROWER than isValidDomain, which allows 200 characters. That is a
 * deliberate trade, and it is the only place this module loses information: a
 * domain whose slug is longer than 48 characters is recorded as `null` rather
 * than lengthening the line. Written out, the bound is what makes the size
 * ceiling a PROOF rather than a test result — see MAX_LINE_BYTES.
 */
const DOMAIN_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

/**
 * The proven ceiling on one line, before the newline. Pinned by the guard.
 *
 * Every variable part of a line is bounded, so this is arithmetic and not a
 * measurement that happened to come out low:
 *
 *   {            1
 *   "ts":"…"    31   (5 + a 26-byte quoted ISO stamp)
 *   ,"tool":"…" 42   (8 + 2 quotes + 32, the TOOL_NAME_RE bound)
 *   ,"domain":… 60   (10 + 2 quotes + 48, the DOMAIN_SLUG_RE bound)
 *   ,"ok":false 11
 *   ,"refused": 15
 *   ,"ms":…     14   (6 + 8 digits, ms clamped at 86_400_000)
 *   ,"via":"…"  18   (the literal, or the field is absent)
 *   }            1
 *                ───
 *                193
 *
 * That is why TOOL_NAME_RE lost eight characters in v3.61.0: at the old bound
 * of 40 the worst line with `via` came to 201 and this number would have had to
 * move — and the app tells the user, in as many words, that a line stays under
 * 200 bytes however large the call was.
 */
export const MAX_LINE_BYTES = 200;

let _warnedThisProcess = false;

/** stderr, once per process. Never stdout — that is the JSON-RPC stream. */
function warnOnce(err) {
  if (_warnedThisProcess) return;
  _warnedThisProcess = true;
  const detail = (err && (err.code || err.message)) || 'unknown error';
  console.error(
    `[The Curator] MCP usage log could not be written (${detail}). ` +
    `Tool calls are unaffected; the Settings tool map will be incomplete.`,
  );
}

/** TEST-ONLY: re-arm the once-per-process stderr notice. */
export function __resetUsageWarning() {
  _warnedThisProcess = false;
}

/**
 * `via`, normalised to the one literal or to null.
 *
 * An `===` against the literal rather than a pattern: the value arrives from
 * an environment variable, and the set of legal values has exactly one member.
 * A pattern would be a place for a second member to be added without anyone
 * deciding that a second member is allowed in a content-free file.
 */
export function normaliseVia(v) {
  return v === VIA_SELF_TEST ? VIA_SELF_TEST : null;
}

/**
 * Read `via` off a process environment. Re-read per call, never snapshotted at
 * import: the same rule paths.js's getters follow, so a seam set after import
 * still wins and a test does not depend on module load order.
 */
export function viaFromEnv(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : null);
  return normaliseVia(e ? e[VIA_ENV_VAR] : null);
}

/** Build the one line this module will ever write. Total function — no throw. */
export function buildUsageLine(entry, nowIso) {
  const e = entry || {};
  const tool = typeof e.tool === 'string' && TOOL_NAME_RE.test(e.tool) ? e.tool : 'unknown';
  const domain = typeof e.domain === 'string' && DOMAIN_SLUG_RE.test(e.domain) ? e.domain : null;
  let ms = Number(e.ms);
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  // Bounded so a broken clock cannot write an arbitrarily long number, which
  // is the only way a line could grow past the 200-byte ceiling the guard pins.
  ms = Math.min(Math.round(ms), 86_400_000);
  const rec = {
    ts: nowIso || new Date().toISOString(),
    tool,
    domain,
    ok: e.ok === true,
    refused: e.refused === true,
    ms,
  };
  // LAST, and only when it is the literal. Assigning `via: null` unconditionally
  // would change every ordinary line's key set for no reader's benefit, and the
  // guard compares that set exactly.
  const via = normaliseVia(e.via);
  if (via) rec.via = via;
  return JSON.stringify(rec);
}

/**
 * Append one usage record. Fire-and-forget: returns a promise that ALWAYS
 * resolves, so a caller may ignore it without risking an unhandled rejection.
 * Never throws, synchronously or otherwise.
 */
export async function appendUsage(entry) {
  try {
    const file = getMcpUsageLogPath();
    // `via` comes from the CHILD'S ENVIRONMENT, not from the dispatch handler:
    // the handler knows which tool ran, and only the process that spawned this
    // one knows why. An entry may still carry it (that is the in-process seam
    // the suites drive) and an explicit value wins.
    const via = entry && entry.via !== undefined ? entry.via : viaFromEnv();
    const line = `${buildUsageLine({ ...(entry || {}), via })}\n`;
    // Rotate BEFORE appending, so the new line always lands in a file under
    // the cap. Statting per call rather than tracking the size in memory: the
    // app and the MCP child are separate processes over one file, and an
    // in-memory count in either of them is wrong the moment the other writes.
    // A stat is ~0.1 ms and this whole function is off the response path.
    try {
      const st = await stat(file);
      if (st.size >= MAX_LOG_BYTES) await rename(file, `${file}.1`);
    } catch { /* absent (first append) or unstattable — appendFile decides */ }
    await appendFile(file, line, 'utf8');
  } catch (err) {
    warnOnce(err);
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

// Parsed lines, cached on the identity of the two files (mtime + size of each,
// and whether each exists). Nothing else invalidates it, because nothing else
// can change a file: this is the same "no invalidation logic to get wrong"
// shape as files.js's logDateCache and v3.57.0's health-scan signature.
let _cache = null;   // { key, lines }

function fileKeyPart(st) {
  return st ? `${st.mtimeMs}:${st.size}` : 'absent';
}

async function statOrNull(file) {
  try { return await stat(file); } catch { return null; }
}

function parseLines(text) {
  const out = [];
  let malformed = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { malformed++; continue; }
    if (!rec || typeof rec !== 'object' || typeof rec.ts !== 'string') { malformed++; continue; }
    const t = Date.parse(rec.ts);
    if (!Number.isFinite(t)) { malformed++; continue; }
    out.push({
      ts: rec.ts,
      at: t,
      tool: typeof rec.tool === 'string' ? rec.tool : 'unknown',
      domain: typeof rec.domain === 'string' ? rec.domain : null,
      ok: rec.ok === true,
      refused: rec.refused === true,
      ms: Number.isFinite(rec.ms) ? rec.ms : 0,
      // Normalised on READ as well as on write. A line on disk can have been
      // hand-edited or written by a future version, and everything downstream
      // of here treats `via` as a two-state fact.
      via: normaliseVia(rec.via),
    });
  }
  return { records: out, malformed };
}

/**
 * Read the log and aggregate it per tool.
 *
 *   {
 *     present, path, logBytes, logStartedAt, lineCount, malformedLines,
 *     byTool: { <name>: {lastUsedAt, lastOk, lastVia, count7d, countTotal,
 *                        refusedTotal, selfTestTotal} },
 *     sessions: { lastBootstrapAt, lastSaveAt },   // self-test lines EXCLUDED
 *   }
 *
 * `logStartedAt` comes from the first parseable line of the OLDEST file
 * present (`.1` when it exists), which is the value the map needs to say "not
 * used since this log began" honestly — the app must never claim a tool has
 * NEVER been used when all it knows is that this file does not mention it.
 *
 * Options: `now` (clock seam, ms), `since` (ms/ISO/Date — the recency window
 * for `count7d`; defaults to now − 7 days), `noCache`.
 */
export async function readUsage(opts = {}) {
  const file = getMcpUsageLogPath();
  const prev = `${file}.1`;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let since = opts.since;
  if (since instanceof Date) since = since.getTime();
  else if (typeof since === 'string') since = Date.parse(since);
  if (!Number.isFinite(since)) since = now - RECENT_WINDOW_MS;

  const [stMain, stPrev] = await Promise.all([statOrNull(file), statOrNull(prev)]);
  const key = `${fileKeyPart(stPrev)}|${fileKeyPart(stMain)}`;

  let lines;
  let malformedLines;
  if (!opts.noCache && _cache && _cache.key === key) {
    lines = _cache.lines;
    malformedLines = _cache.malformed;
  } else {
    const records = [];
    let malformed = 0;
    // Oldest file first, so `logStartedAt` is the first record overall.
    for (const f of [stPrev ? prev : null, stMain ? file : null]) {
      if (!f) continue;
      let text;
      try { text = await readFile(f, 'utf8'); } catch { continue; }
      const parsed = parseLines(text);
      records.push(...parsed.records);
      malformed += parsed.malformed;
    }
    lines = records;
    malformedLines = malformed;
    _cache = { key, lines, malformed };
  }

  const present = !!(stMain || stPrev);
  const logBytes = (stMain ? stMain.size : 0) + (stPrev ? stPrev.size : 0);

  const byTool = Object.create(null);
  let lastBootstrapAt = null;
  let lastSaveAt = null;
  for (const r of lines) {
    let agg = byTool[r.tool];
    if (!agg) {
      agg = byTool[r.tool] = {
        lastUsedAt: null, lastOk: null, lastVia: null,
        count7d: 0, countTotal: 0, refusedTotal: 0, selfTestTotal: 0,
      };
    }
    agg.countTotal++;
    if (r.refused) agg.refusedTotal++;
    if (r.via === VIA_SELF_TEST) agg.selfTestTotal++;
    if (r.at >= since) agg.count7d++;
    if (agg.lastUsedAt === null || r.at >= Date.parse(agg.lastUsedAt)) {
      agg.lastUsedAt = r.ts;
      agg.lastOk = r.ok;
      // The NEWEST line's `via`, which is what the tile's marker reads: the
      // question a marker answers is "is the reading above it mine or my
      // agent's", and the reading above it is the newest call.
      agg.lastVia = r.via;
    }
    // ── THE TWO SESSION READINGS SKIP SELF-TEST LINES ──────────────────────
    // A self-test is not a session start and saved nobody's handoff. Counting
    // it here would make "Last session start · 2 min" true of a button the
    // user pressed on this screen, on the one strip the memory layer exists
    // for — a false reading is worse than no reading (v3.15.0's rule, and
    // v3.60.0 built this strip precisely to answer the question honestly).
    if (r.via === VIA_SELF_TEST) continue;
    // A session STARTED when an agent bootstrapped its context. Either tool
    // does it — get_project_context is v3.59.0's one-call bootstrap and
    // get_working_state was the way before it, and a user on an older skill
    // still starts sessions with the latter.
    if (r.tool === 'get_project_context' || r.tool === 'get_working_state') {
      if (!lastBootstrapAt || r.at >= Date.parse(lastBootstrapAt)) lastBootstrapAt = r.ts;
    }
    if (r.tool === 'save_working_state') {
      if (!lastSaveAt || r.at >= Date.parse(lastSaveAt)) lastSaveAt = r.ts;
    }
  }

  return {
    present,
    path: file,
    logBytes,
    logStartedAt: lines.length ? lines[0].ts : null,
    lineCount: lines.length,
    malformedLines,
    byTool,
    sessions: { lastBootstrapAt, lastSaveAt },
  };
}

/** TEST-ONLY: drop the parsed-line cache. */
export function __clearUsageCache() {
  _cache = null;
}
