/**
 * How the tray stays current — and what that costs while nobody is looking.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE MENU IS CLOSED FOR ALMOST THE ENTIRE LIFE OF THE PROCESS.           ║
 * ║  THAT IS THE NUMBER THAT MATTERS.                                        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The MCP server writes working state in a SEPARATE PROCESS, so there is no
 * in-process event to subscribe to. That leaves polling or a filesystem watch,
 * and the research pass measured both against synthetic trees mirroring the
 * real layout:
 *
 *   one recursive fs.watch over a 10,000-file tree, idle    0.0044% of a core
 *   poll every 20 s over the same tree                      0.31%   (70x)
 *   poll every 5 min                                        0.02%
 *   one index read, 300 (scope, machine) pairs              61 ms
 *
 * So: WATCH, never poll on a short interval. This module holds the four timing
 * decisions that follow from that, and it holds them as pure, injectable code
 * so `scripts/test-tray-shell.js` can drive real event sequences through them
 * with a fake clock — no filesystem, no Electron, no waiting.
 *
 *   1. DEBOUNCE ~150 ms. One save produces THREE events in the same
 *      millisecond — the `.tmp-…` file, `current.md`, and `journal.jsonl` —
 *      so without a debounce every save triggers three index reads.
 *
 *   2. FILTER on the path. 30 wiki writes produced 32 events and NONE of them
 *      contained `/state/`, so the filter is close to free and removes ingest
 *      traffic entirely. Dot-prefixed names are dropped, which is what removes
 *      the atomic write's temp file.
 *
 *   3. A 5-MINUTE FALLBACK POLL, and no faster. The watch survived a burst of
 *      100 saves with nothing dropped and survived its own root being deleted
 *      and recreated, so this is belt-and-braces rather than a load-bearing
 *      path — but the untested cases are real (a network volume, a domains
 *      folder on another volume, FSEvents overflow under whole-disk load) and a
 *      silently dead watch is invisible. Five minutes is slow enough to be
 *      free and fast enough that a lost watch degrades to "slightly stale"
 *      rather than "silently dead".
 *
 *   4. A ONE-SHOT GLYPH EXPIRY, which is not a poll. See
 *      `tray-model.js:liveExpiresInMs` — the "live" glyph has to go idle two
 *      minutes after the last local save even though nothing happens on disk
 *      at that moment. One `setTimeout`, armed only while the glyph is live,
 *      firing at most once per save, doing NO I/O when it fires.
 *
 * THE EVENT TYPE CARRIES NO INFORMATION. Every event on the recursive macOS
 * path arrives as `rename`, never `change` — an FSEvents artefact. Nothing here
 * branches on it, and nothing may be added that does.
 *
 * ── TOTAL, WITH THE MENU CLOSED ────────────────────────────────────────────
 *
 *   watch                       0.0044% of a core
 *   fallback poll, 5 min        0.02%
 *   debounce timer              0 when idle — armed only after an event
 *   glyph expiry                0 when idle — armed only while live
 *   index read per real save    1.4-61 ms, a few times an hour
 *   ──────────────────────────────────────────────
 *   ~0.025% of one core, and no additional memory
 *
 * which is inside the noise of the 0.060% the app already measures at idle.
 *
 * THE DESIGN THAT WOULD RUIN IT, named so it is refused explicitly: a menu that
 * re-reads the index on a short interval so that it is "instant" when opened.
 * The push-on-change design here already gives instant opening, because the
 * main process is holding the current snapshot when the click arrives.
 */

/** One save emits three events within the same millisecond. 150 ms is far
 *  wider than that and far narrower than a human noticing. */
export const DEBOUNCE_MS = 150;

/** Belt and braces. See point 3 above for why it is this slow and not faster. */
export const FALLBACK_POLL_MS = 5 * 60 * 1000;

