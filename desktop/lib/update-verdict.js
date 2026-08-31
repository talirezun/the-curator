/**
 * describeUpdate() — turn an `/api/config/update-check` payload into the
 * dialog the "Check for Updates…" menu item shows, and
 * describeInstallOutcome() — turn what happened next into the one after it.
 *
 * Electron-free and src-free, like every other module in this folder, so the
 * guard suite EXECUTES it against real payload shapes rather than grepping
 * main.js for the string `showMessageBox`.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ONE RULE THIS FILE MUST NEVER BREAK:                                 ║
 * ║  IT DOES NOT COMPARE VERSIONS. NOT ONCE. NOT ANYWHERE.                    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * `src/routes/config.js` already decided everything there is to decide, and it
 * is the only side that can: it read the release list. It ships the verdict as
 * four independent, already-computed booleans —
 *
 *     updateAvailable      a newer installable/publishable version exists
 *     localAhead           we are newer than anything published
 *     comparable           the two version strings could be compared at all
 *     noInstallableRelease nothing with an installer has been published yet
 *
 * — and `pickInstallableRelease()` already chose WHICH release. This function
 * reads those flags and picks a sentence. That is all it does.
 *
 * `src/public/next/views/settings.js` states the same rule for the same reason
 * in `classifyInstallerUpdate`'s docblock: "a second, independent verdict on
 * the client is how a UI comes to contradict its own API". A native dialog and
 * a settings panel disagreeing about whether you need to update would be that
 * defect twice over, in two processes, with no way for the user to tell which
 * one lied.
 *
 * There is exactly ONE string inequality below (`latest !== current`) and it
 * decides a LABEL, never a verdict: whether to render "v3.30.0 → v3.31.0" or
 * "newer commits". The verdict it sits inside was already `updateAvailable`
 * before that line ran. The suite asserts no comparator exists in this file.
 *
 * ── WHY THE SHELL SHOWS A DIALOG AT ALL, RATHER THAN OPENING SETTINGS ───────
 *
 * "Check for Updates…" is a macOS idiom with a fixed meaning — Sparkle's, and
 * Apple's own. The ellipsis promises a dialog; the item promises an ANSWER.
 * The alternatives were weighed and are recorded in desktop/README.md; the
 * short version is that a menu item which silently swaps the visible view has
 * no way to say "you are up to date", which is the answer four times out of
 * five.
 *
 * That argument is about THE CHECK, and it still holds. It never covered what
 * happens after the user has explicitly agreed to download and install — see
 * `main.js`'s `runMenuInstall()` for the separate decision about where the
 * PROGRESS goes, which is not this file's to make.
 *
 * ── WHAT THIS FILE ONCE SAID AND NO LONGER DOES ────────────────────────────
 *
 * Until v3.36.0 the `available` branch said, in the app's own voice:
 *
 *     "This build does not install updates by itself. Download opens the
 *      release page in your browser; you then replace The Curator in your
 *      Applications folder."
 *
 * That was TRUE of v3.31.0, which is when it was written. v3.33.0 shipped the
 * in-app updater in the same release as this menu, built by a different agent,
 * and nobody rewired the menu — so the sentence went on describing a design
 * the app no longer had, while Settings ▸ General downloaded and installed the
 * update in place. The maintainer met it on v3.35.0.
 *
 * The sentence is not deleted, because it is still exactly right for a build
 * with NO engine attached — a checkout, or a packaged app whose registration
 * failed. It is now CONDITIONED on the server's own `updaterAttached`, which
 * is the same field Settings reads. A copy of one fact in two places is how
 * they drift; a branch on one fact in two places cannot.
 *
 * ── WHAT IS DUPLICATED FROM Settings → General, AND WHAT IS NOT ─────────────
 *
 * NOT duplicated: which release is newest, whether it is newer than us,
 * whether the versions are comparable, whether anything is published, whether
 * an updater is attached, whether a job is already running, the release URL,
 * and every failure sentence — all of those arrive on the wire.
 *
 * Duplicated: four short headline sentences ("You're up to date", and so on),
 * and `INSTALL_EXPLAINER` below. That is a real cost and it is bounded. The
 * explainer is duplicated BYTE FOR BYTE and pinned by a cross-file assertion
 * that reads `src/public/next/views/settings.js` — the same technique
 * `lib/menu.js` uses for `RELEASES_URL`, and the reason is the same: every
 * module in this folder is src-free so the suite can EXECUTE it, and a
 * constant pinned by an assertion is the cheapest way to have both properties.
 * Re-authoring the sentence would have produced two descriptions of one
 * operation, free to drift — which is the defect this release exists to fix.
 */

