#!/usr/bin/env node
/**
 * publish-win-assets.js — the Windows twin of publish-dmg-assets.js: prove the
 * files a Windows release publishes are the ones the in-app updater can use,
 * and REFUSE otherwise. Three modes.
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
 * ── 2. THE SOURCE CODE (`--sources --out <dir> --notices <file>`) ──────────
 * The Windows app ships MinGit, which contains GPL, LGPL and MPL components.
 * Owner's decision (2026-11-20): the exact corresponding source of EVERY one
 * of them is attached to the same GitHub release. The list is
 * desktop/lib/fetch-mingit.mjs `RELEASE_SOURCE_ASSETS` (GitHub's archive of
 * the git-for-windows tag, plus one makepkg source package per copyleft
 * component, desktop/lib/mingit-components.mjs). This mode, BEFORE anything
 * is published:
 *
 *   · checks the notices file the build shipped names every one of them
 *     (so what the app tells a person to look for is what the release has)
 *   · downloads each, and refuses unless it is the pinned file: the exact
 *     byte size, the SHA-256 where the host publishes one, and its structure
 *     (a tar in which every entry sits under `<pkgbase>/`, with
 *     `<pkgbase>/PKGBUILD`; for the git archive, `git-<tag>/` with git's
 *     `GIT-VERSION-GEN` and `COPYING`)
 *   · writes the verified paths, one per line, to `<dir>/sources.txt`, and
 *     `sources_list=<that file>` to $GITHUB_OUTPUT
 *
 * One missing, short, changed or wrong-tree file fails the job, and the
 * workflow then publishes NOTHING (the setup included).
 *
 * ── 3. THE RELEASE, AFTERWARDS (`--check-release <json> --setup <path> --sources-list <file>`) ──
 * Reads `gh release view <tag> --json assets` and checks, BY EXACT NAME, that
 * the setup and every source file are there with the size (and, where GitHub
 * records one, the SHA-256) of the file that was verified. A missing one
 * exits 1, so publish-windows goes red.
 *
 * ── CLI ───────────────────────────────────────────────────────────────────
 *     node scripts/publish-win-assets.js --dir desktop/dist --version 4.0.0 [--check-consumers]
 *     node scripts/publish-win-assets.js --sources --out <dir> --notices <file>
 *     node scripts/publish-win-assets.js --check-release <json> --setup <path> --sources-list <file>
 *
 * Exit 0 only when every check passed; anything else is exit 1 with a named
 * reason. Zero dependencies (node: builtins, and imports from desktop/lib/,
 * which are Electron-free and src/-free). Reading a `.tar.zst` needs a Node
 * with zstd in node:zlib (22.15 or later); without one it REFUSES
 * (`zstd-unavailable`) rather than skip the check.
 */

