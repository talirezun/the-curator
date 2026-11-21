/**
 * tray-popover-shell.js — the small pieces of the Windows tray popover's wiring that main.js
 * would otherwise hold untestably (v4.1.0, package P5):
 *
 *   appendDesktopLogLine   one line to curator.log (the popover's fallback notes, the self-test)
 *   popoverSelfTestRequested  is the CI self-test asked for? Only on win32, and ONLY alongside
 *                          CURATOR_TEST_USER_DATA_DIR, so no real person's app can ever run it
 *   runTrayPopoverSelfTest the self-test itself, against the REAL controller (lib/tray-popover.js)
 *                          in the packaged app on GitHub's windows-latest runner
 *                          (scripts/ci-win-app.mjs popover-selftest greps its line)
 *
 * Pure apart from what is injected; scripts/test-tray-popover-shell.js executes all of it.
 */
import path from 'node:path';

export const LOG_FILE_NAME = 'curator.log';

/** Append `<iso> [<level>] [desktop] <line>` to curator.log in `logsDir`. Never throws. */
export function appendDesktopLogLine({ logsDir, line, fs, level = 'info', now = () => new Date() }) {
  try {
    if (!logsDir || !fs || typeof line !== 'string') return false;
    const one = line.replace(/[\r\n]+/g, ' ').slice(0, 2000);
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(logsDir, LOG_FILE_NAME), `${now().toISOString()} [${level}] [desktop] ${one}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// ── The CI self-test ─────────────────────────────────────────────────────────

/** The variable the runner sets ("1"). Starts with CURATOR_TEST_ so ci-win-app.mjs's personEnv()
 *  strips it from every launch that is meant to behave like a person's. */
export const SELFTEST_ENV = 'CURATOR_TEST_TRAY_POPOVER_SELFTEST';
export const SELFTEST_PASS_LINE = 'tray-popover-selftest: pass';
export const SELFTEST_FAIL_PREFIX = 'tray-popover-selftest: fail: ';
/** How long the popover may take to appear on a cold, slow runner (it retries the show). */
export const SELFTEST_SHOW_TIMEOUT_MS = 30000;
/** The wait before the first show, so the main window has opened and taken its focus. */
export const SELFTEST_START_DELAY_MS = 5000;
/** How long Esc may take to hide it. */
export const SELFTEST_HIDE_TIMEOUT_MS = 3000;

/** Honoured ONLY on win32 with the variable exactly "1" AND an isolated user-data folder. */
export function popoverSelfTestRequested(env, platform) {
  if (platform !== 'win32' || !env || typeof env !== 'object') return false;
  if (env[SELFTEST_ENV] !== '1') return false;
  const ud = env.CURATOR_TEST_USER_DATA_DIR;
  return typeof ud === 'string' && ud.trim() !== '';
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
/** Is rectangle `b` entirely inside rectangle `area`? */
export function boundsInside(b, area) {
  if (!b || !area || ![b.x, b.y, b.width, b.height, area.x, area.y, area.width, area.height].every(finite)) return false;
  if (!(b.width > 0 && b.height > 0)) return false;
  return b.x >= area.x && b.y >= area.y
    && b.x + b.width <= area.x + area.width
    && b.y + b.height <= area.y + area.height;
}

/**
 * Show the popover, check it, press Esc, check it went. Resolves `{ pass, line, facts }`; never
 * rejects. `line` is what main writes to curator.log.
 *
 * deps:
 *   popover        the controller (createTrayPopover): show, isVisible, stats, pressKey,
 *                  probeRefusedLoad (the negative probe: a file: load outside the page's folder,
 *                  from the page itself, that the session's request filter must cancel)
 *   publish        () => void   main's publishPopover (a payload before the first show)
 *   getTrayBounds  () => Rectangle | undefined
 *   workAreaFor    (bounds) => Rectangle | null   the work area of the display the popover is on
 *   sleep, now     injected time
 */
export async function runTrayPopoverSelfTest(deps) {
  const { popover, publish, getTrayBounds, workAreaFor } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const showTimeout = deps.showTimeoutMs || SELFTEST_SHOW_TIMEOUT_MS;
  const hideTimeout = deps.hideTimeoutMs || SELFTEST_HIDE_TIMEOUT_MS;
  const every = deps.everyMs || 50;
  const facts = {};
  const fail = (why) => ({ pass: false, line: SELFTEST_FAIL_PREFIX + why + ' ' + JSON.stringify(facts), facts });
  const stats = () => { try { return popover.stats() || {}; } catch { return {}; } };
  try {
    if (!popover || typeof popover.show !== 'function') return fail('no popover controller');
    // Let the app's own window come up first: its focus would hide a popover shown under it.
    await sleep(deps.startDelayMs === undefined ? SELFTEST_START_DELAY_MS : deps.startDelayMs);
    publish();
    // 1. Shown. The first show on a window still loading falls back (slow-load) and the window
    //    keeps loading; the next show then succeeds — so the show is retried until the deadline.
    const until = now() + showTimeout;
    let shows = 0;
    while (now() < until) {
      const s = stats();
      if (popover.isVisible() && s.painted && !s.waiting) break;
      if (!s.waiting && !popover.isVisible()) { shows += 1; popover.show(getTrayBounds()); }
      await sleep(every);
    }
    const s1 = stats();
    Object.assign(facts, {
      shows, failures: s1.failuresTotal === undefined ? s1.failures : s1.failuresTotal, off: s1.off, sentGen: s1.sentGen,
      rows: s1.lastPainted ? s1.lastPainted.rows : null, bounds: s1.bounds || null,
      cspViolations: s1.cspViolations,
    });
    if (!popover.isVisible()) return fail('the popover never became visible');
    // EVERY failure this session, not only the consecutive run a successful show resets.
    if (s1.off || s1.failures !== 0 || (s1.failuresTotal || 0) !== 0) return fail('the popover recorded a failure');
    // 2. Painted rows, inside the work area, no CSP refusal.
    if (!s1.lastPainted || !(s1.lastPainted.rows > 0)) return fail('the page painted no rows');
    const area = workAreaFor(s1.bounds);
    facts.workArea = area || null;
    if (!boundsInside(s1.bounds, area)) return fail('the popover is not inside the work area');
    if (s1.cspViolations !== 0) return fail('the page reported Content Security Policy violations');
    // 2b. The NEGATIVE probe: a file: request outside src/public/next/, issued from the page's own
    //     context, must be cancelled by the session's webRequest filter (not merely never made).
    if (typeof popover.probeRefusedLoad !== 'function') return fail('the negative probe is missing');
    const refusedBefore = s1.refusedRequests || 0;
    const probe = await popover.probeRefusedLoad();
    const sp = stats();
    facts.probe = probe;
    facts.refusedRequests = sp.refusedRequests;
    facts.cspViolations = sp.cspViolations;
    if (probe !== 'error') return fail('the negative probe was not refused');
    if (!((sp.refusedRequests || 0) > refusedBefore)) return fail('the negative probe was not cancelled by the request filter');
    if (sp.cspViolations !== 0) return fail('the negative probe was refused by the page\'s CSP, not the request filter');
    // 3. Esc on the root page dismisses it (the page's own key map → curatorTray.dismiss()).
    const dismissedBefore = s1.dismissals || 0;
    if (!popover.pressKey('Escape')) return fail('Esc could not be pressed');
    const hideBy = now() + hideTimeout;
    while (now() < hideBy && popover.isVisible()) await sleep(every);
    const s2 = stats();
    facts.dismissals = s2.dismissals;
    if (popover.isVisible()) return fail('Esc did not hide the popover');
    if (!((s2.dismissals || 0) > dismissedBefore)) return fail('the popover hid, but not because the page dismissed it');
    return { pass: true, line: SELFTEST_PASS_LINE, facts };
  } catch (e) {
    return fail('threw: ' + ((e && e.message) || String(e)));
  }
}

// ── The clicks main.js wires (executed by the suite with the real controller) ─

/**
 * Windows, a LEFT click on the tray icon: publish the payload from memory, then toggle the
 * popover at the icon. No controller (it could not be created) → the native menu. A controller
 * that is off for the session gets no payload; its toggle() falls back to the native menu itself.
 * @returns {'popover'|'menu'}
 */
export function popoverLeftClick({ popover, publish, popMenu, trayBounds }) {
  if (!popover) { popMenu(); return 'menu'; }
  if (popover.isEnabled()) publish();
  let bounds;
  try { bounds = trayBounds(); } catch { bounds = undefined; }
  popover.toggle(bounds);
  return 'popover';
}

/** Should a tray render also repaint the popover? Only while it is on screen or about to be:
 *  a hidden one is rebuilt by the next left click, not on every save. */
export function popoverWantsRepaint(popover) {
  if (!popover) return false;
  try { return popover.isVisible() === true || (popover.stats() || {}).waiting === true; } catch { return false; }
}

/** The controller's onFallback: that click pops the native menu — except while the CI self-test
 *  runs, where a native menu's modal loop would block the runner. */
export function popoverFallbackHandler({ popMenu, selfTestRunning }) {
  return () => { if (!selfTestRunning()) popMenu(); };
}
