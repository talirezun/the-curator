/**
 * src/brain/ingest-activity.js — the single-file ingest's activity record.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 * Reported from real use, with a screenshot. Start a single-file ingest,
 * navigate away from the Ingest view, come back: the view shows only the
 * generic amber note "Waiting on another write in this domain". No file name,
 * no phase, no progress, no elapsed time. When the ingest FINISHES you get
 * nothing at all — in the maintainer's words, "the process ended, but there's
 * basically no way I can know if this article was ingested or not."
 *
 * MEASURED, not assumed: the events were never missing. `runIngest` in
 * views/ingest.js deliberately does NOT abort its SSE fetch on navigate-away
 * (the teardown's own comment says so, and gives the reason: the write gate
 * would otherwise lie), so every `progress` event AND the final `done` event
 * still ARRIVE at the browser. They are then DROPPED, because `setProgress`
 * and the done handler are gated on `isCurrentMount(token)` and a returning
 * mount has a brand-new `state` object. Data received; no consumer reads it.
 * That is this repo's signature dead-data shape — the same one v3.9.1 found
 * three times in one release.
 *
 * The comment at the top of views/ingest.js names the missing piece itself:
 *   "no server-side 'get status' endpoint exists for it — nothing to
 *    reattach to, so aborting would just make the gate lie."
 *
 * This module IS that missing piece. `src/routes/ingest.js` already funnels
 * every event through ONE local `emit()` closure, and its own comment records
 * that `await ingestFile(...)` completes regardless of client state — so the
 * server can observe an entire run with no client attached. It just never
 * remembered what it saw.
 *
 * ── WHY IN MEMORY, AND WHY THAT IS NOT A GAP ────────────────────────────────
 * A `running` record describes work being done by THIS process, right now.
 * If the process dies, the ingest dies with it, and a record that outlived it
 * would be a false statement — worse than no record, because it would leave
 * the view reporting a phase that nobody is working on. In-memory means the
 * record's lifetime is exactly the truth's lifetime.
 *
 * The cost is that a TERMINAL record does not survive a server restart, so a
 * result can be lost by quitting the app before looking at it. Stated rather
 * than implied away. Persisting it is a bigger change (a store, atomic writes,
 * a location outside the synced work-tree — see the ingest queue's own
 * `getIngestQueueDir` for why that last one is not a detail) and it is not
 * what the report asked for.
 *
 * ── KEYED BY DOMAIN ─────────────────────────────────────────────────────────
 * `src/routes/ingest.js` takes a per-domain file lock (`acquireFileLock(
 * domainPath(domain))`) before it starts, so at most one single-file ingest
 * can be running per domain. One record per domain is therefore not a
 * simplification, it is the shape of the thing. `startActivity` additionally
 * REFUSES to displace a record that is still `running` — so the lock and this
 * store cannot disagree about whether a domain is busy, and the route's
 * lock-refusal path cannot clobber the record belonging to the run that
 * actually holds the lock.
 *
 * ── IT CAN NEVER FAIL AN INGEST ─────────────────────────────────────────────
 * Same rule as the raw-source manifest (v3.5.0): a bookkeeping side-channel
 * must never be able to break the thing it is describing. Every exported
 * function swallows its own errors and returns a safe value. That is layer
 * one; `src/routes/ingest.js` wraps every call site as well. Two layers,
 * because the whole point is that this is not load-bearing.
 *
 * ── NOT ENFORCED (stated, not hidden) ───────────────────────────────────────
 *  - Nothing here is persisted. A restart loses terminal records (above).
 *  - The BATCH queue has the same terminal-case hole and is NOT covered here.
 *    `getActiveJob()` in ingest-queue.js filters on
 *    `!TERMINAL_STATUSES.has(job.status)`, so a batch that finished while you
 *    were away is invisible to `GET /api/ingest-queue/active` in exactly the
 *    way a finished single-file ingest was invisible to everything. Verified
 *    by reading that function; deliberately out of scope for this change.
 *  - This module records what the route EMITS. If a future caller writes
 *    pages without emitting, the record will not know. The route's single
 *    `emit()` closure is what makes that a non-issue today.
 */

import { randomUUID } from 'node:crypto';
import { wireStr, wireNum, wireBool } from './wire-safe.js';