/** Buttons are ALWAYS [dismiss, action?] — index 0 dismisses, index 1 (when
 *  present) performs `action`. Same convention as main.js's quit dialog, whose
 *  handler reads `response === 1`, so one rule covers both dialogs. */
export const DISMISS_ID = 0;
export const ACTION_ID = 1;

/** Fallback when a payload names no page. Only ever reached for a `git-pull`
 *  payload, which carries no release URLs at all — the installer arm always
 *  sends `releasesPageUrl`. */
export const RELEASES_PAGE_FALLBACK = 'https://github.com/talirezun/the-curator/releases';

/**
 * What the app is about to do, in the app's own words — BYTE-IDENTICAL to the
 * sentence `onInstallInApp()` in `src/public/next/views/settings.js` puts in
 * front of the same decision, and pinned to it by the suite.
 *
 * ── EVERY CLAUSE IS TRUE, AND ONE OF THEM IS THE GOOD NEWS ─────────────────
 *
 *  · "downloads the new version"      — GET on an https github.com asset.
 *  · "checks it arrived complete and unaltered"  — byte length against the
 *    release's declared `size`, then sha256 against the digest GitHub
 *    publishes for that asset, then the staged bundle's own version string,
 *    then `codesign --verify --deep --strict`.
 *  · "with no security warning to click through" — THE GOOD NEWS, and it is
 *    measured rather than hoped: a DMG carrying `com.apple.quarantine` (what
 *    a browser download stamps on it) yields a quarantined app and the
 *    Privacy & Security detour; the same DMG fetched by the app's own
 *    `fetch()` yields an unquarantined one. Both arms are in the macOS suite,
 *    the browser-download arm as the control. That difference IS the whole
 *    reason this path beats the hand-install flow the maintainer rejected.
 *  · "Nothing is replaced until that check passes" — `prepareUpdate` stages
 *    beside the installed app and replaces nothing; the two renames happen in
 *    `installUpdate`, after every check above.
 *  · "your knowledge base, API keys and sync settings are untouched" — they
 *    live under `getUserDataDir()` and `getDomainsDir()`, outside the bundle.
 *
 * ── AND WHAT IT DELIBERATELY DOES NOT CLAIM ────────────────────────────────
 *
 * That Apple has vouched for the bytes. It has not: the build is ad-hoc
 * signed, so `codesign --verify` is an INTEGRITY check and not an authenticity
 * one, and authenticity rests entirely on GitHub's published digest and on TLS
 * to github.com. "No security warning to click through" is a statement about
 * quarantine, not about notarization, and the two must never be blurred — the
 * `prerelease` sentence below says out loud that the app is not signed by
 * Apple.
 */
export const INSTALL_EXPLAINER =
  'The Curator downloads the new version, checks it arrived complete and unaltered, then restarts ' +
  'into it — with no security warning to click through. Nothing is replaced until that check passes, so ' +
  'a failed download leaves this copy working. Your knowledge base, API keys and sync settings are untouched.';

/** The sentence for a build that genuinely cannot install its own update. Kept
 *  verbatim from v3.31.0 because it is still true THERE — see the header. */
export const MANUAL_INSTALL_EXPLAINER =
  'This build does not install updates by itself. Download opens the release page in your browser; ' +
  'you then replace The Curator in your Applications folder. Your knowledge base, API keys and sync ' +
  'settings live outside the app and are untouched.';

