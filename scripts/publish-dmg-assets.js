#!/usr/bin/env node
/**
 * publish-dmg-assets.js — give electron-builder's two `.dmg` files the names
 * the in-app updater can actually match, and REFUSE if they do not.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * electron-builder's default mac artifact name is
 * `${productName}-${version}-${arch}.${ext}`, and it OMITS the arch segment
 * for x64. So a real build of 3.37.0 produces:
 *
 *     The Curator-3.37.0-arm64.dmg      ← arm64
 *     The Curator-3.37.0.dmg            ← x86_64, with NO arch in the name
 *
 * The consumer is `archFromAssetName()` in `desktop/lib/update-plan.js`, which
 * lowercases the name, requires `.dmg`, splits the stem on `-` ONLY, and looks
 * for a whole token `arm64` or `x64`. Run against those two raw names it
 * returns `arm64` and **null**. `pickInstallerAsset()` then filters the release
 * assets by `archFromAssetName(name) !== arch`, so a release published with the
 * raw names offers NOTHING to an Intel Mac — and the failure is silent: the
 * updater reports `no-asset-for-arch` rather than anything a user reads as
 * "the release is mis-named".
 *
 * Publishing therefore has to rename, and renaming by hand at upload time is
 * exactly how v3.30.0 shipped DMGs whose filename said 3.30.0 and whose
 * Info.plist said 0.0.0. This module is that rename, written down.
 *
 * ── THE NAMING RULE IS NOT COPIED, IT IS CHECKED AGAINST THE CONSUMER ─────
 * The published names are composed here, but nothing here re-implements the
 * matcher. `planPublish()` imports the REAL `archFromAssetName` and refuses a
 * plan whose output names do not resolve to the architecture they claim. So a
 * change to the matcher — a stricter separator, a different token — cannot
 * silently leave this producing names it no longer accepts: the build fails.
 * That is also why this file lives in `scripts/` rather than duplicating a
 * regex into the workflow's YAML, where nothing could execute it.
 *
 * ── AND THE FILENAME IS ONLY A CLAIM ──────────────────────────────────────
 * Nothing in this module opens a disk image. A `.dmg` named `x64-Intel` that
 * contains an arm64 binary would pass every check here. Proving the CONTENTS
 * match the name needs `hdiutil` + `lipo`, i.e. a macOS runner, and that check
 * lives in `.github/workflows/desktop-dmg.yml` immediately after this script.
 * The two are deliberately separate: this half is pure and runs in `npm test`,
 * that half cannot.
 *
 * ── CLI ───────────────────────────────────────────────────────────────────
 *     node scripts/publish-dmg-assets.js --dir desktop/dist --version 3.37.0
 *     node scripts/publish-dmg-assets.js --dir desktop/dist --version 3.37.0 --dry-run
 *
 * Exit 0 only when both files exist, were renamed (or already carried the
 * published name), and the names ON DISK afterwards resolve to one `arm64` and
 * one `x64`. Anything else is exit 1 with a named reason.
 *
 * When `GITHUB_OUTPUT` is set the final paths are written to it as `arm64=`
 * and `x64=`, so later workflow steps address the files by name rather than by
 * globbing — a glob would put ordering, and therefore which file gets which
 * architecture assertion, back into the shell.
 *
 * Zero dependencies — node: builtins only, and one import from desktop/lib/
 * which is itself Electron-free and `src/`-free.
 */

