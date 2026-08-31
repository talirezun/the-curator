/**
 * update-plan.js — every DECISION the in-app updater makes, and no I/O at all.
 *
 * Electron-free and `src/`-free, like every other module in this folder, so
 * `npm test` EXECUTES it rather than grepping it. The rule this repo keeps
 * re-learning (v3.0.17) is "assert behaviour, not the presence of a line of
 * source"; the way that rule is honoured here is by keeping the arithmetic,
 * the asset choice, the refusal codes and the shell script TEXT in a module
 * that has no reason to import anything.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THIS FILE DOES NOT DECIDE WHICH RELEASE IS NEWEST, AND MUST NEVER        ║
 * ║  START. `src/routes/config.js` owns that — `pickInstallableRelease()`     ║
 * ║  and `decideInstallerUpdate()` — and lib/update-release.js delegates to   ║
 * ║  it. What THIS file decides is a strictly smaller question the route      ║
 * ║  has never had to answer: given the release the route already chose,      ║
 * ║  WHICH OF ITS TWO .dmg FILES belongs on this Mac's CPU.                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The distinction matters because "one source of truth for what is the newest
 * version" is a real constraint and it would be easy to violate by accident:
 * a second `compareSemver` here, or a second `versionFromTag`, and the menu
 * bar, the Settings panel and the installer could each name a different
 * version. There is no version comparator in this file. The suite asserts it.
 */

import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
//  Progress
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five phases, in the order they occur. This list IS the contract with the
 * UI — the other half of this feature renders a bar keyed on it — so it is
 * exported and frozen rather than left as five string literals scattered
 * across the engine.
 *
 *   resolving    asking GitHub which release, and which asset
 *   downloading  the only phase with a byte count that means anything
 *   verifying    sha256 over the bytes on disk, then the staged bundle
 *   staging      mounting the .dmg and copying the .app into place
 *   installing   the swap helper has been handed off; the app is quitting
 */
export const UPDATE_PHASES = Object.freeze([
  'resolving', 'downloading', 'verifying', 'staging', 'installing',
]);

/**
 * Build one progress record.
 *
 * ONE place computes `percent`, and it is here, because every way of getting
 * it wrong is a division: an unknown total is 0 (Infinity), a missing total is
 * undefined (NaN), and a server that lies about Content-Length gives >100.
 * A progress bar handed NaN renders as either 0% forever or as nothing at all,
 * and neither says "we do not know how big this is".
 *
 * So `percent` is `null` — never a number — when the total is unknown, which a
 * UI can render as an indeterminate bar. It is a fact and its absence never
 * sharing a value: the same rule v3.15.0 records for the cost path.
 */
