/**
 * describeUpdate() — turn an `/api/config/update-check` payload into the ONE
 * dialog the "Check for Updates…" menu item shows.
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
 * ── WHAT IS DUPLICATED FROM Settings → General, AND WHAT IS NOT ─────────────
 *
 * NOT duplicated: which release is newest, whether it is newer than us,
 * whether the versions are comparable, whether anything is published, the
 * release URL, and every failure sentence — all of those arrive on the wire.
 *
 * Duplicated: four short headline sentences ("You're up to date", and so on).
 * That is a real cost and it is bounded to four strings that describe states
 * the server named. It is accepted rather than hidden, and desktop/README.md
 * says where the other copy lives.
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
 * @returns {{
 *   kind: string, style: string, type: string,
 *   message: string, detail: string,
 *   buttons: string[], defaultId: number, cancelId: number,
 *   action: null | {type:'open-url', url:string} | {type:'open-settings'}
 * }}
 *
 * SIX kinds, and no two of them share wording:
 *
 *   error            we could not find out — the server's own sentence
 *   available        a newer build exists — here is how to get it
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
export function describeUpdate(payload) {
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
      return {
        ...base,
        kind: 'available',
        type: 'info',
        message: versionsDiffer && lat ? `The Curator ${lat} is available` : 'A newer build of The Curator is available',
        detail:
          `${curPhrase}${pre}\n\n` +
          'This build does not install updates by itself. Download opens the release page in your browser; ' +
          'you then replace The Curator in your Applications folder. Your knowledge base, API keys and sync ' +
          'settings live outside the app and are untouched.',
        buttons: ['Later', 'Download…'],
        // The RELEASE's own page, chosen by the route. Falls back to the
        // listing rather than to nothing.
        action: openUrl(typeof p.releaseUrl === 'string' && p.releaseUrl ? p.releaseUrl : pageUrl(p)),
        // The only dialog here whose default is the ACTION: the user asked
        // "is there an update", the answer is yes, and getting it is what
        // they came for. Nothing about it is destructive — it opens a page.
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
