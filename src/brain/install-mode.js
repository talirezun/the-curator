/**
 * Install mode and its CAPABILITIES — what this copy of The Curator is
 * physically able to do to itself.
 *
 * ── Why this module exists, and why it is not just `isRepoInstall()` ─────────
 *
 * `src/brain/paths.js` already answers one question — "where does user data
 * live?" — and it answers it by asking "is this positively a bundle?", because
 * the two mistakes there are not symmetric (see that module's docblock; the
 * catastrophic direction is silently relocating a live install).
 *
 * This module answers a DIFFERENT question, and the difference matters:
 *
 *     paths.js        WHERE do I keep the user's data?
 *     install-mode.js WHAT am I allowed to do to my own code?
 *
 * The auto-updater does not actually want to know whether it is a checkout. It
 * wants to know whether it can run `git reset --hard` against its own source.
 * Today those coincide — every install is a repo install and every repo install
 * has a `.git` — and they will not coincide forever. A Homebrew cask is a
 * git-less NON-bundle; a `.pkg` that installs into `/usr/local/curator` is
 * another. Branching on the install FORM would put both of those on the repo
 * arm, which runs `git fetch` against a directory with no `.git`, and they
 * would fail with git's own text rather than a refusal that says why.
 *
 * There is a second, sharper reason. `isRepoInstall()` is literally
 * `!isBundleInstall()`. Branching on it at several call sites means branching
 * on a negation-of-a-negation in several places, and the day a third mode
 * exists every one of those sites silently inherits the repo arm — the arm
 * that runs destructive git commands. A named capability makes that a decision
 * someone has to write down, in one table, rather than a default nobody chose.
 *
 * HONEST CAVEAT, recorded rather than glossed: TODAY all four booleans below
 * are perfectly correlated with `mode === 'repo'`. They are not four
 * independent measurements. They are four distinct QUESTIONS that happen to
 * have the same answer in the only two modes that exist, and the value is in
 * the naming and in the single table — not in any information the booleans
 * carry over the mode itself. `scripts/test-install-mode.js` enforces the half
 * that is not aspirational: no route may branch on the MODE directly.
 *
 * ── The asymmetry is inherited from paths.js, verbatim and on purpose ───────
 *
 * `getInstallMode()` is `isBundleInstall() ? 'bundle' : 'repo'`. Anything
 * unrecognised is 'repo'. That direction fails LOUDLY (a write into a
 * read-only bundle errors immediately, nothing is lost); the inverse fails
 * SILENTLY with an empty wiki, which paths.js's own docblock names as "the
 * update deleted my second brain".
 *
 * Note what that means for the capability table: an unrecognised layout gets
 * the PERMISSIVE arm. That is the correct trade here for the same reason it is
 * correct in paths.js — a checkout wrongly refused an update is an annoyance
 * the user can work around with `git pull`, while a bundle wrongly permitted
 * one fails on the first write with an OS error naming the read-only path.
 *
 * ── Exhaustive by construction ──────────────────────────────────────────────
 *
 * Every mode's record must carry EVERY capability key, and no others. A
 * missing key would read as `undefined`, which is falsy, which would silently
 * route a repo install onto the refusing arm — a "your app can no longer
 * update itself" bug with no error anywhere. `defineCapabilities()` therefore
 * throws at module load if a record is incomplete or carries an unknown key.
 * That throw is deterministic (it reads a literal in this file, no I/O), so it
 * is a red test on the first `npm test`, never a runtime surprise in the field.
 *
 * ── Which keys have a branch, and which are DECLARED-ONLY ───────────────────
 *
 * `mcpLaunchStyle` and `restartStyle` shipped with NO branch behind them, on
 * an argument recorded here at the time: both were decisions the packaging
 * release had to make, and both were cheap to state while the bundle arm was
 * provably dead code. Both now have one. The table below is the whole truth,
 * measured off the tree rather than remembered — `scripts/test-install-mode.js`
 * §4 enumerates the readers FROM DISK and fails if this list drifts from them:
 *
 *   BRANCHED
 *     canSelfUpdateViaGit      src/routes/config.js (update, update-check)
 *                              src/brain/diagnostics.js (skips the git row)
 *     canRunNpmInstall         src/brain/diagnostics.js (same row)
 *     mcpLaunchStyle           src/routes/mcp.js, src/brain/mcp-launcher.js
 *     restartStyle             src/brain/restart.js   (POST /api/restart)
 *     folderPickerStyle        src/routes/config.js   (pick-folder)
 *
 *   DECLARED-ONLY, with the reason — and this half was previously MIS-STATED
 *   here, which is why it is now a list rather than a sentence. The old text
 *   named mcpLaunchStyle and restartStyle as the unwired pair; in fact these
 *   two were unread as well, and nothing said so:
 *
 *     canRebuildAppleScriptApp  SUBSUMED. `scripts/build-app.sh` is run at
 *       exactly one place — inside `updateHandler`, below its
 *       `canSelfUpdateViaGit` early return. A build that cannot reach the
 *       updater cannot reach the rebuild, so a second check there would be
 *       unreachable code, and unreachable code is not a guard. It stays as a
 *       named FACT because the day anything else wants to run that script —
 *       a repair action, a menu item — the answer must already be written
 *       down, not re-derived from "well, we're not a bundle".
 *
 *     canWriteBesideCode        SUBSUMED, and deliberately so.
 *       `src/brain/mcp-launcher.js` writes the shim into the USER DATA DIR
 *       precisely so it never writes beside the code, and `paths.js` is what
 *       decides where that is. Branching on this would invite the opposite
 *       reading — that writing beside the code is a supported mode as long as
 *       the flag is true. It is the statement of an invariant, not a switch.
 *
 * Two of the branched forks need an action this process cannot take by
 * itself — showing a native directory chooser, and relaunching the
 * application. Both resolve through `src/brain/desktop-host.js`, whose header
 * explains why an in-process registry is a real channel rather than a wish.
 * The rule that matters here: a bundle arm with nothing registered REFUSES.
 * It never falls back to the repo behaviour, because a route that claims one
 * contract and honours another is worse than one that says no.
 *
 * This module performs NO filesystem writes and never writes to stdout (it is
 * reachable from the MCP child process's import graph via paths.js's rules).
 */

