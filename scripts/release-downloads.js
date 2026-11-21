#!/usr/bin/env node
/**
 * release-downloads.js — the parts of a GitHub Release a PERSON uses: three
 * download links that never change, and a release body that starts with them.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 * Owner, 2026-11-21: the Releases page was unusable. A release carries the
 * three installers plus ~30 GPL source files for the bundled MinGit; GitHub
 * lists assets alphabetically (the sources first), hides most of them behind
 * "Show all", and the body said only "Full Changelog". The docs could not
 * link to an installer because its name carries the version.
 *
 * So every real release ALSO carries three stable-name COPIES:
 *
 *     TheCurator-Windows-Setup.exe      = TheCurator-X.Y.Z-x64-Windows-Setup.exe
 *     TheCurator-Mac-AppleSilicon.dmg   = TheCurator-X.Y.Z-arm64-AppleSilicon.dmg
 *     TheCurator-Mac-Intel.dmg          = TheCurator-X.Y.Z-x64-Intel.dmg
 *
 * and GitHub serves `/releases/latest/download/<name>` for the newest release,
 * so the docs and the website can link to them forever.
 *
 * ── THE COPIES MUST BE INVISIBLE TO THE IN-APP UPDATER ────────────────────
 * The updater picks its download with `archFromAssetName()` (whole hyphen
 * tokens `arm64` / `x64`). The stable names carry NO arch token, so it reads
 * them as null and never picks them: it keeps downloading the versioned file,
 * exactly as before. That is not assumed here: `stage` runs the REAL matcher
 * (and the real `pickInstallerAsset`) over each stable name and REFUSES if
 * the updater would pick it, so a later change to the matcher cannot quietly
 * start installing a copy; the build goes red instead.
 *
 * ── MODES ─────────────────────────────────────────────────────────────────
 *   stage  --version X.Y.Z --out <dir> --file <key>=<versioned path> [...]
 *          Copies each versioned installer to <dir>/<stable name>, then
 *          re-reads both and refuses unless size and SHA-256 are identical.
 *          Writes `<key with _>=<copy path>` to $GITHUB_OUTPUT
 *          (darwin_arm64=, darwin_x64=, win32_x64=).
 *   check  --release-json <file> --version X.Y.Z --file <key>=<versioned path> [...]
 *          `gh release view --json assets` against the local files: the
 *          versioned file AND its stable copy must both be on the release, by
 *          exact name, with the local file's size (and SHA-256 where GitHub
 *          records a digest). A missing or wrong-size one exits 1.
 *   body   --version X.Y.Z --out <file> [--release-json <file>] [--asset <name> ...] [--tags <file>]
 *          Writes the release body: "## Download" first (one plain line per
 *          installer on the release), the GPL source note, the changelog link.
 *          Which installers it lists comes from the release's own assets
 *          (--release-json) and/or the names about to be uploaded (--asset).
 *          --tags is `git ls-remote --tags` output, used to find the previous
 *          release for the changelog link (absent or unreadable: the tag's
 *          commit history instead).
 *
 * Exit 0 only when every check passed; otherwise exit 1 with a named reason
 * (2 for bad arguments). Zero dependencies: node: builtins and imports from
 * desktop/lib/ and scripts/ that are Electron-free and src/-free.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { archFromAssetName, pickInstallerAsset } from '../desktop/lib/update-plan.js';
import { installerFileName } from '../desktop/lib/win-pack.mjs';
import { publishedNameFor } from './publish-dmg-assets.js';
import { checkReleaseAssets } from './publish-win-assets.js';

/** The public repository. Cross-checked against config.js RELEASES_PAGE_URL by the suite. */
export const REPO = 'talirezun/the-curator';
export const REPO_URL = `https://github.com/${REPO}`;

/**
 * One entry per installer. `key` is the platform-arch the workflow passes;
 * `ext` is what the updater's matcher is asked with; `versioned(v)` is the
 * name the updater DOES pick (the existing publish scripts' own definitions).
 */
export const INSTALLERS = Object.freeze([
  Object.freeze({
    key: 'win32-x64', ext: '.exe', arch: 'x64', stable: 'TheCurator-Windows-Setup.exe',
    versioned: (v) => installerFileName(v),
  }),
  Object.freeze({
    key: 'darwin-arm64', ext: '.dmg', arch: 'arm64', stable: 'TheCurator-Mac-AppleSilicon.dmg',
    versioned: (v) => publishedNameFor(v, 'arm64'),
  }),
  Object.freeze({
    key: 'darwin-x64', ext: '.dmg', arch: 'x64', stable: 'TheCurator-Mac-Intel.dmg',
    versioned: (v) => publishedNameFor(v, 'x64'),
  }),
]);