import { createHash } from 'node:crypto';
import {
  closeSync, createReadStream, createWriteStream, existsSync, openSync, readSync, mkdirSync, readFileSync, readdirSync, appendFileSync,
  statSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import * as zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { archFromAssetName } from '../desktop/lib/update-plan.js';
import { installerFileName } from '../desktop/lib/win-pack.mjs';
import { MINGIT, MINGIT_SOURCE, RELEASE_SOURCE_ASSETS, mingitSourceFor } from '../desktop/lib/fetch-mingit.mjs';

const { gunzipSync } = zlib;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/** The one architecture of the first Windows release (owner D6). */
export const WIN_ARCH = 'x64';

/** Named refusals, so a red run says which rule failed. */
export const WIN_PUBLISH_REFUSALS = Object.freeze([
  'bad-version', 'no-such-dir', 'missing-setup', 'unrecognised-exe', 'blockmap-present',
  'update-feed-present', 'name-does-not-resolve', 'not-a-windows-installer', 'counted-as-mac-installer',
]);

/** Named refusals of the source and release checks. */
export const SOURCE_REFUSALS = Object.freeze([
  'notices-unreadable', 'notices-do-not-name-source', 'download-failed', 'wrong-size', 'wrong-sha256',
  'not-gzip', 'not-zstd', 'zstd-unavailable', 'not-a-tar', 'too-few-entries', 'wrong-tree', 'not-git-source',
  'no-pkgbuild', 'unsafe-asset-name', 'release-unreadable', 'missing-on-release', 'wrong-size-on-release',
  'wrong-digest-on-release',
]);

const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/;
/** What a release asset name may be (GitHub rewrites anything else). */
export const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

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

// ── Tar reading ─────────────────────────────────────────────────────────────

/**
 * A streaming tar header reader (ustar, pax `x`/`g`, GNU `L` long names).
 * It never holds more than one header and one small metadata body, so a
 * 600 MB source tar is scanned in constant memory. `names` collects every
 * entry name; `paxGlobalComment` keeps the first `comment=` of a global
 * header (GitHub records the commit there).
 */
export class TarScanner {
  constructor() {
    this.names = [];
    this.paxGlobalComment = null;
    this.pending = [];
    this.pendingLen = 0;
    this.skip = 0;              // body bytes still to drop
    this.collect = null;        // {type, size, chunks, len} while reading a metadata body
    this.nextName = null;
    this.ended = false;
    this.error = null;
  }

  _take(n) {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const head = this.pending[0];
      const k = Math.min(head.length, n - off);
      head.copy(out, off, 0, k);
      off += k;
      if (k === head.length) this.pending.shift();
      else this.pending[0] = head.subarray(k);
    }
    this.pendingLen -= n;
    return out;
  }

  push(chunk) {
    if (this.ended || this.error) return;
    this.pending.push(chunk);
    this.pendingLen += chunk.length;
    try { this._drain(); } catch (err) { this.error = err; }
  }

  _drain() {
    for (;;) {
      if (this.skip > 0) {
        if (this.pendingLen === 0) return;
        const k = Math.min(this.skip, this.pendingLen);
        this._take(k);
        this.skip -= k;
        continue;
      }
      if (this.collect) {
        const want = this.collect.padded;
        if (this.pendingLen < want) return;
        const body = this._take(want).subarray(0, this.collect.size);
        const { type } = this.collect;
        this.collect = null;
        const text = body.toString('utf8');
        if (type === 'x') {
          const m = text.match(/(?:^|\n)\d+ path=([^\n]*)\n/);
          if (m) this.nextName = m[1];
        } else if (type === 'g') {
          const m = text.match(/comment=([0-9a-f]{40})/);
          if (m && !this.paxGlobalComment) this.paxGlobalComment = m[1];
        } else if (type === 'L') {
          this.nextName = text.replace(/\0.*$/s, '');
        }
        continue;
      }
      if (this.pendingLen < 512) return;
      const h = this._take(512);
      if (h.every((b) => b === 0)) { this.ended = true; return; }
      const field = (o, n) => h.subarray(o, o + n).toString('utf8').replace(/\0.*$/s, '');
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : h[i];
      const stored = parseInt(field(148, 8).trim() || 'x', 8);
      if (!Number.isFinite(stored) || stored !== sum) throw new Error('a tar header fails its checksum');
      const size = parseInt(field(124, 12).trim() || '0', 8);
      if (!Number.isFinite(size) || size < 0) throw new Error('bad tar header size');
      const type = field(156, 1) || '0';
      const padded = Math.ceil(size / 512) * 512;
      if (type === 'x' || type === 'g' || type === 'L') {
        if (size > 1024 * 1024) throw new Error('a tar metadata header is implausibly large');
        this.collect = { type, size, padded };
        continue;
      }
      const magic = field(257, 6);
      const prefix = magic.startsWith('ustar') ? field(345, 155) : '';
      let name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
      if (this.nextName) { name = this.nextName; this.nextName = null; }
      this.names.push(name);
      this.skip = padded;
    }
  }
}

/** Read a tar's entry names from a buffer. Pure. (The git archive check uses it.) */
export function tarEntryNames(buf) {
  const s = new TarScanner();
  s.push(buf);
  if (s.error) throw s.error;
  if (!s.ended && (s.pendingLen > 0 || s.skip > 0 || s.collect)) throw new Error('the archive is truncated');
  return s.names;
}

