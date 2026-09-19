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
 *   {"ts":"…","tool":"get_node","domain":"articles","ok":true,"refused":false,"ms":12,"sid":"9f2c…"}
 *
 * Those SEVEN keys, in that order, plus TWO optional ones — `project`
 * (v3.63.0) and `via` (v3.61.0), whose only legal value is the literal
 * `"self-test"` — and nothing else, EVER. No arguments, no results, no file
 * paths, no error text, no user prose. Two reasons, and the second is the one
 * that binds:
 *
 *   1. A search query, a slug, a conversation title or a handoff body is the
 *      user's content. This file is not a place for content. `search_wiki`'s
 *      `query` alone would turn the log into a record of what the user was
 *      thinking about, on disk, forever.
 *   2. The map this feeds is shown in the app as "kept on this machine only,
 *      no arguments or content logged". A claim made to a user in the product
 *      is a contract; `scripts/test-mcp-usage.js` asserts the line's key SET
 *      and that a call carrying a 10 KB argument still leaves a line under
 *      MAX_LINE_BYTES, so the contract cannot rot by accident.
 *
 * The `tool` name is checked against a strict shape and replaced with
 * `"unknown"` otherwise — a caller can name any tool it likes over JSON-RPC,
 * and an unknown NAME is a user-supplied string. The domain is checked the
 * same way and dropped to `null` when it does not look like a slug.
 *
 * ── v3.63.0: `sid`, `project`, AND A SECOND KIND OF LINE ────────────────────
 *
 * The log could say WHAT was called and WHEN. It could not say which calls
 * belonged to ONE session, which PROJECT they were about, or which harness
 * made them — so it could not answer the one question the memory layer exists
 * for: did this session start with the bootstrap, and did it save before it
 * stopped. Three facts were missing; each is one bounded field.
 *
 *   `sid`     — a MINTED RANDOM id, 12 hex characters, once per BRIDGE
 *               PROCESS, on every tool line. A session IS one bridge process.
 *               Not a pid (the OS recycles them, and two processes sharing one
 *               inside a log generation would MERGE into a session that read
 *               and saved when in fact two sessions each did half — a wrong
 *               reading on the one strip this feeds, which is worse than no
 *               reading). Not a silence heuristic (a session that idles forty
 *               minutes and then saves would count as two, one of which "did
 *               not save": a guess presented as a measurement). Not the
 *               harness's own session id (only a hook can see it, and it is a
 *               value the harness chose).
 *
 *   `project` — the resolved project slug, when the call carries one; ABSENT
 *               otherwise. THIS IS A DELIBERATE WIDENING of a file the product
 *               calls content-free, from one user-chosen slug to two, and it
 *               was taken rather than assumed: the meter's page is PER
 *               PROJECT, and a per-project page showing a figure silently
 *               aggregated over every project in the domain would be a false
 *               reading on exactly the strip this exists to make honest. A
 *               folder name the owner chose is the same KIND of thing
 *               `domain` already is. It is still not content: no argument, no
 *               query, no title, no body.
 *
 *   `client`  — WHICH HARNESS. It does NOT ride the tool line. It rides ONE
 *               `{"ev":"session"}` line per process, written lazily in the
 *               same append as that process's FIRST tool line:
 *
 *                 {"ts":"…","ev":"session","sid":"9f2c…","client":"codex"}
 *
 *               Once per process rather than once per call because the value
 *               is constant for the process and ~8,000 copies of a 32-byte
 *               label per log generation buys nothing. Lazily, because a
 *               process that connects and calls nothing has no session worth
 *               recording — and because a client that never sends
 *               `notifications/initialized` still gets a session line this way.
 *
 *               The value is ALLOW-LISTED through `mcp-clients.js` and written
 *               as a canonical id or `other`, NEVER verbatim: it is a string
 *               the client chose, the observed values are unstable (Copilot
 *               CLI renamed itself inside six months; Cline reports two names
 *               at once), and MCP revision 2026-07-28 — which REMOVED the
 *               `initialize` handshake and made `clientInfo` an optional,
 *               per-request, self-reported `_meta` entry — says a server
 *               SHOULD NOT change behaviour or security decisions on it.
 *               NOTHING in this codebase branches on it. It is a label on a
 *               report, and a suite greps `mcp/**` to keep it that way.
 *
 * A LINE WRITTEN BEFORE v3.63.0 HAS NO `sid`. It is not malformed and is not
 * dropped: it is a LEGACY line, counted in `summariseSessions`'s `legacyLines`
 * and never as a session, because a session it cannot identify is a session it
 * must not invent. This is the one place the v3.61.0 byte-identity property
 * ends, and it ends knowingly.
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
 * At ~150 bytes a line, MAX_LOG_BYTES (1 MB) is ~7,000 calls. On overflow the
 * file is renamed to `<path>.1`, keeping exactly one previous generation, so
 * the feature is bounded at ~2 MB on disk and ~2 MB to parse. `logStartedAt`
 * is read from the OLDEST file present, which is what lets the map say "not
 * used since this log began" with a real age instead of the word "never".
 *
 * Appends are O_APPEND writes of ~150 bytes — or, on the first call of a
 * process, ONE write carrying the session line AND the first tool line, worst
 * case 131 + 291 = 422 bytes — still under PIPE_BUF, so two processes
 * appending concurrently interleave whole writes but never corrupt one. That
 * one-write shape is also what guarantees a process's session line lands
 * BEFORE its first tool line without any ordering machinery.
 *
 * ROTATION AND THE SESSION LINE, stated rather than discovered: a process
 * whose session line has been rotated out of both generations while its tool
 * lines survive loses its client label. The summariser reports `client: null`
 * for that sid — "no session line for this id", which is a different fact from
 * `other` ("a name we did not recognise") and is kept different.
 */