/**
 * Which update mechanism a PAYLOAD describes. Note: the payload, not the
 * install mode. This shell must not fork on the mode (there is one binary and
 * two possible checkouts under it), and it does not need to: the route already
 * forked, and stamped its answer.
 *
 * Absent means `git-pull`, exactly as `updateStyleOf()` in settings.js decides
 * it, and for the reason recorded there — the repo arm of the route is
 * byte-identical to what it has always returned and never carried the field.
 */
export function updateStyleOf(payload) {
  return (payload && payload.updateStyle === 'download-installer')
    ? 'download-installer'
    : 'git-pull';
}

/** `3.30.0` → `v3.30.0`; anything unusable → null, never a placeholder that
 *  reads like a version. A dialog saying "v" or "vundefined" is worse than a
 *  dialog that omits the number. */
function v(version) {
  return (typeof version === 'string' && version.trim()) ? `v${version.trim()}` : null;
}

function pageUrl(payload) {
  const p = payload || {};
  if (typeof p.releasesPageUrl === 'string' && p.releasesPageUrl) return p.releasesPageUrl;
  return RELEASES_PAGE_FALLBACK;
}

/** An `{ type:'open-url' }` action, or null when there is nothing to open. */
function openUrl(url) {
  return (typeof url === 'string' && /^https:\/\//i.test(url)) ? { type: 'open-url', url } : null;
}

/**
 * @param {object|null} payload the body from fetchUpdateCheck()
 * @param {{attached?: boolean|null, jobState?: string|null, jobVersion?: string|null}} [installer]
 *        the normalised `GET /api/config/update-progress` probe. `attached`
 *        has THREE values on purpose — `true`, `false`, and `null` for "we
 *        could not ask" — and only `true` offers to install. Unknown therefore
 *        falls back to the download-page dialog, which is true of every build:
 *        the fail-safe direction, and the same asymmetry `paths.js` uses for
 *        install-mode detection.
 * @returns {{
 *   kind: string, style: string, type: string,
 *   message: string, detail: string,
 *   buttons: string[], defaultId: number, cancelId: number,
 *   action: null | {type:'open-url', url:string} | {type:'open-settings'}
 *         | {type:'install'} | {type:'install-staged'}
 * }}
 *
 * EIGHT kinds, and no two of them share wording:
 *
 *   error            we could not find out — the server's own sentence
 *   available        a newer build exists — here is how to get it
 *   install          a newer build exists and this app can install it itself
 *   install-staged   it is already downloaded and verified; one step left
 *   install-running  an update is already downloading right now
 *   current          you are on the newest one
 *   local-ahead      you are newer than anything published
 *   no-release       nothing installable has been published yet
 *   unknown-version  a build exists; the versions cannot be compared
 *
 * The order below is precedence and it is load-bearing: `error` first (nothing
 * else in the payload is trustworthy once the check itself failed), then the
 * two "we cannot answer the question" states, then the comparison outcomes.
 * It mirrors settings.js's `classifyInstallerUpdate` precisely so the two
 * surfaces cannot reach different kinds from one payload.
 */
export function describeUpdate(payload, installer = {}) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const style = updateStyleOf(p);
  const cur = v(p.current);
  const lat = v(p.latest);
  const curPhrase = cur ? `You’re running ${cur}.` : 'This build does not report a version number.';

  const base = { style, defaultId: DISMISS_ID, cancelId: DISMISS_ID };

  // ── 1. The check itself failed ────────────────────────────────────────────
  // The sentence is the SERVER's, verbatim. `classifyReleaseFailure()` writes
  // one per failure mode (unreachable / rate-limited / http-error /
  // unexpected-response) and each one is already actionable. Re-authoring them
  // here would be four more strings to keep true, and they would be the four
  // that matter most — a user only reads them when something is wrong.
  if (typeof p.error === 'string' && p.error.trim()) {
    const url = pageUrl(p);
    return {
      ...base,
      kind: 'error',
      type: 'error',
      message: 'Couldn’t check for updates',
      detail: p.error.trim(),
      buttons: ['OK', 'Open Releases Page'],
      action: openUrl(url),
    };
  }

  // ── 2. Nothing installable exists yet ─────────────────────────────────────
  // NOT an error and NOT "up to date" — the route is explicit that these are
  // three different facts, so they get three different dialogs.
  if (p.noInstallableRelease === true) {
    return {
      ...base,
      kind: 'no-release',
      type: 'info',
      message: 'No installable build has been published yet',
      detail: `${curPhrase} When a release with an installer is published, this check will find it.`,
      buttons: ['OK', 'Open Releases Page'],
      action: openUrl(pageUrl(p)),
    };
  }

  // ── 3. The versions could not be compared ─────────────────────────────────
  // `comparable` is only ever sent by the installer arm. `=== false` rather
  // than falsy, so a git-pull payload — which omits the field entirely — is
  // not swept into a state its route never claimed.
  if (p.comparable === false) {
    const named = (typeof p.releaseName === 'string' && p.releaseName) ? p.releaseName : (lat || 'the published build');
    return {
      ...base,
      kind: 'unknown-version',
      type: 'warning',
      message: 'Couldn’t compare versions',
      detail:
        `The newest published build is “${named}”, and ${cur ? `this one reports ${cur}` : 'this one reports no version'}. ` +
        'One of those isn’t a version number The Curator can compare, so it can’t tell you which is newer.',
      buttons: ['OK', 'Open Releases Page'],
      action: openUrl(typeof p.releaseUrl === 'string' && p.releaseUrl ? p.releaseUrl : pageUrl(p)),
    };
  }

  // ── 4. We are newer than anything published ───────────────────────────────
  // One button. A developer running a local build ahead of the release does
  // not need a link to the release they are ahead of.
  if (p.localAhead === true) {
    return {
      ...base,
      kind: 'local-ahead',
      type: 'info',
      message: 'You’re ahead of the published version',
      detail: lat
        ? `This build is ${cur || 'unversioned'}. The newest published build is ${lat}. There is nothing to install.`
        : `This build is ${cur || 'unversioned'} — newer than anything published. There is nothing to install.`,
      buttons: ['OK'],
      action: null,
    };
  }

  // ── 5. An update is available ─────────────────────────────────────────────
  if (p.updateAvailable === true) {
    // The ONE string inequality in this file, and it decides a LABEL. The
    // verdict was already made, on the wire, above.
    const versionsDiffer = Boolean(lat && lat !== cur);

    if (style === 'download-installer') {
      const pre = p.prerelease === true
        ? ' It is published as a pre-release — the Mac app is still a preview build and is not yet signed by Apple.'
        : '';
      const headline = versionsDiffer && lat
        ? `The Curator ${lat} is available`
        : 'A newer build of The Curator is available';
      const inst = (installer && typeof installer === 'object') ? installer : {};

      // ── 5a. An update is ALREADY running, started somewhere else. ────────
      // Almost certainly Settings ▸ General in an open window. Said here
      // rather than discovered as a 409 after the user clicks Download: the
      // route WOULD refuse, correctly and with a good sentence, but "you
      // already have one going" is a better answer than a refusal to a
      // request that should not have been made.
      //
      // The state comes from the SERVER's job record — the one field that can
      // possibly know, since a download started in another surface is
      // invisible to this one.
      if (inst.attached === true && (inst.jobState === 'running' || inst.jobState === 'applying')) {
        const named = v(inst.jobVersion);
        return {
          ...base,
          kind: 'install-running',
          type: 'info',
          message: 'An update is already being installed',
          detail:
            `The Curator is downloading${named ? ` ${named}` : ' the update'} now. Its progress is on this menu, ` +
            'beside the app name, and on the General tab in Settings. The app restarts by itself when it is done.',
          buttons: ['OK'],
          action: null,
        };
      }

      // ── 5b. Already downloaded and verified. One step left. ──────────────
      // Offering "Download and Install" here would start a second 140 MB
      // transfer for a build that is already on this Mac, verified, sitting
      // beside the running app. `install-staged` skips to the swap.
      if (inst.attached === true && inst.jobState === 'staged') {
        const named = v(inst.jobVersion) || lat;
        return {
          ...base,
          kind: 'install-staged',
          type: 'info',
          message: named ? `${named} is downloaded and ready to install` : 'The update is downloaded and ready to install',
          detail:
            'The Curator has already downloaded this update and checked it arrived complete and unaltered. ' +
            'Nothing has been replaced yet. Installing takes a moment and restarts the app.',
          buttons: ['Later', 'Install Now'],
          action: { type: 'install-staged' },
          defaultId: ACTION_ID,
        };
      }

      // ── 5c. This app can install it itself. THE ORDINARY CASE. ───────────
      if (inst.attached === true) {
        return {
          ...base,
          kind: 'install',
          type: 'info',
          message: headline,
          detail: `${curPhrase}${pre}\n\n${INSTALL_EXPLAINER}`,
          buttons: ['Later', 'Download and Install'],
          action: { type: 'install' },
          // The default is the ACTION, exactly as it was when this button
          // opened a web page — the user asked "is there an update", the
          // answer is yes, and getting it is what they came for. What CHANGED
          // is that the action is now the update itself, so `INSTALL_EXPLAINER`
          // has to carry the consent: it says the app restarts, and it says
          // nothing is replaced until the check passes.
          defaultId: ACTION_ID,
        };
      }

      // ── 5d. No engine attached — the v3.31.0 behaviour, still correct. ───
      // Reached when the shell registered no update hooks, or when the probe
      // could not be made at all. The sentence below is the one this release
      // exists to stop showing when it is false; it is kept because it is
      // still exactly true here.
      return {
        ...base,
        kind: 'available',
        type: 'info',
        message: headline,
        detail: `${curPhrase}${pre}\n\n${MANUAL_INSTALL_EXPLAINER}`,
        buttons: ['Later', 'Download…'],
        // The RELEASE's own page, chosen by the route. Falls back to the
        // listing rather than to nothing.
        action: openUrl(typeof p.releaseUrl === 'string' && p.releaseUrl ? p.releaseUrl : pageUrl(p)),
        defaultId: ACTION_ID,
      };
    }

    // git-pull — a checkout, i.e. `npm start` or this shell run from source.
    // The shell deliberately does NOT offer to apply it: POST /api/config/update
    // rewrites the checkout with `git reset --hard` and reinstalls dependencies,
    // and settings.js puts that behind a typed confirm dialog explaining what it
    // replaces. Reproducing that gate in a native dialog would be a second
    // consent surface for the single most destructive button in the app.
    return {
      ...base,
      kind: 'available',
      type: 'info',
      message: 'An update is available',
      detail:
        (versionsDiffer && lat && cur ? `${cur} → ${lat}\n\n` : 'Newer commits are published on the release branch.\n\n') +
        'This is a source checkout, so the update is applied by the app itself — open Settings → General and use ' +
        'Install update, which explains exactly what it replaces before it does anything.',
      buttons: ['Later', 'Open Settings'],
      action: { type: 'open-settings' },
      defaultId: ACTION_ID,
    };
  }

  // ── 6. Up to date ─────────────────────────────────────────────────────────
  return {
    ...base,
    kind: 'current',
    type: 'info',
    message: 'You’re up to date',
    detail: cur
      ? `The Curator ${cur} is the newest version available.`
      : 'The Curator is on the newest version available.',
    buttons: ['OK'],
    action: null,
  };
}

