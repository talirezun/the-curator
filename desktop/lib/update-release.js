/**
 * update-release.js — "which release, and which file inside it?"
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  EVERY VERSION DECISION IN THIS FILE IS DELEGATED. NOT ONE OF THEM IS     ║
 * ║  MADE HERE. There is no comparator, no tag parser and no notion of        ║
 * ║  "newest" anywhere below — `src/routes/config.js` owns all three and its  ║
 * ║  own exported functions are CALLED, not copied.                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The route module is INJECTED rather than imported, and that is what keeps
 * this file executable by the offline suite while still being a real
 * delegation: `scripts/test-desktop-update.js` passes in the REAL
 * `src/routes/config.js`, so the suite proves the delegation against the
 * production picker, not against a stand-in for it. (Every other module in
 * `desktop/lib/` imports nothing from `src/`; this one keeps that property by
 * taking the module as an argument.)
 *
 * ── THE ONE THING THIS FILE ADDS, AND WHY THE ROUTE COULD NOT ───────────────
 *
 * `pickInstallableRelease()` returns a PROJECTION — version, tag, name, url,
 * prerelease, publishedAt — and deliberately drops `assets`, because the
 * update-check endpoint's job ends at "a newer version exists, here is its
 * page". A downloader needs the asset: its URL, its byte length and its
 * digest. So the raw release entry is looked up again, BY THE TAG THE ROUTE
 * ALREADY CHOSE, and only the assets are read off it. The choice of release is
 * not revisited, re-sorted or second-guessed.
 *
 * ── ONE NETWORK CALL, AND IT IS THE ROUTE'S OWN ─────────────────────────────
 *
 * The read is the route's own exported `fetchReleaseList` (v4.2.2; before it
 * was `RELEASES_API_URL`, `RELEASES_USER_AGENT` and `RELEASES_TIMEOUT_MS` used
 * verbatim here), so the URL, the headers, both budgets and the failure
 * classification have one owner. The alternative — asking the
 * app's own `/api/config/update-check` and then making a SECOND call to
 * `releases/tags/<tag>` for the assets — would be two round trips, a fourth
 * copy of the repository slug, and a window in which a release published
 * between the two calls makes the verdict describe one version and the
 * download fetch another.
 *
 * Unauthenticated, no user data in a header or a query string, exactly as the
 * route's own comment requires.
 */

import { pickInstallerAsset, updateFailure } from './update-plan.js';
import { localizeFailure } from './update-plan-win32.js';

/**
 * @param {object} deps
 * @param {object} deps.configModule  the real `src/routes/config.js` namespace
 * @param {Function} deps.fetchImpl
 * @param {string} deps.currentVersion  this build's version
 * @param {string} deps.arch            'arm64' | 'x64'
 * @param {string} [deps.platform]      the platform this app runs on; absent =
 *   `process.platform`. It is handed to `pickInstallableRelease` exactly as
 *   `installerUpdateCheck()` hands it, so Settings' check and this resolver
 *   name the SAME release on every platform (a Mac never gets an EXE-only
 *   release, Windows never a DMG-only one). On win32 the asset comes from the
 *   route's own `installerAssetsFor(raw, 'win32')`, the one definition of "a
 *   Windows installer"; on every other platform the Mac path below is
 *   unchanged.
 * @returns {Promise<object>} `{ok:true, …}` or a named `updateFailure`
 */
