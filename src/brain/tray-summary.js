/**
 * src/brain/tray-summary.js — ONE cheap call for the menubar widget.
 *
 * `getTraySummary()` is the whole data surface of the tray: the shell calls
 * it, renders what comes back, and asks nothing else. It is a PROJECTION over
 * the working-state store, not a second inventory of it.
 *
 * ── WHY THIS IS ITS OWN MODULE AND NOT PART OF working-state.js ───────────
 *
 * Three reasons, in order of weight.
 *
 * 1. THE STORE HAS NO NOTION OF "HOW MANY PROJECTS", AND THAT IS DELIBERATE.
 *    Every function in working-state.js takes a `project` and answers about
 *    that project. `src/routes/memory.js` says so in its own docblock and
 *    owns `MAX_PROJECTS` for exactly that reason — the cross-project cap is
 *    the *consumer's* bound, not the store's. A function that enumerates
 *    domains would be the first thing in the store to know that domains come
 *    in a list, and every later reader would reasonably conclude the store
 *    owns that concept.
 *
 * 2. THIS ROW CARRIES FACTS THE STORE DOES NOT OWN. `remote` is a Personal
 *    Sync fact; `brief` is a stat the route layer already had to compute for
 *    itself. Putting either inside the store would drag `sync.js` into the
 *    import graph of a module the MCP server loads on every spawn — and the
 *    MCP's stdout-discipline rule is stated over exactly that reachable
 *    import graph.
 *
 * 3. working-state.js is already 2,600+ lines and is the file every audit of
 *    this feature has to read end to end. A projection for one surface does
 *    not belong in it.
 *
 * What this module deliberately does NOT do is re-walk the tree. It calls
 * `listWorkingScopes` — the same function the app view and the MCP call — so
 * the tray and the app can never come to disagree about what is on disk.
 * That is the rule `routes/memory.js` records when it refuses a "cheaper
 * hand-rolled walker".
 *
 * ── THIS MODULE MAKES NO NETWORK CALL, AND THAT IS STRUCTURAL ─────────────
 *
 * It does not import `src/brain/sync.js`. Not the constants, not the types,
 * nothing — so no edit to this file can reach `getRemoteStatus()`, which is a
 * real `git fetch` behind a TTL cache, without first adding an import that a
 * reviewer will see. That is a stronger guarantee than "we only call it when
 * the cache is warm", and it is the only one available, because sync.js
 * exposes no way to READ its cache without also being willing to fill it:
 *
 *     getRemoteStatus({maxAgeMs}) -> cache hit ? return : git fetch
 *
 * There is no peek. `maxAgeMs: 0` does not help — `remoteCacheTtl` returns 0
 * for a successful payload, so `(now - at) < 0` is false and the call fetches.
 * A second fetch site is not a theoretical cost here: v3.9.1 put one behind
 * the sync badge and it aborted the user's own pull 11 times out of 12 over a
 * ref lock. So the tray does not get one.
 *
 * Instead `remote` is an OBSERVATION: whatever the last completed remote
 * check said, handed to `noteRemoteStatus()` by whoever ran it. See that
 * function for who is expected to call it and why the field is null until
 * they do.
 *
 * ── COST ──────────────────────────────────────────────────────────────────
 *
 * Exactly what `GET /api/memory` costs, which the navbar badge already polls:
 * `listDomains()` (one readdir + one stat per candidate) plus, per project,
 * `listWorkingScopes()` — one stat per (scope, machine) pair and one 16 KB
 * journal tail read per pair it returns, bounded by MAX_INDEX_ENTRIES. No
 * LLM, no network, no subprocess, no write to the state store.
 *
 * The `pulse` strip adds NO file I/O to that. Every timestamp it buckets was
 * already read and already parsed to compute a row's age — `journalFacts` then
 * discarded all but the newest (54 of 65 lines on the maintainer's real
 * store). The heartbeat is those numbers kept rather than thrown away; see
 * `computePulse` and working-state.js's `withSaveTimes` opt-in.
 *
 * ── EVERY NUMBER IS A MEASUREMENT OR A NULL ───────────────────────────────
 *
 * An age that is not known arrives as `null`, never as 0 and never as a
 * string. A cap that was hit is reported in `warnings` with the TRUE total
 * beside it, so a cap can never be read as a measurement. Both rules are this
 * repo's, applied here rather than restated.
 */

import { stat } from 'fs/promises';
import { listDomains } from './files.js';
import {
  listWorkingScopes,
  resolveInsideState,
  machineId,
  hostSlug,
  BRIEF_FILENAME,
  INSTALL_ID_RE,
} from './working-state.js';

/** Rows the panel asks for when it does not say. §1.3's eight-row layout. */
export const TRAY_DEFAULT_LIMIT = 8;

/**
 * Hard ceiling on rows, whatever the caller asks for. Well above the panel's
 * eight so an "expanded" view is possible, well below MAX_INDEX_ENTRIES so a
 * caller cannot turn a menubar poll into a full index dump by passing a large
 * number.
 */
export const TRAY_MAX_LIMIT = 40;

