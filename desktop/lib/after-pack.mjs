/**
 * after-pack.mjs — the ONE `afterPack` hook electron-builder runs.
 *
 * electron-builder takes a single `afterPack`, so this composes the two
 * artifact-level refusals. Both read the bundle that was just written; neither
 * takes anything on trust from the config text:
 *
 *   1. lib/verify-version.mjs   the Info.plist must carry the ROOT
 *                              package.json's version, not the 0.0.0 sentinel.
 *   2. lib/adhoc-sign.mjs       the bundle must leave here with a VALID ad-hoc
 *                              signature — and with no real certificate on it.
 *
 * Order is deliberate: the version check is cheap and reads only one file, so a
 * version mistake fails in milliseconds rather than after signing 5,500 files.
 * Signing runs second and re-seals everything, including the Info.plist the
 * first step just read.
 *
 * WHERE THIS SITS IN THE BUILD, verified against electron-builder 26.15.3's
 * source rather than recalled:
 *
 *   doPack -> applyCommonInfo (writes Info.plist)
 *          -> emitAfterPack   ← WE ARE HERE
 *          -> doAddElectronFuses  (returns immediately: no `electronFuses` in
 *                                  our config — and adhoc-sign.mjs REFUSES the
 *                                  build if that ever stops being true, because
 *                                  flipping fuses after us would invalidate the
 *                                  signature)
 *          -> doSignAfterPack     (identity: null -> handleNullIdentity(),
 *                                  no keychain call, no modification)
 *   then the dmg target packages the .app we just signed.
 *
 * `AsyncEventEmitter.emit` awaits user hooks with NO try/catch, so a throw here
 * aborts the build before any .dmg exists.
 *
 * ── WINDOWS (2026-11-20) ─────────────────────────────────────────────────────
 *
 * A `--win` build arrives here with `context.electronPlatformName === 'win32'`
 * and goes to lib/win-pack.mjs instead: there is no .app, no Info.plist and no
 * codesign on Windows, and the two steps above would throw on every Windows
 * build. That branch checks the packed version, the bundled git and the tray
 * icons, and writes the bundle marker resources\app\.curator-bundle (without
 * it the installed app would keep the user's wiki inside the program folder).
 * ONLY the exact value 'win32' takes it: anything else, including a context
 * with no platform at all, runs the Mac body below, unchanged.
 */

import { verifyPackedVersion, findAppBundle } from './verify-version.mjs';
import { adhocSign } from './adhoc-sign.mjs';
import { winAfterPack } from './win-pack.mjs';

export async function afterPack(context) {
  if (context && context.electronPlatformName === 'win32') {
    winAfterPack({
      appOutDir: context.appOutDir,
      config: (context.packager && context.packager.config) || {},
      winOptions: (context.packager && context.packager.platformSpecificBuildOptions) || {},
    });
    return;
  }

  const version = verifyPackedVersion({ appOutDir: context.appOutDir });
  console.log(`  • version identity  version=${version} (matches the root package.json)`);

  const opts = context.packager.platformSpecificBuildOptions || {};
  const result = adhocSign({
    appPath: findAppBundle(context.appOutDir),
    // `identity` is read off the RESOLVED build options, not off the yml text,
    // so a `--config.mac.identity=…` on the command line is seen too.
    identity: Object.prototype.hasOwnProperty.call(opts, 'identity') ? opts.identity : undefined,
    env: process.env,
    electronFuses: (context.packager.config || {}).electronFuses ?? null,
  });

  if (result.signed) {
    console.log(`  • ad-hoc signature  valid, sealed resources, no TeamIdentifier (${result.info.flags.join(',')})`);
  } else {
    console.log(`  • ad-hoc signature  SKIPPED — ${result.reason}`);
  }
}

export default afterPack;
