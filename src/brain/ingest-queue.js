/**
 * Batch-ingest queue (Track 3) — server-owned, disk-persisted, strictly
 * sequential worker for ingesting many files into one domain as a single,
 * resumable operation.
 *
 * ── Why a queue, and why these specific guarantees ──────────────────────────
 *
 * Today's `POST /api/ingest` (src/routes/ingest.js) handles ONE file per
 * request, browser-driven. A 30-file batch means 30 manual uploads, and a
 * closed tab kills whatever was in flight. This module makes that one
 * durable, resumable server-side operation instead.
 *
 * Four properties are CORRECTNESS requirements, not conveniences:
 *
 *   1. STRICTLY SEQUENTIAL. `ingestFile` snapshots the domain's existing
 *      entity/concept filenames ONCE at the start of a call. Two concurrent
 *      ingests both see "openai.md doesn't exist" and both create it —
 *      parallelism here manufactures duplicate pages, not just slower
 *      output. One item at a time, one job at a time, process-wide.
 *   2. DURABLE STAGING. `ingestFile(domain, filePath, ...)` reads `filePath`
 *      once. multer writes uploads to the OS temp dir, which the OS may
 *      clean and which does not survive an app restart. Every uploaded file
 *      is copied into this module's own staging directory at job-creation
 *      time, BEFORE the create call returns — otherwise "resume after a
 *      crash" has no bytes to resume from.
 *   3. A RATE LIMIT PAUSES THE BATCH; IT DOES NOT FAIL THE ITEM. llm.js
 *      already retries 429/503 four times with backoff before giving up. If
 *      that reaches here, the provider is saying stop, not "this one file is
 *      bad" — continuing would fail items N+1..end identically in seconds.
 *   4. NEVER AUTO-START SPEND. A job interrupted by a crash/restart recovers
 *      to `paused`; nothing here ever calls startOrResumeJob() on its own.
 *
 * ── Duplicate handling — decided ONCE, at creation, never at run time ───────
 *
 * `ingestFile` writes the source into `raw/<name>` as its FIRST internal step
 * (see src/brain/ingest.js), before any LLM work. So an item interrupted
 * mid-ingest has ALREADY created `raw/<name>` by the time a crash recovers it
 * back to `pending`. A duplicate check performed AT EXECUTION TIME would see
 * that file, mark the resumed item `skipped`, and silently drop the very
 * content the crash interrupted — reporting success while the file is gone.
 *
 * The fix: duplicates are decided EXACTLY ONCE, in `createJob`, against the
 * domain's `raw/` state as it exists before the batch starts. An item found
 * to be a pre-existing duplicate (and `overwrite` is false) is marked
 * `skipped` on the manifest at creation time and is NEVER staged. The worker
 * (`processItem`) performs NO duplicate check of its own — it only ever asks
 * "is this item's status `pending`?" This makes the resume path immune to the
 * failure above by construction: an item that legitimately started ingesting
 * is not a "duplicate" by any definition the worker uses.
 *
 * ── Transient-error classification ───────────────────────────────────────────
 *
 * `classifyTransientError` reads a structured `err.curatorTransient` tag set
 * by llm.js's `generateText` when it exhausts its own 429/503 retries (see
 * llm.js — the message TEXT there is unchanged, only two properties were
 * added). If that tag is lost because a caller re-wrapped the error, a
 * message-text fallback catches it too — but NOT via a bare `/\b429\b/`
 * word-boundary regex as an earlier draft of this design proposed. That regex
 * matches inside "yielded only 429 characters of text" (ingest.js's genuine,
 * unrelated MIN_TEXT_LEN error) just as readily as inside "(HTTP 429)" —
 * word boundaries surround digits the same way whether or not "HTTP"
 * precedes them. The fallback here requires "HTTP 429"/"HTTP 503"
 * specifically (still a regex, still not `.includes`), which a re-wrapped
 * message preserves (e.g. `Ingest failed: ${originalErr.message}` keeps the
 * "(HTTP 429)" substring) while the false-positive case does not contain it.
 * See scripts/test-ingest-queue.js's transient-classifier section, which
 * pins the "429 characters of text" case explicitly.
 *
 * Belt-and-braces on top of classification: a CONSECUTIVE-FAILURE CIRCUIT
 * BREAKER pauses the job after CONSECUTIVE_FAILURE_LIMIT items in a row fail
 * for ANY reason, correctly classified or not. This is the real protection —
 * it bounds "burn the rest of the batch in seconds" regardless of whether a
 * given provider error string was recognised.
 *
 * ── How guarantee 1 (strict sequentiality) is actually enforced ─────────────
 *
 * Not by "check a flag, then do some work, then set the flag" — that shape
 * shipped here once and was WRONG. `startOrResumeJob` read `_runningJobId`,
 * then performed three awaits (a domain re-validation that lists every
 * domain and reads each CLAUDE.md, plus two manifest writes) before setting
 * it. Two requests landing inside that window BOTH saw `null` and BOTH
 * started a worker loop: reproduced at 3 items ingesting concurrently, one
 * document written to log.md three times, and the job reporting `done` while
 * two items were still `running`. Double-clicking Resume was enough. The
 * per-domain `.write-lock` did not save it either — `acquireFileLock` is
 * `existsSync` -> `writeFileAtomic` with no `O_EXCL`, so two callers racing
 * through the same window both "acquire" it.
 *
 * The rule now, and the reason it is a rule rather than a convention:
 *
 *   THE CLAIM IS TAKEN SYNCHRONOUSLY. `claimSync` reads and writes the claim
 *   registry in ONE synchronous turn, with no `await` between the two. Node
 *   is single-threaded, so a synchronous check-and-set is genuinely atomic
 *   and a second caller cannot interleave. Anything with an `await` between
 *   check and set is not atomic, and adding MORE checks after the awaits only
 *   narrows the window — it does not close it.
 *
 * Two claims exist, both through the same `claimSync`/`releaseClaim` pair:
 * `worker` (at most one worker loop, process-wide, keyed by job id) and
 * `create` (at most one `createJob` in flight, which is what makes its
 * read-active-job / stage / write sequence effectively serialised — three
 * concurrent creates previously produced three active jobs on disk).
 *
 * Underneath both sits `assertSoleIngest`, the invariant itself rather than a
 * proxy for it: a synchronous in-flight counter incremented immediately
 * before, and decremented immediately after, the ONE `ingestFileImpl` call in
 * this module. If it is ever greater than 1 the call throws instead of
 * running. That is what "strictly sequential" MEANS, checked where it means
 * it, independent of how a caller reached that line.
 *
 * ── How guarantee 5 (no item is ever lost) is enforced ──────────────────────
 *
 * An item left in `running` with no worker executing it used to be invisible
 * to all three places that could have caught it: `recoverOnBoot` gated on the
 * JOB's status so a stranded item under a non-running job was skipped, the
 * worker loop only ever selected `pending` items, and `finishJobDone` wrote
 * `done` without checking that every item had reached a terminal state. The
 * observable result was a 3-file batch reporting "2 done, 0 failed, 0
 * skipped" — a file in none of the three buckets, `ingestFile` never called
 * for it, and a green summary over a silently dropped document.
 *
 * Rather than patch those three sites independently, there is now ONE
 * invariant, enforced in one place:
 *
 *   NO ITEM MAY BE `running` WHILE NO WORKER IS EXECUTING IT, AND A JOB MAY
 *   NOT BE `done` WHILE ANY ITEM IS NON-TERMINAL.
 *
 * `reclaimStrandedItems` restores the first half (running -> pending) and is
 * called at the top of every worker-loop iteration, inside the single settle
 * chokepoint, and on boot recovery. `settleJob` — through which EVERY exit
 * from `running` now passes — enforces the second half as a tripwire: asked
 * to write `done` while an item is non-terminal, it refuses and settles
 * `paused` instead. Because the reclaim runs first, the tripwire should never
 * fire; it exists so that if it ever does, the failure is a visible pause
 * with work left to do, never a false report of success.
 *
 * ── KNOWN, NOT FIXED — recorded so nobody rediscovers them as surprises ────
 *
 * 1. A FILENAME CONTAINING A RAW DOUBLE QUOTE IS SILENTLY DROPPED. It breaks
 *    the `Content-Disposition` header mid-parse, so busboy yields a different
 *    (or no) file and the request still returns HTTP 200 `ok:true` with that
 *    file simply ABSENT from `items` — no `rejected` entry, no warning. The
 *    failure is in the multipart parse, upstream of every line of this module,
 *    so `createJob`'s per-item isolation cannot see it.
 *    Reachability, both halves: a BROWSER cannot lose a file this way — the
 *    WHATWG form serialisation escapes `"` to `%22` — but a SCRIPTED client
 *    that builds its own multipart body CAN, and it loses the file silently.
 *    The same applies to a NUL byte in a filename, which fails the parse
 *    outright (`Malformed part header`) and rejects the whole batch with a 400
 *    naming the likely cause; NUL is not a legal filename byte on any
 *    mainstream filesystem, so no file picker can produce it.
 *
 * 3. UPSTREAM FRAGILITY (not this module's, not fixed here): `appendLog` in
 *    src/brain/files.js reads `wiki/log.md` with NO existence check, unlike
 *    `readIndex` two lines below it, which guards with `existsSync`. On a
 *    domain whose `log.md` is missing, a full ingest COMPLETES — real LLM
 *    spend, all pages written to disk — and then throws `ENOENT` at the final
 *    logging step, so the queue marks the item `failed` with a cryptic error
 *    while its pages are already on disk and correct. If you are reading this
 *    because you hit that error: the pages are fine, create an empty
 *    `wiki/log.md` and re-run.
 *    Deliberately NOT fixed here: `files.js` is shared ingest code, the
 *    single-file ingest route fails identically, so it is not a queue defect,
 *    and this release must not expand into it. It is also not reachable by any
 *    documented path — `createDomain()` writes `log.md`, and docs/domains.md
 *    instructs manual users to create it — so it takes a hand-built domain.
 *
 * 2. `MAX_WIRE_STRING` TRUNCATES A LONG `pausedMessage`. The H1 tripwire's
 *    message enumerates every unfinished filename, so on a batch large enough
 *    for that list to exceed the cap the tail is replaced with
 *    "… (truncated)". Cosmetic only — the authoritative per-item state is in
 *    `items[]`, which the UI renders from — and the cap is deliberate: it is
 *    what bounds a 48 MB manifest to a sane response.
 */

import { mkdir, readdir, readFile, rm, copyFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';

import { getIngestQueueDir } from './paths.js';
import {
  listDomains,
  isDomainReadonly,
  domainPath,
  rawPath,
  wikiPath,
  readIndex,
  getDomainStats,
} from './files.js';
import { scrubPaths } from './scrub-paths.js';
import { writeFileAtomic } from './atomic-write.js';
import { registerWrite, acquireFileLock, isUpdateInProgress } from './write-registry.js';
import {
  ingestFile as realIngestFile,
  capExistingFilesForPrompt,
  makeUsageAccumulator,
  __testing as ingestTesting,
} from './ingest.js';
import { getProviderInfo, getModelPrice, isFreeModel, isAbortError, isOfferableModel } from './llm.js';
import { scanWiki } from './health.js';

const { buildPrompt, buildOutlinePrompt, buildBatchPromptParts, TEXT_CAP } = ingestTesting;

// ── Constants ────────────────────────────────────────────────────────────────

const QUEUE_MANIFEST_VERSION = 1;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Any 3 items in a row fail, for any reason — pause the batch. See docblock. */
export const CONSECUTIVE_FAILURE_LIMIT = 3;

const MAX_JOBS_LISTED = 20;

/**
 * Terminal job directories beyond this many are deleted (oldest `updatedAt`
 * first) at the end of every successful `createJob`. Without this, every job
 * directory — and every staged file belonging to an item that did not
 * SUCCEED, up to 50 MB each — persisted forever, and `listJobs`/`getActiveJob`
 * read every manifest on disk on every poll of the Ingest tab.
 */
const MAX_JOBS_RETAINED = 20;

/**
 * Hard bound on how many job directories any single scan will read manifests
 * for. Pruning keeps the real number far below this; this is the backstop for
 * a queue dir that somehow accumulated thousands (a pre-pruning install, or a
 * user hand-copying directories in), so that a poll of /active can never turn
 * into an unbounded disk walk.
 */
const MAX_JOB_DIRS_SCANNED = 200;

/** Response-size bounds for `toWire` — see its docblock. */
const MAX_WIRE_ITEMS = 500;
const MAX_WIRE_STRING = 2000;

/**
 * Longest staged basename we will write, BEFORE the `<idx>-` prefix. macOS
 * (and most Linux filesystems) cap a single path component at 255 bytes, so a
 * legal 254-character upload plus a `12-` prefix overflows and `copyFile`
 * throws ENAMETOOLONG — which used to abort the entire batch with a 500 and
 * two absolute paths in the body. Truncating (extension preserved) makes the
 * legal-but-long case simply work; the untruncatable remainder is handled
 * per-item, not per-batch. The staged name is an internal handle only —
 * `item.name` keeps the real filename for display and for raw/.
 */
const MAX_STAGED_BASENAME = 180;

/** Mirrors routes/ingest.js's multer fileFilter — kept in sync by hand. */
const ACCEPTED_EXTENSIONS = new Set(['.txt', '.md', '.pdf']);
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * `/estimate` takes metadata only, so nothing upstream bounds how many
 * entries a caller can send — 10,000 were accepted, each one running the real
 * prompt-assembly code against the domain's full inventory. Matches the
 * route's own MAX_FILES_PER_BATCH, since a batch larger than that could never
 * be created anyway.
 */
const MAX_ESTIMATE_FILES = 100;

/**
 * Mirrors the PRIVATE `MULTI_PHASE_INPUT_THRESHOLD` constant in
 * src/brain/ingest.js (grep-verified 2026-08-23, not exported — this module
 * is not permitted to edit ingest.js to export it). If that constant ever
 * changes, this estimate's single-pass/multi-phase split drifts until this
 * copy is updated by hand. Documented rather than silently risked.
 */
const MULTI_PHASE_INPUT_THRESHOLD = 15_000;

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'failed']);

// ── Transient-error classification ──────────────────────────────────────────