export const STABLE_NAMES = Object.freeze(INSTALLERS.map((i) => i.stable));

export const DOWNLOAD_REFUSALS = Object.freeze([
  'bad-version', 'unknown-key', 'missing-file', 'not-the-versioned-file', 'stable-name-matched-by-updater',
  'copy-differs', 'release-unreadable', 'missing-on-release', 'wrong-size-on-release', 'wrong-digest-on-release',
]);

const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/;

export function installerFor(key) {
  return INSTALLERS.find((i) => i.key === key) || null;
}

/** The link that always serves the newest release's copy. */
export function stableDownloadUrl(name) {
  return `${REPO_URL}/releases/latest/download/${name}`;
}

const sha256File = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

/**
 * Pure. Would the in-app updater ever pick this stable name? Asked of the
 * REAL matcher for every arch on every installer extension, and of the real
 * `pickInstallerAsset` with the copy listed FIRST (it takes the first match).
 * Returns null when it is ignored everywhere, else a description.
 */
export function updaterWouldPick(name) {
  for (const ext of ['.dmg', '.exe']) {
    const arch = archFromAssetName(name, { ext });
    if (arch !== null) return `archFromAssetName(${JSON.stringify(name)}, {ext:'${ext}'}) = ${arch}`;
    for (const a of ['arm64', 'x64']) {
      const asset = { name, browser_download_url: `${REPO_URL}/releases/download/v0.0.0/${name}`, size: 1 };
      const r = pickInstallerAsset([asset], { arch: a, ext });
      if (r && r.ok) return `pickInstallerAsset picks ${name} for ${a} ${ext}`;
    }
  }
  return null;
}

/** Parse repeated `--file key=path`. */
export function parseFilePairs(list) {
  const out = [];
  for (const s of list) {
    const i = typeof s === 'string' ? s.indexOf('=') : -1;
    if (i <= 0) return { error: `--file wants <key>=<path>, got ${JSON.stringify(s)}` };
    out.push({ key: s.slice(0, i), file: s.slice(i + 1) });
  }
  return { pairs: out };
}

function resolvePairs(pairs, version, installers = INSTALLERS) {
  if (typeof version !== 'string' || !PLAIN_SEMVER.test(version)) {
    return { ok: false, reason: 'bad-version', detail: `"${version}" is not a bare X.Y.Z version` };
  }
  const out = [];
  for (const p of pairs) {
    const inst = installers.find((i) => i.key === p.key);
    if (!inst) return { ok: false, reason: 'unknown-key', detail: `${p.key} (known: ${installers.map((i) => i.key).join(', ')})` };
    if (!p.file || !existsSync(p.file) || !statSync(p.file).isFile()) return { ok: false, reason: 'missing-file', detail: String(p.file) };
    const expect = inst.versioned(version);
    if (path.basename(p.file) !== expect) {
      return { ok: false, reason: 'not-the-versioned-file', detail: `${p.key}: ${path.basename(p.file)} is not ${expect}` };
    }
    out.push({ inst, file: p.file });
  }
  return { ok: true, items: out };
}

/**
 * Copy each versioned installer to its stable name in `out`, and prove the
 * copy is the same file. Never throws. `installers` and `copyFile` are seams
 * for the suite (a name the updater WOULD pick; a copy that comes out short).
 */