/**
 * Projects scanned. DELIBERATELY THE SAME NUMBER as `MAX_PROJECTS` in
 * src/routes/memory.js, and not imported from it: `src/brain/` must not
 * import from `src/routes/`, and duplicating one integer is the lesser evil
 * against inverting the dependency.
 *
 * Matching matters more than the value does. A tighter cap here would make
 * the tray say "nothing saved" about a project the app's Agent memory view
 * lists happily — two surfaces over one store disagreeing about what exists,
 * which is the failure this whole module is arranged to avoid. If one of
 * these two ever moves, move both.
 */
export const TRAY_MAX_PROJECTS = 200;

/**
 * How long an observed remote answer stays worth showing.
 *
 * Numerically equal to sync.js's REMOTE_CHECK_TTL_MS, and NOT imported from
 * it — see the module docblock: this file must not import sync.js at all, and
 * a constant is not worth breaking that for. It is an upper bound on staleness
 * for a fact whose own producer already refuses to reuse an answer older than
 * this, so the two can only ever agree or this one can be stricter.
 */
export const REMOTE_OBSERVATION_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * How many harness collisions are named individually before the rest are
 * reported as a count. Each collision names a specific folder the user has to
 * decide about, so they are NOT aggregated the way a repeated pipeline warning
 * is; this cap exists only so a pathological store cannot flood the payload.
 */
const MAX_LISTED_COLLISIONS = 10;

// ─────────────────────────────────────────────────────────────────────────
// The pulse — an aggregate heartbeat over the memory layer
// ─────────────────────────────────────────────────────────────────────────

/**
 * How far back the heartbeat looks: SEVEN DAYS, and the number is measured
 * rather than chosen for tidiness.
 *
 * On the maintainer's real store the median gap between saves is 28.8 minutes
 * and the last 24 hours hold FOUR saves. A 24-hour window would therefore draw
 * a strip that is empty most of the time and says nothing about whether the
 * habit is alive — the one question a heartbeat is for. Seven days covers the
 * 3.52-day span his store actually holds with room for it to grow, and it puts
 * a weekend inside the window, which is where an honest work rhythm shows.
 */
export const PULSE_WINDOW_SECONDS = 7 * 24 * 3600;      // 604800

/**
 * Six hours per cell. 28 cells across the window — enough resolution to see
 * morning-versus-evening within a day, few enough that one cell is a
 * meaningful number of saves rather than a coin flip at a 28.8-minute median.
 */
export const PULSE_BUCKET_SECONDS = 6 * 3600;           // 21600

/** 604800 / 21600 = 28. Derived, never typed twice. */
export const PULSE_BUCKET_COUNT = PULSE_WINDOW_SECONDS / PULSE_BUCKET_SECONDS;

/**
 * Reduce per-pair save timestamps to the heartbeat strip.
 *
 * PURE and exported, so bucket boundaries can be driven directly rather than
 * inferred from a tree on disk — the same reason `journalFacts` is exported.
 *
 * @param {Array<{saveTimes: number[]|null, journalTailTruncated?: boolean}>} pairs
 *   one entry per (scope, machine) pair READ, in any order. `saveTimes` is
 *   epoch ms; `null` means there was no journal to read, which is different
 *   from an empty array and is counted differently.
 * @param {number} now  the clock the buckets are anchored to.
 * @returns {object|null} the `pulse` payload, or null when NOTHING was read.
 *
 * ── WHERE THE BOUNDARIES ARE, STATED ONCE SO IT CANNOT DRIFT ─────────────
 *
 * Buckets are anchored on `now`, not on midnight, so the newest cell is
 * always the one containing this instant. Cell `i` (0 = oldest, 27 = newest)
 * covers
 *
 *     ( now - (COUNT - i) * bucket ,  now - (COUNT - 1 - i) * bucket ]
 *
 * — OPEN at the older edge, CLOSED at the newer edge. So the whole window is
 * `(now - window, now]`, an event landing EXACTLY on an internal boundary
 * belongs to the OLDER of the two cells it touches, and an event landing
 * exactly on `now - window` is outside the window rather than in cell 0.
 * Every event therefore lands in exactly one cell, and the suite asserts it
 * on a real boundary rather than trusting this paragraph.
 *
 * A save stamped in the FUTURE — a machine with a skewed clock, which sync
 * makes reachable — is clamped into the newest cell and counted. That is the
 * same direction `journalFacts` already clamps a negative age to 0: a real
 * save is not made unreal by a bad clock, and dropping it would silently
 * shrink the count a user is being shown.
 */
