/**
 * app-version.js — ONE source of truth for the version this app reports.
 *
 * ── The defect this exists to close ─────────────────────────────────────────
 *
 * The first packaged build shipped an About panel reading `0.0.0 (0.0.0)`.
 * That was not a display bug. `/Applications/The Curator.app/Contents/
 * Info.plist` genuinely carried CFBundleShortVersionString=0.0.0 and
 * CFBundleVersion=0.0.0, because electron-builder derives both from the app
 * manifest's `version` (macPackager `applyCommonInfo`:
 *   CFBundleShortVersionString = bundleShortVersion || appInfo.version
 *   CFBundleVersion            = bundleVersion      || appInfo.buildVersion
 * and buildVersion falls back to version), and `desktop/package.json` is
 * pinned at 0.0.0.
 *
 * ── The claim that was WRONG, corrected here rather than repeated ───────────
 *
 * v3.30.0's changelog row says desktop/package.json is pinned "so the DMG
 * version can only come from the git tag". Half of that is true and the half
 * that matters was false:
 *
 *   TRUE   `.github/workflows/desktop-dmg.yml` really does pass
 *          `--config.extraMetadata.version="${GITHUB_REF_NAME#v}"`. The CI
 *          path was never broken.
 *   FALSE  "can only". `npm run dist` was
 *          `electron-builder --mac --config electron-builder.yml` with no
 *          version flag at all, and that is the command that produced the
 *          DMGs which were then RENAMED BY HAND at upload time. Nothing
 *          refused, warned, or even noticed.
 *
 * So the hole was never the CI job. It was every other way of invoking the
 * build, and the pin turned a missing value into a plausible-looking one.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * The ROOT `package.json` version is the only source of truth. `desktop/
 * package.json` stays at UNSET_VERSION forever — it is a SENTINEL, not a
 * number to maintain. Two manifests that must agree is exactly how this broke,
 * so the second one is never allowed to be right.
 *
 * The value reaches the artifact by `--config.extraMetadata.version`, built by
 * `lib/dist.js` from the root manifest, and the result is CHECKED against the
 * real Info.plist on disk by `lib/verify-version.mjs`, which electron-builder
 * runs as an `afterPack` hook on every build that uses `electron-builder.yml`.
 * A mismatch throws and the build dies before a DMG exists.
 *
 * ── Electron-free and src-free, on purpose ──────────────────────────────────
 *
 * Like the other `lib/` modules, this imports nothing from Electron and
 * nothing from `src/`, so `scripts/test-desktop-version-identity.js` can
 * EXECUTE it rather than grep it.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The version `desktop/package.json` is pinned at, and the value that must
 * never reach a shipped Info.plist.
 *
 * It is deliberately a real, parseable semver rather than a string like
 * "UNSET": npm needs to read this manifest (`npm ci` against
 * desktop/package-lock.json, which records 0.0.0), and electron-builder
 * requires a version before `extraMetadata` is merged.
 */
export const UNSET_VERSION = '0.0.0';

/** The electron-builder CLI flag that overrides the app manifest's version. */
export const VERSION_FLAG = '--config.extraMetadata.version';

/** Argv token `lib/dist.js` accepts to print its command instead of running it. */
export const PRINT_ARGS_FLAG = '--print-args';

/**
 * Read `version` out of a package manifest.
 *
 * Returns null for every failure — missing file, unreadable, unparseable, no
 * `version`, or a `version` that is not a non-empty string. Callers must treat
 * null as "refuse", never as "use a default": the whole defect being fixed is
 * a default that looked like an answer.
 */
export function readManifestVersion(manifestPath) {
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const v = parsed && parsed.version;
  return (typeof v === 'string' && v.trim().length > 0) ? v.trim() : null;
}

/**
 * The repository root, given the `desktop/` directory.
 *
 * One line, and it is here rather than inlined so that both the dist wrapper
 * and the build hook derive it identically. They must, or they would be
 * checking two different manifests.
 */
export function repoRootFrom(desktopDir) {
  return path.resolve(desktopDir, '..');
}

/**
 * Build the electron-builder argv for a release build.
 *
 * `passthrough` is appended AFTER the injected flag so a caller can still add
 * `--x64`, `--dir`, and so on. It is appended rather than prepended on
 * purpose: electron-builder's own arg parser takes the LAST occurrence of a
 * repeated `--config.*`, so a caller who deliberately passes their own
 * `--config.extraMetadata.version` wins here — and then loses at the hook,
 * loudly, which is the right order. Silently ignoring their flag would be
 * worse than refusing it.
 */
