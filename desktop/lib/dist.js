#!/usr/bin/env node
/**
 * dist.js — the `npm run dist` entry point.
 *
 * It exists for one reason: the previous `dist` script was
 *
 *     electron-builder --mac --config electron-builder.yml
 *
 * with no version anywhere in it, and that is the command that produced the
 * DMGs whose Info.plist said 0.0.0 and which were then renamed by hand to
 * `TheCurator-3.30.0-…dmg` at upload time. Nothing in that loop could notice.
 *
 * This wrapper reads the ROOT `package.json` — the field `scripts/release.js`
 * already moves in lockstep with `package-lock.json` and `CLAUDE.md` — and
 * passes it through as `--config.extraMetadata.version`. There is no second
 * number to maintain and no flag to remember.
 *
 * A hand-typed `npx electron-builder` still bypasses this file. That is why
 * the refusal lives in `lib/verify-version.mjs`, which electron-builder itself
 * runs, rather than here.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readManifestVersion, repoRootFrom, distArgv, UNSET_VERSION, PRINT_ARGS_FLAG,
} from './app-version.js';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = repoRootFrom(DESKTOP_DIR);

function die(message) {
  console.error(`\n  dist: ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const printOnly = argv.includes(PRINT_ARGS_FLAG);
const passthrough = argv.filter((a) => a !== PRINT_ARGS_FLAG);

const version = readManifestVersion(path.join(REPO_ROOT, 'package.json'));
if (!version) {
  die(`could not read a version from ${path.join(REPO_ROOT, 'package.json')}. ` +
      'That file is the only source of truth for this app\'s version.');
}
if (version === UNSET_VERSION) {
  die(`the root package.json reports ${UNSET_VERSION}. That is the sentinel ` +
      'desktop/package.json carries, not a release version. Refusing to build.');
}

let args;
try {
  args = distArgv(version, passthrough);
} catch (err) {
  die(err.message);
}

// A test seam, and deliberately a boring one: it prints the exact argv that
// WOULD be executed and exits 0 without spawning anything. That is what lets
// scripts/test-desktop-version-identity.js assert the real command this script
// builds from the real root manifest, rather than asserting that a string
// appears in a file.
if (printOnly) {
  console.log(JSON.stringify({ version, args }));
  process.exit(0);
}

const bin = path.join(DESKTOP_DIR, 'node_modules', '.bin', 'electron-builder');
if (!existsSync(bin)) {
  die('electron-builder is not installed. Run `npm install` inside desktop/ first — ' +
      'the Electron toolchain deliberately lives only in this folder, never in the ' +
      'root manifest that every user\'s auto-updater runs `npm install` against.');
}

console.log(`  building The Curator ${version} (from ${path.join(REPO_ROOT, 'package.json')})`);
const r = spawnSync(bin, args, { cwd: DESKTOP_DIR, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