/**
 * ENFORCED: every pattern is anchored on the literal token "HTTP" followed by
 * the status code. NOT a loose keyword list.
 *
 * An earlier version of this table carried four unanchored patterns —
 * `/Too Many Requests/i`, `/RESOURCE_EXHAUSTED/i`, `/temporarily overloaded/i`
 * and `/Service Unavailable/i` — while the docblock above advertised the
 * narrow `\bHTTP\s+429\b` anchoring. The anchoring covered two of six. The
 * gap is reachable and its consequence is an inescapable loop, not a cosmetic
 * mislabel: ingest.js's genuine errors quote the FILENAME back
 * (`"<name>" yielded only N characters of text`), so a file called
 * `Service Unavailable.pdf` that fails extraction is classified transient,
 * pauses the whole batch, and pauses again on every Resume, forever.
 *
 * The four are simply removed rather than re-anchored: llm.js's own thrown
 * errors are the only real source, and BOTH of them set the structured
 * `curatorTransient` tag AND contain the literal "(HTTP 429)"/"(HTTP 503)"
 * (grep-verified in llm.js, the two `e.curatorTransient = ...` sites). The
 * tag is the primary signal; this text fallback exists only for a caller that
 * re-wraps the error and loses the properties, and such a wrap
 * (`Ingest failed: ${err.message}`) preserves the "(HTTP nnn)" substring.
 *
 * NOT ENFORCED, stated rather than hidden: a filename containing the literal
 * text "HTTP 429" would still false-positive on the text fallback. That is
 * why `classifyTransientError` takes an optional `ignore` string — the worker
 * passes the item's own filename, which is removed from the message before
 * matching, closing the filename vector for the errors this module raises.
 */
const TRANSIENT_PATTERNS = [
  [/\bHTTP\s+429\b/i, 'rate_limit'],
  [/\bHTTP\s+503\b/i, 'service_unavailable'],
];

/**
 * @param {unknown} err
 * @param {{ignore?: string}} [opts]  `ignore` is removed from the message
 *   before the text fallback runs — the worker passes the item's filename so
 *   a document NAMED after a provider error cannot masquerade as one.
 * @returns {'rate_limit'|'service_unavailable'|null}
 */