import { randomBytes } from 'crypto';
import { appendFile, rename, stat, readFile } from 'fs/promises';
import { getMcpUsageLogPath } from './paths.js';
import { labelForClient, normaliseStoredClient } from './mcp-clients.js';

/** Rotate at this size; one previous generation is kept as `<path>.1`. */
export const MAX_LOG_BYTES = 1024 * 1024;

/**
 * A TOOL line's keys, in emission order. The guard compares against this array.
 *
 * The first SEVEN are always present. `project` and `via` are the two optional
 * keys and are emitted last, in that order, so an ordinary line differs from a
 * v3.61.0 line by exactly one added key (`sid`) and a line that names no
 * project carries no `project` key at all — absent, never null, which is the
 * v3.61.0 rule for `via` applied to the new field for the same reason: a key
 * set is a contract and an always-present null is a second thing to explain.
 */
export const LINE_KEYS = ['ts', 'tool', 'domain', 'ok', 'refused', 'ms', 'sid', 'project', 'via'];

/** The seven keys every tool line carries. `LINE_KEYS` minus the optionals. */
export const LINE_KEYS_ALWAYS = LINE_KEYS.slice(0, 7);

/** The two keys a tool line carries only when there is something to say. */
export const LINE_KEYS_OPTIONAL = LINE_KEYS.slice(7);

/** The SESSION line's keys, in emission order. `via` is optional here too. */
export const SESSION_LINE_KEYS = ['ts', 'ev', 'sid', 'client', 'via'];

/** The only value `ev` may hold, and the only line kind that is not a call. */
export const SESSION_EV = 'session';

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
 * byte ceiling a PROOF once `via` joined the line (see MAX_LINE_BYTES). The
 * ceiling has since moved to 300 for v3.63.0's `sid`/`project`, but the bound
 * stays: eight characters of headroom is plenty, and widening it again would
 * put the arithmetic back in play for nothing.
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
 * What a PROJECT slug may look like. A LOCAL copy of `working-state.js`'s
 * `SEGMENT_RE` + its 64-character `isSafeSegment` ceiling, for the same reason
 * DOMAIN_SLUG_RE is a local copy: this module sits on the MCP child's import
 * graph and must not drag the store in behind it, and the check exists to keep
 * a user string out of a file rather than to decide whether a project is
 * addressable.
 *
 * Unlike the domain bound, this one is NOT narrower than the store's. It is
 * exactly 64 because a project slug the meter cannot name is a meter that
 * cannot say which project it is about — the four-byte saving would buy a
 * reading nobody can act on. The ceiling below absorbs the cost instead.
 */