export function stageStableCopies({ pairs, version, out, installers = INSTALLERS, copyFile = copyFileSync }) {
  try {
    const r = resolvePairs(pairs, version, installers);
    if (!r.ok) return r;
    for (const { inst } of r.items) {
      const why = updaterWouldPick(inst.stable);
      if (why) return { ok: false, reason: 'stable-name-matched-by-updater', detail: `${why}: the in-app updater could install the copy` };
    }
    mkdirSync(out, { recursive: true });
    const copies = [];
    for (const { inst, file } of r.items) {
      const dest = path.join(out, inst.stable);
      if (path.resolve(dest) === path.resolve(file)) return { ok: false, reason: 'copy-differs', detail: `${dest} is the source itself` };
      copyFile(file, dest);
      const a = { size: statSync(file).size, sha: sha256File(file) };
      const b = { size: statSync(dest).size, sha: sha256File(dest) };
      if (a.size !== b.size || a.sha !== b.sha) {
        return { ok: false, reason: 'copy-differs', detail: `${inst.stable}: ${b.size} bytes ${b.sha}, expected ${a.size} bytes ${a.sha}` };
      }
      copies.push({ key: inst.key, versioned: file, stable: dest, size: a.size, sha256: a.sha });
    }
    return { ok: true, copies };
  } catch (err) {
    return { ok: false, reason: 'copy-differs', detail: String(err && err.message) };
  }
}

/**
 * What must be on the release for these files: each versioned installer AND
 * its stable copy, both with the local file's size and SHA-256.
 */
export function expectedWithCopies({ pairs, version }) {
  const r = resolvePairs(pairs, version);
  if (!r.ok) return r;
  const expected = [];
  for (const { inst, file } of r.items) {
    const size = statSync(file).size;
    const sha256 = sha256File(file);
    expected.push({ name: inst.versioned(version), size, sha256 });
    expected.push({ name: inst.stable, size, sha256 });
  }
  return { ok: true, expected };
}

/** The check mode. Never throws. */
export function checkReleaseCopies({ release, pairs, version }) {
  try {
    const exp = expectedWithCopies({ pairs, version });
    if (!exp.ok) return exp;
    return checkReleaseAssets(release, exp.expected);
  } catch (err) {
    return { ok: false, reason: 'release-unreadable', detail: String(err && err.message) };
  }
}

/**
 * Pure. The newest plain `vX.Y.Z` tag older than `version`, from
 * `git ls-remote --tags` text (rehearsal tags like v3.99.3-wintest.4 never
 * count). null when there is none.
 */
export function previousReleaseTag(lsRemote, version) {
  if (typeof lsRemote !== 'string' || !PLAIN_SEMVER.test(String(version))) return null;
  const parse = (v) => v.split('.').map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const cur = parse(version);
  let best = null;
  for (const line of lsRemote.split(/\r?\n/)) {
    const m = /\trefs\/tags\/v(\d+\.\d+\.\d+)(?:\^\{\})?$/.exec(line);
    if (!m) continue;
    const v = parse(m[1]);
    if (cmp(v, cur) >= 0) continue;
    if (!best || cmp(v, best) > 0) best = v;
  }
  return best ? `v${best.join('.')}` : null;
}

const LINE = Object.freeze({
  'win32-x64': {
    label: 'Windows 10/11',
    how: 'Run it. If "Windows protected your PC" appears, click More info, then Run anyway.',
  },
  'darwin-arm64': {
    label: 'Mac with Apple Silicon (M1 and later)',
    how: 'Open it and drag The Curator onto Applications. The first time macOS blocks it: open System Settings → Privacy & Security, click Open Anyway, then open the app again.',
  },
  'darwin-x64': {
    label: 'Mac with Intel',
    how: 'Open it and drag The Curator onto Applications. The first time macOS blocks it: open System Settings → Privacy & Security, click Open Anyway, then open the app again.',
  },
});

/**
 * Pure. The release body. `assets` is the list of names on (or about to be
 * on) the release; an installer is listed only when BOTH its versioned file
 * and its stable copy are among them, so the body never links a file this
 * release does not carry.
 */