export async function resolveInstallerRelease(deps = {}) {
  const cfg = deps.configModule;
  if (!cfg || typeof cfg.pickInstallableRelease !== 'function' || typeof cfg.decideInstallerUpdate !== 'function'
      || typeof cfg.fetchReleaseList !== 'function') {
    // Not a user-facing state: it means the shell resolved a different module
    // than the server is running, which is the exact failure `desktop-host.js`
    // warns about for the hook registry. Named, never a raw TypeError.
    return updateFailure('unexpected-response', 'the update-check module did not expose its release helpers');
  }

  const doFetch = ('fetchImpl' in deps) ? deps.fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') return updateFailure('network-unreachable', 'no fetch implementation');

  const current = typeof deps.currentVersion === 'string' ? deps.currentVersion.trim() : '';
  if (!current) return updateFailure('local-version-unreadable', 'no current version supplied');

  // ── DELEGATED: the read itself (v4.2.2). ──
  // `cfg.fetchReleaseList` is the route's own read: the same URL, headers and
  // two budgets (answer, then body), and the same classification, so Settings'
  // check and this resolver can never call one failure two different things.
  // The caller's signal (Cancel) is passed through and aborts either phase;
  // the budgets still bound it (the v3.x lesson recorded here before: a
  // caller's signal must never REPLACE the timeout). `deps.releaseTimeouts`
  // is the test seam ({ headersMs, bodyMs }).
  const read = await cfg.fetchReleaseList(doFetch, {
    ...(deps.releaseTimeouts || {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (!read.ok) {
    if (read.kind === 'http') {
      const r = read.response;
      return updateFailure('github-error', `status ${r ? r.status : 'none'}`);
    }
    // A body that did not arrive in full is a NETWORK failure ("try again"),
    // never 'unexpected-response': before v4.2.2 a body cut off by the 8 s
    // budget was reported as "not in the expected form".
    if (read.kind === 'body') return updateFailure('network-unreachable', 'the release list did not arrive in full');
    if (read.kind === 'shape') return updateFailure('unexpected-response', 'release list is not an array');
    return updateFailure('network-unreachable');
  }
  const payload = read.payload;

  // ── DELEGATED: which release. ──
  // The platform travels with the question, as it does in the route's own
  // `installerUpdateCheck()`. For darwin (and anything not win32) the picker's
  // answer is byte-identical to the no-argument call this line used to make —
  // pinned by scripts/test-update-installer.js §3b.
  const platform = typeof deps.platform === 'string' && deps.platform ? deps.platform : process.platform;
  const release = cfg.pickInstallableRelease(payload, { platform });
  if (!release) return updateFailure('no-installable-release');

  // ── DELEGATED: is it newer than us. ──
  const verdict = cfg.decideInstallerUpdate({ current, latest: release.version });
  if (!verdict.comparable) return updateFailure('not-comparable', `${current} vs ${release.version}`);
  if (verdict.localAhead) return updateFailure('local-ahead', `${current} > ${release.version}`);
  if (!verdict.updateAvailable) return updateFailure('no-update', `${current} == ${release.version}`);

  // ── NOT delegated, because the route has no reason to know it: the assets. ──
  // Re-associated by the tag the picker returned, never by list position — a
  // re-published or back-dated release moves list position and the route's own
  // picker exists precisely because that order is not a contract.
  const raw = payload.find((r) => r && typeof r === 'object' && String(r.tag_name) === release.tagName);
  if (!raw) return updateFailure('unexpected-response', 'the chosen release vanished from its own payload');

  let picked;
  if (platform === 'win32') {
    // The route's own definition of "a Windows installer", never a second
    // extension list here. Then the same whole-token arch rule, https-only
    // host check, size and digest parsing the Mac path uses.
    if (typeof cfg.installerAssetsFor !== 'function') {
      return updateFailure('unexpected-response', 'the update-check module did not expose installerAssetsFor');
    }
    picked = localizeFailure(
      pickInstallerAsset(cfg.installerAssetsFor(raw, 'win32'), { arch: deps.arch, ext: '.exe' }), 'win32');
  } else {
    picked = pickInstallerAsset(raw.assets, { arch: deps.arch });
  }
  if (!picked.ok) return picked;

  return {
    ok: true,
    current,
    version: release.version,
    tagName: release.tagName,
    releaseName: release.name,
    releaseUrl: release.url,
    prerelease: release.prerelease,
    publishedAt: release.publishedAt,
    asset: picked.asset,
  };
}