/**
 * Is this filesystem event about working state?
 *
 * `filename` is what a recursive `fs.watch` hands back: a path RELATIVE to the
 * watch root, e.g. `myproject/state/main/laptop-a1b2c3/current.md`.
 *
 * Two rejections, and both are load-bearing:
 *
 *   - NO `state` PATH SEGMENT -> not ours. Wiki writes, raw sources, ingest
 *     queue files and conversation JSON all land elsewhere in the same tree,
 *     and an ingest writes hundreds of files.
 *
 *   - ANY DOT-PREFIXED SEGMENT -> ignored. `writeFileAtomic` writes `.tmp-…`
 *     and renames, so without this every save is counted twice and the widget
 *     reads the index while the rename is still in flight. It also removes
 *     `.DS_Store`, `.git/**` and the write lock in one rule rather than four.
 *
 * A null/empty filename is REFUSED rather than treated as "something changed".
 * fs.watch can deliver a null filename on some platforms; treating that as a
 * hit would make every unrelated write in the tree a refresh, which is the poll
 * this module exists to avoid, arrived at by accident.
 */
export function isWorkingStateEvent(filename) {
  if (typeof filename !== 'string' || !filename) return false;
  const parts = filename.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((p) => p.startsWith('.'))) return false;
  return parts.includes('state');
}

/**
 * The OTHER thing worth watching: `.curator-config.json`, so that flipping the
 * setting in Settings takes effect without a restart.
 *
 * ── WHY A FILE WATCH AND NOT A CHANNEL ─────────────────────────────────────
 *
 * The renderer POSTs the new mode to the server, and the server and the shell
 * are the same Node realm — so a registry ought to be the channel. It is not
 * available: `registerDesktopHost()` REFUSES an unknown hook name by throwing,
 * and its frozen list is `pickFolder, relaunch, prepareUpdate, installUpdate`.
 * Adding a fifth is a change in `src/`, which this shell does not own.
 *
 * So the shell notices for itself. It watches the config file's DIRECTORY, not
 * the file: the config is written with `writeFileAtomic`, which is a temp file
 * plus a rename, and a watch on an inode that gets renamed over stops
 * delivering events — silently, which is the worst way for it to stop.
 *
 * The filter is the inverse of `isWorkingStateEvent`'s: this basename IS
 * dot-prefixed, so it is matched exactly rather than by rule, and nothing else
 * in that directory can trigger a read.
 */
export function isConfigEvent(filename, basename) {
  if (typeof filename !== 'string' || !filename) return false;
  if (typeof basename !== 'string' || !basename) return false;
  const parts = filename.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return false;
  // The atomic write's own temp file must not trigger a read of a file that is
  // still being written. Only the final name counts.
  return parts[parts.length - 1] === basename;
}

/**
 * Coalesce a burst of pings into one call.
 *
 * Injectable timers so the suite can drive it with a fake clock: a debounce
 * tested with real `setTimeout` is a test that sleeps, and a test that sleeps
 * is a test nobody runs enough times to trust.
 */
export function createDebouncer({
  delayMs = DEBOUNCE_MS,
  onFire,
  setTimeout: setT = setTimeout,
  clearTimeout: clearT = clearTimeout,
} = {}) {
  if (typeof onFire !== 'function') throw new Error('createDebouncer: onFire must be a function');
  let handle = null;
  let coalesced = 0;
  return {
    ping() {
      coalesced++;
      if (handle !== null) clearT(handle);
      handle = setT(() => {
        handle = null;
        const n = coalesced;
        coalesced = 0;
        onFire(n);
      }, delayMs);
    },
    /** For assertions and for the stop path — a pending timer must not fire
     *  after the tray has been destroyed. */
    pending() { return handle !== null; },
    cancel() {
      if (handle !== null) clearT(handle);
      handle = null;
      coalesced = 0;
    },
  };
}

/**
 * The whole refresh strategy, as one object with a `start()` and a `stop()`.
 *
 * Every effect is injected — the watcher factory, both timer pairs, and the
 * refresh function itself — so that the suite runs the REAL sequencing logic
 * against fakes. What is left for main.js is `fs.watch` and `Date`.
 *
 * @param {object} o
 * @param {string[]} o.roots        directories to watch recursively
 * @param {Function} o.watch        (path, opts, listener) => watcher-with-close()
 * @param {Function} o.onRefresh    () => void|Promise — does the index read
 * @param {Function} [o.filter]     (filename) => boolean; defaults to working state
 * @param {boolean}  [o.recursive]  defaults true; the config-file watch passes false
 * @param {Function} [o.onWatchError]  (err, root) => void
 */
