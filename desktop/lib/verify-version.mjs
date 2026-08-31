/**
 * verify-version.mjs — electron-builder `afterPack` hook.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * `lib/dist.js` makes the version CORRECT. This makes a wrong one IMPOSSIBLE
 * TO SHIP, which is a different and stronger job, because `npm run dist` is
 * only one of the ways this build gets invoked. It runs for
 *
 *   · `npm run dist`
 *   · `.github/workflows/desktop-dmg.yml` (tag → --config.extraMetadata.version)
 *   · a hand-typed `npx electron-builder --mac --config electron-builder.yml`
 *   · `npx electron-builder --mac` with no --config at all (electron-builder
 *     auto-discovers electron-builder.yml in the working directory)
 *
 * and it reads the ARTIFACT, not the intent: the real `Info.plist` inside the
 * `.app` that was just packed. It is the difference between "we passed a flag"
 * and "the file on disk says the right thing".
 *
 * ── Why afterPack, and why a throw here is enough ───────────────────────────
 *
 * Verified by reading the installed electron-builder 26.15.3, not recalled:
 *
 *   · `macPackager.applyCommonInfo` writes CFBundleShortVersionString and
 *     CFBundleVersion during `doPack`, and `platformPackager.pack` emits
 *     `afterPack` AFTER `doPack` returns. So the plist exists by the time we
 *     read it.
 *   · `AsyncEventEmitter.emit` awaits each handler with NO try/catch, so a
 *     rejection propagates out of the pack and aborts the build.
 *   · DMG targets are finalised after packing, so the refusal lands BEFORE any
 *     .dmg is written. The .app on disk is left in place and is wrong; the
 *     build exits non-zero and says why.
 *
 * ── The limit, stated rather than implied ───────────────────────────────────
 *
 * This cannot stop someone who does not use this config: a different config
 * file, or `--config.afterPack=null`, bypasses it, and so does packaging the
 * `.app` by hand. Those are deliberate acts, not accidents. What it does close
 * is every path where the version is simply FORGOTTEN — which is the one that
 * actually shipped.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readManifestVersion,
  repoRootFrom,
  parseInfoPlistVersions,
  checkBundleVersions,
  VERSION_FLAG,
} from './app-version.js';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read the two version keys out of a bundle's Info.plist.
 *
 * XML first, because that is what electron-builder writes. `plutil` only as a
 * fallback for a binary plist, and its absence (it is macOS-only) is not an
 * error here — it just leaves the values null, and null is a refusal.
 * Exported so the suite can drive it against a real file on disk.
 */
export function readPlistVersions(plistPath) {
  let xml = null;
  try {
    xml = readFileSync(plistPath, 'utf8');
  } catch (err) {
    return { short: null, bundle: null, error: `could not read ${plistPath}: ${err.message}` };
  }
  const parsed = parseInfoPlistVersions(xml);
  if (parsed.short && parsed.bundle) return parsed;

  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const field = key === 'CFBundleShortVersionString' ? 'short' : 'bundle';
    if (parsed[field]) continue;
    try {
      parsed[field] = execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plistPath],
        { encoding: 'utf8' }).trim() || null;
    } catch {
      // plutil is absent (Linux) or the key genuinely is not there. Either way
      // the value stays null and checkBundleVersions refuses.
    }
  }
  return parsed;
}

/** Locate the single `.app` electron-builder just wrote into `appOutDir`. */
export function findAppBundle(appOutDir) {
  let entries;
  try {
    entries = readdirSync(appOutDir);
  } catch (err) {
    throw new Error(`afterPack: cannot read appOutDir ${appOutDir}: ${err.message}`);
  }
  const apps = entries.filter((e) => e.endsWith('.app'));
  if (apps.length !== 1) {
    throw new Error(
      `afterPack: expected exactly one .app in ${appOutDir}, found ${apps.length} ` +
      `(${apps.join(', ') || 'none'}). Refusing rather than guessing which one to check.`
    );
  }
  return path.join(appOutDir, apps[0]);
}

/**
 * The check itself, separated from the hook signature so the suite can drive
 * it against a fabricated bundle without inventing an electron-builder
 * context. Throws on refusal; returns the accepted version on success.
 */
export function verifyPackedVersion({ appOutDir, repoRoot = repoRootFrom(DESKTOP_DIR) }) {
  const expected = readManifestVersion(path.join(repoRoot, 'package.json'));
  const appPath = findAppBundle(appOutDir);
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const { short, bundle } = readPlistVersions(plistPath);
  const { ok, problems } = checkBundleVersions({ expected, short, bundle });

  if (!ok) {
    throw new Error(
      'BUILD REFUSED — the packaged app\'s version does not match the root package.json.\n\n' +
      problems.map((p) => `  · ${p}`).join('\n') + '\n\n' +
      `  root package.json : ${expected ?? '(unreadable)'}\n` +
      `  Info.plist        : ${plistPath}\n` +
      `                      CFBundleShortVersionString=${short ?? '(unreadable)'} ` +
      `CFBundleVersion=${bundle ?? '(unreadable)'}\n\n` +
      '  The root package.json is the only source of truth for this app\'s version.\n' +
      '  desktop/package.json is pinned at a sentinel on purpose and is never the answer.\n' +
      `  Build with \`npm run dist\`, which injects ${VERSION_FLAG} from the root manifest.\n`
    );
  }
  return expected;
}

/** electron-builder calls this. Named export, so its hook resolver finds it. */
export async function afterPack(context) {
  const version = verifyPackedVersion({ appOutDir: context.appOutDir });
  // stdout is fine here: this is a build tool, not the MCP server.
  console.log(`  • version identity  version=${version} (matches the root package.json)`);
}

export default afterPack;