/**
 * How long a TERMINAL record is kept.
 *
 * NOT a round number picked for looking reasonable. The record exists so a
 * user who walked away can come back and see what happened, so the floor is
 * "longer than a plausible absence", and the ceiling is set by the fact that
 * a result from a previous working session reappearing is noise rather than
 * news.
 *
 * The measured anchor is how long an ingest itself takes: v3.0.17's live runs
 * against an articles-scale domain were 587 s (Gemini) and 210 s (Anthropic),
 * and v3.16.0 measured a single runaway outline call at 467 s. 30 minutes is
 * roughly 3x the longest of those, so a user who starts a long ingest, leaves
 * for the length of that ingest again, and comes back, still sees the outcome.
 *
 * A `running` record NEVER expires. An ingest is legitimately allowed to take
 * a long time, and expiring a live one would re-create the exact defect this
 * module fixes. Expiry is only ever applied to a settled record.
 */
export const TERMINAL_TTL_MS = 30 * 60 * 1000;

/**
 * Caps on the arrays a terminal record carries.
 *
 * A normal ingest writes 5-30 pages, so none of these engages in practice —
 * they bound a runaway. v3.16.0 measured one real run that produced 903 pages
 * on a `finish_reason: length` runaway, and v3.0.17 measured 75 warnings on a
 * single live Gemini run before same-class aggregation cut it to 11.
 *
 * The array is truncated and the TRUE total is reported alongside it, rather
 * than the array being silently shortened. A client that renders counts from
 * a silently-shortened array reports a smaller ingest than actually happened —
 * an under-statement of the user's own work, which is the dishonest direction.
 */
export const MAX_CHANGES = 500;
export const MAX_PAGES_WRITTEN = 500;
export const MAX_WARNINGS = 200;

/**
 * Hard bound on how many domains can hold a record at once.
 *
 * The natural bound is the number of domains on the install, and the route
 * validates `domain` against `listDomains()` before it ever gets here, so this
 * cannot be driven by a caller. It exists so a pathological or programmatic
 * caller cannot grow the map without limit. Eviction takes the OLDEST TERMINAL
 * record — a running record is never evicted, because evicting one would make
 * a live ingest invisible, which is the defect.
 */
export const MAX_TRACKED_DOMAINS = 200;

/** domain -> record. Module-scoped, in-process, never persisted. */
const records = new Map();

function now() { return Date.now(); }

/** Terminal statuses. A record in one of these can expire and be replaced. */
const TERMINAL = new Set(['done', 'error']);

/**
 * Drop settled records past their TTL.
 *
 * Lazy — called from the mutating entry points and from the read. Deliberately
 * NOT a `setInterval`: a timer in a leaf module keeps the event loop alive,
 * has to be cleaned up by every test that imports it, and buys nothing here
 * because the map is only ever observed through the functions below.
 */
function sweep(at = now()) {
  for (const [domain, rec] of records) {
    if (TERMINAL.has(rec.status) && rec.finishedAt != null && (at - rec.finishedAt) > TERMINAL_TTL_MS) {
      records.delete(domain);
    }
  }
}

/** Evict the oldest terminal record if the map is over its bound. */
function enforceCap() {
  if (records.size <= MAX_TRACKED_DOMAINS) return;
  const terminal = [...records.entries()]
    .filter(([, r]) => TERMINAL.has(r.status))
    .sort((a, b) => (a[1].finishedAt || 0) - (b[1].finishedAt || 0));
  while (records.size > MAX_TRACKED_DOMAINS && terminal.length) {
    records.delete(terminal.shift()[0]);
  }
}

/**
 * Begin tracking a single-file ingest. Returns the record's id, or null.
 *
 * Returns null — and changes nothing — when a record for this domain is
 * still `running`. See the file header: the route's per-domain file lock
 * already guarantees one at a time, and refusing here means a second caller
 * cannot overwrite the live run's record with its own. A null id makes every
 * function below a no-op, so a caller never has to branch on it.
 */
