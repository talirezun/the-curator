#!/usr/bin/env node
/**
 * publish-win-assets.js — the Windows twin of publish-dmg-assets.js: prove the
 * files a Windows release publishes are the ones the in-app updater can use,
 * and REFUSE otherwise. Two modes.
 *
 * ── 1. THE SETUP PROGRAM (`--dir desktop/dist --version X.Y.Z`) ────────────
 * electron-builder.yml's `nsis.artifactName` already writes the published
 * name, `TheCurator-X.Y.Z-x64-Windows-Setup.exe` (desktop/lib/win-pack.mjs
 * `installerFileName`, the one definition, pinned against that file by
 * scripts/test-desktop-win-build.js). So there is nothing to rename; what this
 * mode adds is the CHECK, against the consumers, before anything is published:
 *
 *   · exactly that one setup program is in the folder (a stale setup of
 *     another version, or any other .exe, is refused rather than guessed at)
 *   · no `.blockmap` and no `latest*.yml`: nothing reads them (the app updates
 *     itself without electron-updater) and publishing them would advertise an
 *     update feed this project does not run
 *   · the REAL `archFromAssetName(name, {ext: '.exe'})` resolves it to x64
 *     (what desktop/lib/update-release.js picks the download with)
 *   · the REAL `installerAssetsFor()` from src/routes/config.js counts it as a
 *     Windows installer and NOT as a Mac one (what pickInstallableRelease and
 *     Settings' update check use), when `--check-consumers` is given; the
 *     workflow passes it on the Windows runner, which has the root
 *     node_modules config.js imports
 *
 *   It writes `setup=<path>` to $GITHUB_OUTPUT so later steps never glob.
 *
 * ── 2. THE GPLv2 SOURCE (`--source --out <dir>`) ───────────────────────────
 * The Windows app ships MinGit (GPL-2.0). Section 3 of the GPL is met by
 * attaching the corresponding source to the same release (owner's decision,
 * 2026-11-20). desktop/lib/fetch-mingit.mjs `MINGIT_SOURCE` names it, derived
 * from the pinned tag, and the app's THIRD-PARTY-NOTICES.txt prints that same
 * name. This mode downloads GitHub's archive of that tag, checks it IS that
 * tag's tree (gzip, a tar whose every entry sits under `git-<tag>/`, with git's
 * own `GIT-VERSION-GEN` and `COPYING`), checks a notices file names it
 * (`--notices <file>`, the one the build shipped), and writes `source=<path>`.
 *
 * ── CLI ───────────────────────────────────────────────────────────────────
 *     node scripts/publish-win-assets.js --dir desktop/dist --version 3.100.0 [--check-consumers]
 *     node scripts/publish-win-assets.js --source --out <dir> [--notices <file>]
 *
 * Exit 0 only when every check passed; anything else is exit 1 with a named
 * reason. Zero dependencies (node: builtins, and imports from desktop/lib/,
 * which are Electron-free and src/-free).
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, statSync, renameSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { archFromAssetName } from '../desktop/lib/update-plan.js';
import { installerFileName } from '../desktop/lib/win-pack.mjs';
import { MINGIT, MINGIT_SOURCE, mingitSourceFor } from '../desktop/lib/fetch-mingit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/** The one architecture of the first Windows release (owner D6). */
export const WIN_ARCH = 'x64';

/** Named refusals, so a red run says which rule failed. */
export const WIN_PUBLISH_REFUSALS = Object.freeze([
  'bad-version', 'no-such-dir', 'missing-setup', 'unrecognised-exe', 'blockmap-present',
  'update-feed-present', 'name-does-not-resolve', 'not-a-windows-installer', 'counted-as-mac-installer',
]);

const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Pure. The names in electron-builder's output folder → {ok, setup} or a named
 * refusal. `installerAssetsFor` is the route's function when the caller has
 * it (the workflow does); without it only the desktop-side matcher is used.
 */