import { isBundleInstall } from './paths.js';

/** The install forms this app knows about. Order is not significant. */
export const INSTALL_MODES = Object.freeze(['repo', 'bundle']);

/**
 * The authoritative capability key list. Adding a key here without adding it
 * to BOTH records below is a module-load throw, by design.
 */
export const CAPABILITY_KEYS = Object.freeze([
  // Can this copy run git against its own source tree? The question
  // `POST /api/config/update` actually asks — NOT "am I a checkout".
  'canSelfUpdateViaGit',
  // Can it run `npm install` into its own node_modules? Separate from the
  // above because a git-less-but-writable install (a tarball drop, a cask
  // staging dir) can do one and not the other.
  'canRunNpmInstall',
  // Can it re-run scripts/build-app.sh? That script rewrites The Curator.app
  // and ends in an ad-hoc `codesign --force --deep --sign -`, which would
  // DESTROY a Developer ID signature. In a signed bundle this must never run.
  'canRebuildAppleScriptApp',
  // Can it drop a file next to its own code and expect it to persist? False
  // in a signed bundle (invalidates the signature) and false for any
  // read-only install prefix.
  'canWriteBesideCode',
  // How Claude Desktop should be told to launch the MCP child.
  //   'node-script'      — `<node> <APP_ROOT>/mcp/server.js` (today)
  //   'launcher-script'  — a shell launcher the app rewrites on each start,
  //                        because a bundle's process.execPath moves under
  //                        App Translocation.
  'mcpLaunchStyle',
  // What "restart" means here.
  //   'respawn-node' — POST /api/restart spawns process.execPath (today)
  //   'app-relaunch' — the desktop shell relaunches itself; killing the node
  //                    process alone would leave a windowless app.
  'restartStyle',
  // How `POST /api/config/pick-folder` asks the user for a directory.
  //   'osascript'     — shell out to `osascript … choose folder` (today)
  //   'native-dialog' — the desktop shell's own directory chooser, installed
  //                     as the `pickFolder` hook in src/brain/desktop-host.js
  //
  // THIS IS NOT COSMETIC, and it is not the same question as "which dialog is
  // prettier". Notarization requires the HARDENED RUNTIME, under which the
  // osascript path is exposed to TWO INDEPENDENT mechanisms, neither of which
  // covers the other:
  //
  //   1. Driving another app via Apple events needs
  //      `com.apple.security.automation.apple-events`. Without it the call is
  //      DENIED — an error the route can report.
  //   2. Reading a folder under Documents / Desktop / Downloads needs the
  //      matching `NS*FolderUsageDescription` string in Info.plist. Without
  //      it macOS does not deny the read, it KILLS THE PROCESS.
  //
  // A capability that can end the process is not one to leave implicit, and
  // this is the ONE action an existing user must complete on their first
  // screen — pointing the app at a wiki they already have. Getting it wrong
  // does not degrade the app, it makes an existing second brain invisible.
  'folderPickerStyle',
]);