import { existsSync, readdirSync, renameSync, appendFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { archFromAssetName } from '../desktop/lib/update-plan.js';

/**
 * The published basename. NO SPACE — `productName` is "The Curator", but a
 * space in a release asset name is percent-encoded in the download URL and
 * makes every shell line that touches it need quoting. The updater does not
 * care what the prefix is; it only reads the `-` separated tokens.
 */
export const PUBLISHED_PREFIX = 'TheCurator';

/**
 * The arch segment of a published name: the machine token the updater matches
 * on, followed by the word a human recognises on the Releases page. Both halves
 * are load-bearing in different directions — `arm64` / `x64` is what
 * `archFromAssetName` tokenises, `AppleSilicon` / `Intel` is what someone
 * choosing a download reads.
 */
export const ARCH_LABEL = Object.freeze({
  arm64: 'arm64-AppleSilicon',
  x64: 'x64-Intel',
});

/** Both architectures are always published. A release missing one is refused. */
export const PUBLISHED_ARCHES = Object.freeze(['arm64', 'x64']);

/** `lipo -archs` spells x64 differently from everyone else. */
export const LIPO_ARCH = Object.freeze({ arm64: 'arm64', x64: 'x86_64' });

/** Refusal ids, so a failure names itself rather than describing itself. */
export const PUBLISH_REFUSALS = Object.freeze([
  'bad-version',
  'no-such-dir',
  'unrecognised-dmg',
  'missing-arch',
  'duplicate-arch',
  'name-does-not-resolve',
  'rename-collision',
]);

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * The published name for one architecture, or null if the inputs cannot make
 * one. Composition only — the check that it RESOLVES lives in `planPublish`.
 */
export function publishedNameFor(version, arch) {
  if (typeof version !== 'string' || !SEMVER.test(version)) return null;
  const label = ARCH_LABEL[arch];
  if (!label) return null;
  return `${PUBLISHED_PREFIX}-${version}-${label}.dmg`;
}

/**
 * Which architecture is this file electron-builder just wrote?
 *
 * Anchored on the VERSION rather than on the product name, because the product
 * name is a config value that may legitimately change and the version is the
 * one thing the workflow already knows for certain (it came from the tag).
 *
 * The third arm is the whole reason this function exists: a stem ending in the
 * bare version, with no arch segment at all, IS the x64 build. That is
 * electron-builder's documented default and it is what makes the raw name
 * unmatchable by the updater.
 *
 * Returns null for anything else — including an already-published name, which
 * `planPublish` recognises separately so a re-run is not mistaken for a
 * corrupted build directory.
 */
export function classifyBuiltName(name, version) {
  if (typeof name !== 'string' || typeof version !== 'string') return null;
  if (!name.toLowerCase().endsWith('.dmg')) return null;
  const stem = name.slice(0, -4);
  if (stem.endsWith(`-${version}-arm64`)) return 'arm64';
  if (stem.endsWith(`-${version}-x64`)) return 'x64';
  if (stem.endsWith(`-${version}`)) return 'x64';
  return null;
}

/**
 * Turn a directory listing into the rename plan, or a named refusal.
 *
 * `from === to` is legal and means "already published" — a workflow re-run
 * over a directory this script has already processed must be a no-op rather
 * than a failure.
 *
 * The last loop is the verification the whole design turns on: every `to` is
 * fed through the REAL `archFromAssetName` and must come back as the arch the
 * plan assigned it. A plan that would publish a name the updater cannot match
 * is refused here, before any file moves.
 */
export function planPublish(names, version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    return { ok: false, reason: 'bad-version', detail: `not a semver: ${JSON.stringify(version)}` };
  }

  const dmgs = (Array.isArray(names) ? names : []).filter(
    (n) => typeof n === 'string' && n.toLowerCase().endsWith('.dmg'),
  );

  const byArch = new Map();
  for (const name of dmgs) {
    let arch = classifyBuiltName(name, version);
    if (!arch) {
      // Already carrying its published name? Then it is not an unknown file.
      for (const a of PUBLISHED_ARCHES) if (name === publishedNameFor(version, a)) arch = a;
    }
    if (!arch) {
      return {
        ok: false,
        reason: 'unrecognised-dmg',
        detail: `${name} is not a ${version} build this script knows how to publish. ` +
                'electron-builder\'s artifact naming changed, or a stale .dmg is in the output directory.',
      };
    }
    if (byArch.has(arch)) {
      return { ok: false, reason: 'duplicate-arch', detail: `two ${arch} builds: ${byArch.get(arch)} and ${name}` };
    }
    byArch.set(arch, name);
  }

  const missing = PUBLISHED_ARCHES.filter((a) => !byArch.has(a));
  if (missing.length) {
    return {
      ok: false,
      reason: 'missing-arch',
      detail: `no ${missing.join(' and no ')} build among [${dmgs.join(', ') || '(no .dmg files)'}]`,
    };
  }

  const plan = [];
  for (const arch of PUBLISHED_ARCHES) {
    const from = byArch.get(arch);
    const to = publishedNameFor(version, arch);
    if (from !== to && byArch.has(to)) {
      return { ok: false, reason: 'rename-collision', detail: `${from} -> ${to}, but ${to} already exists` };
    }
    plan.push({ arch, from, to, alreadyPublished: from === to });
  }

  // ── THE CHECK THIS FILE EXISTS FOR ───────────────────────────────────────
  // Run the app's OWN matcher over the names about to be published. Not a
  // transcribed regex: the imported function, so the producer cannot drift
  // from the consumer without the build going red.
  for (const step of plan) {
    const resolved = archFromAssetName(step.to);
    if (resolved !== step.arch) {
      return {
        ok: false,
        reason: 'name-does-not-resolve',
        detail: `archFromAssetName(${JSON.stringify(step.to)}) === ${JSON.stringify(resolved)}, expected ${JSON.stringify(step.arch)}`,
      };
    }
  }

  return { ok: true, plan };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CLI
// ─────────────────────────────────────────────────────────────────────────────

export function parsePublishArgs(argv) {
  const out = { dir: null, version: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') { out.dryRun = true; continue; }
    if (a === '--dir') { out.dir = argv[++i] ?? null; continue; }
    if (a.startsWith('--dir=')) { out.dir = a.slice(6); continue; }
    if (a === '--version') { out.version = argv[++i] ?? null; continue; }
    if (a.startsWith('--version=')) { out.version = a.slice(10); continue; }
    return { ...out, error: `unrecognised argument: ${a}` };
  }
  if (!out.dir) return { ...out, error: 'missing --dir' };
  if (!out.version) return { ...out, error: 'missing --version' };
  return out;
}

/**
 * Plan, rename, then RE-READ the directory and verify what is actually there.
 *
 * The re-read is not belt-and-braces. The plan is a statement about a listing
 * taken before anything moved; the second `planPublish` is a statement about
 * the files that exist now, and it is the one a later step depends on. A rename
 * that silently did not happen — a case-insensitive filesystem collapsing two
 * names, a partial failure — is caught by the second pass and by nothing else.
 */
export function publishNames({ dir, version, dryRun = false, log = console.log }) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, reason: 'no-such-dir', detail: dir };
  }
  const before = readdirSync(dir);
  const planned = planPublish(before, version);
  if (!planned.ok) return planned;

  for (const step of planned.plan) {
    if (step.alreadyPublished) { log(`  = ${step.from} (already published name)`); continue; }
    log(`  ${step.from}  ->  ${step.to}`);
    if (!dryRun) renameSync(path.join(dir, step.from), path.join(dir, step.to));
  }
  if (dryRun) return { ok: true, plan: planned.plan, dryRun: true, files: {} };

  const after = planPublish(readdirSync(dir), version);
  if (!after.ok) return after;
  for (const step of after.plan) {
    if (step.from !== step.to) {
      return { ok: false, reason: 'name-does-not-resolve', detail: `after renaming, ${step.from} is still not ${step.to}` };
    }
  }
  const files = {};
  for (const step of after.plan) files[step.arch] = path.join(dir, step.to);
  return { ok: true, plan: after.plan, dryRun: false, files };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const args = parsePublishArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`✗ ${args.error}`);
    console.error('  usage: node scripts/publish-dmg-assets.js --dir <dir> --version <x.y.z> [--dry-run]');
    process.exit(1);
  }
  console.log(`Publishing names for ${args.version} in ${args.dir}:`);
  const r = publishNames(args);
  if (!r.ok) {
    console.error('');
    console.error(`✗ ${r.reason}: ${r.detail}`);
    console.error('  Nothing was published. See scripts/publish-dmg-assets.js for what each refusal means.');
    process.exit(1);
  }
  for (const arch of PUBLISHED_ARCHES) {
    const name = publishedNameFor(args.version, arch);
    console.log(`  ✓ ${name} — archFromAssetName() resolves it to ${archFromAssetName(name)}`);
  }
  if (!r.dryRun && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `arm64=${r.files.arm64}\nx64=${r.files.x64}\n`);
  }
  process.exit(0);
}