export function planWinPublish(names, version, { installerAssetsFor = null } = {}) {
  if (typeof version !== 'string' || !PLAIN_SEMVER.test(version)) {
    return { ok: false, reason: 'bad-version', detail: `"${version}" is not a bare X.Y.Z version (the workflow strips the v)` };
  }
  const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string') : [];
  const setup = installerFileName(version);
  const blockmaps = list.filter((n) => /\.blockmap$/i.test(n));
  if (blockmaps.length) return { ok: false, reason: 'blockmap-present', detail: blockmaps.join(', ') };
  const feeds = list.filter((n) => /^latest.*\.ya?ml$/i.test(n) || /^app-update\.ya?ml$/i.test(n));
  if (feeds.length) return { ok: false, reason: 'update-feed-present', detail: feeds.join(', ') };
  const exes = list.filter((n) => /\.exe$/i.test(n));
  const strays = exes.filter((n) => n !== setup);
  if (strays.length) return { ok: false, reason: 'unrecognised-exe', detail: `${strays.join(', ')} (expected only ${setup})` };
  if (!exes.includes(setup)) return { ok: false, reason: 'missing-setup', detail: `${setup} is not in the folder` };

  // The consumers, not a transcribed rule.
  const arch = archFromAssetName(setup, { ext: '.exe' });
  if (arch !== WIN_ARCH) {
    return { ok: false, reason: 'name-does-not-resolve', detail: `archFromAssetName("${setup}", {ext:'.exe'}) = ${arch}` };
  }
  if (typeof installerAssetsFor === 'function') {
    const rel = { assets: [{ name: setup }] };
    if (installerAssetsFor(rel, 'win32').length !== 1) {
      return { ok: false, reason: 'not-a-windows-installer', detail: `installerAssetsFor(…, 'win32') does not count ${setup}` };
    }
    if (installerAssetsFor(rel, 'darwin').length !== 0) {
      return { ok: false, reason: 'counted-as-mac-installer', detail: `installerAssetsFor(…, 'darwin') counts ${setup}` };
    }
  }
  return { ok: true, setup, arch };
}

/** The setup mode, against a real folder. Never throws. */
export async function publishWinSetup({ dir, version, checkConsumers = false, log = console.log }) {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, reason: 'no-such-dir', detail: String(dir) };
  }
  let installerAssetsFor = null;
  if (checkConsumers) {
    const cfg = await import(pathToFileURL(path.join(ROOT, 'src', 'routes', 'config.js')).href);
    installerAssetsFor = cfg.installerAssetsFor;
  }
  // Re-read from disk: the names that exist, not the ones expected.
  const plan = planWinPublish(readdirSync(dir), version, { installerAssetsFor });
  if (!plan.ok) return plan;
  const full = path.join(dir, plan.setup);
  log(`  ${plan.setup}: the app's own matcher resolves it to ${plan.arch}` +
    (installerAssetsFor ? '; config.js counts it as a Windows installer and not a Mac one' : ''));
  return { ok: true, setup: full, bytes: statSync(full).size };
}

// ── The GPLv2 source archive ────────────────────────────────────────────────

/** Read a tar's entry names (ustar + pax), stopping at the end marker. Pure. */
export function tarEntryNames(buf) {
  const names = [];
  let off = 0;
  let paxPath = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (o, n) => h.subarray(o, o + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`bad tar header at ${off}`);
    const type = field(156, 1) || '0';
    const magic = field(257, 6);
    const prefix = magic.startsWith('ustar') ? field(345, 155) : '';
    let name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const body = buf.subarray(off + 512, off + 512 + size);
    if (body.length < size) throw new Error('the archive is truncated');
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;                       // pax global header (GitHub puts the commit there)
    if (type === 'x') {                               // pax header for the NEXT entry
      const m = body.toString('utf8').match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      paxPath = m ? m[1] : null;
      continue;
    }
    if (paxPath) { name = paxPath; paxPath = null; }
    names.push(name);
  }
  return names;
}

/** The pax global header's `comment=` (GitHub writes the commit id there), or null. */
export function tarCommitComment(buf) {
  if (buf.length < 1024) return null;
  const h = buf.subarray(0, 512);
  if (h.subarray(156, 157).toString() !== 'g') return null;
  const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
  const m = buf.subarray(512, 512 + size).toString('utf8').match(/comment=([0-9a-f]{40})/);
  return m ? m[1] : null;
}

/**
 * Pure. Is this gzip'd tar GitHub's archive of the pinned git-for-windows tag?
 * {ok, entries, commit} or {ok:false, reason, detail}.
 */