export function releaseBody({ version, assets = [], previousTag = null }) {
  if (typeof version !== 'string' || !PLAIN_SEMVER.test(version)) throw new Error(`not a bare X.Y.Z version: ${version}`);
  const names = new Set(assets.filter((n) => typeof n === 'string'));
  const tag = `v${version}`;
  const lines = ['## Download', ''];
  const listed = [];
  for (const inst of INSTALLERS) {
    const versioned = inst.versioned(version);
    if (!names.has(versioned) || !names.has(inst.stable)) continue;
    listed.push(inst.key);
    const l = LINE[inst.key];
    lines.push(`- **${l.label}:** [${inst.stable}](${stableDownloadUrl(inst.stable)}) (this release: \`${versioned}\`). ${l.how}`);
  }
  if (!listed.length) lines.push('No installer is attached to this release yet.');
  lines.push('');
  if (listed.includes('win32-x64')) {
    lines.push('All other files attached here are the source code of the git program bundled in the Windows app, published as its licence (GPL) requires.');
    lines.push('');
  }
  const changelog = previousTag
    ? `${REPO_URL}/compare/${previousTag}...${tag}`
    : `${REPO_URL}/commits/${tag}`;
  lines.push(`**Changelog:** ${changelog}`);
  return lines.join('\n') + '\n';
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function parseDownloadArgs(argv) {
  const [mode, ...rest] = argv;
  const o = { mode, version: null, out: null, releaseJson: null, tags: null, files: [], assets: [] };
  if (!['stage', 'check', 'body'].includes(mode)) return { error: 'the first argument is stage, check or body' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const v = rest[i + 1];
    if (a === '--version') { o.version = v; i++; }
    else if (a === '--out') { o.out = v; i++; }
    else if (a === '--release-json') { o.releaseJson = v; i++; }
    else if (a === '--tags') { o.tags = v; i++; }
    else if (a === '--file') { o.files.push(v); i++; }
    else if (a === '--asset') { o.assets.push(v); i++; }
    else return { error: `unrecognised argument ${a}` };
  }
  if (!o.version) return { error: '--version is required' };
  if (mode === 'stage' && (!o.out || !o.files.length || o.releaseJson || o.assets.length || o.tags)) return { error: 'stage takes --version, --out and --file' };
  if (mode === 'check' && (!o.releaseJson || !o.files.length || o.out || o.assets.length || o.tags)) return { error: 'check takes --release-json, --version and --file' };
  if (mode === 'body' && (!o.out || o.files.length || (!o.releaseJson && !o.assets.length))) return { error: 'body takes --version, --out, and --release-json and/or --asset (and optionally --tags)' };
  const fp = parseFilePairs(o.files);
  if (fp.error) return { error: fp.error };
  o.pairs = fp.pairs;
  return o;
}

function readJson(file) {
  try { return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }; } catch (err) {
    return { ok: false, reason: 'release-unreadable', detail: String(err && err.message) };
  }
}

/** Runs one mode. Never throws; returns {ok, ...} or a named refusal. */
export function runDownloads(args, { writeOutput = () => {} } = {}) {
  if (args.mode === 'stage') {
    const r = stageStableCopies({ pairs: args.pairs, version: args.version, out: args.out });
    if (r.ok) for (const c of r.copies) writeOutput(c.key.replace(/-/g, '_'), c.stable);
    return r;
  }
  if (args.mode === 'check') {
    const j = readJson(args.releaseJson);
    if (!j.ok) return j;
    return checkReleaseCopies({ release: j.value, pairs: args.pairs, version: args.version });
  }
  // body
  const names = [...args.assets];
  if (args.releaseJson) {
    const j = readJson(args.releaseJson);
    if (!j.ok) return j;
    const assets = j.value && Array.isArray(j.value.assets) ? j.value.assets : null;
    if (!assets) return { ok: false, reason: 'release-unreadable', detail: 'no assets array' };
    for (const a of assets) if (a && typeof a.name === 'string' && (!a.state || a.state === 'uploaded')) names.push(a.name);
  }
  let tagsText = null;
  if (args.tags) { try { tagsText = readFileSync(args.tags, 'utf8'); } catch { tagsText = null; } }
  let body;
  try { body = releaseBody({ version: args.version, assets: names, previousTag: previousReleaseTag(tagsText, args.version) }); } catch (err) {
    return { ok: false, reason: 'bad-version', detail: String(err && err.message) };
  }
  writeFileSync(args.out, body);
  return { ok: true, body };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const args = parseDownloadArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`release-downloads: ${args.error}`);
    process.exit(2);
  }
  const r = runDownloads(args, {
    writeOutput: (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); },
  });
  if (!r.ok) {
    console.error(`release-downloads: REFUSED (${r.reason}) ${r.detail || ''}`);
    process.exit(1);
  }
  if (args.mode === 'stage') for (const c of r.copies) console.log(`  ${path.basename(c.stable)} = ${path.basename(c.versioned)} (${c.size} bytes, sha256 ${c.sha256}); the in-app updater ignores it`);
  if (args.mode === 'check') console.log(`  the release carries all ${r.checked} files (versioned + stable copies), by exact name and size`);
  if (args.mode === 'body') process.stdout.write(r.body);
  console.log('release-downloads: ok');
}