/**
 * The dialog shown AFTER an install attempt that did not end in a restart.
 *
 * ── THERE IS NO SUCCESS DIALOG, AND THAT IS NOT AN OMISSION ────────────────
 *
 * A successful install ends with this process gone and a new one launched.
 * There is nobody left to show a dialog to, and a "success" box would have to
 * be shown by the NEW app, which would then be a modal in front of a user who
 * did not ask for one on every update. `runInstall` returning `{ok: true}` is
 * the shell's cue to show nothing.
 *
 * ── SO EVERY DIALOG THIS FUNCTION PRODUCES CAN SAY ONE TRUE THING ──────────
 *
 * Nothing was replaced. Not as a hopeful reassurance but as a tautology: this
 * dialog is being drawn by the running app, so the running app is still there.
 * `prepareUpdate` stages beside the installed bundle and replaces nothing, and
 * a failed `installUpdate` rolls back and reopens the old app — but neither
 * argument is needed, because the app is on screen saying it.
 *
 * ── AND THE SENTENCE IS THE SERVER'S ───────────────────────────────────────
 *
 * `outcome.error` is relayed verbatim: it is written by the engine's own
 * 36-entry `UPDATE_FAILURES` table or by the route's shared refusal shapes,
 * always by the side that knows what actually happened, and each one already
 * names the fix. `outcome.hint` too. This function chooses a HEADLINE, an
 * icon, and which button to offer — nothing else.
 *
 * `outcome.reason` is NEVER shown. A slug beside a sentence is an internal
 * identifier put in front of a person, which is the v3.31.0 defect the whole
 * in-app updater exists to undo.
 *
 * @param {object} outcome from `runInstall()` in lib/update-client.js
 */