export function classifyTransientError(err, opts = {}) {
  if (!err) return null;
  if (err.curatorTransient === 'rate_limit' || err.curatorTransient === 'service_unavailable') {
    return err.curatorTransient;
  }
  let msg = typeof err.message === 'string' ? err.message : '';
  const ignore = typeof opts.ignore === 'string' ? opts.ignore : '';
  if (ignore && msg.includes(ignore)) msg = msg.split(ignore).join(' ');
  for (const [re, kind] of TRANSIENT_PATTERNS) {
    if (re.test(msg)) return kind;
  }
  return null;
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function jobDir(jobId) { return path.join(getIngestQueueDir(), jobId); }
function manifestPath(jobId) { return path.join(jobDir(jobId), 'manifest.json'); }
function filesDir(jobId) { return path.join(jobDir(jobId), 'files'); }

export function isValidJobId(id) {
  return typeof id === 'string' && JOB_ID_RE.test(id);
}

function statusErr(status, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = status;
  Object.assign(err, extra);
  return err;
}

/**
 * Money is accumulated at 6 decimal places, not 4. At 4, `round4(spent +
 * charge)` truncated any charge below $0.00005 straight to zero — so a long
 * batch of small items could run indefinitely with `spentUsd` frozen, which
 * is exactly the "the cap silently stops bounding anything" shape this
 * module is supposed to be immune to. 6 places keeps sub-cent charges; the
 * rounding exists at all only to stop float noise (0.30000000000000004)
 * reaching the manifest and the UI.
 */
function round6(n) { return Math.round(n * 1e6) / 1e6; }

// ── The absolute-path scrubber lives in its own leaf module ────────────────
// MOVED to ./scrub-paths.js, not copied: `llm.js` needs the same scrubber and
// this module imports `llm.js`, so importing it back would be a cycle (and
// would pull the whole queue into the MCP child's import graph). Re-exported
// here so every existing importer keeps its import path and there is still
// exactly ONE implementation. The measured reasoning — the two passes, and the
// BARE_PATH_SPACE_BRIDGE table — moved with it.
// Re-exported, not re-implemented. NOTE that a bare `export ... from` creates
// no LOCAL binding and this module calls scrubPaths itself at five sites, so
// the import above is load-bearing too — caught by test-ingest-queue.js going
// red with `scrubPaths is not defined`, not by reading.
export { scrubPaths };

/**
 * Basename-only, character-whitelisted. Defense in depth (belt-and-braces —
 * `filesDir(jobId)` is never derived from user input, so this cannot escape
 * on its own), matching the posture of writePage's isUnsafePagePath and
 * health.js's resolveInsideWiki elsewhere in this codebase.
 */
function sanitizeBaseName(name) {
  const base = path.basename(String(name || '')).replace(/[\\/]/g, '_');
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || 'file';
}

function stagedFileName(idx, originalName) {
  const base = sanitizeBaseName(originalName);
  if (base.length <= MAX_STAGED_BASENAME) return `${idx}-${base}`;
  // Preserve the extension — pdf-parse vs readFile is chosen by extension in
  // ingest.js, so a truncated name that lost ".pdf" would change how the
  // staged file is read. (item.name, which is what ingestFile is told the
  // file is called, is never truncated.)
  const ext = path.extname(base).slice(0, 16);
  const stem = base.slice(0, Math.max(1, MAX_STAGED_BASENAME - ext.length));
  return `${idx}-${stem}${ext}`;
}

// ── Synchronous claim registry — the sequentiality mutex ────────────────────
//
// See this module's docblock ("How guarantee 1 is actually enforced"). The
// ONLY correct use is: call `claimSync` and branch on its return value in the
// SAME synchronous turn. There must be no `await` between the read and the
// write, which is why this is one function and not a getter plus a setter.

/** @type {Map<string, string|true>} name -> holder token */
const _claims = new Map();

/**
 * Atomically (single synchronous turn) claim `name` for `token`.
 * @returns {null|string|true} `null` if the claim was taken by this call;
 *   otherwise the token of the EXISTING holder.
 */
function claimSync(name, token) {
  if (_claims.has(name)) return _claims.get(name);
  _claims.set(name, token);
  return null;
}

function releaseClaim(name, token) {
  if (_claims.get(name) === token) _claims.delete(name);
}

function currentClaim(name) {
  return _claims.has(name) ? _claims.get(name) : null;
}

/**
 * Resolves when the currently-running worker loop has fully exited. See
 * `startOrResumeJob` — a Resume arriving between "the manifest says paused"
 * and "the loop's finally released the claim" must WAIT for the loop rather
 * than silently no-op, which is what it used to do.
 */
let _workerSettled = Promise.resolve();

// ── The sequentiality invariant itself ──────────────────────────────────────

let _ingestInFlight = 0;
let _ingestMaxInFlight = 0;

/**
 * Guarantee 1, checked at the only place in this module that calls
 * `ingestFile`. `claimSync` makes a second worker loop unreachable; this
 * makes a second CONCURRENT INGEST detectable and fatal regardless of how a
 * caller got here — including through a future code path nobody has written
 * yet. Increment/check/decrement are synchronous around the single `await`.
 */
function enterIngest() {
  _ingestInFlight++;
  if (_ingestInFlight > _ingestMaxInFlight) _ingestMaxInFlight = _ingestInFlight;
  if (_ingestInFlight > 1) {
    _ingestInFlight--;
    throw new Error(
      'Refused to run two ingests at once. Batch ingest is strictly sequential — running two ' +
      'ingests of the same domain in parallel creates duplicate wiki pages, because each one ' +
      'snapshots the existing page list before the other has written to it. This is a bug in ' +
      'The Curator; nothing was ingested for this file.'
    );
  }
}

function exitIngest() {
  if (_ingestInFlight > 0) _ingestInFlight--;
}

// ── Manifest I/O ─────────────────────────────────────────────────────────────

/** Reads one job's manifest. Returns null on any problem — never throws. */
export async function getJob(jobId) {
  if (!isValidJobId(jobId)) return null;
  try {
    const raw = await readFile(manifestPath(jobId), 'utf8');
    const job = JSON.parse(raw);
    if (!job || typeof job !== 'object' || !Array.isArray(job.items)) return null;
    return job;
  } catch {
    return null;
  }
}

async function writeJob(job) {
  await mkdir(jobDir(job.jobId), { recursive: true });
  await writeFileAtomic(manifestPath(job.jobId), JSON.stringify(job, null, 2));
}

// ── The wire representation ─────────────────────────────────────────────────

function wireStr(v, max = MAX_WIRE_STRING) {
  // Anything that is not a string becomes null — a number or object landing
  // in a string slot is corrupt manifest data, not something to pass through.
  if (typeof v !== 'string') return null;
  const scrubbed = scrubPaths(v);
  return scrubbed.length > max ? scrubbed.slice(0, max) + '… (truncated)' : scrubbed;
}
function wireNum(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function wireBool(v) { return v === true; }

function wireCounts(counts) {
  if (!counts || typeof counts !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(counts)) {
    if (typeof k === 'string' && k.length <= 64 && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function wireItem(item) {
  if (!item || typeof item !== 'object') return null;
  const r = item.result;
  const u = item.tokenUsage;
  return {
    idx: wireNum(item.idx),
    name: wireStr(item.name, 512),
    bytes: wireNum(item.bytes),
    status: wireStr(item.status, 32),
    startedAt: wireStr(item.startedAt, 64),
    finishedAt: wireStr(item.finishedAt, 64),
    attempts: wireNum(item.attempts),
    error: wireStr(item.error),
    result: r && typeof r === 'object' ? {
      title: wireStr(r.title, 512),
      pagesWritten: wireNum(r.pagesWritten),
      warningCount: wireNum(r.warningCount),
      changeCounts: wireCounts(r.changeCounts),
    } : null,
    tokenUsage: u && typeof u === 'object' ? {
      provider: wireStr(u.provider, 64),
      model: wireStr(u.model, 128),
      calls: wireNum(u.calls),
      inputTokens: wireNum(u.inputTokens),
      outputTokens: wireNum(u.outputTokens),
      cachedReadTokens: wireNum(u.cachedReadTokens),
      cacheWriteTokens: wireNum(u.cacheWriteTokens),
    } : null,
  };
}

/**
 * THE single chokepoint between a manifest on disk and anything that reaches
 * HTTP — every route response and every SSE frame goes through it.
 *
 * Built as an explicit ALLOW-LIST, not a `...rest` spread with `stagedPath`
 * deleted. The spread form had two defects that a field-name blocklist
 * structurally cannot fix. First, it echoed every field it did not recognise,
 * so any future internal field would leak by DEFAULT and only stop leaking if
 * somebody remembered to add it to the strip list — the inverse of the
 * posture this data deserves. Second, it was unbounded: a 48 MB manifest came
 * back whole (a measured `GET /` response of 50,002,001 bytes).
 *
 * So: named fields only, every string scrubbed of absolute paths (see
 * `scrubPaths` — the `stagedPath` field was stripped while raw fs errors
 * carried absolute paths through `item.error` in prose) and length-capped,
 * every number validated, and the items array bounded. A normal batch is at
 * most MAX_FILES_PER_BATCH items, so the item cap never engages in practice;
 * it bounds a hand-planted or corrupted manifest.
 */
export function toWire(job) {
  if (!job || typeof job !== 'object') return job;
  const allItems = Array.isArray(job.items) ? job.items : [];
  const liveFlags = readControlFlags(job.jobId);
  const shown = allItems.slice(0, MAX_WIRE_ITEMS).map(wireItem).filter(Boolean);
  const est = job.estimate && typeof job.estimate === 'object' ? job.estimate : null;
  const health = job.health && typeof job.health === 'object' ? job.health : null;

  return {
    jobId: wireStr(job.jobId, 64),
    version: wireNum(job.version),
    domain: wireStr(job.domain, 256),
    createdAt: wireStr(job.createdAt, 64),
    updatedAt: wireStr(job.updatedAt, 64),
    status: wireStr(job.status, 32),
    pausedReason: wireStr(job.pausedReason, 64),
    pausedMessage: wireStr(job.pausedMessage),
    failReason: wireStr(job.failReason),
    overwrite: wireBool(job.overwrite),
    budgetUsd: wireNum(job.budgetUsd),
    spentUsd: wireNum(job.spentUsd),
    spendIsEstimated: wireBool(job.spendIsEstimated),
    spendIsLowerBound: wireBool(job.spendIsLowerBound),
    order: wireStr(job.order, 64),
    estimate: est ? {
      inputTokensLow: wireNum(est.inputTokensLow),
      inputTokensHigh: wireNum(est.inputTokensHigh),
      outputTokensLow: wireNum(est.outputTokensLow),
      outputTokensHigh: wireNum(est.outputTokensHigh),
      usdLow: wireNum(est.usdLow),
      usdHigh: wireNum(est.usdHigh),
      basis: wireStr(est.basis, 4000),
    } : null,
    currentIndex: wireNum(job.currentIndex),
    consecutiveFailures: wireNum(job.consecutiveFailures),
    // These two fields exist because a request can be PENDING for a short
    // window before the job settles, and the UI needs to show that.
    //
    // HISTORY, because this comment described the opposite behaviour for one
    // release and that is exactly how a stale docblock misleads the next
    // reader: cancel used to be honoured only BETWEEN items, so a batch kept
    // working on the in-flight file after the click — minutes, on a large
    // multi-phase document. These fields were added so the UI could at least
    // SAY so. Cancel now genuinely aborts the in-flight file (measured 334 s
    // -> 63-74 ms; see requestCancel and ingest.js's throwIfCancelled), so the
    // pending window is milliseconds rather than minutes — but it is still a
    // real window, a second tab still needs to see it, and pause STILL waits
    // for the current file by design. Read live, never persisted (see
    // readControlFlags).
    cancelRequested: liveFlags.cancelRequested,
    pauseRequested: liveFlags.pauseRequested,
    itemCount: allItems.length,
    itemsTruncated: allItems.length > shown.length,
    items: shown,
    health: health ? { scannedAt: wireStr(health.scannedAt, 64), counts: wireCounts(health.counts) } : null,
  };
}

/**
 * Every job-directory scan goes through here, so the MAX_JOB_DIRS_SCANNED
 * bound cannot be forgotten at one call site.
 */
async function listJobDirIds() {
  const dir = getIngestQueueDir();
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const ids = entries.filter(e => e.isDirectory() && isValidJobId(e.name)).map(e => e.name);
  if (ids.length > MAX_JOB_DIRS_SCANNED) {
    console.error(`[ingest-queue] ${ids.length} job directories present; scanning only ${MAX_JOB_DIRS_SCANNED}.`);
    return ids.slice(0, MAX_JOB_DIRS_SCANNED);
  }
  return ids;
}

export async function listJobs() {
  const jobs = [];
  for (const id of await listJobDirIds()) {
    const job = await getJob(id);
    if (job) jobs.push(job);
  }
  jobs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return jobs.slice(0, MAX_JOBS_LISTED);
}

/**
 * The one job that is not in a terminal state, if any. See create-time 409.
 *
 * Deliberately returns the OLDEST such job rather than whatever `readdir`
 * happened to yield first: before `createJob` took a synchronous claim, three
 * concurrent creates could leave three active jobs on disk, and an
 * arbitrary-order answer meant `/active` showed one of them while the others
 * stayed invisible yet still 409'd every new batch — the user had to discover
 * and clear them one at a time. Creation is serialised now, so this is for
 * pre-existing state; deterministic is still strictly better than arbitrary.
 */
export async function getActiveJob() {
  const active = [];
  for (const id of await listJobDirIds()) {
    const job = await getJob(id);
    if (job && !TERMINAL_STATUSES.has(job.status)) active.push(job);
  }
  if (active.length === 0) return null;
  active.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return active[0];
}

/**
 * Delete terminal job directories beyond MAX_JOBS_RETAINED, oldest first,
 * together with any staged files they still hold. Never touches a job that is
 * not terminal. Best-effort: a failure here must never fail a create.
 */
async function pruneOldJobs() {
  try {
    const terminal = [];
    for (const id of await listJobDirIds()) {
      const job = await getJob(id);
      if (job && TERMINAL_STATUSES.has(job.status)) terminal.push(job);
    }
    if (terminal.length <= MAX_JOBS_RETAINED) return 0;
    terminal.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    let pruned = 0;
    for (const job of terminal.slice(MAX_JOBS_RETAINED)) {
      if (currentClaim('worker') === job.jobId) continue;
      try { await rm(jobDir(job.jobId), { recursive: true, force: true }); pruned++; } catch { /* best-effort */ }
    }
    return pruned;
  } catch {
    return 0;
  }
}

// ── Domain validation (create AND every start/resume) ───────────────────────

/**
 * Same refusal text as routes/ingest.js's readonly-mirror check, for a
 * consistent user-facing message across both ingest surfaces.
 */
export async function assertDomainUsable(domain) {
  const domains = await listDomains();
  if (!domains.includes(domain)) {
    throw statusErr(400, `Unknown domain: ${domain}`);
  }
  if (await isDomainReadonly(domain)) {
    throw statusErr(400,
      `Domain "${domain}" is a read-only Shared Brain mirror — it is updated by "Pull updates" in the ` +
      `Sync tab, and direct writes would be overwritten on the next pull. Ingest into your personal ` +
      `opted-in domain instead, then push contributions from the Sync tab.`
    );
  }
}

// ── Cost estimate ────────────────────────────────────────────────────────────
//
// See this module's exported `estimateIngestQueueCost` for the full, cited
// derivation. Summary: this domain's REAL existing entity/concept filenames
// and REAL index.md are fed into ingest.js's actual prompt-building functions
// (via its __testing surface — the same functions ingestFile itself calls)
// with a synthetic filler source text of the estimated length. That gives an
// EXACT character count for what THIS domain's prompts would look like for a
// document of that size — not a guessed formula — which is what makes the
// estimate capture the dominant cost driver this feature exists to surface:
// cost scales with WIKI size, not document size (NEXT-PHASE-PLAN.md finding
// #3: the same 30-page PDF is ~188k input tokens on a fresh domain and ~416k
// on the real `articles` domain).

/** docs/ingestion-pipeline.md Stage 1c: "the single best estimate" of ~3.53 chars/token. */
const CHARS_PER_TOKEN = 3.53;

/**
 * Average OUTPUT tokens per LLM call, blended across an ingest. Derived (not
 * fabricated) from NEXT-PHASE-PLAN.md's real measurement: a 30-page PDF on
 * the mature `articles` domain costs ~416k input / ~35k output tokens. Any
 * substantial PDF reliably exceeds the 80,000-char TEXT_CAP (30 pages of
 * prose is typically well over 80k chars), which per
 * docs/ingestion-pipeline.md §8's own table lands on the "80k chars → 1
 * outline + 20 batches = 21 total calls" row. 35,000 / 21 ≈ 1,667
 * tokens/call. Applied uniformly to every call (outline and batch alike) —
 * a single blended average, not a per-phase model; see the full derivation
 * in this module's report / estimateIngestQueueCost's comment.
 */
const AVG_OUTPUT_TOKENS_PER_CALL = 1667;

/**
 * Total-LLM-call-count interpolation, built ONLY from cited real anchors in
 * docs/ingestion-pipeline.md §8 ("Performance characteristics"):
 *   <=12,000 chars  -> single-pass, 1 call
 *   >MULTI_PHASE_INPUT_THRESHOLD (15,000, mirrors ingest.js's own gate) -> multi-phase
 *   ~20,000 chars   -> 1 outline + 6 batches = 7 total calls
 *   ~55,000 chars   -> 1 outline + 14 batches = 15 total calls
 *   80,000 chars (TEXT_CAP) -> 1 outline + 20 batches = 21 total calls
 * The (15000, 2) knot is NOT from the table — it is a reasoned floor (the
 * smallest multi-phase outline plans at least one batch of up to
 * BATCH_SIZE=4 pages, so outline + 1 batch = 2 calls), used only to anchor
 * the interpolation's low end; flagged here so it is never mistaken for a
 * measured figure.
 */
function estimateCallCounts(chars) {
  if (chars <= MULTI_PHASE_INPUT_THRESHOLD) {
    return { mode: 'single-pass', totalCalls: 1, numBatches: 0 };
  }
  const knots = [[MULTI_PHASE_INPUT_THRESHOLD, 2], [20000, 7], [55000, 15], [80000, 21]];
  let totalCalls = knots[knots.length - 1][1];
  for (let i = 0; i < knots.length - 1; i++) {
    const [x0, y0] = knots[i];
    const [x1, y1] = knots[i + 1];
    if (chars <= x1) {
      totalCalls = Math.round(y0 + (y1 - y0) * ((chars - x0) / (x1 - x0)));
      break;
    }
  }
  return { mode: 'multi-phase', totalCalls, numBatches: totalCalls - 1 };
}

/**
 * Fraction of the RAW input-token cost that prompt caching removes, for a
 * file whose ingest will make `totalCalls` LLM calls. Cited anchors only
 * (CLAUDE.md v3.0.16 + docs/ingestion-pipeline.md Stage 1b):
 *   totalCalls=1 (single-pass)       -> 0%    (deliberately no cache breakpoint is ever set)
 *   totalCalls=4 (outline+3 batches) -> 30.3% ("the canonical multi-batch case")
 *   totalCalls=7 (outline+6 batches) -> 56%   ("rising to -56% at 7 batches")
 *   totalCalls>7                     -> capped at 56% — the only figure tied to
 *                                        an explicit batch count in the docs;
 *                                        other REAL Anthropic runs are cited as
 *                                        high as 71% (Stage 1b), so 56% is a
 *                                        deliberately conservative cap, not a
 *                                        true ceiling.
 * Linear between cited points; this is an interpolation of measured facts,
 * not a fitted curve.
 */
export function cachingSavingsFraction(totalCalls) {
  if (totalCalls <= 1) return 0;
  if (totalCalls >= 7) return 0.56;
  if (totalCalls <= 4) return 0.303 * ((totalCalls - 1) / 3);
  return 0.303 + (0.56 - 0.303) * ((totalCalls - 4) / 3);
}

function estimateOneFile({ f, promptFiles, index, today, price }) {
  // Size-based proxy for extracted text length — /estimate takes metadata
  // only (no file bytes, per the HTTP contract), so no real extraction
  // happens here. For .txt/.md this is close (bytes≈chars for ASCII-heavy
  // text). For .pdf, real extracted text is USUALLY SHORTER than the file's
  // byte size (embedded fonts, images, structural overhead) — using bytes
  // directly is a deliberately conservative choice: it is likely to
  // OVER-estimate chars (and therefore cost) for PDFs rather than
  // under-estimate, which is the safer direction for a cost gate. No
  // repo-measured PDF bytes-to-chars ratio exists to do better than this.
  // `f.size` is validated to a finite non-negative number by the caller (see
  // estimateIngestQueueCost's file loop). The clamp is belt-and-braces: a
  // negative value reaching `'x'.repeat()` throws a RangeError that surfaced
  // as an HTTP 500 (`{"error":"Invalid count value: -5000"}`).
  const chars = Math.max(0, Math.min(f.size, TEXT_CAP));
  const { mode, totalCalls, numBatches } = estimateCallCounts(chars);
  const syntheticText = 'x'.repeat(chars);
  const placeholderSummaryPath = 'summaries/estimate-placeholder.md';

  let promptChars;
  if (mode === 'single-pass') {
    const prompt = buildPrompt(today, index, promptFiles, f.name, syntheticText, false, false, placeholderSummaryPath);
    promptChars = prompt.length;
  } else {
    const outline = buildOutlinePrompt(today, index, promptFiles, f.name, syntheticText, false, placeholderSummaryPath);
    // pageBatch=[] and allOutlinePages=[] slightly UNDER-count the small
    // per-page listing in the suffix (a handful of short slugs, at most a
    // few hundred chars) — negligible next to the 80k-char source + 100k+
    // char inventory this prefix already carries. Documented, not silent.
    const batchParts = buildBatchPromptParts(today, f.name, syntheticText, [], promptFiles, []);
    const batchChars = batchParts.prefix.length + batchParts.suffix.length;
    promptChars = outline.length + numBatches * batchChars;
  }

  const inputTokens = Math.round(promptChars / CHARS_PER_TOKEN);
  const outputTokens = totalCalls * AVG_OUTPUT_TOKENS_PER_CALL;

  if (!price) {
    return { name: f.name, chars, mode, totalCalls, inputTokens, outputTokens, usdLow: null, usdHigh: null };
  }

  const usdHigh = (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
  const inputCostRaw = (inputTokens / 1e6) * price.input;
  const savings = cachingSavingsFraction(totalCalls);
  const usdLow = Math.max(0, usdHigh - inputCostRaw * savings);

  return { name: f.name, chars, mode, totalCalls, inputTokens, outputTokens, usdLow, usdHigh };
}

/**
 * ── DO NOT PUT A SINGLE COST MULTIPLE IN THIS STRING ───────────────────────
 *
 * There is no such number. The mature-vs-fresh ratio is dominated by the
 * FIXED per-call overhead (the index + the slug inventory, re-sent on every
 * call), so it collapses as the document grows. Measured 2026-08-24 against
 * the real 3,336-page `articles` domain and an empty domain, same estimator,
 * input tokens for one document:
 *
 *     doc size                fresh tok    mature tok     ratio
 *     2 KB  (tiny note)           1,837        72,443    39.4x
 *     5 KB  (short article)       2,707        73,313    27.1x
 *     15 KB (long article)       10,530       105,516    10.0x
 *     40 KB (chapter)           149,156       487,932     3.3x
 *     80 KB (TEXT_CAP)          493,115     1,051,302     2.1x
 *     200 KB (clamped to cap)   493,115     1,051,302     2.1x
 *
 *   THE MULTIPLIER IS SIZE-DEPENDENT AND RANGES FROM ~2x TO ~40x.
 *
 * 80 KB is the single most FAVOURABLE point on that curve — the one place a
 * "roughly twice" claim is true — and it is the point an earlier version of
 * this string was derived from, so a user batching short notes into a mature
 * wiki read "roughly twice" and paid 40x. A realistic mixed batch measured
 * 16.9x here and 8.8x on the coordinator's live run. Two revisions before
 * that, the same string quoted "~416k input tokens" for a case the estimator
 * computed at 1,051,302.
 *
 * ── AND `usdHigh` IS NOT A CEILING ─────────────────────────────────────────
 *
 * Measured on a completed live run — real `gemini-2.5-flash-lite`, an isolated
 * copy of the 3,336-page domain, 4 real documents plus one too short to ingest:
 *
 *     estimate usdLow–usdHigh : $0.014162 – $0.016703
 *     ACTUAL spentUsd         : $0.017225   (real tokenUsage, not estimated)
 *     actual / usdHigh        : 103.1%
 *
 * Actual spend came in 3.1% ABOVE `usdHigh`, on a run where Gemini's implicit
 * caching was active — so the gap is the underlying token model slightly
 * under-predicting the base cost, not the caching assumption being wrong.
 *
 * Do NOT tune a constant to close that 3%. Three percent is well inside what
 * is achievable for LLM cost estimation, and fitting an arithmetic constant to
 * one sample is precisely the mistake recorded above. The correct response is
 * the one taken here: stop the PROSE implying a bound it does not have.
 * `usdHigh` is the no-caching end of an estimate, not a cap.
 *
 * That is three times in one feature that ONE measured point became a general
 * claim. So: the generic multiple is gone and must not come back. What is
 * quoted instead is computed FOR THE BATCH IN FRONT OF US — `sizeMultiplier`,
 * the same files run through the same code against an empty domain — which is
 * correct at every point on the curve by construction. If you are about to
 * replace it with a constant you derived from a sample, this comment is
 * addressed to you.
 */
function buildBasisString({ domain, provider, model, price, stats, indexBytes, sizeMultiplier }) {
  const providerLabel = provider === 'gemini' ? 'Gemini' : provider === 'anthropic' ? 'Claude' : 'AI provider';
  const domainSize = stats
    ? `${stats.pageCounts?.entities ?? '?'} entities, ${stats.pageCounts?.concepts ?? '?'} concepts, ${(indexBytes / 1024).toFixed(0)} KB index`
    : 'a wiki whose current size could not be read';
  const priceNote = price ? '' : ' No published price is on file for this model, so a dollar figure cannot be shown — see MODEL_PRICES_USD_PER_MTOK in src/brain/llm.js.';

  // Quoted only when it was actually computed for these files AND the wiki is
  // big enough for the answer to mean anything. A near-empty domain yields
  // something like 1.0004x (its CLAUDE.md and index header are not nothing),
  // and telling the user "about 1.0x" is noise dressed as information. This is
  // a DISPLAY threshold only — the arithmetic above is untouched.
  const overheadNote = (typeof sizeMultiplier === 'number' && Number.isFinite(sizeMultiplier) && sizeMultiplier >= 1.05)
    ? ` For THIS batch, that existing content works out to about ${sizeMultiplier >= 10 ? Math.round(sizeMultiplier) : sizeMultiplier.toFixed(1)}x ` +
      `the input tokens the same files would cost against an empty domain. That figure is computed for these ` +
      `specific files, not a rule of thumb: the overhead is a fixed cost per AI call, so it weighs far more ` +
      `heavily on short documents than on long ones and varies enormously from batch to batch.`
    : '';

  return (
    `Estimated for ${providerLabel} "${model || '(no model configured)'}" against the "${domain}" domain, ` +
    `currently ${domainSize}. Cost depends heavily on how large this wiki ALREADY is, not just on the files ` +
    `being ingested: every AI call re-sends the existing page list so the model can link to (not duplicate) ` +
    `what is already there.${overheadNote} This estimate is not a flat rate — it is derived from this domain's ` +
    `REAL current page inventory and index, run through the same prompt-assembly code the ingest itself uses. ` +
    `It is size-based, not a real text extraction (no file content is read at estimate time), so document ` +
    `length is a proxy. usdLow assumes prompt-caching applies (multi-call documents only); usdHigh assumes ` +
    `it does not. Both ends are estimates rather than limits — actual spend can land above the range, and ` +
    `on a measured real batch it did.${priceNote}`
  );
}

/**
 * @param {string} domain
 * @param {Array<{name: string, size: number}>} files  metadata only — no bytes read
 */
export async function estimateIngestQueueCost(domain, files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length > MAX_ESTIMATE_FILES) {
    throw statusErr(400,
      `Too many files to estimate at once (${list.length}, max ${MAX_ESTIMATE_FILES}). ` +
      `Split the batch and estimate each part.`);
  }

  const accepted = [];
  const rejected = [];
  let totalBytes = 0;
  for (const f of list) {
    const name = typeof f?.name === 'string' ? f.name : '';
    // A missing or non-numeric size used to be coerced to 0, which is the
    // WRONG direction for a cost gate: the file was still "accepted" and
    // contributed $0.00, so a client that omitted sizes got a $0.00 estimate
    // for a real batch. A size we cannot trust is a file we cannot price, so
    // it is rejected and named rather than silently under-counted.
    const rawSize = f?.size;
    const sizeOk = typeof rawSize === 'number' && Number.isFinite(rawSize) && rawSize >= 0;
    if (!name) { rejected.push({ name: '(unnamed)', reason: 'Missing filename.' }); continue; }
    if (!sizeOk) {
      rejected.push({ name, reason: `Missing or invalid file size (${JSON.stringify(rawSize ?? null)}) — cannot estimate cost for this file.` });
      continue;
    }
    const size = rawSize;
    const ext = path.extname(name).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.has(ext)) {
      rejected.push({ name, reason: `Unsupported file type: ${ext || '(none)'} — The Curator can ingest .txt, .md and .pdf files.` });
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      rejected.push({ name, reason: `File is too large (${(size / 1024 / 1024).toFixed(1)} MB, max 50 MB).` });
      continue;
    }
    accepted.push({ name, size });
    totalBytes += size;
  }

  let provider = null, model = null, price = null;
  try {
    const info = getProviderInfo();
    provider = info.provider;
    model = info.model;
    price = getModelPrice(model);
  } catch { /* no key configured — degrades to nulls below */ }

  const warnings = [];
  if (!provider) warnings.push('No AI provider is configured — add an API key in Settings to see a cost estimate.');
  // A free model reaches `price === null` by the SAME route as an unpriced one
  // (getModelPrice returns null for both), so it used to inherit "cost cannot
  // be estimated in dollars" — which is false, and false in the direction that
  // matters least to a user but reads worst: the cost is known exactly, and it
  // is nothing. Named as its own case rather than left to the unpriced text.
  //
  // `usdLow`/`usdHigh` stay NULL rather than becoming 0, deliberately. Writing
  // a zero into the dollar fields would put a truthy zero back on the money
  // path — the trap llm.js's FREE_MODELS docblock refuses — and would make
  // chargeForItem's estimate share silently "work" for a free model instead of
  // being explicitly bypassed. Null keeps the rule intact: no dollar figure to
  // render, with the reason stated in words instead.
  else if (isFreeModel(model)) warnings.push(`"${model}" is free to use — this batch will not cost anything, so no dollar estimate is shown. The file and call counts below still apply.`);
  else if (!price) warnings.push(`No published price is on file for "${model}" — cost cannot be estimated in dollars, but the file/call counts below are still shown.`);

  const wikiDir = wikiPath(domain);
  const existingFiles = {
    entities: await readdir(path.join(wikiDir, 'entities')).then(list => list.filter(x => x.endsWith('.md'))).catch(() => []),
    concepts: await readdir(path.join(wikiDir, 'concepts')).then(list => list.filter(x => x.endsWith('.md'))).catch(() => []),
  };
  const index = await readIndex(domain).catch(() => '');
  // Mirrors ingestFile's own call shape exactly (capExistingFilesForPrompt is
  // an inert safety valve on all but pathologically large domains — see
  // ingest.js's SLUG_INVENTORY_BUDGET_CHARS docblock — so promptFiles equals
  // existingFiles on virtually every real domain, but using the real
  // function keeps this estimate correct on the rare domain where it fires).
  const promptFiles = capExistingFilesForPrompt(existingFiles, '').files;
  const today = new Date().toISOString().slice(0, 10);

  let stats = null;
  try { stats = await getDomainStats(domain); } catch { /* best-effort context only */ }

  const perFile = accepted.map(f => estimateOneFile({ f, promptFiles, index, today, price }));

  // The SAME files, the SAME code, against an EMPTY domain. This is what makes
  // "how much is my wiki's size costing me" answerable for the batch actually
  // in front of the user, instead of by a constant that is wrong everywhere
  // except the one document size it was sampled at (see buildBasisString).
  // Pure string work on much smaller prompts — no I/O, no extra readdir. On
  // the real `articles` domain a 100-file estimate measures 33 ms before this
  // and 46 ms after.
  const perFileFresh = accepted.map(f => estimateOneFile({ f, promptFiles: { entities: [], concepts: [] }, index: '', today, price }));
  const matureInputTokens = perFile.reduce((n, e) => n + (e.inputTokens || 0), 0);
  const freshInputTokens = perFileFresh.reduce((n, e) => n + (e.inputTokens || 0), 0);
  // Deliberately independent of `price`: the ratio is meaningful even when no
  // dollar figure can be shown.
  const sizeMultiplier = freshInputTokens > 0 ? matureInputTokens / freshInputTokens : null;

  const sum = (key) => perFile.reduce((n, e) => n + (e[key] || 0), 0);
  const estimate = {
    inputTokensLow: price ? sum('inputTokens') : null,
    inputTokensHigh: price ? sum('inputTokens') : null,
    outputTokensLow: price ? sum('outputTokens') : null,
    outputTokensHigh: price ? sum('outputTokens') : null,
    usdLow: price ? round6(perFile.reduce((n, e) => n + (e.usdLow || 0), 0)) : null,
    usdHigh: price ? round6(perFile.reduce((n, e) => n + (e.usdHigh || 0), 0)) : null,
    basis: buildBasisString({ domain, provider, model, price, stats, indexBytes: index.length, sizeMultiplier }),
  };

  return {
    ok: true,
    provider,
    model,
    files: {
      count: accepted.length,
      totalBytes,
      accepted: accepted.map(a => a.name),
      rejected,
    },
    estimate,
    domainContext: { pageCount: stats?.pageCount ?? null, indexBytes: index.length },
    warnings,
  };
}

// ── Job creation ─────────────────────────────────────────────────────────────

/**
 * @param {{ domain: string, uploadedFiles: Array<{originalname:string, path:string, size:number}>,
 *           overwrite?: boolean, budgetUsd?: number|null }} args
 *   `uploadedFiles` is exactly multer's `req.files` shape — the route passes
 *   it straight through.
 */
export async function createJob(args) {
  // ── SYNCHRONOUS CLAIM. Must be the first statement, with no `await`
  // before it. `getActiveJob()` reads disk and `writeJob` writes it, with
  // file staging and a cost estimate in between — several hundred ms of
  // awaits between "is a job already active?" and "here is the new one".
  // Three concurrent creates therefore all saw "no active job" and all
  // wrote one: three active jobs on disk, /active showing an arbitrary one
  // while the other two stayed invisible and still 409'd every new batch.
  // Serialising creation is what makes the check-then-write below sound.
  const token = Symbol('createJob');
  const heldBy = claimSync('create', token);
  if (heldBy !== null) {
    throw statusErr(409, 'Another batch is being created right now. Wait for it to finish, then try again.');
  }
  try {
    return await createJobInner(args);
  } finally {
    releaseClaim('create', token);
  }
}

async function createJobInner({ domain, uploadedFiles, overwrite = false, budgetUsd = null }) {
  await assertDomainUsable(domain);

  const active = await getActiveJob();
  if (active) {
    throw statusErr(
      409,
      `A batch ingest is already active (job ${active.jobId}, domain "${active.domain}", status ${active.status}). ` +
      `Wait for it to finish, or pause/cancel it, before starting another.`,
      { activeJobId: active.jobId }
    );
  }

  if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) {
    throw statusErr(400, 'No files provided.');
  }

  const jobId = crypto.randomUUID();

  // Largest-first (NEXT-PHASE-PLAN.md §5: "file 30 sees the vocabulary of
  // files 1–29, file 1 sees nothing" — biggest documents build the most
  // vocabulary first). `items[]`'s array order IS the processing order and
  // IS the record of that choice — see `job.order` below.
  const ordered = uploadedFiles
    .map((f, uploadIndex) => ({ ...f, uploadIndex }))
    .sort((a, b) => (b.size || 0) - (a.size || 0));

  const rawDir = rawPath(domain);
  const items = [];
  /** Names already claimed BY THIS BATCH — see the in-batch duplicate check. */
  const seenInBatch = new Set();

  try {
    for (let idx = 0; idx < ordered.length; idx++) {
      const f = ordered[idx];
      const name = path.basename(f.originalname || `file-${idx}`);
      const bytes = typeof f.size === 'number' && Number.isFinite(f.size) ? f.size : 0;
      const item = {
        idx, name, bytes,
        status: 'pending',
        startedAt: null, finishedAt: null, attempts: 0, error: null,
        result: null, tokenUsage: null,
        stagedPath: null,
      };

      // Duplicate check happens EXACTLY HERE, once, against pre-batch state.
      // See this module's docblock ("Duplicate handling") for why a
      // per-item runtime check would break crash resume.
      const existingRawPath = path.join(rawDir, name);
      if (existsSync(existingRawPath) && !overwrite) {
        item.status = 'skipped';
        item.finishedAt = new Date().toISOString();
        item.error = `"${name}" has already been ingested into this domain (found in raw/). Skipped — re-create the batch with overwrite to re-ingest it.`;
        try { await unlink(f.path); } catch { /* best-effort temp cleanup */ }
        items.push(item);
        continue;
      }

      // The check above compares against PRE-EXISTING raw/ state and never
      // against the batch itself, so two files that share a basename both
      // passed it. Both ingested (their staged names differ by the `<idx>-`
      // prefix), the second overwrote raw/<name>, and because the summary
      // slug is derived deterministically from the filename, both union-
      // merged into ONE summary page: two documents, one page, no warning.
      // A same-name second file is dropped regardless of `overwrite` —
      // `overwrite` means "replace what is already in the wiki", and it
      // cannot make two files with one name into two pages.
      const nameKey = name.toLowerCase();
      if (seenInBatch.has(nameKey)) {
        item.status = 'skipped';
        item.finishedAt = new Date().toISOString();
        item.error = `Another file in this batch is also called "${name}". Only the first was ingested — two files with the same name would be merged into a single wiki page, silently losing one of them. Rename it and ingest it separately.`;
        try { await unlink(f.path); } catch { /* best-effort temp cleanup */ }
        items.push(item);
        continue;
      }
      seenInBatch.add(nameKey);

      // Per-file, NOT per-batch. One unstageable file (a filename the OS
      // refuses, a name too long even after truncation, a read error) used to
      // throw out of this loop and abort the whole create: a 16-file batch
      // with one bad name returned a 400 and DISCARDED the other 15, with a
      // message blaming disk space. A file that cannot be staged is one
      // failed item; the batch still runs.
      try {
        const staged = path.join(filesDir(jobId), stagedFileName(idx, name));
        await mkdir(filesDir(jobId), { recursive: true });
        await copyFile(f.path, staged);
        item.stagedPath = staged;
      } catch (err) {
        item.status = 'failed';
        item.finishedAt = new Date().toISOString();
        item.error = `This file could not be saved for processing and was skipped: ${scrubPaths((err && err.message) || String(err))}`;
        item.stagedPath = null;
      }
      try { await unlink(f.path); } catch { /* best-effort temp cleanup */ }
      items.push(item);
    }
  } catch (err) {
    // Staging partially failed in a way the per-file guard above did not
    // cover (e.g. the job directory itself is unusable) — clean up whatever
    // we already wrote so a half-built job dir doesn't linger, then re-throw.
    try { await rm(jobDir(jobId), { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }

  // Estimated over the items that will ACTUALLY be ingested, not over every
  // uploaded file. Previously this took the full upload list — including
  // files marked `skipped` right above — and `chargeForItem` then divided
  // that total by the non-skipped count, inflating the per-file fallback
  // charge by exactly the proportion of the batch that was skipped.
  const plannedFiles = items.filter(i => i.status === 'pending');
  const estimate = await estimateIngestQueueCost(
    domain,
    plannedFiles.map(i => ({ name: i.name, size: i.bytes }))
  );

  // A cap that cannot be enforced must not be accepted. `chargeForItem`
  // returns 0 from BOTH branches when the active model has no published
  // price: the real branch has no price to multiply by, and the estimate
  // fallback divides `estimate.usdHigh`, which `estimateIngestQueueCost`
  // gates on that same price and therefore leaves null. Measured: a $0.01 cap
  // ran a full 6-file batch to completion with `spentUsd` frozen at 0 while
  // `spendIsEstimated: true` claimed the estimate was in use. The cap was not
  // loose, it was INERT — the exact "the guard silently stops reaching the
  // thing it protects" shape. Refusing here is the honest half of the choice;
  // it also guarantees the fallback charge is strictly positive whenever a
  // budget exists, so the cap always converges.
  //
  // A FREE MODEL IS EXEMPT, AND REFUSING IT WAS THE LESS SAFE CHOICE.
  // `usdHigh` is null for a free model for the same reason it is null for an
  // unpriced one (`getModelPrice` returns null for both), so this guard used
  // to 400 a cap on a free batch with a message whose central claim is false
  // there: The Curator CAN measure what a free batch spends — exactly $0.00 —
  // and "it would run the whole batch while reporting $0.00" describes the
  // correct outcome, not a failure. The user experience was the inverse of the
  // guard's purpose: someone who picked the free model precisely to control
  // spend, and set a cautious cap on top, was told the app cannot track money.
  //
  // The safety argument runs the same way. A refusal is a 400 — the job is not
  // created, so the user retries WITHOUT a cap. If the run then walks off the
  // free model onto a paid fallback rung, they have no cap at all. Accepting
  // it stores a real `budgetUsd` that stays trivially unreached while the run
  // is free (chargeForItem now returns a true 0) and engages for real the
  // moment a priced model answers. Accepting protects strictly more than
  // refusing does.
  //
  // An unpriced NON-free model is still refused, unchanged: there the cap
  // genuinely cannot be enforced, because spend advances by an estimate share
  // whose relationship to the bill is unknown.
  const requestedBudget = (typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) && budgetUsd > 0) ? budgetUsd : null;
  if (requestedBudget !== null && typeof estimate.estimate.usdHigh !== 'number' && !isFreeModel(estimate.model)) {
    try { await rm(jobDir(jobId), { recursive: true, force: true }); } catch { /* best-effort */ }
    throw statusErr(400,
      `A spending cap can't be applied to this batch. ${estimate.model ? `No published price is on file for the model currently in use ("${estimate.model}")` : 'No AI provider is configured'}, ` +
      `so The Curator cannot measure what the batch is spending and would not be able to stop at the cap — ` +
      `it would run the whole batch while reporting $0.00. Run the batch without a cap and watch it, or ` +
      `switch to a model with a published price in Settings.`);
  }

  const now = new Date().toISOString();
  const job = {
    jobId,
    version: QUEUE_MANIFEST_VERSION,
    domain,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    pausedReason: null,
    pausedMessage: null,
    failReason: null,          // additive beyond the drafted schema — see report
    overwrite: !!overwrite,
    budgetUsd: requestedBudget,
    spentUsd: 0,
    // ── TWO FLAGS, BECAUSE THERE ARE TWO WAYS TO BE INEXACT ──────────────
    // These were ONE flag, and it meant two contradictory things at once:
    //
    //   spendIsEstimated — some charge was an ESTIMATE SHARE (usdHigh / n),
    //     because the model has no published price. usdHigh is the no-caching
    //     end of an estimate and is NOT a bound in either direction: measured
    //     at 103.1% of actual on Gemini and 66.8% on Anthropic, i.e. it can
    //     read ~50% ABOVE real spend. The honest word is "approx.".
    //
    //   spendIsLowerBound — some charge was MEASURED but INCOMPLETE: the
    //     provider call in flight when the item was cancelled / failed / 429'd
    //     never completed, so llm.js never reported it, so it is not in the
    //     totals. Every counted dollar was really billed. The honest words
    //     are "at least".
    //
    // Rendering an estimate share as "at least" is simply false, and calling
    // a measured partial "estimated, not measured" is false in the other
    // direction. Both are additive: `spendIsEstimated` keeps its name, its
    // default and its meaning-of-record, and readers that only know it still
    // work — they just stop claiming a floor they were never given.
    //
    // BOTH ARE STICKY AND NEITHER IS EVER RESET. They describe the CUMULATIVE
    // `spentUsd`, not the current item: once an approximate or incomplete
    // charge has been folded into a running total, no later item completing
    // successfully can make that total exact again.
    spendIsEstimated: false,   // additive — flips true if any item's cost had to be estimate-charged
    spendIsLowerBound: false,  // additive — flips true if any charge was a measured PARTIAL
    order: 'largest-first',
    estimate: estimate.estimate,
    currentIndex: null,
    consecutiveFailures: 0,
    items,
    health: null,
  };

  await writeJob(job);
  await pruneOldJobs();
  return job;
}

// ── Cost charging (real usage, with a fallback that keeps the cap honest) ───

/**
 * Which provider's CACHE RATES apply to this model id — or `null` for "we have
 * not measured this one", which is the fail-safe answer and the common one.
 *
 * Deliberately NOT a general provider resolver, and the asymmetry is the whole
 * design: a provider only needs to be nameable here if it has earned a
 * DISCOUNT. Anything this function cannot place falls through to full price in
 * `cacheMultipliers`, so a fourth provider, an unqualified OpenRouter id, a
 * retired model, an id from a catalogue that has not synced yet, and a garbage
 * string all over-state rather than under-state. Adding a provider to a
 * discount table is a deliberate act backed by a measurement; forgetting to
 * add one costs the user nothing.
 *
 * Membership is an exact `===` scan over the live catalogue via
 * `isOfferableModel`, so `'__proto__'`, `'constructor'` and `'toString'` are
 * structurally unable to resolve (llm.js's `findOfferableModel` indexes no
 * object with the caller's string). Anthropic and OpenRouter ids cannot
 * collide — every OpenRouter id carries a `vendor/` segment and no Anthropic
 * id does — so a non-Anthropic model cannot acquire Anthropic's discount by
 * name.
 */
function cacheRateProvider(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return null;
  if (isOfferableModel('anthropic', modelId)) return 'anthropic';
  return null;
}

/**
 * The cached-read and cache-write multipliers on the base INPUT rate, per
 * provider. Mirrors `cacheMultipliers` in src/public/next/views/chat.js —
 * same name, same two numbers, same fail-safe default — because the two
 * surfaces price the same tokens and a user comparing them must not be shown
 * two answers.
 *
 * ── THE DEFECT THIS CLOSES, AND WHY THIS COPY WAS THE WORSE ONE ──────────
 * Both copies used to apply Anthropic's 0.1x cached-read discount to EVERY
 * provider. OpenRouter bills cached reads at FULL input price — measured
 * against real credit-balance deltas, a cold run as the control (matching
 * actual spend to 8 decimal places, so the rates and the harness are both
 * validated) and a warm run as the case, which came in up to 2.17x UNDER.
 *
 * In the chat view that was a misreport. HERE it is a control failure: this
 * number feeds `job.spentUsd`, which the worker loop tests against
 * `job.budgetUsd` between items. Under-counting cached reads let a batch run
 * PAST the ceiling the user set — the cap did not merely display a wrong
 * figure, it stopped biting when it should have.
 *
 * ── ANTHROPIC: 0.1x / 1.25x, FROM THE PROVIDER'S OWN DOCUMENTATION ───────
 * `cache_read_input_tokens` bills at ~0.1x base input and
 * `cache_creation_input_tokens` at ~1.25x. It is the only provider this
 * project has a published source for, and the only one that gets a discount.
 * It is also the only provider ingest sends a cache breakpoint to at all (see
 * llm.js's ANTHROPIC_CACHE_MIN_PREFIX_CHARS, gated on a 16k-char prefix AND
 * totalBatches >= 2), so this is the arm the multi-batch path exercises.
 *
 * ── EVERYONE ELSE: FULL PRICE ON READS ───────────────────────────────────
 * OpenRouter is MEASURED at full price. Gemini's implicit prefix cache is NOT
 * measured — its real discount is neither 1.0x nor 0.1x, and inventing a
 * third number from memory is precisely the move that put the wrong constant
 * in both files to begin with. Over-stating a bill pauses a batch sooner than
 * strictly necessary; under-stating one lets it spend past a cap the user set.
 * Only the second is a failure the user cannot detect. When a provider's rate
 * is measured the way OpenRouter's was, add it here with the numbers in the
 * comment, not from a spec sheet.
 *
 * ── WRITES STAY AT 1.25x EVERYWHERE, DELIBERATELY ────────────────────────
 * Only Anthropic's write rate is published, but 1.25 > 1.0, so applying it
 * universally errs UPWARD — the same direction llm.js's
 * `normalizeOpenRouterUsage` already reasons about when it declines to
 * subtract `cache_write_tokens` from `prompt_tokens`. Dropping it to 1.0 for
 * unverified providers would be a second under-report introduced while fixing
 * the first.
 */
function cacheMultipliers(provider) {
  if (provider === 'anthropic') return { read: 0.1, write: 1.25 };
  return { read: 1, write: 1.25 };
}

/**
 * Charge one completed item against `job.spentUsd`. If the item returned a
 * usable `tokenUsage` AND we have a published price for that exact model,
 * compute the real cost, with the cache terms resolved PER PROVIDER through
 * `cacheMultipliers` — never by one universal pair of literals. See that
 * function's docblock for the measurement that forced the split.
 *
 * Otherwise (`tokenUsage` missing/undefined — a real, documented possibility;
 * see routes/ingest.js's own comment on `result.tokenUsage` being
 * "possibly undefined on an older/partial result shape" — or the model has
 * no entry in MODEL_PRICES_USD_PER_MTOK): fall back to charging this item
 * its share of the job's CONFIRMED ESTIMATE (`usdHigh`, the conservative/
 * upper bound), and flip `job.spendIsEstimated = true`. Silently adding 0 in
 * this branch would leave `spentUsd` stalled forever while the batch keeps
 * running — the exact "guard silently stops reaching the thing it protects"
 * bug shape flagged during design of this module.
 *
 * ENFORCED, and the correction to what this docblock used to claim: the
 * fallback is only non-zero if `job.estimate.usdHigh` is a number, and that
 * is null for a model with no published price — the same condition that
 * makes the real branch unusable. So BOTH branches returned 0 together, and
 * a budget cap was silently inert (measured: a $0.01 cap ran a full 6-file
 * batch with spentUsd frozen at 0). That is now closed at the OTHER end:
 * `createJob` refuses a `budgetUsd` it cannot price. This function is
 * therefore only reached with a cap when `usdHigh` is a real number, and the
 * fallback charge is strictly positive.
 *
 * NOT ENFORCED, deliberately: with NO cap set, an unpriced model still
 * accrues 0 and `spentUsd` stays 0. Nothing depends on it in that case, and
 * inventing a number to display would be worse than showing none.
 *
 * NOT ENFORCED, and this is the one to understand before trusting the cap:
 * THE FALLBACK CHARGE IS APPROXIMATE AND CAN UNDER-COUNT. It is a share of
 * `estimate.usdHigh`, and `usdHigh` is the no-caching end of an ESTIMATE, not
 * an upper bound — a measured live batch came in at 103.1% of it (see
 * buildBasisString's comment for the numbers). So a batch running entirely on
 * the fallback can overshoot its cap somewhat before the cap engages, and the
 * overshoot grows with the number of items charged that way. What the cap
 * genuinely guarantees is that spend is TRACKED and BOUNDED — it always
 * advances by a positive amount, so the job always stops — not that the final
 * figure is exact or that `budgetUsd` is never exceeded. `spendIsEstimated`
 * is the flag that tells the UI which of the two regimes it is reporting.
 * Do not close this gap by inflating the estimate: that would trade an honest
 * approximation for a number tuned to one sample.
 */
function chargeForItem(job, item) {
  const u = item.tokenUsage;
  // ── A FREE MODEL BILLS NOTHING, AND ZERO IS A MEASUREMENT ────────────────
  // `getModelPrice()` returns null for a free model BY DESIGN (see llm.js's
  // FREE_MODELS docblock: a free model is recorded by MEMBERSHIP, never by a
  // zero price, because `{input:0,output:0}` is truthy and would re-arm
  // v3.3.0's inert-cap defect). That null is indistinguishable from "this
  // model has no published price" at this call site, so without this line a
  // free model fell straight through to the estimate branch below and was
  // charged a FULL share of `estimate.usdHigh` — measured at $0.140000 on a
  // one-file batch, carrying `spendIsEstimated: true`, for a model that bills
  // $0.00. That is a spend surface reporting money that was never spent: the
  // exact class v3.14.0 exists to eliminate ("reported or absent, never
  // inferred"), arriving through the one door nothing was watching.
  //
  // `spendIsEstimated` is deliberately NOT set. It means "this figure is
  // INFERRED", and zero-for-free is not inferred — it is known from
  // membership, the same way a priced model's cost is known from its rate.
  // Flipping the flag here would make the UI print "approx. $0.00" over a
  // number that is exact, and would poison the flag for every later item in
  // the job (it is sticky and never reset).
  //
  // FIRST, ahead of the priced branch, and that ordering is the point:
  // membership is the authority over any price that might ever be typed for a
  // free id. Today `defineOfferableModel` refuses to register a price for a
  // free model so the two can't disagree, but if they ever did, "free" must
  // win rather than being silently overridden by a stale table entry.
  //
  // Keyed on `u.model` — the model that ACTUALLY RAN, reported by llm.js per
  // completed provider call — never on the job's configured model, so a
  // fallback-chain walk from a free model onto a paid one is charged for real.
  // NOT ENFORCED, and it is the honest residual: an item whose `tokenUsage` is
  // missing entirely names no model, so it still takes the estimate share even
  // on a free-model job. Closing that needs the model persisted on the job
  // manifest, which is a schema change and a separate piece of work.
  if (u && isFreeModel(u.model)) return 0;
  const price = u && u.model ? getModelPrice(u.model) : null;
  if (u && price) {
    const inCost = (u.inputTokens || 0) / 1e6 * price.input;
    const outCost = (u.outputTokens || 0) / 1e6 * price.output;
    // Resolved from the model that ACTUALLY RAN (`u.model`, reported by llm.js
    // per completed provider call) — the same id the price two lines up came
    // from, so the rate and the multiplier applied to it can never be drawn
    // from two different catalogue entries. On a fallback-chain walk this is
    // the id the user did NOT choose, which is exactly when it matters.
    //
    // Written as two statements rather than `cacheMultipliers(cacheRateProvider(u.model))`
    // ON PURPOSE. The suite's §0 binding scanner matches `name(` only when a
    // non-identifier character precedes it, and that character is CONSUMED by
    // the enclosing match — so a call nested as the first argument of another
    // call is invisible to it. Measured: the nested form reported only
    // `cacheMultipliers` as unresolved and said nothing about
    // `cacheRateProvider`. Keeping both at statement level keeps §0 able to
    // see them, i.e. keeps the guard load-bearing rather than lucky.
    const rateProvider = cacheRateProvider(u.model);
    const mult = cacheMultipliers(rateProvider);
    const cachedReadCost = (u.cachedReadTokens || 0) / 1e6 * price.input * mult.read;
    const cacheWriteCost = (u.cacheWriteTokens || 0) / 1e6 * price.input * mult.write;
    return inCost + outCost + cachedReadCost + cacheWriteCost;
  }
  job.spendIsEstimated = true;
  const plannedCount = job.items.filter(i => i.status !== 'skipped').length || 1;
  const perFileHigh = (job.estimate && typeof job.estimate.usdHigh === 'number') ? job.estimate.usdHigh : 0;
  return perFileHigh / plannedCount;
}

/**
 * Charge an item that did NOT complete — cancelled, failed, or bounced back to
 * `pending` by a transient provider error.
 *
 * THE DEFECT THIS CLOSES, and why it was the worst of the three:
 * `chargeForItem` was reachable from exactly ONE place, the success path.
 * Every other outcome charged nothing. Measured: a 2-file batch where item 2
 * (21.7 KB, multi-phase) was cancelled at Phase-2 batch 9 of 11 reported
 * `spentUsd: 0.009368` — the figure from before item 2 started — with
 * `spendIsEstimated: false`. Item 2 had really run a Phase-1 outline call plus
 * nine Phase-2 calls. Real spend was ~35-40% higher than reported, AND the
 * flag asserted the number was measured rather than estimated. Under-reporting
 * money while claiming precision is the worst available combination: the flag
 * is the thing that tells a reader whether to trust the figure, so a wrong
 * figure carrying `false` is worse than no figure at all.
 *
 * `totals` is the per-item usage accumulated live from `opts.onUsage`, which
 * llm.js fires once per COMPLETED provider call — under the 429/503 retry loop
 * and under the model-fallback chain — so it is what was actually BILLED, not
 * what the successful path cost.
 *
 * THREE CASES, and the middle one is the honest part:
 *
 *   calls === 0 — charge NOTHING and touch no flag. Not a guess: zero
 *     completed provider calls means zero was billed. This covers a cancel
 *     before Phase 1, a PDF that failed text extraction, a file refused for
 *     being too short, and the injected test seam. Routing this through
 *     `chargeForItem` instead would take its fallback branch and charge a FULL
 *     file's share of the estimate for a file that spent nothing — an
 *     over-report, and it would flip `spendIsEstimated` for no reason.
 *
 *   calls > 0, model priced — charge the REAL measured cost.
 *
 *   calls > 0, model unpriced — no per-call price exists, so fall through to
 *     `chargeForItem`'s estimate share (which flips the flag itself). Over-
 *     charging a partial item is the safe direction for a budget cap.
 *
 * AND, IN BOTH `calls > 0` CASES, `spendIsLowerBound` IS SET TRUE. This is the
 * decision that matters and it is deliberate: the call that was in flight when
 * the user hit Cancel never completed, so llm.js never reported it, so it is
 * NOT in `totals` — and providers do bill for tokens generated before an abort.
 * The figure is therefore a measured LOWER BOUND, not an exact total. Reporting
 * it as exact would repeat the defect in a smaller font.
 *
 * IT IS `spendIsLowerBound`, NOT `spendIsEstimated`, AND THE DISTINCTION IS
 * THE FIX: every dollar counted here was MEASURED — llm.js reported it for a
 * completed provider call. Flagging that as "estimated, not measured" was
 * false, and it made the UI render an estimate share (which can read ~50%
 * ABOVE real spend) with the same "at least" prefix as a genuine floor. The
 * unpriced-model case still ALSO sets `spendIsEstimated`, because it really
 * does fall through to the estimate share — see chargeForItem.
 *
 * ── STICKINESS, corrected rather than papered over ────────────────────────
 * This docblock used to claim "a batch in which every item ran to completion
 * still reports false". That was FALSE on the transient-429 path, which
 * charges the partial and puts the item back to `pending` for a full retry:
 * a batch that paused on a 503 and then completed perfectly kept the flag,
 * and nothing reset it.
 *
 * The claim is corrected, NOT the behaviour, and deliberately so. These flags
 * describe the cumulative `spentUsd`, not the current item. The pre-429
 * partial charge really is in that total and really is incomplete; the
 * retry's own charge is added independently on top. Resetting the flag when
 * the retry succeeds would assert exactness over a total that still contains
 * an unmeasurable component — trading a slightly pessimistic label for a
 * quietly wrong number, which is the trade this whole area exists to refuse.
 * So: once true, true for the life of the job.
 *
 * @param {object} job
 * @param {object} item
 * @param {object|null} totals per-item usage accumulator totals
 * @returns {number} USD to add to job.spentUsd
 */
function chargePartialSpend(job, item, totals) {
  const calls = totals && typeof totals.calls === 'number' && Number.isFinite(totals.calls) ? totals.calls : 0;
  if (calls <= 0) return 0;
  // MEASURED but INCOMPLETE — see the docblock. chargeForItem below may
  // ADDITIONALLY set spendIsEstimated if the model turns out to be unpriced,
  // in which case the charge is an estimate share as well and the UI's
  // "approx." wins over "at least".
  job.spendIsLowerBound = true;
  // chargeForItem reads item.tokenUsage, so hand it the measured partial via a
  // shallow stand-in rather than mutating the caller's item — the transient
  // path leaves the item `pending` for a full retry, and a tokenUsage stamped
  // on it there would be double-counted against the retry's own charge.
  return chargeForItem(job, { tokenUsage: totals, status: item && item.status });
}

// ── SSE pub/sub ──────────────────────────────────────────────────────────────

/** @type {Map<string, Set<(event: object) => void>>} */
const _listeners = new Map();

/** Subscribe to a job's events. Returns an unsubscribe function. */
export function subscribeToJob(jobId, listener) {
  if (!_listeners.has(jobId)) _listeners.set(jobId, new Set());
  _listeners.get(jobId).add(listener);
  return () => {
    const set = _listeners.get(jobId);
    if (!set) return;
    set.delete(listener);
    // Drop the empty Set too — otherwise the Map grows one permanent entry
    // per job ever streamed, for the life of the process.
    if (set.size === 0) _listeners.delete(jobId);
  };
}

function emit(jobId, event) {
  const set = _listeners.get(jobId);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try { fn(event); } catch { /* one bad listener must never affect the worker */ }
  }
}

// ── Worker ───────────────────────────────────────────────────────────────────

/**
 * @type {Map<string, {cancelRequested: boolean, pauseRequested: boolean,
 *                     abort: AbortController|null}>}
 *
 * `abort` is the AbortController for the item currently in flight, or null
 * between items. It is what makes Cancel take effect DURING a file rather than
 * only between files: a 76 KB source is a multi-phase ingest of dozens of LLM
 * calls taking minutes, and a cancel that waits it out is not a cancel — the
 * user watches a "Cancelling…" button while their API budget keeps draining.
 *
 * PAUSE DELIBERATELY DOES NOT TOUCH THIS. Pause keeps its documented meaning
 * (finish the current file, then stop) — that is what makes it the safe,
 * lossless control. Only Cancel aborts in flight, and Cancel is the one that
 * warns about partial work.
 */
const _controlFlags = new Map();

/** Get-or-create, so a caller never has to know whether the worker ran first. */
function getFlags(jobId) {
  let flags = _controlFlags.get(jobId);
  if (!flags) {
    flags = { cancelRequested: false, pauseRequested: false, abort: null };
    _controlFlags.set(jobId, flags);
  }
  return flags;
}

/**
 * The live pause/cancel request state for a job, for `toWire`.
 *
 * These flags are IN-PROCESS ONLY and are deliberately never written to the
 * manifest. Persisting them would turn a cancel that was requested before a
 * restart into a booby trap on a job the user later chooses to resume — the
 * worker would honour a request the user made about a different session and
 * stop the batch for no visible reason. The Map is the whole truth, and it is
 * correctly empty for any job recovered after a restart.
 *
 * Because of that, `toWire` must read this at SERIALISATION time rather than
 * snapshotting it onto the job object. That is also what makes a second tab
 * polling `GET /:jobId` see the same pending-cancel state as the tab that
 * clicked the button — both serialise from the same live Map.
 *
 * Returns strict booleans, never `undefined`: the frontend renders a badge off
 * these, and `undefined` would read as "no such field" rather than "no request
 * pending".
 */
function readControlFlags(jobId) {
  const flags = _controlFlags.get(jobId);
  return {
    cancelRequested: flags ? flags.cancelRequested === true : false,
    pauseRequested: flags ? flags.pauseRequested === true : false,
  };
}

/**
 * An item in one of these needs no further work; anything else is unfinished.
 *
 * `cancelled` (v3.3.x) is the status of the item that was in flight when the
 * user cancelled and was aborted mid-ingest. It MUST be here: `settleJob`
 * computes `unfinished` from this set, and an item status missing from it
 * makes the no-item-is-lost tripwire refuse to settle — turning every cancel
 * into a phantom "paused, 1 file never finished" state. Boot recovery reads
 * the same set, so an omission would also rewrite a legitimately cancelled
 * item as `failed` on the next restart.
 */
const ITEM_TERMINAL = new Set(['done', 'failed', 'skipped', 'cancelled']);

/**
 * Half one of the no-item-is-lost invariant: an item may not sit in `running`
 * while nothing is executing it. Synchronous and idempotent; the caller
 * persists.
 *
 * `attempts` is deliberately NOT decremented — it is the record of how many
 * times this item has been tried, and a crash mid-item IS a try. (The
 * transient-error path decrements separately and on purpose: a 429 is the
 * provider refusing, not an attempt the item consumed.)
 *
 * @returns {string[]} names of the items reclaimed, for logging.
 */
function reclaimStrandedItems(job) {
  const reclaimed = [];
  for (const it of job.items) {
    if (it.status === 'running') {
      it.status = 'pending';
      it.startedAt = null;
      reclaimed.push(it.name);
    }
  }
  return reclaimed;
}

async function purgeStagedFiles(job) {
  for (const it of job.items) {
    if (it.stagedPath) {
      try { await unlink(it.stagedPath); } catch { /* best-effort */ }
      it.stagedPath = null;
    }
  }
}

/**
 * THE single place a job leaves the `running` state — pause, cancel, fail and
 * done all pass through here, which is what makes the no-item-is-lost
 * invariant enforceable in ONE place instead of at the three independent
 * sites that each used to miss it.
 *
 * Two things happen for every settle, in this order:
 *
 *   1. Stranded `running` items are reclaimed to `pending`. Nothing is
 *      executing them any more, by definition of settling.
 *   2. THE TRIPWIRE: a settle to `done` is REFUSED while any item is
 *      non-terminal, and becomes a `paused` settle instead. Because step 1
 *      already ran, this should be unreachable; it exists so that if the
 *      invariant is ever violated the user sees a pause with visible work
 *      remaining, never a green "2 done, 0 failed, 0 skipped" over a batch of
 *      three files — which is precisely what shipped before.
 *
 * @param {string} jobId
 * @param {{status: string, pausedReason?: string|null, pausedMessage?: string|null,
 *          failReason?: string|null, purgeStaged?: boolean, scanHealth?: boolean}} patch
 */
async function settleJob(jobId, patch) {
  const job = await getJob(jobId);
  if (!job) return null;

  const reclaimed = reclaimStrandedItems(job);
  if (reclaimed.length) {
    console.error(`[ingest-queue] Job ${jobId}: reclaimed ${reclaimed.length} stranded item(s) to pending: ${reclaimed.join(', ')}`);
  }

  let { status } = patch;
  let pausedReason = patch.pausedReason ?? null;
  let pausedMessage = patch.pausedMessage ?? null;

  const unfinished = job.items.filter(i => !ITEM_TERMINAL.has(i.status));
  if (status === 'done' && unfinished.length > 0) {
    console.error(
      `[ingest-queue] Job ${jobId}: refused to report "done" — ${unfinished.length} item(s) never reached a ` +
      `terminal state (${unfinished.map(i => `${i.name}:${i.status}`).join(', ')}). Settling as paused instead.`
    );
    status = 'paused';
    pausedReason = 'interrupted';
    pausedMessage =
      `Paused — ${unfinished.length} file(s) in this batch were never finished (${unfinished.map(i => i.name).join(', ')}). ` +
      `Click Resume to process them. Nothing was lost.`;
  }

  job.status = status;
  job.pausedReason = pausedReason;
  job.pausedMessage = pausedMessage;
  if (patch.failReason !== undefined) job.failReason = patch.failReason;
  job.currentIndex = null;
  job.updatedAt = new Date().toISOString();

  // Staged files are dead weight once a job is terminal: only a SUCCESSFUL
  // item unlinked its own, so every failed and every skipped item's staged
  // copy (up to 50 MB each) used to persist for the life of the install.
  if (TERMINAL_STATUSES.has(job.status)) await purgeStagedFiles(job);

  if (patch.scanHealth) {
    try {
      const report = await scanWiki(job.domain);
      job.health = {
        scannedAt: report.scannedAt,
        counts: {
          ...report.counts,
          brokenLinks: report.brokenLinks.length,
          orphans: report.orphans.length,
          folderPrefixLinks: report.folderPrefixLinks.length,
          crossFolderDupes: report.crossFolderDupes.length,
          hyphenVariants: report.hyphenVariants.length,
          missingBacklinks: report.missingBacklinks.length,
        },
      };
    } catch (err) {
      console.error(`[ingest-queue] End-of-batch Health scan failed for job ${jobId} (non-fatal): ${err && err.message}`);
    }
  }

  await writeJob(job);
  emit(jobId, { type: 'job', job: toWire(job) });
  emit(jobId, { type: 'done', job: toWire(job) });
  return job;
}

async function settleAsPaused(jobId, reason, message) {
  return settleJob(jobId, { status: 'paused', pausedReason: reason, pausedMessage: message });
}

async function settleAsCancelled(jobId) {
  return settleJob(jobId, { status: 'cancelled' });
}

async function finishJobDone(jobId) {
  return settleJob(jobId, { status: 'done', scanHealth: true });
}

function summarizeChangeCounts(changes) {
  const out = { created: 0, updated: 0, unchanged: 0 };
  if (Array.isArray(changes)) {
    for (const c of changes) {
      if (c && typeof c.status === 'string' && Object.hasOwn(out, c.status)) out[c.status]++;
    }
  }
  return out;
}

/**
 * Runs ONE item. Never throws — see `runWorkerLoop`, whose only handler for an
 * escaped throw used to be `.catch(console.error)` on an un-awaited promise,
 * which left the item in `running` with no worker (the H1 orphan) and killed
 * the loop silently. Anything that escapes the inner handling below is
 * converted into an item-level failure so the consecutive-failure breaker can
 * bound it like any other failure.
 *
 * @returns {Promise<{harnessError?: string}>} `harnessError` is set only when
 *   the failure could not be recorded on the manifest at all (e.g. the disk
 *   is full and `writeJob` itself throws) — the loop bounds those separately,
 *   since a state it cannot persist is a state it cannot make progress from.
 */
async function processItem(jobId, itemIdx, ingestFileImpl) {
  try {
    return await processItemInner(jobId, itemIdx, ingestFileImpl);
  } catch (err) {
    const message = (err && err.message) || String(err);
    console.error(`[ingest-queue] Job ${jobId} item ${itemIdx}: unhandled worker error: ${err && err.stack || message}`);
    try {
      const j = await getJob(jobId);
      if (!j) return { harnessError: scrubPaths(message) };
      const it = j.items.find(i => i.idx === itemIdx);
      if (!it) return { harnessError: scrubPaths(message) };
      it.status = 'failed';
      it.finishedAt = new Date().toISOString();
      it.error = scrubPaths(message);
      j.consecutiveFailures = (j.consecutiveFailures || 0) + 1;
      j.currentIndex = null;
      j.updatedAt = new Date().toISOString();
      await writeJob(j);
      emit(jobId, { type: 'job', job: toWire(j) });
      return {};
    } catch (inner) {
      // Scrubbed like every other string that leaves this module: it is not
      // wired to HTTP today, but an unscrubbed absolute path travelling out of
      // here is exactly what leaks the first time somebody surfaces it.
      return { harnessError: scrubPaths((inner && inner.message) || String(inner)) };
    }
  }
}

/**
 * True when the item's failure is the user's cancellation rather than a fault.
 * Deliberately accepts EITHER signal: the tagged error from llm.js/ingest.js,
 * or an already-aborted controller (which covers an SDK that throws some other
 * shape on abort, and the case where the ingest failed for an unrelated reason
 * in the same instant).
 */
function cancelledDuringItem(err, signal) {
  if (signal && signal.aborted) return true;
  return isAbortError(err);
}

async function processItemInner(jobId, itemIdx, ingestFileImpl) {
  let job = await getJob(jobId);
  if (!job) return {};
  const item = job.items.find(i => i.idx === itemIdx);
  if (!item) return {};

  item.status = 'running';
  item.startedAt = new Date().toISOString();
  item.attempts = (item.attempts || 0) + 1;
  job.currentIndex = itemIdx;
  job.updatedAt = new Date().toISOString();
  await writeJob(job);
  emit(jobId, { type: 'job', job: toWire(job) });

  const domain = job.domain;
  let releaseRegistry = null;
  let releaseLock = null;
  // Declared out here so the catch can consult `.signal.aborted` — the catch
  // runs outside the try where the controller is published.
  let itemAbort = null;

  // Live per-item spend, accumulated AS EACH PROVIDER CALL COMPLETES.
  //
  // `result.tokenUsage` only exists when the ingest RETURNS. Every non-return
  // outcome — cancel, failure, a transient error that bounces the item back to
  // pending — used to charge nothing at all, so the money those calls cost
  // vanished from the batch total while `spendIsEstimated: false` insisted the
  // total was measured. This accumulator survives the throw, which is the whole
  // point, so like `itemAbort` it MUST be declared outside the try the catch
  // sits beside. See `chargePartialSpend`.
  const itemUsage = makeUsageAccumulator();

  try {
    releaseRegistry = registerWrite(domain, 'batch-ingest');
    releaseLock = await acquireFileLock(domainPath(domain), { op: 'batch-ingest' });

    if (!releaseLock) {
      // Another process holds the write lock — PAUSE THE JOB, do not fail
      // the item. Put the item back to pending so it's the next thing tried
      // on resume.
      releaseRegistry();
      releaseRegistry = null;
      const j = await getJob(jobId);
      const it = j && j.items.find(i => i.idx === itemIdx);
      if (it) {
        it.status = 'pending';
        it.startedAt = null;
        it.attempts = Math.max(0, it.attempts - 1);
        j.currentIndex = null;
        await writeJob(j);
      }
      await settleAsPaused(jobId, 'locked',
        `Another process is writing to "${domain}" (file lock held) — paused. Resume once it finishes.`);
      return {};
    }

    // `item-progress` is the one SSE frame whose payload originates OUTSIDE
    // this module (ingest.js's progress callback), so it does not pass through
    // toWire. Every ingest.js progress message is currently a static string or
    // interpolates only counts — verified by reading all 13 call sites — but
    // that is a property of a file this module does not own and cannot pin.
    // Scrubbing and bounding it here keeps the guarantee local: no frame this
    // module emits can carry an absolute path, whatever ingest.js does later.
    const onProgress = (ev) => {
      emit(jobId, {
        type: 'item-progress',
        idx: itemIdx,
        pct: (ev && typeof ev.pct === 'number' && Number.isFinite(ev.pct)) ? ev.pct : null,
        message: wireStr(ev && ev.message, 500),
      });
    };

    // ── Real cancellation (v3.3.x) ──────────────────────────────────────
    // One controller per item, published on the job's control flags so
    // `requestCancel` can abort the call that is in flight RIGHT NOW.
    //
    // The pre-abort below closes the narrow race where the user clicks Cancel
    // between the worker's between-items check and this line: without it the
    // flag would be set, nothing would be listening, and the whole file would
    // still run to completion.
    const controller = new AbortController();
    itemAbort = controller;
    const flags = getFlags(jobId);
    flags.abort = controller;
    if (flags.cancelRequested) controller.abort();

    // Guarantee 1, at the only place it can actually be guaranteed. See
    // `enterIngest`. The increment/check is synchronous and immediately
    // precedes the await; the decrement is in the matching finally.
    let result;
    enterIngest();
    try {
      result = await ingestFileImpl(domain, item.stagedPath, item.name, job.overwrite, onProgress, {
        signal: controller.signal,
        onUsage: itemUsage.onUsage,
      });
    } finally {
      exitIngest();
      // Only clear OUR controller: a later item may already have published its
      // own by the time an error path unwinds through here.
      if (flags.abort === controller) flags.abort = null;
    }

    const j = await getJob(jobId);
    const it = j && j.items.find(i => i.idx === itemIdx);
    if (!it) return {};
    it.status = 'done';
    it.finishedAt = new Date().toISOString();
    it.error = null;
    it.result = {
      title: result && result.title,
      pagesWritten: Array.isArray(result?.pagesWritten) ? result.pagesWritten.length : 0,
      warningCount: Array.isArray(result?.warnings) ? result.warnings.length : 0,
      changeCounts: summarizeChangeCounts(result?.changes),
    };
    it.tokenUsage = result && result.tokenUsage ? result.tokenUsage : null;
    if (it.stagedPath) { try { await unlink(it.stagedPath); } catch { /* best-effort */ } it.stagedPath = null; }

    j.consecutiveFailures = 0;
    j.spentUsd = round6((j.spentUsd || 0) + chargeForItem(j, it));
    j.currentIndex = null;
    j.updatedAt = new Date().toISOString();
    await writeJob(j);
    emit(jobId, { type: 'job', job: toWire(j) });
    return {};
  } catch (err) {
    // ── CANCELLED, checked before every other classification ─────────────
    // An abort is the user's own decision, not a failure of the file and not
    // a provider problem: it must not count toward the consecutive-failure
    // breaker, must not pause-and-retry like a 429, and must not be recorded
    // as `failed` (which would read to the user as "my file was broken").
    //
    // `signal.aborted` is checked ALONGSIDE the error tag because an ingest
    // can fail for an unrelated reason in the same instant the user cancels;
    // attributing that to the cancel is both true and the kinder report.
    if (cancelledDuringItem(err, itemAbort && itemAbort.signal)) {
      const j = await getJob(jobId);
      const it = j && j.items.find(i => i.idx === itemIdx);
      if (it) {
        it.status = 'cancelled';
        it.finishedAt = new Date().toISOString();
        // Honest about partial state, and about the recovery — which really is
        // just "ingest it again". Re-ingest is idempotent by design
        // (deterministic summary slug + union merge), so re-running completes
        // the file. NOTHING is deleted or rolled back here: pages written
        // before the abort may have MERGED into pages that already existed,
        // and unpicking that is destructive in a way an abandoned page is not.
        it.error = 'Stopped partway through — some pages may already have been written. ' +
                   'Re-ingest this file to complete it.';
        // A cancelled item HAS SPENT MONEY — a mid-document cancel can be nine
        // Phase-2 calls deep. Attribute what was measurably billed, and stamp
        // the partial usage on the item so the manifest and the wire stop
        // reporting `tokenUsage: null` for a file that made real calls.
        // `chargePartialSpend` also downgrades `spendIsEstimated`, because the
        // call that was in flight at the moment of the abort never completed
        // and so is not in these totals.
        it.tokenUsage = itemUsage.totals.calls > 0 ? itemUsage.totals : null;
        j.spentUsd = round6((j.spentUsd || 0) + chargePartialSpend(j, it, itemUsage.totals));
        j.currentIndex = null;
        j.updatedAt = new Date().toISOString();
        await writeJob(j);
      }
      // Settle from INSIDE the item, the same way the transient path pauses
      // from here: the worker loop's between-items cancel check runs AFTER its
      // "no pending items left -> finishJobDone" branch, so a cancel on the
      // LAST item of a batch would otherwise be reported as a completed job.
      await settleAsCancelled(jobId);
      return {};
    }

    // `ignore: item.name` — ingest.js quotes the filename back in its own
    // errors, so without this a document literally named after a provider
    // error ("Service Unavailable.pdf") would classify as transient and pause
    // the batch again on every Resume. See TRANSIENT_PATTERNS.
    const transient = classifyTransientError(err, { ignore: item.name });

    if (transient) {
      // A RATE LIMIT / SERVICE-UNAVAILABLE ERROR PAUSES THE WHOLE BATCH — IT
      // DOES NOT FAIL THE ITEM. llm.js has already exhausted its own 429/503
      // retry+backoff before this reaches here (4 attempts, up to ~40s), so
      // this is the provider saying stop, not "this one file is bad".
      // Continuing would fail every remaining item identically in seconds
      // (see this module's docblock). Put the item back to pending — it is
      // the next thing the worker tries on resume — and pause the JOB, not
      // just skip past it.
      const j = await getJob(jobId);
      const it = j && j.items.find(i => i.idx === itemIdx);
      if (it) {
        it.status = 'pending';
        it.startedAt = null;
        it.attempts = Math.max(0, it.attempts - 1);
        // A 429/503 reaching here means llm.js already burned up to four
        // billed attempts, and any Phase-1/Phase-2 calls that landed before it
        // were billed too. Charge them. `it.tokenUsage` is deliberately NOT
        // stamped: this item goes back to `pending` and will be re-run from
        // scratch on resume, and that run's own full charge is independent —
        // stamping here would leave a stale figure to be double-counted.
        j.spentUsd = round6((j.spentUsd || 0) + chargePartialSpend(j, it, itemUsage.totals));
        j.currentIndex = null;
        await writeJob(j);
      }
      await settleAsPaused(jobId, transient,
        `Paused — ${transient === 'rate_limit' ? 'the AI provider rate-limited this request' : 'the AI provider is temporarily unavailable'}. ` +
        `"${item.name}" will be retried first on resume. (${scrubPaths((err && err.message) || String(err))})`);
    } else {
      const j = await getJob(jobId);
      const it = j && j.items.find(i => i.idx === itemIdx);
      if (!it) return {};
      it.status = 'failed';
      it.finishedAt = new Date().toISOString();
      it.error = scrubPaths((err && err.message) || String(err));
      // A failed item can also have spent money — a document that dies in
      // Phase 2 has already paid for its Phase-1 outline. Failures that spend
      // NOTHING (unextractable PDF, too-short source: both throw before any
      // provider call) report `calls === 0` and are charged nothing, with the
      // measured/estimated flag left alone.
      it.tokenUsage = itemUsage.totals.calls > 0 ? itemUsage.totals : null;
      j.spentUsd = round6((j.spentUsd || 0) + chargePartialSpend(j, it, itemUsage.totals));

      j.consecutiveFailures = (j.consecutiveFailures || 0) + 1;
      j.currentIndex = null;
      j.updatedAt = new Date().toISOString();
      await writeJob(j);
      emit(jobId, { type: 'job', job: toWire(j) });
    }
    return {};
  } finally {
    if (releaseLock) { try { await releaseLock(); } catch { /* best-effort */ } }
    if (releaseRegistry) { try { releaseRegistry(); } catch { /* best-effort */ } }
  }
}

/**
 * A worker that cannot persist ANY state (disk full, queue dir removed) makes
 * no progress and would otherwise re-select the same item forever in a tight
 * loop. Bounded here rather than trusted not to happen.
 */
const HARNESS_FAILURE_LIMIT = 3;

async function runWorkerLoop(jobId, ingestFileImpl, workerToken) {
  let harnessFailures = 0;
  try {
    for (;;) {
      const job = await getJob(jobId);
      if (!job) break;

      const flags = _controlFlags.get(jobId) || { cancelRequested: false, pauseRequested: false, abort: null };

      // No item may be `running` here: this point is only ever reached
      // BETWEEN items, so anything still marked running is stranded (a
      // previous loop that died, a crash the boot recovery did not cover
      // because the JOB was not itself `running`). Reclaiming it makes it
      // visible to the selector below — the pre-fix loop only ever looked for
      // `pending`, so a stranded item was skipped, never ingested, and the
      // job went on to report `done` without it.
      const reclaimed = reclaimStrandedItems(job);
      if (reclaimed.length) {
        console.error(`[ingest-queue] Job ${jobId}: worker reclaimed stranded item(s): ${reclaimed.join(', ')}`);
        job.updatedAt = new Date().toISOString();
        await writeJob(job);
      }

      const nextIdx = job.items.findIndex(it => it.status === 'pending');
      if (nextIdx === -1) {
        await finishJobDone(jobId);
        break;
      }
      const nextItem = job.items[nextIdx];

      // ── Between-items checks (never mid-item) — order matters (spec):
      // cancel -> pause -> update-in-progress -> budget -> circuit breaker.
      if (flags.cancelRequested) { await settleAsCancelled(jobId); break; }
      if (flags.pauseRequested) { await settleAsPaused(jobId, 'user', 'Paused by user request.'); break; }
      if (isUpdateInProgress()) {
        await settleAsPaused(jobId, 'interrupted', 'Paused because an app update started. Resume once the update finishes.');
        break;
      }
      if (job.budgetUsd != null && job.spentUsd >= job.budgetUsd) {
        await settleAsPaused(jobId, 'budget',
          `Paused — spent $${job.spentUsd.toFixed(4)} of the $${job.budgetUsd.toFixed(4)} budget.` +
          // The two flags mean different things and must not be described with
          // one sentence: "estimated, not measured" was FALSE for a partial
          // charge, where every counted dollar was measured and only the
          // in-flight call is missing. Estimated wins when both are set,
          // because an estimate share can read ABOVE real spend and so cannot
          // honestly be called a floor.
          (job.spendIsEstimated
            ? ' (Some of this spend is estimated, not measured — see spendIsEstimated.)'
            : (job.spendIsLowerBound
              ? ' (Real spend is at least this much: an interrupted item’s final, in-flight call could not be measured — see spendIsLowerBound.)'
              : '')));
        break;
      }
      if ((job.consecutiveFailures || 0) >= CONSECUTIVE_FAILURE_LIMIT) {
        await settleAsPaused(jobId, 'consecutive_failures',
          `Paused after ${CONSECUTIVE_FAILURE_LIMIT} items in a row failed. Check the errors below before resuming.`);
        break;
      }

      const outcome = await processItem(jobId, nextItem.idx, ingestFileImpl);

      if (outcome && outcome.harnessError) {
        harnessFailures++;
        console.error(`[ingest-queue] Job ${jobId}: could not persist item state (${harnessFailures}/${HARNESS_FAILURE_LIMIT}): ${outcome.harnessError}`);
        if (harnessFailures >= HARNESS_FAILURE_LIMIT) {
          await settleAsPaused(jobId, 'interrupted',
            'Paused — The Curator could not save this batch\'s progress. Check that the disk is not full, then Resume.')
            .catch(() => { /* the disk is the problem; nothing more to do here */ });
          break;
        }
        continue;
      }
      harnessFailures = 0;

      // processItem can itself settle the job mid-item (a transient 429/503
      // error, or a lost file-lock race, both pause via settleAsPaused from
      // INSIDE processItem so the failing item can be put back to `pending`
      // atomically with the pause). Without this check the loop would
      // immediately re-select that same now-pending item and hammer the
      // rate-limited provider again in a tight loop instead of actually
      // pausing. Re-read is authoritative — never trust a locally-held flag.
      const after = await getJob(jobId);
      if (!after || after.status !== 'running') break;
      // Otherwise loop back — the NEXT iteration re-reads the job and re-runs
      // every between-items check before touching the following item.
    }
  } finally {
    releaseClaim('worker', workerToken);
    _controlFlags.delete(jobId);
  }
}

/**
 * Start a pending job, or resume a paused one. Idempotent: calling this
 * again while the SAME job's worker is already running just returns the
 * current state without starting a second loop.
 *
 * @param {string} jobId
 * @param {{ingestFile?: Function}} [opts]  test seam — defaults to the real
 *   ingestFile. Same pattern as compile.js's opts.generateText / ingest.js's
 *   ingestMultiPhase llm param.
 */
export async function startOrResumeJob(jobId, opts = {}) {
  const ingestFileImpl = typeof opts.ingestFile === 'function' ? opts.ingestFile : realIngestFile;

  if (!isValidJobId(jobId)) throw statusErr(400, 'Invalid job id.');

  // ── SYNCHRONOUS CLAIM — read and write of the worker claim happen in one
  // turn, with nothing awaited between them. See this module's docblock. The
  // claim is taken BEFORE the job is even read from disk, because every read
  // is an await and every await is a window: the pre-fix code read the job,
  // re-validated the domain (a listDomains + a CLAUDE.md read per domain) and
  // wrote the manifest twice before setting the flag, and four simultaneous
  // /start requests all came back "200 running" with three items ingesting at
  // once. It is released again on every path below that does not hand off to
  // the worker loop.
  const workerToken = jobId;
  let held = null;
  for (let attempt = 0; ; attempt++) {
    held = claimSync('worker', workerToken);
    if (held === null) break;                                  // we hold it

    if (held !== jobId) {
      throw statusErr(409, `Another batch (job ${held}) is currently running in this process.`);
    }

    // Held by THIS job. Either a loop is genuinely running it — in which case
    // start is idempotent and returns the live snapshot — or a loop has
    // already settled the job and is winding down through its `finally`.
    //
    // That second case is not theoretical: `settleAsPaused` publishes
    // `paused` to the manifest BEFORE the loop's finally releases the claim,
    // so a Resume landing in that window used to hit a bare
    // `if (_runningJobId === jobId) return job` and silently do NOTHING —
    // HTTP 200, status "paused", no worker. Reproduced 5/5 by resuming the
    // instant `paused` became visible; it is also what made this module's
    // own test suite ~3% flaky. Wait for the loop to actually exit, then
    // claim properly.
    const snapshot = await getJob(jobId);
    if (snapshot && snapshot.status === 'running') return snapshot;
    if (attempt === 0) {
      try { await _workerSettled; } catch { /* the loop logs its own errors */ }
      continue;
    }
    // Second time round the claim is still held by this job: a concurrent
    // caller won the race and has started the loop. That is the idempotent
    // outcome, so report the current state rather than starting a second one.
    return (await getJob(jobId)) || snapshot;
  }

  try {
    const job = await getJob(jobId);
    if (!job) throw statusErr(404, 'Job not found.');
    if (TERMINAL_STATUSES.has(job.status)) {
      releaseClaim('worker', workerToken);
      return job;
    }

    // Re-validate the domain on EVERY start/resume, not just at create — a job
    // can sit paused across a restart while the domain is deleted, renamed, or
    // converted into a read-only Shared Brain mirror.
    try {
      await assertDomainUsable(job.domain);
    } catch (err) {
      const failed = await settleJob(jobId, { status: 'failed', failReason: err.message });
      releaseClaim('worker', workerToken);
      return failed || job;
    }

    job.status = 'running';
    job.pausedReason = null;
    job.pausedMessage = null;
    job.updatedAt = new Date().toISOString();
    await writeJob(job);
    emit(jobId, { type: 'job', job: toWire(job) });

    _controlFlags.set(jobId, { cancelRequested: false, pauseRequested: false, abort: null });

    // Runs in the background; the route returns immediately with this
    // now-'running' snapshot. Progress/completion arrive via SSE / polling.
    // `_workerSettled` is what a Resume arriving during wind-down awaits.
    _workerSettled = runWorkerLoop(jobId, ingestFileImpl, workerToken).catch(err => {
      console.error(`[ingest-queue] Worker for job ${jobId} crashed unexpectedly: ${err && err.stack || err}`);
    });

    return job;
  } catch (err) {
    // Nothing was handed to a worker loop, so the claim must not be left held
    // — otherwise one failed start would wedge the queue for the life of the
    // process.
    releaseClaim('worker', workerToken);
    throw err;
  }
}

/**
 * A control request is deferred to the worker loop ONLY when a loop is
 * genuinely executing this job. Testing the claim alone was not enough: the
 * claim outlives the settle (see `startOrResumeJob`), so a cancel arriving
 * during wind-down set a flag that no loop would ever read and the job stayed
 * paused instead of cancelling. Requiring the on-disk status to be `running`
 * as well makes both directions correct — and if the loop died without
 * settling, the claim is gone and this settles immediately.
 */
function workerIsExecuting(jobId, job) {
  return currentClaim('worker') === jobId && job.status === 'running';
}

export async function requestPause(jobId) {
  if (!isValidJobId(jobId)) throw statusErr(400, 'Invalid job id.');
  const job = await getJob(jobId);
  if (!job) throw statusErr(404, 'Job not found.');
  if (TERMINAL_STATUSES.has(job.status)) return job;

  if (workerIsExecuting(jobId, job)) {
    // NOTE the asymmetry with requestCancel below: no `.abort()` here. Pause
    // lets the in-flight file finish, so it can never leave a partially
    // ingested source behind.
    getFlags(jobId).pauseRequested = true;
    return job; // flips to 'paused' once the in-flight item finishes
  }
  return (await settleAsPaused(jobId, 'user', 'Paused by user request.')) || job;
}

export async function requestCancel(jobId) {
  if (!isValidJobId(jobId)) throw statusErr(400, 'Invalid job id.');
  const job = await getJob(jobId);
  if (!job) throw statusErr(404, 'Job not found.');
  if (TERMINAL_STATUSES.has(job.status)) return job;

  if (workerIsExecuting(jobId, job)) {
    const flags = getFlags(jobId);
    flags.cancelRequested = true;
    // Stop the CURRENT file too, not just the loop. The flag alone only stops
    // the batch between items, which on a large multi-phase source meant
    // minutes of further paid LLM calls after the click.
    if (flags.abort) { try { flags.abort.abort(); } catch { /* already aborted */ } }
    return job;
  }
  return (await settleAsCancelled(jobId)) || job;
}

/**
 * Deletes by validated PATH, not via a parsed manifest. Routing this through
 * `getJob` meant a job whose manifest was corrupt returned null and therefore
 * 404'd — permanently. Such a job is correctly hidden from `GET /` and
 * `/active` (both skip unparseable manifests), so its directory became
 * unreachable through the API for the life of the install, with no way for
 * the user to reclaim the disk. A corrupt manifest is the case where delete
 * matters MOST, so it must not be the case delete cannot serve.
 */
export async function deleteJobEverything(jobId) {
  if (!isValidJobId(jobId)) throw statusErr(400, 'Invalid job id.');
  const dir = jobDir(jobId);
  if (!existsSync(dir)) throw statusErr(404, 'Job not found.');

  if (currentClaim('worker') === jobId) {
    throw statusErr(409, 'Cannot delete a running job. Pause or cancel it first.');
  }
  // A readable manifest can also veto; an unreadable one cannot (and does not
  // need to — the claim check above is the authoritative "is a worker on it").
  const job = await getJob(jobId);
  if (job && job.status === 'running') {
    throw statusErr(409, 'Cannot delete a running job. Pause or cancel it first.');
  }
  await rm(dir, { recursive: true, force: true });
}

// ── Boot recovery ────────────────────────────────────────────────────────────

/**
 * Scan every job on disk; any whose status is `running` was interrupted by
 * a crash or restart. Its `running` item is reset to `pending` (re-running
 * an item is safe — ingest is idempotent: deterministic summary slug, union
 * merge; see the ingest-report reference in CLAUDE.md), and the JOB is set
 * to `paused`/`interrupted`. Deliberately NEVER starts a worker — resuming
 * spend after an unattended crash is a decision only the user makes.
 *
 * Never throws: a corrupt/unreadable manifest is logged and that job is
 * left as-is (server startup must not depend on ingest-queue disk state
 * being clean).
 */
export async function recoverOnBoot() {
  let ids = [];
  try { ids = await listJobDirIds(); } catch { return { recovered: 0 }; }

  let recovered = 0;
  for (const id of ids) {
    try {
      const job = await getJob(id);
      if (!job) continue;

      // EVERY job is inspected, not only those whose own status is `running`.
      // The old gate (`job.status !== 'running') continue`) repaired JOBS, not
      // ITEMS — an item left `running` under a job that had already been
      // paused, cancelled or (worse) marked done was invisible to boot
      // recovery, invisible to the worker's pending-only selector, and
      // invisible to the done check. That is the whole H1 orphan path.
      let changed = false;

      if (TERMINAL_STATUSES.has(job.status)) {
        // The job is finished; an unfinished item under it can never be
        // picked up again, so close the accounting honestly rather than
        // leaving a file in none of the done/failed/skipped buckets.
        for (const it of job.items) {
          if (!ITEM_TERMINAL.has(it.status)) {
            it.status = 'failed';
            it.finishedAt = new Date().toISOString();
            it.error = it.error ||
              'Interrupted by an app restart and never completed, and this batch had already finished. ' +
              'Ingest this file again to add it.';
            changed = true;
          }
        }
      } else if (reclaimStrandedItems(job).length > 0) {
        changed = true;
      }

      if (job.status === 'running') {
        job.status = 'paused';
        job.pausedReason = 'interrupted';
        job.pausedMessage =
          'The app restarted while this batch was running. The interrupted item will be re-run from the ' +
          'start on resume (ingest is safe to re-run). Review progress below, then click Resume to continue.';
        job.currentIndex = null;
        changed = true;
      }

      if (!changed) continue;
      job.updatedAt = new Date().toISOString();
      await writeJob(job);
      recovered++;
    } catch (err) {
      console.error(`[ingest-queue] Boot recovery: could not recover job ${id} (left as-is): ${err && err.message}`);
    }
  }
  return { recovered };
}

// ── Test-only surface ────────────────────────────────────────────────────────

export const __testing = {
  jobDir, manifestPath, filesDir,
  chargeForItem, chargePartialSpend, estimateCallCounts, sanitizeBaseName, stagedFileName,
  reclaimStrandedItems, pruneOldJobs,
  // Exposed so the `done` tripwire can be tested DIRECTLY. It is the second
  // of two layers: while `reclaimStrandedItems` works, the state the tripwire
  // refuses cannot arise through the worker at all, so a test that went via
  // the worker would be exercising the first layer and reporting it as
  // coverage of the second. Driving settleJob by hand is the only way to
  // assert the tripwire actually refuses.
  settleJob,
  // Exposed so "processItem never throws" can be asserted directly. Driving
  // it through the worker cannot distinguish the guard: whether the throw is
  // caught here or escapes to runWorkerLoop's `.catch`, the loop stops and
  // the on-disk state is identical, so a worker-level test reports coverage
  // it does not have.
  processItem,
  TERMINAL_STATUSES, ITEM_TERMINAL,
  MAX_JOBS_RETAINED, MAX_ESTIMATE_FILES, MAX_STAGED_BASENAME,
  getRunningJobId: () => currentClaim('worker'),
  /** Number of job ids currently holding an SSE listener Set. */
  getListenerJobCount: () => _listeners.size,
  /**
   * Peak concurrent `ingestFile` calls observed since the last reset. THE
   * invariant behind guarantee 1 — a test asserts this is exactly 1 rather
   * than asserting that some flag was null at some instant.
   */
  getMaxIngestInFlight: () => _ingestMaxInFlight,
  // Lets a test forcibly clear in-memory worker state between runs without
  // spinning up a full job lifecycle (offline suites use tempdir-scoped
  // queue dirs, but the claim registry / control flags are process-global —
  // a prior test's job id must not leak into the next).
  __resetInMemoryState: () => {
    _claims.clear();
    _controlFlags.clear();
    _listeners.clear();
    _workerSettled = Promise.resolve();
    _ingestInFlight = 0;
    _ingestMaxInFlight = 0;
  },
};
