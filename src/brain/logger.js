/**
 * src/brain/logger.js — the app's own log file.
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
 * The Curator has never had a logger of its own. `/tmp/the-curator.log`
 * exists only because `scripts/build-app.sh` and `install.sh` redirect the
 * whole process's stdout/stderr into it with a shell `>>` — there is no
 * `createWriteStream`, no logging library, nothing in `src/` that owns that
 * file. `src/server.js`'s own comments already talk about it as if the app
 * wrote it ("a user asking why is my OpenRouter model list short gets the
 * answer in /tmp/the-curator.log"), and `docs/mac-app.md` /
 * `docs/user-guide.md` tell users to read it — but the AppleScript wrapper
 * that produces it does not survive the macOS packaging pivot (a signed
 * bundle is not launched via `nohup ... >> file`), so the whole support story
 * disappears exactly when debugging a bundle on someone else's Mac starts to
 * matter. This module is the real thing the comments were describing.
 *
 * ── WHERE IT WRITES, AND WHY IT DOES NOT FORK ON INSTALL MODE ────────────────
 * `getLogsDir()` in paths.js always resolves to `~/Library/Logs/The Curator/`
 * — see that function's own docblock for why this deliberately does NOT
 * follow getUserDataDir()'s repo-vs-bundle split. Short version: a repo
 * install is still a live git working tree, and this project has already
 * shipped machine-local operational files landing inside a tracked/synced
 * tree by mistake twice (`.DS_Store`, `.write-lock`). A log file is exhaust,
 * not user data, so it gets the OS-conventional home in both install modes.
 *
 * ── IT CAN NEVER BREAK THE APP ────────────────────────────────────────────────
 * Same rule this project already applies to `ingest-activity.js` and the raw
 * -source manifest: a bookkeeping side-channel must never be able to break
 * the thing it is describing. Every exported function swallows its own
 * errors and returns nothing a caller has to check. `logError`/`logWarn`/
 * `logInfo` are deliberately synchronous (`appendFileSync`, not a promise a
 * caller could forget to `.catch`) — the whole call, including the directory
 * check, the rotation check and the write, is wrapped in ONE try/catch, so
 * the worst case for a caller is silence, never a throw and never an
 * unhandled rejection.
 *
 * ── STDOUT DISCIPLINE ─────────────────────────────────────────────────────────
 * This module writes to a FILE only. It never writes to stdout or stderr —
 * not even on its own internal failure — so it stays safe to import from
 * anywhere, including a module someday reachable from the MCP child process,
 * where stdout is reserved for JSON-RPC frames (see CLAUDE.md's MCP stdout
 * discipline rule). Today nothing in mcp/'s import graph reaches this module;
 * the constraint is honoured anyway because it costs nothing and a future
 * import site should not have to remember to re-check it.
 *
 * ── BOUNDED, NOT UNBOUNDED ───────────────────────────────────────────────────
 * A long-running local app with no cap on its own log is a disk-fill bug
 * waiting to happen. Single-generation rotation: the active file is capped at
 * MAX_LOG_BYTES (checked before each write); crossing it renames the current
 * file to `curator.log.1` (replacing any previous backup) and starts a fresh
 * one. Ceiling: MAX_LOG_BYTES × 2. A second numbered generation was
 * considered and rejected — this log exists so a user (or the maintainer,
 * reading a pasted excerpt) can answer "what just happened", not to be an
 * audit trail; one rotation keeps recent context available across the
 * boundary without the unbounded growth that ships with most naive loggers.
 *
 * ── WHAT IS LOGGED, AND WHAT DELIBERATELY IS NOT ─────────────────────────────
 * Candidates named in the brief: errors, provider failures, update outcomes,
 * startup facts. This module is intentionally policy-free about WHAT gets
 * logged — that decision belongs to each call site — but every call site
 * wired up in this pass is on the low-frequency, high-signal side of that
 * line: server startup (version/provider/port), bind retries/failures,
 * restart/update outcomes, and the System Check "live API" probe's failures.
 * Nothing here logs per-request traffic — an Express access-log line for
 * every GET would turn a support file into noise within a day on a chatty
 * client (the frontend polls several endpoints), which is worse than no log
 * at all for the "what just happened" question this exists to answer.
 *
 * ── SECRETS AND PATHS NEVER REACH THE FILE ───────────────────────────────────
 * Every line passes through `scrubPaths` (the ONE existing absolute-path
 * scrubber — imported, not re-implemented; see scrub-paths.js) and then
 * `scrubSecrets` (this module's own credential-shaped-string scrubber,
 * exported for the audit trail this class of bug always eventually needs).
 * `scrubSecrets`'s patterns are the SAME shapes this repo's own pre-commit
 * hook (`.git/hooks/pre-commit`) refuses to let into the public tree —
 * chosen deliberately, so "credential-shaped" means one thing project-wide
 * rather than two lists that can quietly drift apart. This is defense in
 * depth: today's call sites only ever pass short, hand-composed strings
 * (never a raw error object, never file contents), but a future call site
 * that interpolates one should not be able to leak a live key just because
 * nobody remembered to scrub it first.
 *
 * ── NOT ENFORCED (stated, not hidden) ───────────────────────────────────────
 *  - scrubPaths' own documented limits apply here too (an unquoted path with
 *    an unusually long space-separated folder name can partially survive).
 *  - scrubSecrets matches known credential SHAPES. A secret that matches none
 *    of them (an opaque internal id, a password with no recognisable prefix)
 *    is not caught by pattern-matching alone — callers still must not hand
 *    this module raw file contents or raw config objects.
 *  - Rotation is SIZE-triggered, checked lazily before each write. A single
 *    call site pathologically logging in a tight loop could, in principle,
 *    keep the active file briefly larger than MAX_LOG_BYTES between the
 *    check and the write of one line — bounded by one line's length, not
 *    unbounded growth.
 *  - Nothing here is synced. The log lives outside getUserDataDir() and
 *    outside getDomainsDir() on purpose (this is per-MACHINE operational
 *    exhaust, the same reasoning `getIngestQueueDir()` already documents for
 *    the batch queue), so it never appears in Personal Sync and never needs
 *    a `.gitignore` entry.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { getLogsDir } from './paths.js';
import { scrubPaths } from './scrub-paths.js';

export const LOG_FILE_NAME = 'curator.log';
export const LOG_BACKUP_FILE_NAME = 'curator.log.1';

/**
 * Cap on the ACTIVE log file, checked before each write. 5 MB holds many
 * thousands of the short, infrequent lines this module actually emits (see
 * the "what is logged" note above) while still bounding worst-case disk use
 * to MAX_LOG_BYTES x 2 (active + one rotated backup) even under a bug that
 * logs far more than intended.
 */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

