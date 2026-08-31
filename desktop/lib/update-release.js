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
 * `RELEASES_API_URL`, `RELEASES_USER_AGENT` and `RELEASES_TIMEOUT_MS` are the
 * route's exported constants, used verbatim. The alternative — asking the
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

/**
 * @param {object} deps
 * @param {object} deps.configModule  the real `src/routes/config.js` namespace
 * @param {Function} deps.fetchImpl
 * @param {string} deps.currentVersion  this build's version
 * @param {string} deps.arch            'arm64' | 'x64'
 * @returns {Promise<object>} `{ok:true, …}` or a named `updateFailure`
 */
export async function resolveInstallerRelease(deps = {}) {
  const cfg = deps.configModule;
  if (!cfg || typeof cfg.pickInstallableRelease !== 'function' || typeof cfg.decideInstallerUpdate !== 'function') {
    // Not a user-facing state: it means the shell resolved a different module
    // than the server is running, which is the exact failure `desktop-host.js`
    // warns about for the hook registry. Named, never a raw TypeError.
    return updateFailure('unexpected-response', 'the update-check module did not expose its release helpers');
  }

  const doFetch = ('fetchImpl' in deps) ? deps.fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') return updateFailure('network-unreachable', 'no fetch implementation');

  const current = typeof deps.currentVersion === 'string' ? deps.currentVersion.trim() : '';
  if (!current) return updateFailure('local-version-unreadable', 'no current version supplied');

  let response;
  try {
    response = await doFetch(cfg.RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': cfg.RELEASES_USER_AGENT },
      // Same budget as the route. The caught error below is deliberately not
      // read, let alone surfaced — the route's own comment gives the reason and
      // it holds here for the same reason: nothing in it is actionable, and not
      // touching it is the strongest guarantee that nothing derived from the
      // request reaches a dialog.
      // `AbortSignal.any`, not an override. The first draft of this line wrote
      // the caller's signal OVER the timeout, which silently removed the 8 s
      // budget and left a cancellable-but-unbounded request — a hang with a
      // Cancel button rather than a bounded call. Both signals must be live:
      // the timeout bounds it, the caller's cancels it.
      signal: deps.signal ? AbortSignal.any([AbortSignal.timeout(cfg.RELEASES_TIMEOUT_MS), deps.signal])
        : AbortSignal.timeout(cfg.RELEASES_TIMEOUT_MS),
    });
  } catch {
    return updateFailure('network-unreachable');
  }
  if (!response || !response.ok) {
    return updateFailure('github-error', `status ${response ? response.status : 'none'}`);
  }

  let payload;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!Array.isArray(payload)) return updateFailure('unexpected-response', 'release list is not an array');

  // ── DELEGATED: which release. ──
  const release = cfg.pickInstallableRelease(payload);
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

  const picked = pickInstallerAsset(raw.assets, { arch: deps.arch });
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