export function verifySourceArchive(gz, source = MINGIT_SOURCE) {
  if (!Buffer.isBuffer(gz) || gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) {
    return { ok: false, reason: 'not-gzip', detail: 'the file is not gzip data' };
  }
  let tar;
  try { tar = gunzipSync(gz, { maxOutputLength: 1024 * 1024 * 1024 }); } catch (err) {
    return { ok: false, reason: 'not-gzip', detail: err.message };
  }
  let names;
  try { names = tarEntryNames(tar); } catch (err) { return { ok: false, reason: 'not-a-tar', detail: err.message }; }
  if (names.length < 100) return { ok: false, reason: 'too-few-entries', detail: `${names.length} entries` };
  const prefix = `${source.topDir}/`;
  const outside = names.filter((n) => !(n === source.topDir || n === prefix || n.startsWith(prefix)));
  if (outside.length) return { ok: false, reason: 'wrong-tree', detail: `${outside.length} entries outside ${prefix}, e.g. ${outside[0]}` };
  for (const must of ['GIT-VERSION-GEN', 'COPYING']) {
    if (!names.includes(prefix + must)) return { ok: false, reason: 'not-git-source', detail: `no ${prefix}${must}` };
  }
  return { ok: true, entries: names.length, commit: tarCommitComment(tar) };
}

/** Does a notices text name the source file (and the MinGit tag it is for)? Pure. */
export function noticesNameSource(text, source = MINGIT_SOURCE, pin = MINGIT) {
  const t = typeof text === 'string' ? text : '';
  return t.includes(source.asset) && t.includes(pin.tag);
}

/** The source mode. Downloads, verifies, renames into place. Never throws. */
export async function fetchSourceArchive({ out, notices = null, fetchImpl = globalThis.fetch, source = MINGIT_SOURCE, log = console.log }) {
  if (notices) {
    let text = '';
    try { text = readFileSync(notices, 'utf8'); } catch (err) { return { ok: false, reason: 'notices-unreadable', detail: err.message }; }
    if (!noticesNameSource(text, source)) {
      return { ok: false, reason: 'notices-do-not-name-source', detail: `${notices} does not name ${source.asset}` };
    }
    log(`  ${path.basename(notices)} names ${source.asset}`);
  }
  mkdirSync(out, { recursive: true });
  const dest = path.join(out, source.asset);
  const partial = `${dest}.partial`;
  try {
    const res = await fetchImpl(source.url, { headers: { 'User-Agent': 'the-curator-release-ci' } });
    if (!res || !res.ok || !res.body) return { ok: false, reason: 'download-failed', detail: `status ${res ? res.status : 'none'}` };
    await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
  } catch (err) {
    rmSync(partial, { force: true });
    return { ok: false, reason: 'download-failed', detail: err.message };
  }
  const v = verifySourceArchive(readFileSync(partial), source);
  if (!v.ok) { rmSync(partial, { force: true }); return v; }
  renameSync(partial, dest);
  log(`  ${source.asset}: ${statSync(dest).size} bytes, ${v.entries} entries under ${source.topDir}/` +
    (v.commit ? `, commit ${v.commit}` : ''));
  return { ok: true, source: dest, commit: v.commit };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function parseWinPublishArgs(argv) {
  const o = { dir: null, version: null, checkConsumers: false, source: false, out: null, notices: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dir = argv[++i];
    else if (a === '--version') o.version = argv[++i];
    else if (a === '--check-consumers') o.checkConsumers = true;
    else if (a === '--source') o.source = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--notices') o.notices = argv[++i];
    else return { error: `unrecognised argument ${a}` };
  }
  if (o.source) {
    if (!o.out) return { error: '--source needs --out <dir>' };
    if (o.dir || o.version || o.checkConsumers) return { error: '--source takes only --out and --notices' };
  } else {
    if (!o.dir) return { error: '--dir is required' };
    if (!o.version) return { error: '--version is required' };
    if (o.out || o.notices) return { error: '--out and --notices belong to --source' };
  }
  return o;
}

function writeOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const args = parseWinPublishArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`publish-win-assets: ${args.error}`);
    process.exit(2);
  }
  const r = args.source
    ? await fetchSourceArchive({ out: args.out, notices: args.notices })
    : await publishWinSetup({ dir: args.dir, version: args.version, checkConsumers: args.checkConsumers });
  if (!r.ok) {
    console.error(`publish-win-assets: REFUSED (${r.reason}) ${r.detail || ''}`);
    process.exit(1);
  }
  if (args.source) writeOutput('source', r.source);
  else writeOutput('setup', r.setup);
  console.log('publish-win-assets: ok');
}

export { mingitSourceFor };