export function distArgv(version, passthrough = []) {
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error('distArgv: version must be a non-empty string');
  }
  if (version === UNSET_VERSION) {
    throw new Error(
      `distArgv: refusing to build with the sentinel version ${UNSET_VERSION}. ` +
      'The root package.json is the source of truth and it does not hold that value.'
    );
  }
  return [
    '--mac',
    '--config', 'electron-builder.yml',
    `${VERSION_FLAG}=${version}`,
    ...passthrough,
  ];
}

/**
 * Pull the two version keys out of an XML property list.
 *
 * electron-builder writes Info.plist as XML (it serialises through the `plist`
 * package), so this covers every plist this project produces. It returns null
 * for a key it cannot find rather than guessing, and the hook treats a null as
 * a refusal — a plist we cannot read is not a plist we may ship.
 *
 * Deliberately NOT implemented with `plutil`: the offline suite runs on
 * ubuntu-latest in CI, where that binary does not exist. The hook keeps a
 * `plutil` fallback for the binary-plist case; this pure parser is the path
 * that is actually exercised, on both operating systems.
 */
export function parseInfoPlistVersions(xml) {
  if (typeof xml !== 'string') return { short: null, bundle: null };
  const pick = (key) => {
    // <key>K</key> then the next <string>…</string>. Whitespace and newlines
    // between them are what plist serialisers actually emit.
    const re = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`);
    const m = xml.match(re);
    return m ? m[1] : null;
  };
  return {
    short: pick('CFBundleShortVersionString'),
    bundle: pick('CFBundleVersion'),
  };
}

/**
 * Decide whether a built bundle's versions are acceptable.
 *
 * Returns `{ok, problems[]}` rather than throwing, so the hook owns the throw
 * and the suite can inspect every individual refusal. Three distinct failures,
 * kept distinct because they mean different things to whoever reads the build
 * log:
 *
 *   unreadable  the plist gave us nothing — fail closed, never assume
 *   sentinel    0.0.0 reached the artifact — the exact shipped defect
 *   mismatch    a version reached the artifact that is not the root manifest's
 *
 * CFBundleVersion is checked as well as CFBundleShortVersionString because the
 * About panel shows BOTH — "0.0.0 (0.0.0)" was two wrong numbers, not one.
 */
export function checkBundleVersions({ expected, short, bundle }) {
  const problems = [];
  if (typeof expected !== 'string' || expected.length === 0) {
    problems.push('no expected version was supplied (the root package.json could not be read)');
    return { ok: false, problems };
  }
  if (expected === UNSET_VERSION) {
    problems.push(`the root package.json reports the sentinel version ${UNSET_VERSION}`);
  }
  for (const [label, actual] of [['CFBundleShortVersionString', short], ['CFBundleVersion', bundle]]) {
    if (typeof actual !== 'string' || actual.length === 0) {
      problems.push(`${label} could not be read from the built Info.plist`);
    } else if (actual === UNSET_VERSION) {
      problems.push(
        `${label} is ${UNSET_VERSION} — the desktop manifest's sentinel reached the artifact, ` +
        `which means no version was injected. Build with \`npm run dist\` (or pass ` +
        `${VERSION_FLAG}=${expected}).`
      );
    } else if (actual !== expected) {
      problems.push(`${label} is ${actual} but the root package.json says ${expected}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * How the version is written for a human.
 *
 * The sentinel is labelled rather than hidden. If a build ever slips past the
 * hook, the About panel says so in the one place a user is already looking,
 * instead of quietly presenting 0.0.0 as a release number — which is precisely
 * what happened.
 */
export function formatVersionLabel(version) {
  if (typeof version !== 'string' || version.length === 0) return 'unknown';
  return version === UNSET_VERSION ? `${UNSET_VERSION} (not injected)` : version;
}

/**
 * The options object for Electron's `app.setAboutPanelOptions()`.
 *
 * Kept pure so the suite can assert its content without Electron. The caller
 * supplies every value; nothing here is invented or inferred.
 *
 * WHAT IS DELIBERATELY ABSENT, because each would be a second copy of a fact
 * that already lives somewhere authoritative:
 *
 *   applicationName  comes from the bundle (electron-builder.yml `productName`
 *                    → CFBundleName). Setting it here would be a second name
 *                    to keep in sync — the same class of defect as the second
 *                    version field.
 *   copyright        comes from NSHumanReadableCopyright, which
 *                    electron-builder writes from its `copyright` key.
 *   version          the panel's parenthesised BUILD field, which macOS fills
 *                    from CFBundleVersion. Left to the bundle so the panel
 *                    shows what was actually built, not what we hoped.
 *
 * `systemVersion` is optional and, when present, must be Electron's
 * `process.getSystemVersion()` — the macOS marketing version (e.g. "15.6").
 * When it is absent the line falls back to `process.platform` +
 * `os.release()`, which on a Mac is the DARWIN KERNEL version (e.g. "24.6.0")
 * and is labelled `darwin`, not `macOS`. Calling 24.6.0 "macOS" would be a
 * fabricated field, and this panel exists because the last one had none worth
 * reading.
 */
export function aboutPanelOptions({ version, versions = {}, platform, osRelease, arch, systemVersion } = {}) {
  const lines = [];
  const chunk = (label, value) => (value ? `${label} ${value}` : null);

  const runtime = [
    chunk('Electron', versions.electron),
    chunk('Chromium', versions.chrome),
  ].filter(Boolean).join('   ·   ');
  if (runtime) lines.push(runtime);

  const engine = [
    chunk('Node', versions.node),
    chunk('V8', versions.v8),
  ].filter(Boolean).join('   ·   ');
  if (engine) lines.push(engine);

  const osLine = systemVersion
    ? `macOS ${systemVersion}${arch ? ` (${arch})` : ''}`
    : (platform ? `${platform}${osRelease ? ` ${osRelease}` : ''}${arch ? ` (${arch})` : ''}` : null);
  if (osLine) lines.push(osLine);

  return {
    applicationVersion: formatVersionLabel(version),
    credits: lines.join('\n'),
  };
}

/**
 * Install the About panel on an Electron `app`.
 *
 * This lives here rather than in main.js so it can be EXECUTED by the suite
 * against a stub `app` — `main.js` cannot be imported offline, and a suite that
 * could only grep it for the string `setAboutPanelOptions` would go green on a
 * call that was commented out, misspelled, or handed the wrong object. Only the
 * one-line call site stays in main.js, and the suite says so.
 *
 * ── Why the version comes from `<appRoot>/package.json` ────────────────────
 *
 * Same file as `app.getVersion()` in the packaged app, a DIFFERENT file in dev,
 * and the difference is the point:
 *
 *   packaged  appRoot is Contents/Resources/app, whose package.json IS the
 *             desktop manifest with `extraMetadata.version` merged in — the
 *             injected release version. (Measured: a build injected 3.30.0 and
 *             that manifest read 3.30.0.)
 *   dev       appRoot is the repo root, so this reads the ROOT manifest, the
 *             actual source of truth. `app.getVersion()` would return the
 *             0.0.0 sentinel from desktop/package.json — the exact number this
 *             whole change exists to stop showing anyone.
 *
 * `app.getVersion()` remains the fallback for the case where the manifest
 * cannot be read at all, because an Electron-supplied number beats none.
 *
 * `overrides` exists only so the suite can pin platform-dependent inputs; every
 * default is the real value from this process.
 */
export function applyAboutPanel(electronApp, appRoot, overrides = {}) {
  const fromManifest = readManifestVersion(path.join(appRoot, 'package.json'));
  const version = fromManifest
    || (typeof electronApp.getVersion === 'function' ? electronApp.getVersion() : null);

  const platform = overrides.platform ?? process.platform;
  const opts = aboutPanelOptions({
    version,
    versions: overrides.versions ?? process.versions,
    platform,
    osRelease: overrides.osRelease ?? os.release(),
    arch: overrides.arch ?? process.arch,
    // Electron-only, and the reason the OS line may honestly say "macOS": it
    // returns the marketing version ("15.6"). os.release() is the DARWIN
    // KERNEL version ("24.6.0"), which the fallback labels `darwin` — calling
    // that number macOS would be an invented field, and this panel exists
    // because the last one had no real ones.
    systemVersion: overrides.systemVersion
      ?? ((platform === 'darwin' && typeof process.getSystemVersion === 'function')
        ? process.getSystemVersion() : undefined),
  });

  electronApp.setAboutPanelOptions(opts);
  return opts;
}