export function computePulse(pairs, now = Date.now()) {
  const bucketMs = PULSE_BUCKET_SECONDS * 1000;
  const windowMs = PULSE_WINDOW_SECONDS * 1000;
  const windowStart = now - windowMs;
  const buckets = new Array(PULSE_BUCKET_COUNT).fill(0);

  let events = 0;
  let eventsOutsideWindow = 0;
  let pairsCounted = 0;
  let pairsTruncated = 0;
  let oldestCounted = null;      // oldest event INSIDE the window
  let oldestSeen = null;         // oldest event at all, window or not

  for (const p of Array.isArray(pairs) ? pairs : []) {
    // A pair with no journal fed nothing. It is not counted as a pair that
    // reported zero saves, because it did not report anything.
    if (!p || !Array.isArray(p.saveTimes)) continue;
    pairsCounted++;
    if (p.journalTailTruncated === true) pairsTruncated++;
    for (const t of p.saveTimes) {
      if (!Number.isFinite(t)) continue;
      if (oldestSeen === null || t < oldestSeen) oldestSeen = t;
      if (t <= windowStart) { eventsOutsideWindow++; continue; }
      buckets[bucketIndex(t, now, bucketMs)]++;
      events++;
      if (oldestCounted === null || t < oldestCounted) oldestCounted = t;
    }
  }

  // NULL ONLY WHEN THERE ARE NO JOURNALS AT ALL. A store that has journals but
  // no usable timestamps in them is a real, drawable state — an empty strip
  // with `clock: 'none'` — and must not be collapsed into "there is no store".
  if (pairsCounted === 0) return null;

  // COVERAGE IS THE FACT-VERSUS-ABSENCE RULE APPLIED TO A CHART.
  //
  // A brand-new store and a dormant one draw the same 28 empty cells, and they
  // mean opposite things. `coversWholeWindow` is true only when something was
  // saved at or before the window opened — i.e. the store demonstrably existed
  // for the whole span — so the renderer can grey the leading cells as "did
  // not exist yet" instead of drawing them as "nothing happened".
  const coversWholeWindow = oldestSeen !== null && oldestSeen <= windowStart;

  return {
    windowSeconds: PULSE_WINDOW_SECONDS,
    bucketSeconds: PULSE_BUCKET_SECONDS,
    buckets,
    events,
    eventsOutsideWindow,
    pairsCounted,
    // A LOWER BOUND, DISCLOSED. Any pair here had more history than the 16 KB
    // journal tail could reach, so its older cells under-count. Derived from
    // readTail's own signal — see readPairJournalFacts.
    pairsTruncated,
    // 'agent' means every counted event came from a journal line's own `at`.
    // There is no other value it could take: this module never reads an mtime
    // into the pulse, so there is deliberately no 'file' and no 'mixed'.
    clock: (events + eventsOutsideWindow) > 0 ? 'agent' : 'none',
    oldestEventAt: oldestCounted === null ? null : new Date(oldestCounted).toISOString(),
    coversWholeWindow,
    // Cells BEFORE this index are unknown, not empty. When the store provably
    // predates the window there is nothing unknown, so it is 0. When nothing
    // at all was counted it is PULSE_BUCKET_COUNT — one past the last cell,
    // meaning "no cell is known", which is the honest answer and still an int.
    firstKnownBucket: coversWholeWindow ? 0
      : (oldestCounted === null ? PULSE_BUCKET_COUNT
        : bucketIndex(oldestCounted, now, bucketMs)),
  };
}

/**
 * Which cell an in-window (or future) timestamp belongs to.
 *
 * Counting BACK from `now` rather than forward from the window start: the
 * newest cell is then 27 by construction for anything at or after `now -
 * bucket`, and the "is `now` itself in the last cell or one past the end?"
 * off-by-one simply cannot arise. The clamp catches future timestamps only.
 */
function bucketIndex(t, now, bucketMs) {
  const back = Math.floor((now - t) / bucketMs);
  const i = PULSE_BUCKET_COUNT - 1 - back;
  return i < 0 ? 0 : (i > PULSE_BUCKET_COUNT - 1 ? PULSE_BUCKET_COUNT - 1 : i);
}

// ─────────────────────────────────────────────────────────────────────────
// The remote observation
// ─────────────────────────────────────────────────────────────────────────

let _remoteObservation = null;   // { at: epochMs, remote: {...} }

/**
 * Record the result of a remote check somebody ELSE performed.
 *
 * ── WHO CALLS THIS, AND WHY IT IS NOT AN UNWIRED FIELD ───────────────────
 *
 * The menubar panel fetches the unpulled-remote count ON OPEN and never on a
 * timer — that is a decision with a measured argument behind it
 * (docs/roadmap-menubar-widget.md §2.9(b)): the question is only actionable
 * at the moment the panel is open, and a background timer buys a slightly
 * fresher badge in exchange for The Curator phoning GitHub forever behind a
 * closed menu, on battery, possibly metered.
 *
 * So the *fetch* belongs to the panel, and this function is where the panel
 * hands the answer back so the next `getTraySummary()` — which may be driven
 * by a filesystem watch a second later, with the panel still open — can
 * render it without asking again.
 *
 * TWO FEEDERS, AND THE SECOND ONE IS WHY THE FIRST WAS NOT ENOUGH.
 *
 *  1. `src/routes/sync.js` calls this on every `GET /api/sync/remote-status`,
 *     which the shell's sync badge polls — keeping the observation warm for
 *     free, with no additional fetch anywhere.
 *  2. `desktop/main.js`'s `maybeCheckRemote()`, on a tray MENU OPEN.
 *
 * Feeder 1 alone left this field DEAD in the tray's normal state, and the
 * paragraph above used to describe a fetch-on-open that did not exist. The
 * frontend drives that endpoint from `refreshSyncRemoteBadgeIfVisible()`,
 * which declines to fetch while `document.hidden` — correct on its own terms,
 * and it means that with the window CLOSED, which is the only state the tray
 * exists for, no observation ever arrived and any existing one expired after
 * REMOTE_OBSERVATION_MAX_AGE_MS. The multi-machine signal was inert exactly
 * where it was needed. Nothing rendered wrongly; the line simply never
 * appeared.
 *
 * Feeder 2 closes that, and the argument for its shape — why a menu open and
 * never a timer, and what was and was not verified about racing the user's
 * own pull — is in `desktop/lib/tray-remote.js`. What matters HERE is only
 * that this module still makes no network call and still imports no sync.js:
 * the shell does the asking and hands the answer back through this function,
 * which is the same contract feeder 1 already used.
 *
 * Until something calls this, `remote` is `null` — which is the honest answer
 * ("nobody has checked") and is exactly what the contract asks for in place
 * of triggering a fetch.
 *
 * @param {object|null} payload  a `getRemoteStatus()` result, or null to clear.
 * @returns {boolean} whether anything was recorded.
 */