export function startActivity(domain, filename) {
  try {
    if (typeof domain !== 'string' || !domain) return null;
    sweep();
    const existing = records.get(domain);
    if (existing && !TERMINAL.has(existing.status)) return null;

    const id = randomUUID();
    const at = now();
    records.set(domain, {
      id,
      domain,
      filename: typeof filename === 'string' ? filename : null,
      status: 'running',
      pct: 0,
      message: 'Starting…',
      waiting: false,
      startedAt: at,
      // The clock the view shows is PHASE elapsed, not run elapsed — it
      // resets on a genuine new step and deliberately does NOT reset on a
      // `wait` sub-event, so a stalled phase visibly keeps counting (v3.0.17).
      // Recording it here is what lets a REATTACHING view show the same
      // quantity as a watching one. Showing run-elapsed instead would put two
      // different measurements behind one readout — the "three-figure defect"
      // views/ingest.js already carries a long comment about.
      phaseStartedAt: at,
      finishedAt: null,
      error: null,
      result: null,
    });
    enforceCap();
    return id;
  } catch {
    return null;
  }
}

/**
 * Fold one SSE event into the record.
 *
 * ONE function for every event type, because the route has ONE `emit()`
 * closure that every event goes through — progress, wait, done and error
 * alike. Matching that shape means the integration is a single wrapped call
 * rather than four call sites that can each be forgotten separately.
 *
 * `id` is checked against the stored record so a late event from a previous
 * run cannot write into the record of the run that replaced it.
 */
export function observeActivity(id, event) {
  try {
    if (!id || !event || typeof event !== 'object') return;
    const rec = findById(id);
    if (!rec) return;
    if (TERMINAL.has(rec.status)) return; // settled; a later event is stale

    const at = now();
    if (event.type === 'progress' || event.type === 'wait') {
      const waiting = event.type === 'wait';
      // Only a genuine step restarts the phase clock. A `wait` is a
      // retry/backoff sub-event that re-sends the SAME pct — v3.0.17 made the
      // clock keep counting through those on purpose, so that a stalled phase
      // looks stalled rather than looking restarted.
      if (!waiting) rec.phaseStartedAt = at;
      if (typeof event.pct === 'number' && Number.isFinite(event.pct)) rec.pct = event.pct;
      if (typeof event.message === 'string') rec.message = event.message;
      rec.waiting = waiting;
      return;
    }

    if (event.type === 'done') {
      rec.status = 'done';
      rec.pct = 100;
      rec.waiting = false;
      rec.finishedAt = at;
      const changes = Array.isArray(event.changes) ? event.changes : [];
      const pages = Array.isArray(event.pagesWritten) ? event.pagesWritten : [];
      const warnings = Array.isArray(event.warnings) ? event.warnings : [];
      rec.result = {
        title: event.title,
        changes: changes.slice(0, MAX_CHANGES),
        changesTotal: changes.length,
        pagesWritten: pages.slice(0, MAX_PAGES_WRITTEN),
        pagesWrittenTotal: pages.length,
        warnings: warnings.slice(0, MAX_WARNINGS),
        warningsTotal: warnings.length,
        truncated: !!event.truncated,
        wasOverwrite: !!event.wasOverwrite,
        tokenUsage: event.tokenUsage,
      };
      return;
    }

    if (event.type === 'error') {
      rec.status = 'error';
      rec.waiting = false;
      rec.finishedAt = at;
      rec.error = typeof event.message === 'string' ? event.message : 'Ingest failed.';
    }
  } catch {
    /* bookkeeping must never break an ingest */
  }
}

/**
 * Close a record that is still `running` when its request is over.
 *
 * Called from the route's outermost `finally`, so a record structurally
 * cannot outlive the request that owns it. Without it, a throw on a path that
 * never reaches `emit()` would leave a record saying `running` forever — and
 * because the view treats a running record as "this domain is busy", that
 * would disable Ingest for that domain until the app restarted. A stuck
 * bookkeeping record turning into a stuck BUTTON is precisely the "cannot
 * fail an ingest" rule being violated one step removed.
 *
 * A no-op on an already-settled record, which is the overwhelmingly common
 * case (the route's own catch emits an `error` event first).
 */
export function settleAbandoned(id) {
  try {
    if (!id) return;
    const rec = findById(id);
    if (!rec || TERMINAL.has(rec.status)) return;
    rec.status = 'error';
    rec.waiting = false;
    rec.finishedAt = now();
    rec.error = 'The ingest stopped without reporting a result. Nothing further will be written; ' +
                're-ingest the file to try again.';
  } catch {
    /* see above */
  }
}