const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * THE SESSION ID. Minted ONCE, at module load, for the life of this process.
 *
 * 12 hex characters = 48 bits. Birthday bound n²/2^49 over one log generation:
 * at 1,000 sessions ≈ 1.8 × 10⁻¹², at 5,000 ≈ 4.4 × 10⁻¹¹. The 8-hex
 * alternative costs four fewer bytes and gives ≈ 5.8 × 10⁻⁵ at 1,000 — small,
 * but a collision MERGES two sessions and is INVISIBLE, and this is the strip
 * whose entire purpose is to not report a false reading. Four bytes on a local
 * file that rotates at 1 MB is not a price worth the ambiguity.
 *
 * `crypto.randomBytes`, not `Math.random`: this is an identifier that must not
 * repeat, and the cost is one 6-byte draw per process.
 *
 * It is NOT re-readable from the environment and NOT resettable in production.
 * A test that needs two different ids spawns two processes — which is the
 * property being asserted anyway.
 */
let _sid = randomBytes(6).toString('hex');

/** The shape a `sid` must have to be read back off disk as a session. */
export const SID_RE = /^[0-9a-f]{12}$/;

/** This process's session id. One bridge process is one session. */
export function getSessionId() {
  return _sid;
}

/** TEST-ONLY: mint a fresh id, as a new process would. Never called in production. */
export function __newSessionIdForTest() {
  _sid = randomBytes(6).toString('hex');
  _sessionLinePending = true;
  return _sid;
}

/**
 * The proven ceiling on one line, before the newline. Pinned by the guard.
 *
 * Every variable part of a line is bounded, so this is arithmetic and not a
 * measurement that happened to come out low. The WORST TOOL LINE:
 *
 *   {              1
 *   "ts":"…"      31   (5 + a 26-byte quoted ISO stamp)
 *   ,"tool":"…"   42   (8 + 2 quotes + 32, the TOOL_NAME_RE bound)
 *   ,"domain":…   60   (10 + 2 quotes + 48, the DOMAIN_SLUG_RE bound)
 *   ,"ok":false   11
 *   ,"refused":…  15
 *   ,"ms":…       14   (6 + 8 digits, ms clamped at 86_400_000)
 *   ,"sid":"…"    21   (7 + 2 quotes + 12, SID_RE)
 *   ,"project":…  77   (11 + 2 quotes + 64, PROJECT_SLUG_RE)
 *   ,"via":"…"    18   (the literal, or the field is absent)
 *   }              1
 *                 ───
 *                 291
 *
 * …and the worst SESSION line, which the same ceiling covers:
 *
 *   { + "ts" + ,"ev":"session" + ,"sid" + ,"client":"…" + ,"via" + }
 *   1 +  31  +      15         +   21   + 44 (10+2+32)  +  18   + 1  = 131
 *
 * **THIS NUMBER MOVED IN v3.63.0: 200 → 300**, and it had to. `sid` is 21
 * bytes and `project` is 77, so the v3.61.0 worst case of 193 becomes 291
 * whatever else is traded away — there is no arrangement of these fields that
 * fits 200. What was NOT done to save bytes, and must not be: narrowing
 * DOMAIN_SLUG_RE or bounding `project` below the store's own 64. Either drops
 * a REAL name to null, and a meter that cannot name the project it is about is
 * not a meter. The file is local and rotates at 1 MB; a hundred bytes on the
 * worst line costs nothing anybody can feel.
 *
 * ** A USER-VISIBLE SENTENCE DEPENDS ON THIS NUMBER. ** The MCP bridge page's
 * privacy ⓘ states the ceiling in as many words, and a figure the product
 * tells a user is a contract. When this constant moves, that sentence and the
 * docs that quote it move with it — MAX_LINE_BYTES_LABEL exists so a view can
 * derive the number instead of typing it a second time.
 */