export function noteRemoteStatus(payload, now = Date.now()) {
  if (payload === null || payload === undefined) { _remoteObservation = null; return false; }
  if (typeof payload !== 'object') return false;
  // An unconfigured install has no remote at all. That is not an observation
  // of "0 waiting" and must not be stored as one.
  if (payload.configured !== true) { _remoteObservation = null; return false; }

  // `behindFiles` is null on a FAILED check by sync.js's own honesty rule, and
  // it is carried through as null. "We could not ask" and "there is nothing
  // waiting" are different facts; collapsing them here would undo the rule at
  // the one place it is consumed.
  _remoteObservation = {
    at: Number.isFinite(now) ? now : Date.now(),
    remote: {
      // `ok` IS THE THIRD STATE, AND WITHOUT IT THE FIRST TWO COLLAPSE.
      //
      // This module has always kept "we could not ask" apart from "there is
      // nothing waiting" — that is the honesty rule, and the failed-check
      // observation carries null counts and a real `checkedAt` to prove it.
      // But the ONLY consumer, tray-model.js's `remoteNotice()`, branches on
      // `remote.ok === false`, and nothing here ever emitted an `ok`. So a
      // failed check reached the menu as `{behindFiles: null, …}`, took the
      // "no number to show" exit, and rendered as NOTHING — byte-identical to
      // never having checked. The distinction survived the store and died at
      // the model.
      //
      // That was tolerable while nothing ever triggered a check: absence is
      // honest when the normal state is "nobody asked". It stops being
      // tolerable the moment the tray asks on its own (see the shell's
      // on-open check), because then silence is read as an answer.
      //
      // `remoteChecked` is what sync.js's own `runRemoteCheck` sets on both
      // arms, so it is the authoritative field. It is read STRICTLY for
      // failure and leniently otherwise: only an explicit `false` becomes a
      // reported failure, so a payload from some other shape that omits the
      // field is not accused of having failed.
      ok: payload.remoteChecked !== false,
      behindFiles: Number.isInteger(payload.behindFiles) ? payload.behindFiles : null,
      behindCommits: Number.isInteger(payload.behindCommits) ? payload.behindCommits : null,
      checkedAt: typeof payload.checkedAt === 'string' ? payload.checkedAt : null,
    },
  };
  return true;
}

/** Test seam. Drops any recorded observation. */
export function __resetRemoteObservation() { _remoteObservation = null; }

/**
 * The observation, or null once it is older than
 * REMOTE_OBSERVATION_MAX_AGE_MS. Stale is dropped rather than shown with an
 * age, because a menubar line saying "2 waiting" is read as current and there
 * is no room beside it to say it is not.
 */
function readRemoteObservation(now) {
  if (!_remoteObservation) return null;
  if (now - _remoteObservation.at >= REMOTE_OBSERVATION_MAX_AGE_MS) return null;
  return { ..._remoteObservation.remote };
}

// ─────────────────────────────────────────────────────────────────────────
// Row projection
// ─────────────────────────────────────────────────────────────────────────

/**
 * Which clock a row's age came from, and the age itself.
 *
 * `writtenAt` on a store row is the AGENT's clock, taken from the journal
 * line the agent wrote. `lastWriteAt` is `st.mtime` — when the file last
 * changed on THIS disk, which for state that arrived over Personal Sync is
 * the moment of the pull, not the moment of the save. git rewrites mtime on
 * checkout, so on a multi-machine setup the two differ by however long the
 * handoff sat on the other machine.
 *
 * The tray shows ONE age, so it has to choose — and having chosen, it must
 * say which one it chose. That is `ageSource`. Without it the panel would
 * render "just now" over a day-old handoff and be unable to tell the user it
 * was guessing.
 *
 * `writtenAt` is nullable in the store by design (the journal append is
 * best-effort, and a hand-edited line may carry no usable `at`), so the
 * fallback is a real path and not a defensive one.
 *
 * Both raw facts are ALSO emitted, under names that can only mean one thing,
 * so a consumer that wants §1.3's "written 3 hr ago · arrived just now" line
 * has them without re-deriving anything.
 */