// Test-only override so a suite can force a rotation in milliseconds instead
// of writing megabytes of filler. Production never sets this.
let _maxLogBytesOverride = null;
export function __setMaxLogBytesOverride(n) {
  _maxLogBytesOverride = (typeof n === 'number' && n > 0) ? n : null;
}
function maxLogBytes() {
  return _maxLogBytesOverride || MAX_LOG_BYTES;
}

/**
 * Credential-shaped patterns, deliberately kept IN SYNC with this repo's own
 * `.git/hooks/pre-commit` secret guard (see that file's PATTERN variable) —
 * the project already has one definition of "looks like a real key" and this
 * reuses it rather than inventing a second that could quietly diverge.
 * `Bearer <token>` and a bare `sk-` prefix are added on top as defense in
 * depth for shapes the hook doesn't need to catch (it scans SOURCE, this
 * scans RUNTIME strings that can legitimately contain an echoed HTTP header
 * or an upstream provider's own error text).
 */
const SECRET_LOG_PATTERNS = [
  /AIza[0-9A-Za-z_-]{35}/g,                                    // Gemini / Google API key
  /sk-ant-[0-9A-Za-z_-]{20,}/g,                                 // Anthropic key
  /sk-or-v1-[0-9A-Za-z_-]{20,}/g,                               // OpenRouter key
  /(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[0-9A-Za-z_]{20,}/g, // GitHub PAT (all prefix forms)
  /sbat_[0-9a-f]{40}/g,                                         // Shared Brain admin token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9._~+/=-]{16,}/g,                               // any other sk-* bearer-style key
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,                         // Authorization: Bearer <token>
];

/** URL-embedded basic-auth credentials: scheme://user:TOKEN@host. */
const URL_CREDENTIALS_RE = /:\/\/[^\s/@]+:[^\s/@]+@/g;

/**
 * Redact credential-shaped substrings. Exported so a suite (or a future
 * caller building its own message) can prove a given string is clean before
 * it reaches this module, the same "prove the scrubber, don't just trust it"
 * pattern `redactOpenRouterSecrets` already documents for the OpenRouter
 * adapter's own error surface.
 */
export function scrubSecrets(value) {
  if (typeof value !== 'string' || !value) return value;
  let out = value;
  for (const re of SECRET_LOG_PATTERNS) out = out.replace(re, '[redacted]');
  out = out.replace(URL_CREDENTIALS_RE, '://[redacted]@');
  return out;
}

function logFilePath() {
  return path.join(getLogsDir(), LOG_FILE_NAME);
}

// Remembers the last directory we successfully mkdir'd, so a normal run does
// not stat+mkdir on every single log line. Keyed by the resolved path itself
// (not a boolean) so switching test overrides — a different tempdir per
// suite section — is detected and re-verified rather than silently reusing a
// stale "already ensured" flag from a previous, now-irrelevant directory.
let _ensuredDir = null;
function ensureDir(dir) {
  if (_ensuredDir === dir) return true;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    _ensuredDir = dir;
    return true;
  } catch {
    return false;
  }
}

