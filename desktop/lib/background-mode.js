/**
 * `backgroundMode` — does this install put an icon in the menu bar, and what
 * happens to the Dock icon.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  DEFAULT OFF, AND THE REASON IS NOT CAUTION.                              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The widget's value is proportional to how much agent traffic an install has,
 * and a fresh install has none. On by default gives every new user a
 * permanently empty menu bar icon whose only possible content is "nothing here
 * yet" — the worst first impression of the feature, and one that teaches them
 * the icon is not worth clicking. Apple's HIG says the same thing from the
 * other direction: let people, not your app, decide whether to put your menu
 * bar extra in the menu bar.
 *
 * So an existing user who updates and does nothing sees exactly what they saw
 * before: the same Dock icon, the same window, the same close behaviour, and
 * NO tray icon.
 *
 * ── A NAMED STRING, NOT A BOOLEAN, AND NOT `ui.*` ──────────────────────────
 *
 * Three values rather than two booleans, following `install-mode.js`'s
 * convention, because it makes the illegal fourth combination — no tray AND no
 * Dock, an app with no affordance at all — unrepresentable.
 *
 * It does NOT live in the `ui.*` UI-state allow-list, and that is worth
 * recording rather than rediscovering: every field in that spec is `monotonic`,
 * `writeOnce`, or a one-way `clearable` dismissal, precisely because a consent
 * must not be silently downgradable. A background-mode preference is a two-way
 * toggle a user may flip repeatedly, which no field in that spec can express.
 * The right precedent is `sharedBrainEnabled` — a plain top-level boolean in
 * `.curator-config.json`, read and written freely.
 *
 * ── ABSENT OR UNRECOGNISED RESOLVES TO 'window' ────────────────────────────
 *
 * The same fail-safe asymmetry `paths.js` uses for install-mode detection and
 * `releaseChannel` uses for its channel. Getting this wrong in the 'window'
 * direction costs a user one Settings click; getting it wrong in the 'tray'
 * direction puts an icon in the menu bar of somebody who never asked for one,
 * on a surface where — see below — they may not even be able to see it to
 * remove it.
 *
 * ── THIS MODULE IS PURE ────────────────────────────────────────────────────
 *
 * It reads no file and imports nothing. main.js obtains the raw config value
 * (through the same `src/brain/config.js` the server uses — one realm, one
 * module instance) and hands it here. The ORDERING matters and is stated in
 * main.js: the value is needed BEFORE the tray or the window is created, and
 * the renderer does not exist yet at that point, so it must never be waited on
 * from the renderer.
 */

/** The three legal values, in escalating order of how much they take away. */
export const BACKGROUND_MODES = Object.freeze(['window', 'tray', 'tray-only']);

/** What an absent, unreadable or unrecognised value means. */
export const DEFAULT_BACKGROUND_MODE = 'window';

/**
 * IS `tray-only` ACTUALLY IMPLEMENTED? NO, AND IT IS SAID OUT LOUD.
 *
 * Hiding the Dock icon means `app.setActivationPolicy('accessory')`, and the
 * community reports that the RETURN transition — accessory back to regular,
 * which is what happens the moment the user opens the window from the tray —
 * is buggy in exactly the direction this feature depends on: the app menu does
 * not populate until you tab away and back, and windows get hidden as a side
 * effect. That transition cannot be tested from here (no Electron in the
 * offline suite, and this machine must not have an app launched on it), and
 * shipping an untested path whose failure mode is "no Dock icon, no menu bar,
 * no window, and a user who has forgotten what the tray icon looks like" is not
 * a trade worth making for a mode nobody has asked for yet.
 *
 * So `tray-only` is RECOGNISED — a config file carrying it is not treated as
 * corrupt, and it does not silently collapse into `window` — and it behaves as
 * `tray` with the Dock icon left alone. `resolveTrayPlan()` returns
 * `hedged: true` and a reason, so the difference between "we did what you asked"
 * and "we did the safe half of what you asked" is a value a caller can read and
 * a suite can assert, rather than a comment.
 */
export const DOCK_HIDING_IMPLEMENTED = false;

/**
 * Resolve a raw config value to one of BACKGROUND_MODES.
 *
 * Accepts the raw value in whatever shape it arrives — a string, a whole config
 * object, or nothing at all — because this module is written against a field
 * being added in parallel and must not care which of those the caller has.
 */
export function resolveBackgroundMode(raw) {
  const value = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw.backgroundMode
    : raw;
  if (typeof value !== 'string') return DEFAULT_BACKGROUND_MODE;
  const v = value.trim().toLowerCase();
  return BACKGROUND_MODES.includes(v) ? v : DEFAULT_BACKGROUND_MODE;
}

/**
 * What the shell should actually do, from a mode.
 *
 * @param {string} mode  a raw value; resolved here, so callers cannot forget to.
 * @returns {{mode:string, tray:boolean, hideDock:boolean, hedged:boolean, reason:string|null}}
 */
export function resolveTrayPlan(mode) {
  const m = resolveBackgroundMode(mode);
  if (m === 'window') {
    return { mode: m, tray: false, hideDock: false, hedged: false, reason: null };
  }
  if (m === 'tray-only' && !DOCK_HIDING_IMPLEMENTED) {
    return {
      mode: m,
      tray: true,
      hideDock: false,
      hedged: true,
      reason: 'Hiding the Dock icon is not implemented yet — the menu bar icon is on, and the Dock icon stays.',
    };
  }
  return { mode: m, tray: true, hideDock: m === 'tray-only', hedged: false, reason: null };
}

/**
 * What CHANGES between two modes, so the caller can apply the difference
 * instead of tearing everything down and rebuilding it.
 *
 * ── WHY A TRANSITION IS A VALUE AND NOT A SEQUENCE OF `if`s IN main.js ─────
 *
 * Flipping the setting while the app is running must not need a restart, which
 * means every pair of modes is a live transition and there are nine of them.
 * Writing that as branches in a wiring file puts nine cases somewhere the
 * offline suite cannot execute even one. Here it is a pure function over two
 * strings, and the suite drives the whole 3x3 matrix.
 *
 * IDEMPOTENCE IS THE PROPERTY THAT MATTERS. A config file watch can and will
 * fire more than once for a single save (an atomic write is a create plus a
 * rename), so `from === to` MUST produce no action at all — otherwise a single
 * Settings click destroys and recreates the tray icon, which on macOS moves it
 * to a new position in the menu bar and, with a menu bar manager installed, can
 * file it into a section the user cannot see.
 */
export function planModeTransition(from, to) {
  const a = resolveTrayPlan(from);
  const b = resolveTrayPlan(to);
  return {
    from: a.mode,
    to: b.mode,
    createTray: !a.tray && b.tray,
    destroyTray: a.tray && !b.tray,
    // The watch is the tray's only reason to exist. Turning the tray off must
    // stop paying for it, or the feature keeps costing after it is switched off
    // — which is exactly the kind of residue a user cannot see and cannot
    // reason about.
    startWatch: !a.tray && b.tray,
    stopWatch: a.tray && !b.tray,
    showDock: a.hideDock && !b.hideDock,
    hideDock: !a.hideDock && b.hideDock,
    // Turning it OFF must never leave someone with no visible app. The window
    // is revealed on the way back to `window` mode, so the transition always
    // ends with something on screen.
    revealWindow: a.tray && !b.tray,
    changed: a.mode !== b.mode,
  };
}