/**
 * Build one mode's record, refusing anything not exhaustive. Both directions
 * are checked: a MISSING key is the dangerous one (undefined ⇒ falsy ⇒ the
 * restrictive arm, silently), and an EXTRA key means someone added a
 * capability to one mode and forgot the other, which is the same bug wearing
 * a different hat.
 */
function defineCapabilities(mode, record) {
  const have = Object.keys(record);
  const missing = CAPABILITY_KEYS.filter((k) => !Object.hasOwn(record, k));
  const extra = have.filter((k) => !CAPABILITY_KEYS.includes(k));
  if (missing.length || extra.length) {
    throw new Error(
      `install-mode: capability record for "${mode}" is not exhaustive` +
      (missing.length ? ` — missing: ${missing.join(', ')}` : '') +
      (extra.length ? ` — unknown: ${extra.join(', ')}` : '')
    );
  }
  return Object.freeze({ ...record });
}

const CAPABILITIES = Object.freeze({
  // A git checkout, and — per the inherited asymmetry — any layout we do not
  // positively recognise as a bundle. Byte-for-byte today's behaviour.
  repo: defineCapabilities('repo', {
    canSelfUpdateViaGit: true,
    canRunNpmInstall: true,
    canRebuildAppleScriptApp: true,
    canWriteBesideCode: true,
    mcpLaunchStyle: 'node-script',
    restartStyle: 'respawn-node',
    folderPickerStyle: 'osascript',
  }),
  // A positively-identified packaged app: signed, read-only, no .git, no npm.
  // Unreachable in production today — `scripts/build-app.sh` builds an
  // AppleScript wrapper that RUNS THE CHECKOUT, so that .app is a repo
  // install (see paths.js). This arm is deliberately written while it is
  // provably dead code.
  bundle: defineCapabilities('bundle', {
    canSelfUpdateViaGit: false,
    canRunNpmInstall: false,
    canRebuildAppleScriptApp: false,
    canWriteBesideCode: false,
    mcpLaunchStyle: 'launcher-script',
    restartStyle: 'app-relaunch',
    folderPickerStyle: 'native-dialog',
  }),
});

/** Human-readable labels — for System Check and error text, never for logic. */
export const INSTALL_MODE_LABELS = Object.freeze({
  repo: 'Source install (git checkout)',
  bundle: 'Packaged app',
});

/**
 * 'repo' | 'bundle'. Derived from paths.js's positive bundle test, so the two
 * modules can never disagree about which install form this is.
 *
 * NOT memoised here: `isBundleInstall()` is a couple of cheap `existsSync`
 * calls and a string split, and memoising would defeat the child-process
 * probes the guard suite uses. paths.js memoises the expensive half (the
 * resolved data dir) already.
 */
export function getInstallMode() {
  return isBundleInstall() ? 'bundle' : 'repo';
}

/**
 * The frozen capability record for a mode (default: this install's).
 *
 * Throws on an unknown mode string. That is deliberate and is NOT a violation
 * of the fail-safe-to-'repo' rule above: `getInstallMode()` is total over
 * INSTALL_MODES, so the only way to get here with something else is a caller
 * passing a literal — i.e. a programming error, which should be loud. The
 * environment-driven unknown case is handled one level up, in getInstallMode(),
 * where it resolves to 'repo'.
 */
export function getCapabilities(mode = getInstallMode()) {
  const caps = CAPABILITIES[mode];
  if (!caps) {
    throw new Error(
      `install-mode: unknown install mode "${mode}" — expected one of ${INSTALL_MODES.join(', ')}`
    );
  }
  return caps;
}

/**
 * Wire-safe description of this install. Explicit allow-list, never a spread
 * of internal state — the v3.3.0 `toWire()` rule.
 */
export function describeInstall(mode = getInstallMode()) {
  const caps = getCapabilities(mode);
  const capabilities = {};
  for (const k of CAPABILITY_KEYS) capabilities[k] = caps[k];
  return {
    installMode: mode,
    installModeLabel: INSTALL_MODE_LABELS[mode] || mode,
    capabilities,
  };
}

/**
 * The body for a route arm that a capability forbids. One shape, so every
 * refusal reads the same and names WHY rather than just saying no.
 *
 * 501 (Not Implemented) rather than 403: the server understood the request
 * and is not withholding it for permission reasons — this build of the app
 * genuinely cannot perform it. A user reading "forbidden" would go looking
 * for a setting to flip.
 */
export function capabilityRefusal(capability, action, extra = {}) {
  const mode = getInstallMode();
  return {
    status: 501,
    body: {
      error:
        `Cannot ${action} in this build of The Curator (${INSTALL_MODE_LABELS[mode] || mode}). ` +
        `This install does not have the "${capability}" capability.`,
      refused: 'capability_unavailable',
      capability,
      installMode: mode,
      ...extra,
    },
  };
}
