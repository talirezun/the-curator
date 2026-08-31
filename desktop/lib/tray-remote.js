/**
 * tray-remote.js — WHEN the menubar may ask GitHub whether another machine has
 * pushed, and when it must not.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE DEFECT THIS EXISTS TO CLOSE                                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The tray's `remote` line — "2 handoffs waiting on GitHub" — is the whole
 * multi-machine signal, and it had exactly one feed: `noteRemoteStatus()`,
 * called from `GET /api/sync/remote-status`. That endpoint is driven by the
 * frontend's `refreshSyncRemoteBadgeIfVisible()`, which DECLINES TO FETCH
 * while `document.hidden` — correct on its own terms, since a window nobody is
 * looking at should not phone GitHub every ten minutes.
 *
 * The consequence is that with the window CLOSED — the tray's normal state,
 * and the only state the tray exists for — no observation ever arrives, and
 * any existing one expires after five minutes. Nothing rendered wrongly; the
 * line simply never appeared. A feature built for "notice that another machine
 * sent you something" did not work in the situation it was built for.
 *
 * ── WHY THIS IS A CHECK ON OPEN AND NOT A TIMER ────────────────────────────
 *
 * Four options were weighed.
 *
 *  1. A LOW-RATE TIMER OWNED BY THE SHELL. Refused. It reintroduces exactly
 *     what `document.hidden` was added to stop, one layer down and with no
 *     visibility signal to gate on: The Curator phoning GitHub forever behind
 *     a closed menu, on battery, possibly metered, to keep a line fresh that
 *     nobody is looking at. The whole cost argument for this widget
 *     (roadmap §2.6, §2.9) is that it costs nothing when the panel is shut.
 *
 *  2. LEAVE IT INERT AND DELETE THE LINE. A real option, and the honest
 *     alternative to shipping something that cannot fire. Refused because the
 *     signal is cheap to make work and is one of the two scenarios the widget
 *     was designed around — deleting it would remove the answer rather than
 *     the defect, and the rendering side is already correct and tested.
 *
 *  3. A NON-FETCHING PEEK INTO sync.js's CACHE. This is what the data layer
 *     wanted and could not have: `getRemoteStatus()` is "cache hit ? return :
 *     git fetch" with no peek, and `maxAgeMs: 0` does not help because
 *     `remoteCacheTtl` returns 0 for a successful payload. Adding one means
 *     editing `brain/sync.js`, which owns a money-and-data path this change
 *     does not own.
 *
 *  4. A CHECK ON MENU OPEN, THROUGH THE EXISTING SERIALISED PATH. Chosen.
 *     It is a deliberate human action, it is bounded by the user's own
 *     clicking, and it reuses `getRemoteStatus()` unchanged — which means it
 *     inherits every bound that function already has rather than adding a
 *     parallel one.
 *
 * ── WHAT WAS VERIFIED ABOUT THE RACE, AND WHAT WAS NOT ─────────────────────
 *
 * The recorded incident (v3.9.1) is that a second, UNSERIALISED fetch site
 * made the user's own pull abort in 11 runs out of 12 over a
 * `refs/remotes/origin/main` lock. That is the reason this widget's data layer
 * refuses to fetch at all. Three things were checked before adding a trigger:
 *
 *  - `brain/sync.js:155` `gitFetch()` is a single chokepoint: every
 *    `git fetch` THAT MODULE ISSUES is chained through `_fetchGate`, on both
 *    the fulfil and reject arms so one failure cannot wedge the rest, and a
 *    source guard in `test-sync-hygiene.js` asserts there is exactly one raw
 *    fetch invocation in the file. So a check started here CANNOT collide with
 *    `getRemoteStatus`'s own fetch or with `pull()`'s reporting fetch.
 *  - `getRemoteStatus()` additionally carries a repo-keyed TTL cache (5 min on
 *    success, 1 min on failure) and an in-flight memo that coalesces
 *    concurrent callers into ONE real check.
 *  - `runRemoteCheck()` catches everything and degrades to
 *    `remoteChecked: false, behindFiles: null`. If a check started here does
 *    lose a race, the casualty is the tray's own answer — "we could not tell"
 *    — and never the user's sync.
 *
 * WHAT WAS NOT VERIFIED, STATED PLAINLY: the fetch that `git pull` runs
 * INTERNALLY is a subprocess of git's own making and is not, and cannot be,
 * inside `gitFetch()`'s gate. An attempt to measure that overlap FAILED TO
 * REPRODUCE THE RACE AT ALL — 60 concurrent runs against real git 2.48.1
 * (24 pull-vs-fetch, 24 fetch-vs-fetch, 12 fetch-vs-fetch with a
 * one-second-stretched `upload-pack`) produced zero failures on either side,
 * including in the fetch-vs-fetch shape that IS the recorded incident. A
 * harness that cannot reproduce the known failure cannot certify its absence,
 * so that null result is reported as inconclusive rather than as safety.
 *
 * The argument that carries the decision is therefore NOT "the race is
 * harmless". It is that this trigger reaches the same function, through the
 * same gate, with the same cache, as a call the app ALREADY makes on a
 * ten-minute timer whenever the window is open (`SYNC_REMOTE_REFRESH_MS` in
 * `next/app.js`). It is not a new hazard class; it is one more, rarer,
 * human-initiated trigger for a call that already ships — and unlike that one,
 * it never fires unless a person opened the menu.
 *
 * ── WHY THE FLOOR HERE IS SEPARATE FROM sync.js's TTL ──────────────────────
 *
 * `getRemoteStatus()` already caches for five minutes, so a second limit looks
 * redundant. It is not, for two reasons. A FAILED check is cached for only
 * sixty seconds by design (`REMOTE_CHECK_FAILURE_TTL_MS`, so a badge does not
 * stay stuck on "could not check" after the network returns) — so with a
 * dropped connection, a user clicking the tray repeatedly would drive a real
 * fetch attempt every minute. And this floor is OWNED BY THE SHELL, so it is
 * asserted offline by a suite that must not import `brain/sync.js` to know
 * what the other constant is. Belt and braces on a network path, with the two
 * constants deliberately not derived from each other.
 *
 * ── ELECTRON-FREE AND src-FREE, LIKE EVERY MODULE IN THIS FOLDER ───────────
 *
 * The decision is a pure function over plain numbers, so the suite executes it
 * rather than scanning for it. main.js keeps only the one call it cannot give
 * away.
 */