/** The pax global header's `comment=` (GitHub writes the commit id there), or null. */
export function tarCommitComment(buf) {
  const s = new TarScanner();
  s.push(buf);
  return s.paxGlobalComment;
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

/**
 * Pure. Are these tar entry names a makepkg source package of `pkgbase`?
 * (makepkg --source writes every file under `<pkgbase>/`, PKGBUILD included.)
 */
export function verifyMakepkgTree(names, pkgbase) {
  if (!Array.isArray(names) || names.length === 0) return { ok: false, reason: 'not-a-tar', detail: 'no entries' };
  const prefix = `${pkgbase}/`;
  const outside = names.filter((n) => !(n === pkgbase || n === prefix || n.startsWith(prefix)));
  if (outside.length) return { ok: false, reason: 'wrong-tree', detail: `${outside.length} entries outside ${prefix}, e.g. ${outside[0]}` };
  if (!names.includes(`${prefix}PKGBUILD`)) return { ok: false, reason: 'no-pkgbuild', detail: `no ${prefix}PKGBUILD` };
  return { ok: true, entries: names.length };
}

/** The decompressor for a source file name; null when this Node cannot read it. */
export function decompressorFor(name, z = zlib) {
  if (/\.tar\.gz$/i.test(name) || /\.tgz$/i.test(name)) return { kind: 'gzip', make: () => z.createGunzip() };
  if (/\.tar\.zst$/i.test(name)) {
    return typeof z.createZstdDecompress === 'function' ? { kind: 'zstd', make: () => z.createZstdDecompress() } : { kind: 'zstd', make: null };
  }
  return null;
}

/**
 * Read a downloaded source file ONCE: its SHA-256 and size from the raw
 * bytes, its tar entry names through the decompressor. Never throws.
 */
export async function inspectSourceFile(file, name, { z = zlib } = {}) {
  const d = decompressorFor(name, z);
  if (!d) return { ok: false, reason: 'not-a-tar', detail: `${name} is neither .tar.gz nor .tar.zst` };
  if (!d.make) return { ok: false, reason: 'zstd-unavailable', detail: `this Node (${process.version}) has no zstd in node:zlib; use 22.15 or later` };
  const fd = Buffer.alloc(4);
  const h = openSync(file, 'r');
  try { readSync(h, fd, 0, 4, 0); } finally { closeSync(h); }
  if (d.kind === 'gzip' && !(fd[0] === 0x1f && fd[1] === 0x8b)) return { ok: false, reason: 'not-gzip', detail: 'the file is not gzip data' };
  if (d.kind === 'zstd' && fd.readUInt32LE(0) !== 0xFD2FB528) return { ok: false, reason: 'not-zstd', detail: 'the file is not zstd data' };
  const hash = createHash('sha256');
  let size = 0;
  const scanner = new TarScanner();
  const raw = createReadStream(file);
  raw.on('data', (c) => { hash.update(c); size += c.length; });
  try {
    await pipeline(raw, d.make(), new Writable({
      write(chunk, _enc, cb) { scanner.push(chunk); cb(scanner.error || null); },
    }));
  } catch (err) {
    return { ok: false, reason: d.kind === 'gzip' ? 'not-gzip' : 'not-zstd', detail: err.message };
  }
  if (scanner.error) return { ok: false, reason: 'not-a-tar', detail: scanner.error.message };
  return { ok: true, sha256: hash.digest('hex'), size, names: scanner.names };
}

// ── The source files ────────────────────────────────────────────────────────

/** Does a notices text name the git source file (and the MinGit tag it is for)? Pure. */
export function noticesNameSource(text, source = MINGIT_SOURCE, pin = MINGIT) {
  const t = typeof text === 'string' ? text : '';
  return t.includes(source.asset) && t.includes(pin.tag);
}

/** Every attachment name a notices text does NOT name. Pure. */
export function noticesMissingSources(text, assets = RELEASE_SOURCE_ASSETS) {
  const t = typeof text === 'string' ? text : '';
  return assets.map((a) => a.asset).filter((n) => !t.includes(n));
}

/** Download `url` to `dest` (streamed). Throws on HTTP or network failure. */
async function downloadTo(url, dest, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'the-curator-release-ci' }, redirect: 'follow' });
  if (!res || !res.ok || !res.body) throw new Error(`HTTP ${res ? res.status : 'no response'} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/**
 * Check one downloaded file against its entry in RELEASE_SOURCE_ASSETS.
 * {ok, sha256, size} or a named refusal. Never throws.
 */
export async function verifySourceFile(file, asset, { z = zlib } = {}) {
  if (!SAFE_ASSET_NAME.test(asset.asset)) return { ok: false, reason: 'unsafe-asset-name', detail: asset.asset };
  const st = statSync(file);
  if (asset.size != null && st.size !== asset.size) {
    return { ok: false, reason: 'wrong-size', detail: `${st.size} bytes, the pin says ${asset.size}` };
  }
  if (asset.kind === 'git-tag-archive') {
    const buf = readFileSync(file);
    const v = verifySourceArchive(buf, { topDir: asset.topDir });
    if (!v.ok) return v;
    return { ok: true, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), entries: v.entries, commit: v.commit };
  }
  const info = await inspectSourceFile(file, asset.upstreamName || asset.asset, { z });
  if (!info.ok) return info;
  if (asset.sha256 && info.sha256 !== asset.sha256) {
    return { ok: false, reason: 'wrong-sha256', detail: `SHA-256 is ${info.sha256}, the pin says ${asset.sha256}` };
  }
  const tree = verifyMakepkgTree(info.names, asset.topDir);
  if (!tree.ok) return tree;
  return { ok: true, size: info.size, sha256: info.sha256, entries: tree.entries };
}

/**
 * The single-file git-archive mode the first Windows release design used;
 * kept for the suite and for a person re-checking that one file by hand.
 */
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
    await downloadTo(source.url, partial, fetchImpl);
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

/**
 * The sources mode: every file of RELEASE_SOURCE_ASSETS, downloaded and
 * verified, or a refusal naming the first that failed. Writes
 * `<out>/sources.txt` (one verified path per line) only when ALL passed.
 * Never throws. `retries` re-tries a failed download (not a failed check).
 */
export async function fetchAllSources({
  out, notices, fetchImpl = globalThis.fetch, assets = RELEASE_SOURCE_ASSETS, log = console.log, retries = 1, z = zlib,
}) {
  let text = '';
  try { text = readFileSync(notices, 'utf8'); } catch (err) { return { ok: false, reason: 'notices-unreadable', detail: String(err && err.message) }; }
  const unnamed = noticesMissingSources(text, assets);
  if (unnamed.length) {
    return { ok: false, reason: 'notices-do-not-name-source', detail: `${notices} does not name ${unnamed.join(', ')}` };
  }
  log(`  ${path.basename(notices)} names all ${assets.length} source files`);
  mkdirSync(out, { recursive: true });
  const listFile = path.join(out, 'sources.txt');
  rmSync(listFile, { force: true });
  const done = [];
  for (const a of assets) {
    if (!SAFE_ASSET_NAME.test(a.asset)) return { ok: false, reason: 'unsafe-asset-name', asset: a.asset, detail: a.asset };
    const dest = path.join(out, a.asset);
    const partial = `${dest}.partial`;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      rmSync(partial, { force: true });
      try { await downloadTo(a.url, partial, fetchImpl); lastErr = null; break; } catch (err) { lastErr = err; }
    }
    if (lastErr) {
      rmSync(partial, { force: true });
      return { ok: false, reason: 'download-failed', asset: a.asset, detail: lastErr.message };
    }
    const v = await verifySourceFile(partial, a, { z });
    if (!v.ok) { rmSync(partial, { force: true }); return { ...v, asset: a.asset }; }
    renameSync(partial, dest);
    done.push({ path: dest, asset: a.asset, size: v.size, sha256: v.sha256 });
    log(`  ${a.asset}: ${v.size} bytes, SHA-256 ${v.sha256}${a.sha256 ? ' (matches the pin)' : ' (size pinned; tree checked)'}`);
  }
  writeFileSync(listFile, done.map((d) => d.path).join('\n') + '\n');
  return { ok: true, files: done, list: listFile };
}

/**
 * Pure. The release as `gh release view --json assets` printed it, against
 * what must be on it: [{name, size, sha256?}]. Exact names; the size of the
 * verified file; GitHub's digest when it records one.
 */
export function checkReleaseAssets(release, expected) {
  const assets = release && Array.isArray(release.assets) ? release.assets : null;
  if (!assets) return { ok: false, reason: 'release-unreadable', detail: 'no assets array' };
  const byName = new Map(assets.map((a) => [a && a.name, a]));
  const missing = [], wrongSize = [], wrongDigest = [];
  for (const e of expected) {
    const a = byName.get(e.name);
    if (!a || (a.state && a.state !== 'uploaded')) { missing.push(e.name); continue; }
    if (e.size != null && Number(a.size) !== e.size) wrongSize.push(`${e.name} (${a.size} bytes, expected ${e.size})`);
    const d = typeof a.digest === 'string' ? a.digest.replace(/^sha256:/, '') : null;
    if (d && e.sha256 && d !== e.sha256) wrongDigest.push(`${e.name} (${d}, expected ${e.sha256})`);
  }
  if (missing.length) return { ok: false, reason: 'missing-on-release', detail: missing.join(', '), missing };
  if (wrongSize.length) return { ok: false, reason: 'wrong-size-on-release', detail: wrongSize.join('; ') };
  if (wrongDigest.length) return { ok: false, reason: 'wrong-digest-on-release', detail: wrongDigest.join('; ') };
  return { ok: true, checked: expected.length };
}

/**
 * What must be on the release, built from the files that were verified:
 * the setup, then every line of the sources list, which must itself cover
 * every RELEASE_SOURCE_ASSETS name (a shortened list is a refusal too).
 */
export function expectedReleaseAssets({ setup, sourcesList, assets = RELEASE_SOURCE_ASSETS }) {
  const files = readFileSync(sourcesList, 'utf8').split(/\r?\n/).filter(Boolean);
  const byName = new Map(files.map((f) => [path.basename(f), f]));
  const out = [{ name: path.basename(setup), size: statSync(setup).size, sha256: null }];
  const missing = [];
  for (const a of assets) {
    const f = byName.get(a.asset);
    if (!f) { missing.push(a.asset); continue; }
    out.push({ name: a.asset, size: statSync(f).size, sha256: a.sha256 || createHash('sha256').update(readFileSync(f)).digest('hex') });
  }
  return { expected: out, missing };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function parseWinPublishArgs(argv) {
  const o = { dir: null, version: null, checkConsumers: false, sources: false, out: null, notices: null, checkRelease: null, setup: null, sourcesList: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dir = argv[++i];
    else if (a === '--version') o.version = argv[++i];
    else if (a === '--check-consumers') o.checkConsumers = true;
    else if (a === '--sources') o.sources = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--notices') o.notices = argv[++i];
    else if (a === '--check-release') o.checkRelease = argv[++i];
    else if (a === '--setup') o.setup = argv[++i];
    else if (a === '--sources-list') o.sourcesList = argv[++i];
    else return { error: `unrecognised argument ${a}` };
  }
  const setupMode = o.dir || o.version || o.checkConsumers;
  const modes = [setupMode, o.sources, o.checkRelease].filter(Boolean).length;
  if (modes !== 1) return { error: 'give exactly one of --dir/--version, --sources, --check-release' };
  if (o.sources) {
    if (!o.out) return { error: '--sources needs --out <dir>' };
    if (!o.notices) return { error: '--sources needs --notices <file> (the notices the build shipped)' };
    if (o.setup || o.sourcesList) return { error: '--sources takes only --out and --notices' };
  } else if (o.checkRelease) {
    if (!o.setup || !o.sourcesList) return { error: '--check-release needs --setup <path> and --sources-list <file>' };
    if (o.out || o.notices) return { error: '--check-release takes only --setup and --sources-list' };
  } else {
    if (!o.dir) return { error: '--dir is required' };
    if (!o.version) return { error: '--version is required' };
    if (o.out || o.notices || o.setup || o.sourcesList) return { error: '--out, --notices, --setup and --sources-list belong to the other modes' };
  }
  return o;
}

function writeOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

/** The --check-release mode, against files on disk. Never throws. */
export function checkReleaseFromFiles({ releaseJson, setup, sourcesList, assets = RELEASE_SOURCE_ASSETS }) {
  let release;
  try { release = JSON.parse(readFileSync(releaseJson, 'utf8')); } catch (err) {
    return { ok: false, reason: 'release-unreadable', detail: String(err && err.message) };
  }
  let exp;
  try { exp = expectedReleaseAssets({ setup, sourcesList, assets }); } catch (err) {
    return { ok: false, reason: 'release-unreadable', detail: String(err && err.message) };
  }
  if (exp.missing.length) return { ok: false, reason: 'missing-on-release', detail: `never verified: ${exp.missing.join(', ')}`, missing: exp.missing };
  return checkReleaseAssets(release, exp.expected);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const args = parseWinPublishArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`publish-win-assets: ${args.error}`);
    process.exit(2);
  }
  let r;
  if (args.sources) r = await fetchAllSources({ out: args.out, notices: args.notices });
  else if (args.checkRelease) r = checkReleaseFromFiles({ releaseJson: args.checkRelease, setup: args.setup, sourcesList: args.sourcesList });
  else r = await publishWinSetup({ dir: args.dir, version: args.version, checkConsumers: args.checkConsumers });
  if (!r.ok) {
    console.error(`publish-win-assets: REFUSED (${r.reason})${r.asset ? ` ${r.asset}:` : ''} ${r.detail || ''}`);
    process.exit(1);
  }
  if (args.sources) writeOutput('sources_list', r.list);
  else if (!args.checkRelease) writeOutput('setup', r.setup);
  if (args.checkRelease) console.log(`  the release carries all ${r.checked} files, by exact name and size`);
  console.log('publish-win-assets: ok');
}

export { mingitSourceFor };