export function createStateWatcher({
  roots = [],
  watch,
  onRefresh,
  filter = isWorkingStateEvent,
  recursive = true,
  onWatchError = () => {},
  debounceMs = DEBOUNCE_MS,
  fallbackMs = FALLBACK_POLL_MS,
  setTimeout: setT = setTimeout,
  clearTimeout: clearT = clearTimeout,
  setInterval: setI = setInterval,
  clearInterval: clearI = clearInterval,
} = {}) {
  if (typeof watch !== 'function') throw new Error('createStateWatcher: watch must be a function');
  if (typeof onRefresh !== 'function') throw new Error('createStateWatcher: onRefresh must be a function');

  const watchers = [];
  let fallback = null;
  let started = false;
  const stats = { events: 0, matched: 0, refreshes: 0, fallbacks: 0, watchErrors: 0 };

  const debouncer = createDebouncer({
    delayMs: debounceMs,
    setTimeout: setT,
    clearTimeout: clearT,
    onFire: () => { stats.refreshes++; onRefresh('watch'); },
  });

  function start() {
    if (started) return stats;
    started = true;
    for (const root of roots) {
      try {
        // `recursive: true` is the decisive property, not a convenience: it
        // catches scopes and whole PROJECTS created after the watch was
        // established, with no re-arming and no per-directory bookkeeping. A
        // naive per-directory watch would silently miss every new scope —
        // exactly the event the widget exists to show.
        const w = watch(root, { recursive }, (_type, filename) => {
          stats.events++;
          // Nothing branches on the event type. On the recursive macOS path
          // every event is `rename`, so the type carries no information.
          if (!filter(filename)) return;
          stats.matched++;
          debouncer.ping();
        });
        // A watcher that emits 'error' and is not listened to takes the process
        // down. The tray degrades to the fallback poll instead.
        if (w && typeof w.on === 'function') {
          w.on('error', (err) => { stats.watchErrors++; onWatchError(err, root); });
        }
        watchers.push(w);
      } catch (err) {
        stats.watchErrors++;
        onWatchError(err, root);
      }
    }
    if (fallbackMs > 0) {
      fallback = setI(() => { stats.fallbacks++; onRefresh('fallback'); }, fallbackMs);
      // Node keeps the process alive for a pending interval. In Electron the
      // app's own run loop owns the lifetime, but unref-ing costs nothing and
      // means a stray scheduler can never be the reason a process will not exit.
      if (fallback && typeof fallback.unref === 'function') fallback.unref();
    }
    return stats;
  }

  function stop() {
    started = false;
    debouncer.cancel();
    if (fallback !== null) { clearI(fallback); fallback = null; }
    for (const w of watchers.splice(0)) {
      try { if (w && typeof w.close === 'function') w.close(); } catch { /* already gone */ }
    }
  }

  return { start, stop, stats, isRunning: () => started, debouncer };
}

/**
 * The one-shot glyph corrector.
 *
 * Arm it with the model's `liveExpiresInMs()`. It replaces any previous timer,
 * so a second save inside the live window re-arms rather than stacking, and it
 * arms NOTHING when the answer is null — which is the state the process is in
 * almost all the time.
 */
export function createExpiryTimer({
  onExpire,
  setTimeout: setT = setTimeout,
  clearTimeout: clearT = clearTimeout,
} = {}) {
  if (typeof onExpire !== 'function') throw new Error('createExpiryTimer: onExpire must be a function');
  let handle = null;
  return {
    arm(ms) {
      if (handle !== null) { clearT(handle); handle = null; }
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return false;
      handle = setT(() => { handle = null; onExpire(); }, ms);
      if (handle && typeof handle.unref === 'function') handle.unref();
      return true;
    },
    armed() { return handle !== null; },
    cancel() { if (handle !== null) clearT(handle); handle = null; },
  };
}