function chooseClock(row) {
  const agentAt = typeof row.writtenAt === 'string' ? row.writtenAt : null;
  const agentAge = Number.isFinite(row.writtenAgeSeconds) ? row.writtenAgeSeconds : null;
  const fileAt = typeof row.lastWriteAt === 'string' ? row.lastWriteAt : null;
  const fileAge = Number.isFinite(row.ageSeconds) ? row.ageSeconds : null;

  // The agent clock wins only when BOTH halves of it are present. A timestamp
  // with no age (or the reverse) would make the panel render one fact from
  // one clock and one from the other.
  const useAgent = agentAt !== null && agentAge !== null;

  return {
    agentWrittenAt: agentAt,
    agentWrittenAgeSeconds: agentAge,
    fileChangedAt: fileAt,
    fileChangedAgeSeconds: fileAge,
    writtenAt: useAgent ? agentAt : fileAt,
    writtenAgeSeconds: useAgent ? agentAge : fileAge,
    // A row exists because `current.md` stat succeeded, so the file clock is
    // always available and `ageSource` is always one of the two literals. It
    // is still computed rather than asserted: a store that ever returns a row
    // without `lastWriteAt` should produce a null age here, not a confident
    // 'file' over a null number.
    ageSource: useAgent ? 'agent' : (fileAt !== null ? 'file' : null),
  };
}