/**
 * The shell's own floor between two remote-check ATTEMPTS.
 *
 * Equal to sync.js's REMOTE_CHECK_TTL_MS, and deliberately not imported from
 * it — see the header. Matching means the common case (a successful check
 * inside its TTL) is answered from that cache and this floor never binds; the
 * floor exists for the failure case, where sync.js's own TTL is only 60s.
 */
export const TRAY_REMOTE_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The triggers allowed to start a remote check. A menu OPEN, and nothing else.
 *
 * `mouse-enter` is deliberately absent and that is the load-bearing exclusion:
 * a hover is not a deliberate act — the pointer crosses the icon on the way to
 * something else — and `main.js` re-renders on it precisely because that
 * render costs no I/O and no network. Putting a fetch behind hover would make
 * the cheapest event in the widget the most expensive one.
 *
 * A filesystem watch firing is likewise not a trigger: a local save says
 * nothing about what is on the remote, and the watch fires unattended.
 */
export const REMOTE_CHECK_TRIGGERS = Object.freeze(['click', 'right-click']);

/**
 * Should the shell start a remote check right now?
 *
 * Every refusal names ITSELF rather than returning a bare false, so main.js
 * (and the suite) can tell "too soon" from "wrong event" from "one is already
 * running". A decision function that answers only yes/no is one whose
 * behaviour cannot be asserted without re-deriving its reasoning.
 *
 * @param {object} o
 * @param {string}  o.trigger        the tray event that led here
 * @param {number}  o.nowMs          the clock, injected so the suite is deterministic
 * @param {number|null} o.lastAttemptMs  when a check was last STARTED, or null
 * @param {boolean} o.inFlight       whether one is running right now
 * @param {number}  [o.minIntervalMs]
 * @returns {{check: boolean, reason: string}}
 */
export function decideRemoteCheck(o = {}) {
  const {
    trigger, nowMs, lastAttemptMs = null, inFlight = false,
    minIntervalMs = TRAY_REMOTE_MIN_INTERVAL_MS,
  } = o;

  if (!REMOTE_CHECK_TRIGGERS.includes(trigger)) return { check: false, reason: 'not-a-menu-open' };
  // Belt and braces with getRemoteStatus()'s own in-flight memo. That memo
  // coalesces rather than refuses — a second caller awaits the first — which
  // is right for the HTTP route but wrong here: a queued caller would re-render
  // the tray a second time with the identical answer.
  if (inFlight) return { check: false, reason: 'in-flight' };
  if (!Number.isFinite(nowMs)) return { check: false, reason: 'no-clock' };

  if (Number.isFinite(lastAttemptMs)) {
    const since = nowMs - lastAttemptMs;
    // A clock that went BACKWARDS (a manual change, an NTP step, a laptop
    // resumed in another timezone) leaves `since` negative. Treating that as
    // "long enough ago" would let a clock jump drive a burst of checks, so it
    // is treated as rate-limited: the floor re-arms, and the worst case is one
    // check skipped rather than an unbounded number allowed.
    if (since < minIntervalMs) return { check: false, reason: 'rate-limited' };
  }

  return { check: true, reason: 'check' };
}

/**
 * Is a `getRemoteStatus()` payload worth handing to `noteRemoteStatus()`?
 *
 * `noteRemoteStatus` already refuses an unconfigured install, so this is not a
 * guard — it is what lets main.js skip a pointless re-render. A check that
 * came back saying "there is no remote configured" changes nothing on screen,
 * and re-rendering the menu underneath a user who has it open for no reason is
 * a real cost even when the data cost is zero.
 */
export function remoteAnswerIsRenderable(payload) {
  return !!(payload && typeof payload === 'object' && payload.configured === true);
}