export function progressOf(phase, receivedBytes = 0, totalBytes = null) {
  const received = Number.isFinite(receivedBytes) && receivedBytes >= 0 ? Math.floor(receivedBytes) : 0;
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? Math.floor(totalBytes) : null;
  let percent = null;
  if (total !== null) {
    percent = Math.round((received / total) * 1000) / 10;
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
  }
  return { phase, receivedBytes: received, totalBytes: total, percent };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Failures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every reason this feature can fail, and the sentence each one shows.
 *
 * ── WHY A TABLE AND NOT `err.message` ───────────────────────────────────────
 *
 * The brief for this work fixed it as a contract: "every failure is a named
 * reason the UI can render, never a raw exception string". That is not
 * tidiness. A raw exception on this path is one of
 *
 *   EACCES: permission denied, mkdir '/Applications/.the-curator-update-3f2a'
 *   hdiutil: attach failed - no mountable file systems
 *   AbortError: The operation was aborted
 *
 * — three sentences that tell a user nothing about what to do, and one of
 * which (the first) embeds a path this app should not be splashing into a
 * dialog. Worse, an exception string is not a value a UI can branch on, so the
 * other half of this feature would end up regex-matching our error text, which
 * is the coupling that breaks the day a message is reworded.
 *
 * Each entry names the FIX where there is one. A user told "install-dir-not-
 * writable" has learnt nothing; a user told to drag the app to their own
 * Applications folder has learnt everything.
 */
export const UPDATE_FAILURES = Object.freeze({
  // ── resolving ──
  'network-unreachable': 'Could not reach GitHub to fetch the update. Check your internet connection and try again.',
  'github-error': 'GitHub could not be asked for the release list. Try again in a few minutes.',
  'unexpected-response': 'GitHub’s release list could not be read — the response was not in the expected form.',
  'no-installable-release': 'No installable build has been published yet, so there is nothing to download.',
  'no-update': 'The Curator is already on the newest published version. There is nothing to install.',
  'local-ahead': 'This build is newer than anything published, so there is nothing to install.',
  'not-comparable': 'The published version could not be compared with this one, so this update was not applied automatically. Download it from the releases page instead.',
  'local-version-unreadable': 'The Curator could not read its own version number, so it cannot tell whether an update applies.',
  'no-asset-for-arch': 'The newest release does not include a build for this Mac’s processor. Download it from the releases page instead.',
  'asset-unusable': 'The release’s download could not be used — it names no download address or no size.',

  // ── where we are installed ──
  'not-a-bundle': 'This copy of The Curator is not running as an installed application, so it cannot replace itself. Use the app in your Applications folder.',
  'no-exec-path': 'The Curator could not determine where it is installed, so it did not try to replace itself.',
  'app-translocation': 'macOS is running The Curator from a temporary read-only copy, so it cannot replace itself. Move The Curator to your Applications folder, reopen it, and try again.',
  'install-dir-not-writable': 'The folder The Curator is installed in cannot be written to, so the update cannot be put in place. Move The Curator to your own Applications folder, or ask whoever administers this Mac.',
  'install-dir-cross-device': 'The Curator is installed on a different disk from the folder the update was prepared in, so the swap could not be made safely. Move The Curator to your Applications folder and try again.',

  // ── downloading ──
  'download-failed': 'The download did not complete. Check your internet connection and try again.',
  'download-not-found': 'The download address for this release is no longer valid. Check the releases page.',
  'download-truncated': 'The download ended early and is incomplete, so it was discarded. Try again.',
  'download-oversized': 'The download was larger than the release says it should be, so it was discarded.',
  'download-cancelled': 'The update was cancelled. Nothing on this Mac was changed.',
  'download-write-failed': 'The update could not be written to disk. Check that there is enough free space and try again.',

  // ── verifying ──
  'size-mismatch': 'The downloaded file is not the size the release says it should be, so it was discarded rather than installed.',
  'digest-mismatch': 'The downloaded file does not match the checksum GitHub publishes for it, so it was discarded rather than installed.',
  'staged-version-mismatch': 'The prepared update does not report the version it was supposed to be, so it was discarded rather than installed.',
  'staged-incomplete': 'The prepared update is missing part of the application, so it was discarded rather than installed.',
  'staged-signature-invalid': 'The prepared update did not pass macOS’s own integrity check, so it was discarded rather than installed.',

  // ── staging ──
  'dmg-mount-failed': 'The downloaded disk image could not be opened. Try again, or download it from the releases page.',
  'dmg-no-app': 'The downloaded disk image does not contain The Curator, so nothing was installed.',
  'copy-failed': 'The update could not be copied into place. Check that there is enough free space and try again.',

  // ── installing ──
  'not-prepared': 'No update has been downloaded yet, so there is nothing to install.',
  'stale-token': 'That update is no longer the one that was prepared. Check for updates again.',
  'writes-in-progress': 'The Curator is writing to your knowledge base right now. Wait for it to finish, then install the update.',
  'helper-write-failed': 'The Curator could not prepare the final step of the update, so nothing was changed.',
  'helper-spawn-failed': 'The Curator could not start the final step of the update, so nothing was changed.',
  'relaunch-unavailable': 'The Curator could not arrange to quit itself, so the update was not applied. Quit and reopen the app, then try again.',

  // ── the catch-all, and it is not decoration ──
  // Both hooks promise a NAMED REASON and never a rejection. That promise
  // cannot be kept by enumeration alone: any unforeseen exception — a bad
  // dependency, an fs error nothing anticipated, a TypeError from a hook that
  // was wired wrong — would otherwise escape as a rejected promise, which in
  // the Electron main process is an unhandled rejection and, to the UI, a
  // button that silently does nothing. A mutation removing a guard produced
  // exactly that and CRASHED the suite rather than reddening an assertion,
  // which is how this entry came to exist.
  'internal-error': 'Something went wrong while preparing the update, so nothing on this Mac was changed. Try again, or download the update from the releases page.',
});

/**
 * Every reason this feature can WARN about, and the sentence each one shows.
 *
 * ── WHY THIS TABLE EXISTS AT ALL ────────────────────────────────────────────
 *
 * A warning is not a refusal — the update proceeds — but it travels the exact
 * same road as a failure: engine -> route -> wire -> panel, and the panel
 * renders whatever arrives. So it is subject to the same two rules the
 * `UPDATE_FAILURES` block above was written for: it must be a NAMED reason
 * rather than a borrowed string, and the sentence must be written by the side
 * that knows what is actually about to happen.
 *
 * ── THE SENTENCE CANNOT BE BORROWED FROM `classifyLaunchOrigin` ─────────────
 *
 * The obvious shortcut is to pass `launchOrigin.message` straight through —
 * the origin classifier already has a sentence for `downloads-folder`, and it
 * is a good one. It is good for the MCP shim, which is what it was written
 * for. Read in full it says the app "did not write the Claude Desktop
 * launcher" and that moving the app will get "the Claude Desktop connection
 * set up automatically" — every clause of which is FALSE in front of a user
 * who just pressed Check for updates. Nothing about the Claude Desktop
 * connection is happening; an application is being replaced.
 *
 * That is the whole reason the two sides share a REASON and not a message:
 * `classifyLaunchOrigin` answers "is this location ephemeral, and why", which
 * both features genuinely need, and each feature says its own consequence.
 *
 * ── AND WHY IT IS A STRING ON THE WAY OUT ──────────────────────────────────
 *
 * Because every consumer downstream of here renders it. The route relays it
 * verbatim, exactly as it relays a failure's `message`; the panel prints it.
 * `reason` is kept here so an unmapped one cannot silently vanish, but it is
 * a lookup key, not a payload — a slug beside a sentence is an internal
 * identifier shown to a person, which this release exists to undo.
 */
export const UPDATE_WARNINGS = Object.freeze({
  'downloads-folder':
    'The Curator is running from your Downloads folder, so the update will replace it there rather than in ' +
    'your Applications folder. That works, but Downloads is a temporary place for an app — move The Curator ' +
    'to Applications once the update has finished.',
});

/**
 * A named, non-blocking warning as the sentence to show, or `null` for none.
 *
 * TOTAL, and an unmapped reason gets a true generic sentence rather than
 * `null`. Returning `null` for something the classifier flagged would put the
 * warning back where this release found it: computed, and then silently
 * dropped on the way to the person it was for.
 */
export function updateWarning(reason) {
  if (typeof reason !== 'string' || !reason) return null;
  if (Object.hasOwn(UPDATE_WARNINGS, reason)) return UPDATE_WARNINGS[reason];
  return 'The Curator is running from a temporary location, so the update will replace it where it is. ' +
    'Move The Curator to your Applications folder once the update has finished.';
}

/** A refusal. `detail` is for the LOG, never for the dialog. */
export function updateFailure(reason, detail = null) {
  const message = Object.hasOwn(UPDATE_FAILURES, reason)
    ? UPDATE_FAILURES[reason]
    // An unmapped reason is a bug in this file, not in the caller. It still
    // must not become an empty dialog, and it must be obvious in a log.
    : 'The update could not be completed.';
  return {
    ok: false,
    reason,
    message,
    ...(detail ? { detail: String(detail) } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Which .dmg belongs on this Mac
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sha256:6f1a…` → `{ algorithm:'sha256', hex:'6f1a…' }`, anything else null.
 *
 * GitHub added `digest` to the release-asset payload and it is populated on
 * this repo's real releases — MEASURED against the live API, both DMGs of
 * v3.31.0 and v3.32.0, all four carrying `sha256:` and 64 hex characters. It
 * is nevertheless parsed defensively and allowed to be ABSENT, because an
 * older release predates the field and a missing digest must degrade to
 * "length-only verification, and say so", never to a crash.
 *
 * The algorithm is allow-listed rather than passed through to `createHash`:
 * `createHash` accepts whatever OpenSSL knows, which includes `md5`, and a
 * release payload is not the place to let a remote server choose our hash.
 */
/**
 * The algorithms this file will accept, and the hex length each one must have.
 *
 * ONE table, and the allow-list is DERIVED from it. The first draft kept the
 * two apart and computed the length as `algorithm === 'sha256' ? 64 : 128`,
 * which made the allow-list unfalsifiable: adding `md5` to it changed nothing,
 * because a 32-character md5 was then rejected by the length arm for being
 * "not 128". A mutation that added md5 came back GREEN and the assertion
 * claiming md5 was refused had never been able to fail. Deriving the list from
 * the table means an algorithm cannot be admitted without also stating its
 * length, and the suite asserts the list itself.
 */
export const DIGEST_HEX_LENGTHS = Object.freeze({ sha256: 64, sha512: 128 });
export const SUPPORTED_DIGEST_ALGORITHMS = Object.freeze(Object.keys(DIGEST_HEX_LENGTHS));

export function parseAssetDigest(digest) {
  if (typeof digest !== 'string') return null;
  const m = digest.trim().toLowerCase().match(/^([a-z0-9-]+):([0-9a-f]+)$/);
  if (!m) return null;
  const [, algorithm, hex] = m;
  if (!Object.hasOwn(DIGEST_HEX_LENGTHS, algorithm)) return null;
  if (hex.length !== DIGEST_HEX_LENGTHS[algorithm]) return null;
  return { algorithm, hex };
}

/**
 * Which CPU an asset filename is for, or null.
 *
 * The names are electron-builder's own, from `desktop/electron-builder.yml`'s
 * two-arch `dmg` target, and they are what the live releases actually carry:
 *
 *     TheCurator-3.32.0-arm64-AppleSilicon.dmg
 *     TheCurator-3.32.0-x64-Intel.dmg
 *
 * Matched as a WHOLE HYPHEN-DELIMITED token, not as a bare substring, and the
 * delimiter set is exactly `-` because that is the one electron-builder uses
 * between name, version, arch and label.
 *
 * ── BOTH HALVES OF THAT WERE WRONG IN THE FIRST DRAFT, AND THE SUITE ────────
 *    CAUGHT BOTH
 *
 * The first version split on `[-_.]`. That is looser than a substring test in
 * one direction and tighter in the other, and it got two real filenames wrong:
 *
 *   TheCurator-3.arm64.0-x64-Intel.dmg   splitting on `.` breaks the VERSION
 *       into tokens, so `arm64` appears as a token and the arm64 check — which
 *       runs first — wins. An Intel Mac would have been handed the arm64 build.
 *   TheCurator-3.0.0-x64_64-Intel.dmg    splitting on `_` turns an
 *       unrecognised label into a bare `x64`, so a name this code does not
 *       understand is confidently read as one it does.
 *
 * Splitting on `-` alone makes `3.arm64.0` and `x64_64` each a single token
 * that matches nothing, which is the honest answer in both cases.
 *
 * ── AMBIGUITY REFUSES ───────────────────────────────────────────────────────
 *
 * A name carrying BOTH tokens is not a coin toss between them. Preferring one
 * is how a universal or mislabelled asset gets silently installed on the wrong
 * chip; `null` sends it to `no-asset-for-arch`, which the user can act on.
 */
export function archFromAssetName(name) {
  if (typeof name !== 'string') return null;
  const base = name.toLowerCase();
  if (!base.endsWith('.dmg')) return null;
  const tokens = base.slice(0, -4).split('-');
  const isArm = tokens.includes('arm64');
  const isX64 = tokens.includes('x64');
  if (isArm && isX64) return null;
  if (isArm) return 'arm64';
  if (isX64) return 'x64';
  return null;
}

/**
 * Pick the one asset to download.
 *
 * ── ROSETTA IS NOT ACCOMMODATED, AND THAT IS DELIBERATE ─────────────────────
 *
 * An arm64 Mac running the x64 build under Rosetta reports `process.arch ===
 * 'x64'`, so this would hand it another x64 build and the user would stay on
 * the slow one forever. The tempting fix is to detect translation and
 * "upgrade" them to arm64 — and it is the wrong fix HERE, because this code
 * path replaces the app the user is running with a DIFFERENT architecture's
 * binary, silently, from a progress bar. That is an architecture migration
 * wearing an update's clothes, and if the arm64 build turned out not to launch
 * the user would have no way back. The honest place for it is a one-time,
 * explicit offer in the UI, which is not this half of the feature.
 *
 * So: like-for-like, always. Recorded rather than glossed.
 */
export function pickInstallerAsset(assets, opts = {}) {
  const arch = typeof opts.arch === 'string' ? opts.arch : null;
  const list = Array.isArray(assets) ? assets : [];

  const usable = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const name = typeof a.name === 'string' ? a.name : '';
    if (archFromAssetName(name) !== arch) continue;
    usable.push({
      name,
      url: typeof a.browser_download_url === 'string' ? a.browser_download_url : null,
      size: Number.isFinite(a.size) && a.size > 0 ? Math.floor(a.size) : null,
      digest: parseAssetDigest(a.digest),
    });
  }

  if (!usable.length) return updateFailure('no-asset-for-arch', `no .dmg matched arch=${arch}`);

  const asset = usable[0];
  // HTTPS ONLY, and matched against the host GitHub actually serves release
  // downloads from. This URL comes off the network and is handed to fetch(),
  // so a payload naming `http://…` or another host must not be followed: it
  // would turn a compromised or spoofed release listing into an arbitrary
  // download that we then hand to `hdiutil` and copy over the user's app.
  // The digest check below is the second layer; this is the first, and it is
  // the one that stops the bytes ever arriving.
  if (!asset.url || !/^https:\/\/github\.com\/|^https:\/\/objects\.githubusercontent\.com\//.test(asset.url)) {
    return updateFailure('asset-unusable', `asset ${asset.name} has no usable https download URL`);
  }
  if (!asset.size) {
    return updateFailure('asset-unusable', `asset ${asset.name} declares no size`);
  }
  return { ok: true, asset };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Where we are installed, and whether we may replace it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `/Applications/The Curator.app/Contents/MacOS/The Curator` → the `.app`.
 *
 * Matched as a path COMPONENT ending in `.app`, never as a substring, for the
 * same reason `classifyLaunchOrigin` matches `AppTranslocation` that way: a
 * user folder honestly named `My.apps` must not be mistaken for a bundle.
 *
 * Returns null for anything that is not inside a `.app`, which is the normal
 * state of `npm start` and of `electron .` during development — and which must
 * refuse rather than guess, because the guess would be a directory this code
 * is about to move.
 */
export function bundlePathFromExecPath(execPath) {
  if (typeof execPath !== 'string' || !execPath) return null;
  const parts = execPath.split(path.sep);
  // LAST match, not first: an app installed under a folder that itself ends in
  // `.app` (rare but legal) must resolve to the inner bundle, which is the one
  // `Contents/MacOS` belongs to.
  let idx = -1;
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].toLowerCase().endsWith('.app') && parts[i].length > 4) idx = i;
  }
  if (idx < 0) return null;
  return parts.slice(0, idx + 1).join(path.sep);
}

/**
 * May this install replace itself, and where would the swap happen?
 *
 * ── THE TRANSLOCATION REASONING IS NOT RE-IMPLEMENTED HERE ──────────────────
 *
 * `src/brain/mcp-launcher.js` already answers "is this process running from
 * somewhere ephemeral?" — the path-COMPONENT match on `AppTranslocation`, the
 * case-insensitive `~/Downloads` check because APFS is case-insensitive, the
 * empty-`execPath` case, and a `platform` parameter rather than a read of
 * `process.platform` so the branch can be driven on both platforms. All of
 * that was got right once, with a recorded CI failure behind each detail.
 *
 * So `launchOrigin` is INJECTED: the caller hands in the result of the real
 * `classifyLaunchOrigin(execPath, homeDir)`. A second copy of that matching
 * logic is exactly the duplication that drifts.
 *
 * ── WHERE THE TWO FEATURES DISAGREE, AND WHY ────────────────────────────────
 *
 * They disagree on `~/Downloads`, and the disagreement is correct rather than
 * an oversight. The MCP shim REFUSES a Downloads install because it writes a
 * path that must still be valid days later, and Downloads is one tidy-up away
 * from gone. This feature is replacing a bundle IN PLACE, right now: the app
 * is where it is, and an update applied there is exactly as durable as the app
 * it replaces. Refusing would mean telling a user their app cannot be updated
 * because of where they keep it, which is a worse outcome than updating it
 * there. So Downloads PROCEEDS, and rides along as a `warning` the UI shows —
 * a SENTENCE, from `updateWarning()` above, in this feature's own vocabulary.
 * It is deliberately not `launchOrigin.message`: that sentence is about the
 * Claude Desktop launcher, and relaying it here would tell a user in the
 * middle of an app update about a connection nothing is touching.
 *
 * `app-translocation` is a hard refusal in BOTH features, and here it is not a
 * durability argument at all — it is arithmetic. Under translocation the app
 * is executing from a read-only mount under /private/var/folders that is not
 * where it lives, so there is nothing at that path to replace and the mount
 * itself cannot be written.
 */
export function classifyInstallTarget(opts = {}) {
  const { execPath = null, launchOrigin = null } = opts;

  const origin = launchOrigin && typeof launchOrigin === 'object' ? launchOrigin : null;
  if (origin && origin.ephemeral && origin.reason === 'app-translocation') {
    return updateFailure('app-translocation', origin.reason);
  }
  if (origin && origin.ephemeral && origin.reason === 'no-exec-path') {
    return updateFailure('no-exec-path', origin.reason);
  }

  const bundlePath = bundlePathFromExecPath(execPath);
  if (!bundlePath) return updateFailure('not-a-bundle', `execPath is not inside a .app: ${execPath ? 'set' : 'empty'}`);

  return {
    ok: true,
    bundlePath,
    installDir: path.dirname(bundlePath),
    // Not a refusal. The UI shows it; the install proceeds either way.
    // A STRING or `null` — see `updateWarning()`. Every consumer from here to
    // the panel renders this value, and an object arriving where a sentence
    // was expected is how this warning came to be built and then dropped.
    warning: origin && origin.ephemeral && origin.reason
      ? updateWarning(origin.reason)
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The swap
// ─────────────────────────────────────────────────────────────────────────────

/** POSIX single-quoting. Same helper, same reason, as buildLauncherScript():
 *  `/Applications/The Curator.app` has a space in every real install. */
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** How long the helper waits for the app to exit before giving up, in units of
 *  the 0.2 s poll below. 600 × 0.2 s = two minutes — long enough for a slow
 *  teardown, short enough that a recycled PID cannot hang a script forever. */
export const SWAP_WAIT_TICKS = 600;

/**
 * The `/bin/sh` script that actually replaces the app, written out at install
 * time and run detached after this process exits.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHY A HELPER AT ALL, AND WHY IT CANNOT BE THE APP ITSELF                 ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The running app's own bundle is the thing being replaced. Electron loads
 * resources from that bundle lazily for the whole life of the process — the
 * framework, the helper apps, the icon, `Info.plist` — so a self-replacement
 * from inside the process leaves a running app whose files have moved out from
 * under it. It usually appears to work, and then fails at the first lazy read.
 * The conventional Mac answer, and the one every pre-notarisation updater
 * used, is to hand the job to a small process that outlives the app.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE SWAP IS TWO rename(2) CALLS, BACK TO BACK, WITH NOTHING BETWEEN.     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * A single atomic directory swap is what one would want, and macOS does have
 * it — `renamex_np(…, RENAME_SWAP)`, since 10.12. Node's `fs` does not expose
 * it and no shipped command-line tool calls it, so reaching it means native
 * code. It is not available here, and pretending otherwise would be worse than
 * saying so. `rename(2)` onto an existing non-empty directory fails with
 * ENOTEMPTY, so the swap is necessarily:
 *
 *     rename(TARGET  -> BACKUP)     atomic, metadata only, same filesystem
 *     rename(STAGED  -> TARGET)     atomic, metadata only, same filesystem
 *
 * Both are `/bin/mv` on paths that are SIBLINGS by construction, so `mv`
 * performs a real `rename(2)` and never falls back to its copy-then-delete
 * path. (The engine additionally proves same-device with `stat` before this
 * script is ever written — `mv` across devices would be a non-atomic 400 MB
 * copy, which is precisely the state this design exists to avoid.)
 *
 * ── WHAT POWER LOSS LOOKS LIKE, AT EVERY POINT ──────────────────────────────
 *
 *   before the first mv   TARGET is the old app, complete. Nothing changed.
 *   BETWEEN the two mvs   TARGET does not exist. BACKUP is the complete old
 *                         app; STAGED is the complete new one. Neither bundle
 *                         is half-written — both were fully written and
 *                         verified before this script started, and `rename`
 *                         moves no bytes. The user sees the app missing from
 *                         Applications; recovery is renaming BACKUP back, and
 *                         the log line written just above says both names.
 *   after the second mv   TARGET is the new app, complete. A leftover BACKUP
 *                         may survive; it is swept by the next update and is
 *                         inert in the meantime.
 *
 * That middle window is two syscalls wide, and it is the ONLY state in the
 * whole design that needs a human. It is bought at the price of never being
 * able to produce a HALF-REPLACED bundle — an app that exists at the right
 * path and will not launch, which is a far worse outcome than a missing one
 * because the user cannot tell what happened and has nothing to drag back.
 * Every other failure below rolls back and reopens the old app.
 *
 * ── FAIL TOWARD "THE OLD APP STILL WORKS" ───────────────────────────────────
 *
 * Every refusal and every rollback path ends in `open "$TARGET"`. An update
 * that did not happen must not also cost the user their running application.
 */
export function buildSwapScript(opts = {}) {
  const {
    pid, targetPath, stagedPath, backupPath, stageDir, logPath, waitTicks = SWAP_WAIT_TICKS,
    // TEST-ONLY SEAM, and a narrow one: the command used to reopen the app.
    // Production never passes it. `scripts/test-desktop-update-macos.js` swaps
    // a REAL bundle in a temp directory and must not then LAUNCH it — a test
    // suite that opens applications on the maintainer's desktop is not a test
    // suite anybody wants to run. Same shape and same justification as
    // `compileConversation`'s `opts.generateText` and `ensureMcpLauncherShim`'s
    // `opts.execPath`: defaulted to the real thing, so a caller that forgets it
    // gets production behaviour rather than a silently disabled relaunch.
    openCommand = '/usr/bin/open',
  } = opts;

  for (const [k, v] of Object.entries({ pid, targetPath, stagedPath, backupPath, stageDir })) {
    if (v === null || v === undefined || v === '') {
      throw new Error(`buildSwapScript: ${k} is required`);
    }
  }

  const lines = [
    '#!/bin/sh',
    '# The Curator — update installer.',
    '# Generated at install time by desktop/lib/update-plan.js. Not shipped, not',
    '# edited by hand, and deleted once it has run. It replaces the application',
    '# bundle with the one already downloaded, verified and staged beside it.',
    '#',
    '# The whole swap is two rename(2) calls with nothing between them. Read the',
    '# docblock above buildSwapScript() for what power loss looks like at each',
    '# point, and why a single atomic directory swap is not reachable from here.',
    'set -u',
    '',
    `PID=${q(String(pid))}`,
    `TARGET=${q(targetPath)}`,
    `STAGED=${q(stagedPath)}`,
    `BACKUP=${q(backupPath)}`,
    `STAGE_DIR=${q(stageDir)}`,
    ...(logPath ? [`LOG=${q(logPath)}`] : ['LOG=/dev/null']),
    '',
    '# Never fails the script: a log that cannot be written must not stop an',
    '# update, and must not stop a rollback either.',
    'log() { printf "%s update-install: %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$LOG" 2>/dev/null || true; }',
    '',
    '# ── 1. Wait for The Curator to exit ────────────────────────────────────',
    '# Bounded. An unbounded wait would hang forever the day a PID is recycled',
    '# by an unrelated process, and a hung helper leaves the staged bundle',
    '# sitting in the Applications folder with nothing to clean it up.',
    'log "waiting for pid $PID"',
    'i=0',
    'while kill -0 "$PID" 2>/dev/null; do',
    '  i=$((i+1))',
    `  if [ "$i" -gt ${Number(waitTicks)} ]; then`,
    '    log "REFUSED: pid $PID is still running — nothing was changed"',
    '    exit 3',
    '  fi',
    '  sleep 0.2',
    'done',
    '',
    '# ── 2. Both bundles must still be here ─────────────────────────────────',
    '# Re-checked after the wait, not before it: the user had the whole quit to',
    '# delete either one, and acting on a stale check is how a rollback ends up',
    '# restoring something that is no longer there.',
    'if [ ! -d "$STAGED" ]; then log "REFUSED: prepared update is missing"; exit 4; fi',
    'if [ ! -d "$TARGET" ]; then log "REFUSED: installed app is missing"; exit 5; fi',
    '',
    '# ── 3. THE SWAP — two renames, nothing in between ──────────────────────',
    '# Do not add a log line, a sync, or a check between these two commands.',
    '# The gap between them is the one window in this design in which the app',
    '# is absent from its own path, and every statement placed there widens it.',
    'log "swapping $TARGET"',
    'if ! /bin/mv -f "$TARGET" "$BACKUP"; then',
    '  log "REFUSED: could not move the installed app aside — nothing changed"',
    `  ${openCommand} "$TARGET" 2>/dev/null || true`,
    '  exit 6',
    'fi',
    'if ! /bin/mv -f "$STAGED" "$TARGET"; then',
    '  log "ROLLBACK: could not move the new app into place"',
    '  if /bin/mv -f "$BACKUP" "$TARGET"; then',
    '    log "ROLLBACK: the previous version is back in place"',
    '  else',
    '    log "ROLLBACK FAILED: the previous version is at $BACKUP — move it back to $TARGET"',
    '  fi',
    `  ${openCommand} "$TARGET" 2>/dev/null || true`,
    '  exit 7',
    'fi',
    'log "swap committed"',
    '',
    '# ── 4. Clean up, then relaunch ─────────────────────────────────────────',
    '# The backup is removed only AFTER the swap has committed, so at no point',
    '# does exactly one complete copy of the app exist.',
    '/bin/rm -rf "$BACKUP" "$STAGE_DIR" 2>/dev/null || true',
    'log "relaunching"',
    `${openCommand} "$TARGET" || log "WARNING: could not reopen the app"`,
    'exit 0',
    '',
  ];
  return lines.join('\n');
}