/** Best-effort single-generation rotation. Never throws. */
function rotateIfNeeded(file) {
  try {
    const st = statSync(file);
    if (st.size < maxLogBytes()) return;
  } catch {
    return; // file does not exist yet — nothing to rotate
  }
  const backup = file + '.1';
  try { unlinkSync(backup); } catch { /* no previous backup — fine */ }
  try { renameSync(file, backup); } catch { /* best-effort; fall through and keep appending */ }
}

function composeLine(level, scope, message) {
  const ts = new Date().toISOString();
  const safeScope = String(scope || 'app').replace(/[\s[\]]/g, '_') || 'app';
  const safeMessage = scrubSecrets(scrubPaths(String(message == null ? '' : message)));
  // Newlines inside a single record would let one write masquerade as
  // several lines (or corrupt the one before it visually) — collapse them
  // rather than reject the call, since a caller composing an error message
  // from a multi-line upstream response is a normal, not hostile, case.
  const flat = safeMessage.replace(/\r?\n+/g, ' ⏎ ');
  return `${ts} [${level}] [${safeScope}] ${flat}\n`;
}

/** The one function that touches the filesystem. Never throws. */
function writeLine(level, scope, message) {
  try {
    const dir = getLogsDir();
    if (!ensureDir(dir)) return;
    const file = path.join(dir, LOG_FILE_NAME);
    rotateIfNeeded(file);
    appendFileSync(file, composeLine(level, scope, message), { mode: 0o600 });
  } catch {
    // Worst case: silence. A logging failure must never surface as an
    // application failure — see the module docblock.
  }
}

/** @param {string} scope short source tag, e.g. 'server', 'diagnostics' */
export function logError(scope, message) { writeLine('error', scope, message); }
export function logWarn(scope, message)  { writeLine('warn', scope, message); }
export function logInfo(scope, message)  { writeLine('info', scope, message); }

/** Absolute path to the log file, for the System Check "reveal" affordance. */
export function getLogFilePath() {
  return logFilePath();
}

/**
 * Best-effort stats for the System Check panel — never throws, returns null
 * when the file doesn't exist yet or can't be read (e.g. a blocked dir).
 */
export function getLogFileStats() {
  try {
    const file = logFilePath();
    if (!existsSync(file)) return null;
    const st = statSync(file);
    return { path: file, bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}