function findById(id) {
  for (const rec of records.values()) if (rec.id === id) return rec;
  return null;
}

// ── The wire representation ──────────────────────────────────────────────────
//
// An explicit ALLOW-LIST, never a `...rest` spread. v3.3.0 shipped the spread
// form in the ingest queue and it had two defects a field-name blocklist
// structurally cannot fix: it echoed every field it did not recognise, so any
// future internal field leaked by DEFAULT; and it was unbounded (a measured
// 50,002,001-byte response from a 48 MB manifest). Every string goes through
// `wireStr`, which scrubs absolute paths and caps length — load-bearing here,
// because `rec.error` and `rec.message` can carry a raw `fs` error, and a raw
// `fs` error embeds the user's home directory and cloud-storage layout.

function wireChange(c) {
  if (!c || typeof c !== 'object') return null;
  const sections = Array.isArray(c.sectionsChanged) ? c.sectionsChanged : [];
  return {
    canonPath: wireStr(c.canonPath, 512),
    status: wireStr(c.status, 32),
    bytesBefore: wireNum(c.bytesBefore),
    bytesAfter: wireNum(c.bytesAfter),
    // Section names come from wiki headings, so they are bounded in practice;
    // capped anyway, for the same reason every other array here is.
    sectionsChanged: sections.slice(0, 40).map((s) => wireStr(s, 128)).filter((s) => s !== null),
    bulletsAdded: wireNum(c.bulletsAdded),
  };
}

function wireTokenUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    provider: wireStr(u.provider, 64),
    model: wireStr(u.model, 128),
    calls: wireNum(u.calls),
    inputTokens: wireNum(u.inputTokens),
    outputTokens: wireNum(u.outputTokens),
    cachedReadTokens: wireNum(u.cachedReadTokens),
    cacheWriteTokens: wireNum(u.cacheWriteTokens),
  };
}

function wireRecord(rec) {
  const r = rec.result;
  return {
    id: wireStr(rec.id, 64),
    domain: wireStr(rec.domain, 256),
    filename: wireStr(rec.filename, 512),
    status: wireStr(rec.status, 32),
    pct: wireNum(rec.pct),
    message: wireStr(rec.message),
    waiting: wireBool(rec.waiting),
    startedAt: wireNum(rec.startedAt),
    phaseStartedAt: wireNum(rec.phaseStartedAt),
    finishedAt: wireNum(rec.finishedAt),
    error: wireStr(rec.error),
    result: r ? {
      title: wireStr(r.title, 512),
      changes: r.changes.map(wireChange).filter(Boolean),
      changesTotal: wireNum(r.changesTotal),
      pagesWritten: r.pagesWritten.map((p) => wireStr(p, 512)).filter((p) => p !== null),
      pagesWrittenTotal: wireNum(r.pagesWrittenTotal),
      warnings: r.warnings.map((w) => wireStr(w)).filter((w) => w !== null),
      warningsTotal: wireNum(r.warningsTotal),
      truncated: wireBool(r.truncated),
      wasOverwrite: wireBool(r.wasOverwrite),
      tokenUsage: wireTokenUsage(r.tokenUsage),
    } : null,
  };
}

/**
 * Everything currently tracked, wire-safe.
 *
 * `serverNow` is the server's own epoch-ms clock, sent alongside so a client
 * can turn `phaseStartedAt` into an elapsed duration by SUBTRACTION ONLY —
 * `elapsed = serverNow - phaseStartedAt` — with no reasoning about clock skew
 * between the two machines. Both figures come from the same clock; the client
 * only ever needs their difference. (v3.19.0 ranked a clock-derived figure
 * LAST among rate-limit sources for exactly the skew reason; here the skew
 * cancels, which is why this is safe and that was not.)
 */
export function listActivity() {
  try {
    sweep();
    return {
      serverNow: now(),
      activity: [...records.values()].map(wireRecord),
    };
  } catch {
    // A read that throws must not 500 a view whose whole job is telling the
    // user what happened. An empty list degrades to today's behaviour.
    return { serverNow: now(), activity: [] };
  }
}

/** Test seam. Never called in production. */
export function __resetActivityForTests() {
  records.clear();
}

/** Test seam: the raw in-memory record, pre-wire. Never called in production. */
export function __peekActivityForTests(domain) {
  return records.get(domain) || null;
}