export const MAX_LINE_BYTES = 300;

/** The ceiling in the words a user reads. Derived, never typed twice. */
export const MAX_LINE_BYTES_LABEL = `${MAX_LINE_BYTES} bytes`;

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

/** Build the one tool line this module will ever write. Total function — no throw. */
export function buildUsageLine(entry, nowIso) {
  const e = entry || {};
  const tool = typeof e.tool === 'string' && TOOL_NAME_RE.test(e.tool) ? e.tool : 'unknown';
  const domain = typeof e.domain === 'string' && DOMAIN_SLUG_RE.test(e.domain) ? e.domain : null;
  let ms = Number(e.ms);
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  // Bounded so a broken clock cannot write an arbitrarily long number, which
  // is the only way a line could grow past the byte ceiling the guard pins.
  ms = Math.min(Math.round(ms), 86_400_000);
  const rec = {
    ts: nowIso || new Date().toISOString(),
    tool,
    domain,
    ok: e.ok === true,
    refused: e.refused === true,
    ms,
    // ALWAYS present from v3.63.0 on. An entry may name one (the in-process
    // seam the suites drive); otherwise it is this process's id. A supplied
    // value that is not 12 lowercase hex is not a sid — it falls back to this
    // process's own rather than being written, because a sid is the KEY the
    // meter groups on and a forged one merges two sessions.
    sid: typeof e.sid === 'string' && SID_RE.test(e.sid) ? e.sid : _sid,
  };
  // The two optional keys, in LINE_KEYS order. Absent, never null — same rule
  // and same reason as `via` in v3.61.0: the guard compares the key set
  // exactly, and a key that is always there carrying nothing is a key that has
  // to be explained to every reader of the file.
  const project = typeof e.project === 'string' && PROJECT_SLUG_RE.test(e.project) ? e.project : null;
  if (project) rec.project = project;
  const via = normaliseVia(e.via);
  if (via) rec.via = via;
  return JSON.stringify(rec);
}

/**
 * Build the ONE session line a process writes. Total function — no throw.
 *
 * `client` is ALWAYS present and is ALWAYS an allow-list result: a canonical
 * harness id, or the literal `other`. The caller's string never reaches disk.
 */
export function buildSessionLine(entry, nowIso) {
  const e = entry || {};
  const rec = {
    ts: nowIso || new Date().toISOString(),
    ev: SESSION_EV,
    sid: typeof e.sid === 'string' && SID_RE.test(e.sid) ? e.sid : _sid,
    client: labelForClient(e.client),
  };
  const via = normaliseVia(e.via);
  if (via) rec.via = via;
  return JSON.stringify(rec);
}

/**
 * Has this process already written its session line?
 *
 * Set SYNCHRONOUSLY at the top of the first `appendUsage`, before any `await`
 * — the rule v3.3.0's ingest queue records in as many words ("do not fix a
 * concurrency report by adding another check after an await; that narrows the
 * window rather than closing it"). Two tool calls dispatched in the same tick
 * therefore produce exactly one session line.
 */
let _sessionLinePending = true;

/** TEST-ONLY: re-arm the session line, as a fresh process would. */
export function __resetSessionLine() {
  _sessionLinePending = true;
}

/**
 * Append one usage record. Fire-and-forget: returns a promise that ALWAYS
 * resolves, so a caller may ignore it without risking an unhandled rejection.
 * Never throws, synchronously or otherwise.
 *
 * On a process's FIRST call this writes TWO lines in ONE `appendFile`: the
 * session line, then the tool line. One write, so the order is guaranteed
 * without any ordering machinery and the O_APPEND atomicity argument still
 * holds (worst case 131 + 291 + 2 newlines = 424 bytes, under PIPE_BUF).
 */