/** Absolute ms for ordering. Not an age — ages come from two different `now`s. */
function orderKey(clock) {
  const iso = clock.writtenAt;
  if (typeof iso !== 'string') return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Is this row's `<machine>` folder this installation's own?
 *
 * `machineId()` is the identity every save writes under, so an exact match is
 * identity. A HOSTNAME match is a weaker fact and is reported separately
 * under its own name — a folder can share this host's name and belong to a
 * different installation, which is the entire reason the installation id
 * exists. `readWorkingState` makes the same split for the same reason; this
 * is that rule, not a new one.
 *
 * EXPORTED PURELY AS A TEST SEAM, and it was a mutation that forced it. The
 * `selfInstallId !== null` guard below is only REACHABLE when this install has
 * no parseable installation id — the degraded case where the home directory
 * could not hold `.curator-install-id`. A tempdir install always mints one, so
 * deleting that guard ran GREEN through the whole end-to-end suite: it was
 * masked by the fixture, not redundant. The one honest way to drive it is to
 * hand this function `selfInstallId: null` directly. Same reason `journalFacts`
 * and `computePulse` are exported.
 */
export function machineIdentity(machine, self, host, hostRe, selfInstallId) {
  const exact = machine === self;
  // ── ONE LAPTOP, TWO FOLDER NAMES — and the user was being shown two
  //    computers. MEASURED on the maintainer's own store: `mac-17d23c` and
  //    `talis-macbook-pro-17d23c` are the same machine, because macOS
  //    re-derives the hostname from DHCP and the folder name followed it. That
  //    is working-state.js's own D10 finding; D10 fixed the GO-FORWARD case by
  //    remembering the folder name instead of recomputing it, but the split it
  //    describes is already on disk and no future save removes it.
  //
  //    An exact-string comparison therefore classified half of his own history
  //    as a remote machine, and the menu rendered a machine name in the slot
  //    that shows a harness for local rows.
  //
  //    THE MATCH IS ON THE INSTALLATION ID AND NOTHING ELSE, which is what
  //    makes it safe. That id is minted once per install and lives in
  //    `.curator-install-id`; two different computers do not share one. The
  //    hostname half — the part that flaps — is deliberately not compared at
  //    all, so `buildbox-a1b2c3` cannot become "this machine" unless it
  //    literally carries this installation's id.
  //
  //    BOTH SIDES MUST HAVE ONE. A degraded install with no id resolves to a
  //    bare hostname, and `installIdOf` returns null for it; two nulls must
  //    never compare equal, or every id-less machine in a synced store would
  //    claim to be this one. The `!== null` guards below are that rule, and the
  //    suite asserts it directly rather than trusting the shape.
  const sameInstall = !exact
    && selfInstallId !== null
    && installIdOf(machine) === selfInstallId;
  return {
    isThisMachine: exact || sameInstall,
    // HOW it matched, because a derived answer that cannot be questioned is
    // one nobody can debug. 'install-id' is the renamed-hostname case above.
    machineMatch: exact ? 'exact' : (sameInstall ? 'install-id' : 'none'),
    isThisHost: machine === host || hostRe.test(machine),
  };
}

/**
 * The trailing installation id of a `<hostname-slug>-<install-id>` segment, or
 * null when there is not one.
 *
 * The SHAPE COMES FROM working-state.js's own INSTALL_ID_RE rather than from a
 * second regex written beside it — a local `/-[0-9a-f]+$/` would be free to
 * drift from the id that module actually mints, and would already be wrong
 * about the length bounds.
 *
 * `lastIndexOf` and not a split: a hostname may contain hyphens
 * (`talis-macbook-pro`), and only the final segment is ever the id. `i <= 0`
 * rejects both "no hyphen at all" and a leading hyphen, so a bare hostname
 * yields null and can never match anything.
 */
function installIdOf(machine) {
  if (typeof machine !== 'string') return null;
  const i = machine.lastIndexOf('-');
  if (i <= 0) return null;
  const tail = machine.slice(i + 1);
  return INSTALL_ID_RE.test(tail) ? tail : null;
}

// ─────────────────────────────────────────────────────────────────────────
// The one call
// ─────────────────────────────────────────────────────────────────────────

/**
 * Everything the menubar widget renders, in one local call.
 *
 * ```
 * {
 *   ok: true,
 *   lastSave: {project, scope, machine, harness, writtenAt, writtenAgeSeconds,
 *              ageSource, kind, isThisMachine} | null,
 *   scopes:   [{project, scope, machine, harness, writtenAt, writtenAgeSeconds,
 *               ageSource, headline, isThisMachine, harnessShared, ...}],
 *   total: <rows before the limit>, pairsOnDisk: <every pair seen>,
 *   truncated: <total > scopes.length>,
 *   pulse:    {windowSeconds, bucketSeconds, buckets[28], events,
 *              eventsOutsideWindow, pairsCounted, pairsTruncated, clock,
 *              oldestEventAt, coversWholeWindow, firstKnownBucket} | null,
 *   brief:    {project, ageSeconds} | null,
 *   remote:   {ok, behindFiles, behindCommits, checkedAt} | null,
 *   warnings: [{code, message, ...}]
 * }
 * ```
 *
 * FLAT AND NEWEST-FIRST ACROSS PROJECTS, not grouped by project. The audience
 * is watching an agent, an agent works in one scope at a time, and "what has
 * just happened" is a recency question. The project name rides on each row.
 *
 * `lastSave` is `scopes[0]` re-projected, built from the SAME row object, so
 * the headline row and the glyph can never describe different saves.
 *
 * NEVER THROWS. A store that cannot be read yields empty arrays and a
 * warning, because a menubar panel that renders an exception is a panel the
 * user reads as "the app is broken".
 *
 * @param {{limit?: number, now?: number}} [opts]
 *   `now` is a test seam for the remote observation's staleness window; the
 *   store computes its own ages from its own clock.
 */
export async function getTraySummary(opts = {}) {
  const now = Number.isFinite(opts && opts.now) ? opts.now : Date.now();
  const limit = normaliseLimit(opts && opts.limit);
  const warnings = [];

  let domains = [];
  try {
    domains = await listDomains();
  } catch (err) {
    // The domains folder is missing or unreadable. That is a real state (a
    // user who moved it, a disconnected volume) and it is reported as one.
    return {
      ok: true, lastSave: null, scopes: [], brief: null,
      // Nothing was read, so there is no heartbeat — not an empty one. A strip
      // of 28 zeroes here would be a confident claim that nothing was saved
      // this week, made by a call that could not open the folder.
      pulse: null,
      remote: readRemoteObservation(now),
      warnings: [{
        code: 'domains-unreadable',
        message: 'Could not read the knowledge folder, so no agent memory can be listed.',
        detail: err && err.code ? String(err.code) : null,
      }],
    };
  }

  const scanned = domains.slice(0, TRAY_MAX_PROJECTS);
  if (domains.length > scanned.length) {
    // A cap is disclosed with the true total beside it. It is never allowed
    // to read as a measurement.
    warnings.push({
      code: 'projects-truncated',
      message: `Scanned the first ${scanned.length} of ${domains.length} projects.`,
      scanned: scanned.length,
      total: domains.length,
    });
  }

  // Resolved ONCE for the whole call, not per row: `machineId()` can mint the
  // identity files on its first ever call, and a per-row call would ask that
  // question dozens of times for one answer that cannot change mid-loop.
  //
  // Deferred until we know there is at least one row, so a fresh install
  // whose tray is polling an empty store does not mint identity files as a
  // side effect of a READ. It is idempotent and harmless when it happens —
  // any save would do the same — but a read causing a write is worth not
  // doing when one `if` avoids it.
  let identityResolved = false;
  let self = null, host = null, hostRe = null, selfInstallId = null;

  const rows = [];
  let pairTotal = 0;
  let unlisted = 0;
  const collisions = [];
  // ── THE PULSE'S INPUT, GATHERED FROM EVERY PAIR READ ────────────────────
  //
  // Filled inside the walk, BEFORE the sort and BEFORE `rows.slice(0, limit)`.
  // The tray shows 8 rows while reading 11 pairs on the maintainer's own
  // store; a heartbeat drawn from the 8 would be a picture of the display cap
  // rather than of his week. Reporting a CAP as a MEASUREMENT is this repo's
  // own twice-shipped defect, and the suite asserts that `limit: 1` does not
  // move `events`.
  const pulseInput = [];

  for (const project of scanned) {
    let idx;
    try {
      // THE ONLY CALLER THAT ASKS FOR SAVE TIMES. `src/routes/memory.js` and
      // `mcp/tools/working-state.js` both call this with one argument, so the
      // MCP index — which is under a 400 KB response budget — is unchanged.
      idx = await listWorkingScopes(project, { withSaveTimes: true });
    } catch {
      continue;                       // listWorkingScopes does not throw; belt.
    }
    if (!idx || !idx.ok || !Array.isArray(idx.scopes)) continue;

    pairTotal += Number.isInteger(idx.total) ? idx.total : idx.scopes.length;
    unlisted += Number.isInteger(idx.unlistedEntries) ? idx.unlistedEntries : 0;

    for (const p of idx.scopes) {
      if (!p || typeof p.scope !== 'string' || typeof p.machine !== 'string') continue;
      // Same validated pairs the rows are built from, so the strip and the
      // list can never be describing different sets.
      pulseInput.push({
        saveTimes: Array.isArray(p.saveTimes) ? p.saveTimes : null,
        journalTailTruncated: p.journalTailTruncated === true,
      });
      if (!identityResolved) {
        // A boolean rather than `self === null`: machineId() cannot return
        // null today (it falls back to 'unknown-machine'), but keying the
        // memo on the VALUE would silently re-ask on every row if it ever
        // could — which is a per-row identity-file read on the polled path.
        identityResolved = true;
        self = machineId();
        host = hostSlug();
        // The suffix must LOOK like an installation id, not merely follow a
        // hyphen: a host named `mac` would otherwise claim `mac-pro-2`, which
        // is a different computer. Same expression readWorkingState uses.
        hostRe = new RegExp(`^${host}-[0-9a-f]{4,16}$`);
        // Derived from the resolved identity, once, for the same reason the
        // rest of it is: it cannot change mid-loop, and re-deriving per row
        // would ask one question dozens of times.
        selfInstallId = installIdOf(self);
      }
      const clock = chooseClock(p);
      const ident = machineIdentity(p.machine, self, host, hostRe, selfInstallId);
      rows.push({
        project,
        scope: p.scope,
        machine: p.machine,
        harness: typeof p.harness === 'string' ? p.harness : null,
        headline: typeof p.headline === 'string' ? p.headline : null,
        // What the last save's own notes say about whether it was complete.
        // null means "there is no journal line, so we do not know" — NOT
        // "complete". See classifySaveNotes.
        kind: typeof p.lastSaveKind === 'string' ? p.lastSaveKind : null,
        bytes: Number.isInteger(p.bytes) ? p.bytes : null,
        harnessShared: p.harnessShared === true,
        harnesses: Array.isArray(p.harnesses) ? p.harnesses : [],
        ...clock,
        ...ident,
        _order: orderKey(clock),
      });
      if (p.harnessShared === true) {
        collisions.push({
          project, scope: p.scope, machine: p.machine,
          harnesses: Array.isArray(p.harnesses) ? p.harnesses : [],
        });
      }
    }
  }

  // ── `scopes` ARRIVES ORDERED. A consumer must not re-sort it. ────────────
  //
  // Newest first, on the CHOSEN clock — the agent's where the journal supplied
  // one, the filesystem's otherwise, exactly as `ageSource` reports. Sorting on
  // the filesystem clock alone inverts the whole premise the moment a `git
  // pull` rewrites mtime, which is the defect this module exists to close.
  //
  // Equivalent to sorting ascending on `writtenAgeSeconds`, and deliberately
  // NOT implemented that way: each project's ages are computed against that
  // project's own `Date.now()`, so ages drift by a few milliseconds across a
  // multi-project scan while absolute timestamps do not.
  //
  // A row with NO usable clock at all sorts LAST (`-Infinity`), never first:
  // putting an unknown at the top asserts it is the newest, which is the same
  // class of claim as rendering a null age as "just now".
  rows.sort((a, b) => b._order - a._order);
  // Counted BEFORE the slice. Deriving a total from the array you already cut
  // reports the cap as the measurement.
  const rowTotal = rows.length;
  const shown = rows.slice(0, limit).map((r) => { const { _order, ...rest } = r; return rest; });

  if (rowTotal > shown.length) {
    warnings.push({
      code: 'scopes-truncated',
      message: `Showing the ${shown.length} most recent of ${rowTotal} saved work-streams.`,
      shown: shown.length,
      total: rowTotal,
      // `pairTotal` counts every (scope, machine) pair the store SAW, including
      // pairs past each project's own MAX_INDEX_ENTRIES cap. It is therefore
      // >= rowTotal, and the gap is real truncation inside the store rather
      // than here.
      pairsOnDisk: pairTotal,
    });
  }

  // Collisions are rare and each one names a decision the user has to make, so
  // they are listed individually rather than aggregated — the same rule the
  // ingest warning aggregator applies to semantic near-duplicates. The cap
  // exists only so a pathological store cannot flood the payload.
  for (const c of collisions.slice(0, MAX_LISTED_COLLISIONS)) {
    warnings.push({
      code: 'harness-collision',
      // Named, and nothing else. The remedy — give the two tools separate
      // scopes — is the user's to apply, and a menubar line has no business
      // proposing it in six words.
      message: `Two agent tools are writing ${c.project} · ${c.scope}.`,
      project: c.project, scope: c.scope, machine: c.machine, harnesses: c.harnesses,
    });
  }
  if (collisions.length > MAX_LISTED_COLLISIONS) {
    warnings.push({
      code: 'harness-collisions-truncated',
      message: `${collisions.length} work-streams have two agent tools writing them; ` +
               `${MAX_LISTED_COLLISIONS} are listed.`,
      listed: MAX_LISTED_COLLISIONS, total: collisions.length,
    });
  }

  if (unlisted > 0) {
    warnings.push({
      code: 'unlisted-entries',
      message: `${unlisted} folder${unlisted === 1 ? '' : 's'} on disk could not be listed. ` +
               'Open Agent memory for how to rename them.',
      total: unlisted,
    });
  }

  // ── `lastSave` IS `scopes[0]`, BY CONSTRUCTION — not by coincidence ──────
  //
  // It is a projection of the SAME OBJECT, taken after the sort and after the
  // slice, so the two can never name different saves. The headline row and the
  // first list row are the same record, and a consumer may treat either as
  // authoritative.
  //
  // The alternative — letting `lastSave` be the newest row across the WHOLE
  // set while `scopes` shows a limited window — was rejected: with a limit of
  // 1 those two can differ, and the panel would then show a headline naming
  // one save above a list whose first row names another. There is no reading
  // of that screen which is correct. The sort already guarantees the newest
  // row survives any limit >= 1, so nothing is lost by binding them together.
  const lastSave = shown.length ? {
    project: shown[0].project,
    scope: shown[0].scope,
    machine: shown[0].machine,
    harness: shown[0].harness,
    writtenAt: shown[0].writtenAt,
    writtenAgeSeconds: shown[0].writtenAgeSeconds,
    ageSource: shown[0].ageSource,
    kind: shown[0].kind,
    isThisMachine: shown[0].isThisMachine,
  } : null;

  return {
    ok: true,
    lastSave,
    scopes: shown,
    // ── THE DENOMINATOR, TAKEN BEFORE THE SLICE ─────────────────────────
    //
    // Without this a consumer cannot tell "capped at 8" from "there are
    // exactly 8", so the one case where a user most needs to be told there is
    // more — a busy store — is the case that renders as a complete list. That
    // is this project's own named defect (a cap read as a measurement), and
    // it is why the count is taken from `rows`, not from `shown`.
    //
    // `total` is the number `scopes` was sliced FROM. `pairsOnDisk` is every
    // (scope, machine) pair the store SAW, which is larger when any single
    // project holds more than MAX_INDEX_ENTRIES pairs — those are reachable
    // in the app's Agent memory view but never ranked here. Two different
    // facts, two names; neither is derived from the other.
    total: rowTotal,
    pairsOnDisk: pairTotal,
    truncated: rowTotal > shown.length,
    // ── THE HEARTBEAT ───────────────────────────────────────────────────
    //
    // Built from `pulseInput`, which was filled during the walk — so it draws
    // on every pair READ, not on the rows that survived `limit`. Costs no
    // file I/O of its own: the timestamps were already parsed to compute each
    // row's age and were previously discarded.
    pulse: computePulse(pulseInput, now),
    brief: lastSave ? await briefFor(lastSave.project, now) : null,
    remote: readRemoteObservation(now),
    warnings,
  };
}

/** Clamp a caller's `limit` into [1, TRAY_MAX_LIMIT]; anything unusable defaults. */
function normaliseLimit(v) {
  if (!Number.isFinite(v)) return TRAY_DEFAULT_LIMIT;
  const n = Math.floor(v);
  if (n < 1) return 1;
  if (n > TRAY_MAX_LIMIT) return TRAY_MAX_LIMIT;
  return n;
}

/**
 * The standing brief's age for one project — one `stat`, never a read.
 *
 * The brief is TIER C in the widget's ranking: it changes on the order of
 * weeks, it is up to 32 KB of prose, and its whole value is being read IN
 * FULL at the start of a session. A menubar surface gets its age and nothing
 * else, so this deliberately does not open the file.
 *
 * It is stat'd for the project of the NEWEST save, because that is the
 * project the panel is already showing at the top and the only one where
 * "the brief is six weeks old" is about to matter. Stat'ing every project's
 * brief to show one line would be a cost with no consumer.
 *
 * There is no journal for a brief — it is hand-authored, and no MCP tool
 * writes it — so mtime is the ONLY clock available and no `ageSource` is
 * emitted. There is nothing here to be honest between.
 */
async function briefFor(project, now) {
  const abs = resolveInsideState(project, BRIEF_FILENAME);
  if (!abs) return null;
  try {
    const st = await stat(abs);
    if (!st.isFile()) return null;
    return {
      project,
      updatedAt: st.mtime.toISOString(),
      ageSeconds: Math.max(0, Math.round((now - st.mtimeMs) / 1000)),
    };
  } catch {
    return null;                       // no brief — the normal case, not an error
  }
}