export function describeInstallOutcome(outcome) {
  const o = (outcome && typeof outcome === 'object') ? outcome : {};
  const sentence = (typeof o.error === 'string' && o.error.trim())
    ? o.error.trim()
    // Reached only if the client handed back a failure with nothing to say,
    // which its own `failure()` helper makes impossible. Total anyway: a
    // dialog with an empty body is worse than a generic one.
    : 'The update was not installed.';
  const hint = (typeof o.hint === 'string' && o.hint.trim()) ? o.hint.trim() : '';
  const url = (typeof o.releasesPageUrl === 'string' && o.releasesPageUrl)
    ? o.releasesPageUrl
    : RELEASES_PAGE_FALLBACK;

  const base = { style: 'download-installer', defaultId: DISMISS_ID, cancelId: DISMISS_ID };

  // ── The bundle is downloaded and verified; only the SWAP was refused. ────
  // Overwhelmingly this is `writes-in-progress` — an ingest started during the
  // download, and the server refusing to restart on top of it, which is the
  // guard working rather than failing. Saying "the update failed" here would
  // be false: 140 MB of verified application is on disk and one click away.
  if (o.staged === true) {
    const named = v(o.version);
    return {
      ...base,
      kind: 'install-blocked',
      type: 'info',
      message: named ? `${named} is downloaded, but not installed yet` : 'The update is downloaded, but not installed yet',
      detail: `${sentence}${hint ? `\n\n${hint}` : ''}\n\nNothing has been replaced. This copy of The Curator is still running normally.`,
      buttons: ['Not Now', 'Install Now'],
      action: { type: 'install-staged' },
      // Dismiss, NOT the action. The commonest reason to be here is that the
      // app is mid-write; the honest default is to leave it alone rather than
      // to have Return fire a retry that will be refused again.
      defaultId: DISMISS_ID,
    };
  }

  return {
    ...base,
    kind: 'install-failed',
    type: 'error',
    message: 'The update was not installed',
    detail: `${sentence}${hint ? `\n\n${hint}` : ''}\n\nNothing has been replaced. This copy of The Curator is still running normally.`,
    buttons: ['OK', 'Open Releases Page'],
    // The way that has always worked, offered rather than left to be guessed
    // at. `desktop-host.js`'s no-fallback rule forbids quietly doing something
    // else; it does not forbid naming the thing that still works.
    action: openUrl(url),
  };
}