export async function appendUsage(entry) {
  // SYNCHRONOUS claim — see _sessionLinePending. Nothing may await above this.
  const writeSession = _sessionLinePending;
  if (writeSession) _sessionLinePending = false;
  try {
    const file = getMcpUsageLogPath();
    // `via` comes from the CHILD'S ENVIRONMENT, not from the dispatch handler:
    // the handler knows which tool ran, and only the process that spawned this
    // one knows why. An entry may still carry it (that is the in-process seam
    // the suites drive) and an explicit value wins.
    const via = entry && entry.via !== undefined ? entry.via : viaFromEnv();
    const toolLine = `${buildUsageLine({ ...(entry || {}), via })}\n`;
    const sessionLine = writeSession
      ? `${buildSessionLine({ sid: (entry && entry.sid) || _sid, client: entry && entry.client, via })}\n`
      : '';
    // Rotate BEFORE appending, so the new line always lands in a file under
    // the cap. Statting per call rather than tracking the size in memory: the
    // app and the MCP child are separate processes over one file, and an
    // in-memory count in either of them is wrong the moment the other writes.
    // A stat is ~0.1 ms and this whole function is off the response path.
    try {
      const st = await stat(file);
      if (st.size >= MAX_LOG_BYTES) await rename(file, `${file}.1`);
    } catch { /* absent (first append) or unstattable — appendFile decides */ }
    await appendFile(file, sessionLine + toolLine, 'utf8');
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
    // Normalised on READ as well as on write — for `via`, `sid` and `client`
    // alike. A line on disk can have been hand-edited or written by a future
    // version, and everything downstream treats these as settled facts.
    const via = normaliseVia(rec.via);
    const sid = typeof rec.sid === 'string' && SID_RE.test(rec.sid) ? rec.sid : null;
    if (rec.ev === SESSION_EV) {
      // A SESSION line. It is not a call: it has no tool, contributes to no
      // tile, and must never reach `byTool`. A session line with no usable
      // sid is useless (nothing can join to it) and is dropped as malformed.
      if (!sid) { malformed++; continue; }
      out.push({
        ts: rec.ts, at: t, ev: SESSION_EV, sid, via,
        // The allow-list runs on read too, so a hand-edited or future-written
        // client name cannot put an arbitrary string in front of a reader.
        // `normaliseStoredClient`, NOT `labelForClient`: what is on the line is
        // already a canonical id, and most ids are not also raw keys, so the
        // write-side function would quietly re-label `codex` as `other`.
        client: normaliseStoredClient(rec.client),
      });
      continue;
    }
    out.push({
      ts: rec.ts,
      at: t,
      tool: typeof rec.tool === 'string' ? rec.tool : 'unknown',
      domain: typeof rec.domain === 'string' ? rec.domain : null,
      ok: rec.ok === true,
      refused: rec.refused === true,
      ms: Number.isFinite(rec.ms) ? rec.ms : 0,
      via,
      // null on a line written before v3.63.0 — a LEGACY line, never a session.
      sid,
      project: typeof rec.project === 'string' && PROJECT_SLUG_RE.test(rec.project) ? rec.project : null,
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
  // SESSION LINES ARE NOT CALLS. They carry no tool, so counting them would
  // invent a tile named `unknown` and inflate `lineCount`, which the app
  // reports as "calls recorded". `logStartedAt` above deliberately still comes
  // from the first record of EITHER kind: it answers "when did this file
  // begin", and a session line is a line in the file.
  const toolLines = lines.filter((r) => r.ev !== SESSION_EV);
  const sessionLineCount = lines.length - toolLines.length;
  for (const r of toolLines) {
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
    lineCount: toolLines.length,
    sessionLineCount,
    malformedLines,
    byTool,
    sessions: { lastBootstrapAt, lastSaveAt },
  };
}

/**
 * The parsed log, for a caller that wants the SESSIONS rather than the tiles.
 *
 * `GET /api/memory/:domain/:project/capture` is that caller. It is given the
 * records and `summariseSessions` rather than a finished figure, so the
 * reading stays a pure function of the file and can be driven over a
 * hand-built log with no filesystem at all.
 *
 * Shares `readUsage`'s cache and its file identity key, so the capture route
 * and the tool map never re-read the same bytes.
 */
export async function readUsageLines(opts = {}) {
  const file = getMcpUsageLogPath();
  const prev = `${file}.1`;
  const [stMain, stPrev] = await Promise.all([statOrNull(file), statOrNull(prev)]);
  const key = `${fileKeyPart(stPrev)}|${fileKeyPart(stMain)}`;
  if (!opts.noCache && _cache && _cache.key === key) {
    return {
      present: !!(stMain || stPrev), path: file,
      records: _cache.lines, malformedLines: _cache.malformed,
    };
  }
  const records = [];
  let malformed = 0;
  for (const f of [stPrev ? prev : null, stMain ? file : null]) {
    if (!f) continue;
    let text;
    try { text = await readFile(f, 'utf8'); } catch { continue; }
    const parsed = parseLines(text);
    records.push(...parsed.records);
    malformed += parsed.malformed;
  }
  _cache = { key, lines: records, malformed };
  return { present: !!(stMain || stPrev), path: file, records, malformedLines: malformed };
}

/**
 * THE HONESTY METER, as a pure function.
 *
 *   summariseSessions(records, {project, since, now}) →
 *     {
 *       sessions: [{sid, client, startedAt, endedAt, calls, read, saved, project}],
 *       totals:   {sessions, sessionsRead, sessionsSaved, sessionsReadNotSaved,
 *                  legacyLines, selfTestLines},
 *     }
 *
 * `records` is what `readUsageLines` returns (tool lines and session lines
 * mixed); a raw array of JSON objects works too, since every field is
 * re-checked here. Nothing is read from disk and nothing is written.
 *
 * ── THE DEFINITIONS, AND WHY EACH IS THE ONE IT IS ──────────────────────────
 *
 *   sessions — DISTINCT `sid`. One bridge process is one session (Decision H).
 *   read     — `get_project_context` or `get_working_state` answered `ok: true`
 *              at ANY POINT BEFORE that session's FIRST `save_working_state`.
 *              Not "as the first call": an agent that calls `list_projects`
 *              first and bootstraps second HAS bootstrapped, and requiring the
 *              literal first call would report a false negative on the
 *              continuity skill's own three-step ritual.
 *   saved    — `save_working_state` answered `ok: true`. `ok: true` is required
 *              deliberately in both: a REFUSED save is not a save, and the log
 *              already tells a refusal from a throw.
 *
 * ── WHAT IS EXCLUDED, AND WHAT THAT PROTECTS ────────────────────────────────
 *
 *   `via: 'self-test'` — tool AND session lines. The app's own "Test all N
 *   tools" button calls `get_project_context` and `save_working_state`; if
 *   those counted, pressing a button on the Settings screen would report a
 *   session that read and saved. That is the defect `via` was invented to
 *   prevent and it is prevented here too.
 *
 *   LINES WITH NO `sid` — every line written before v3.63.0. They are counted
 *   in `legacyLines` and never as a session, because the alternative is
 *   inventing sessions out of lines that cannot be grouped. A reader can say
 *   "this log predates the meter" from that number; it must never say
 *   "0 sessions saved" about calls it simply cannot group.
 *
 * ── THE THREE STATES A CALLER MUST BE ABLE TO TELL APART ────────────────────
 *
 *   no session ran         → totals.sessions === 0. Not a failure.
 *   ran and did not save   → sessionsReadNotSaved / sessions − sessionsSaved.
 *   ran and saved          → sessionsSaved / sessions.
 *
 * ── WHAT IT CANNOT SEE, stated rather than discovered ───────────────────────
 *
 *   A session's END is inferred as its LAST line; nothing writes an end
 *   marker, because the bridge process is usually killed. `client` is `null`
 *   — not `other` — when no session line exists for that sid, which happens
 *   when the session line has been rotated away or its append was in flight
 *   when the child exited. And a `curator context` read from the CLI opens no
 *   bridge, so it appends nothing here and is correctly not a session: if it
 *   ever did append, every hook-wired harness would read as "read" and the
 *   denominator would grow by sessions that never opened a bridge — the meter
 *   would be measuring its own instrument.
 *
 * `since` (ms / ISO / Date) keeps a session whose lines include ANY line at or
 * after the boundary, and then reads that session WHOLE. Counting only the
 * lines inside the window would report a session that bootstrapped eight days
 * ago and saved today as "did not read", which is false about the session.
 */
export function summariseSessions(records, opts = {}) {
  const list = Array.isArray(records) ? records : (records && records.records) || [];
  const wantProject = typeof opts.project === 'string' && opts.project ? opts.project : null;
  let since = opts.since;
  if (since instanceof Date) since = since.getTime();
  else if (typeof since === 'string') since = Date.parse(since);
  if (!Number.isFinite(since)) since = null;

  const bySid = new Map();
  const clients = new Map();
  let legacyLines = 0;
  let selfTestLines = 0;

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const at = Number.isFinite(raw.at) ? raw.at : Date.parse(raw.ts);
    if (!Number.isFinite(at)) continue;
    const via = normaliseVia(raw.via);
    if (via === VIA_SELF_TEST) { selfTestLines++; continue; }
    const sid = typeof raw.sid === 'string' && SID_RE.test(raw.sid) ? raw.sid : null;

    if (raw.ev === SESSION_EV) {
      // The client carrier. It names no project, so it is never filtered by
      // one — it is joined to whichever sessions survive the filter below.
      if (sid && !clients.has(sid)) clients.set(sid, normaliseStoredClient(raw.client));
      continue;
    }

    // COUNTED BEFORE THE PROJECT FILTER, on purpose: a legacy line carries no
    // project and never could, so filtering it out first would report
    // `legacyLines: 0` on a log that is entirely pre-v3.63.0 and leave a
    // caller unable to tell "no sessions" from "this log predates the meter".
    // The number is therefore about the LOG, not about one project, and the
    // ⓘ says so.
    if (!sid) { legacyLines++; continue; }
    const project = typeof raw.project === 'string' && PROJECT_SLUG_RE.test(raw.project) ? raw.project : null;
    if (wantProject && project !== wantProject) continue;

    let s = bySid.get(sid);
    if (!s) {
      s = {
        sid, startedAt: at, endedAt: at, calls: 0,
        firstSaveAt: null, firstReadAt: null, saved: false,
        project, inWindow: false,
      };
      bySid.set(sid, s);
    }
    s.calls++;
    if (at < s.startedAt) s.startedAt = at;
    if (at > s.endedAt) s.endedAt = at;
    if (since === null || at >= since) s.inWindow = true;
    // The latest project seen wins when a session touched more than one and
    // no filter was given; with a filter every surviving line carries it.
    if (project) s.project = project;
    const okCall = raw.ok === true;
    if (okCall && (raw.tool === 'get_project_context' || raw.tool === 'get_working_state')) {
      if (s.firstReadAt === null || at < s.firstReadAt) s.firstReadAt = at;
    }
    if (okCall && raw.tool === 'save_working_state') {
      s.saved = true;
      if (s.firstSaveAt === null || at < s.firstSaveAt) s.firstSaveAt = at;
    }
  }

  const sessions = [];
  for (const s of bySid.values()) {
    if (!s.inWindow) continue;
    sessions.push({
      sid: s.sid,
      // null, NOT 'other': "no session line for this id" is a different fact
      // from "a name we did not recognise", and the two must stay different.
      client: clients.has(s.sid) ? clients.get(s.sid) : null,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: new Date(s.endedAt).toISOString(),
      calls: s.calls,
      read: s.firstReadAt !== null && (s.firstSaveAt === null || s.firstReadAt < s.firstSaveAt),
      saved: s.saved,
      project: s.project,
    });
  }
  // Newest first — the view lists "the last N sessions".
  sessions.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));

  const sessionsRead = sessions.filter((s) => s.read).length;
  const sessionsSaved = sessions.filter((s) => s.saved).length;
  return {
    sessions,
    totals: {
      sessions: sessions.length,
      sessionsRead,
      sessionsSaved,
      sessionsReadNotSaved: sessions.filter((s) => s.read && !s.saved).length,
      legacyLines,
      selfTestLines,
    },
  };
}

/** TEST-ONLY: drop the parsed-line cache. */
export function __clearUsageCache() {
  _cache = null;
}
