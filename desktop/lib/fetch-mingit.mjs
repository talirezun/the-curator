#!/usr/bin/env node
/**
 * fetch-mingit.mjs — get the git the Windows app carries, and prove it is the
 * one we pinned BEFORE a single byte of it is unpacked.
 *
 * ── Why the Windows app carries git at all ──────────────────────────────────
 *
 * Personal Sync runs git. A Windows PC has none by default, and a packaged app
 * inherits Explorer's PATH, so the owner decided (D4, 2026-11-20) that the app
 * BUNDLES git: MinGit, the minimal portable git that the Git for Windows
 * project publishes for applications to embed. It lands at
 *
 *     <install>\resources\git\cmd\git.exe
 *
 * which is where src/brain/subprocess-env.js `bundledGitLocation()` looks for
 * it (`<dirname(APP_ROOT)>\git`). electron-builder.yml's `win.extraResources`
 * copies the folder this script writes; nothing else in the build touches it.
 *
 * ── The order is the whole point ────────────────────────────────────────────
 *
 *   1. download (or reuse a cached copy) — the bytes are only DATA so far
 *   2. SIZE must equal the pin, then SHA-256 must equal the pin — else REFUSE,
 *      delete the file, and extract nothing
 *   3. only then is the zip read, by a small reader in this file that refuses
 *      anything a release archive of MinGit never contains (a path that leaves
 *      the folder, a link, an encrypted entry, a Windows-reserved name, two
 *      names that differ only in case) and checks every entry's CRC-32
 *   4. the files are written UNMODIFIED into a fresh staging folder, which is
 *      renamed into place only when everything above passed
 *
 * Alongside the git folder it writes:
 *   · THIRD-PARTY-NOTICES.txt  (shipped as resources\THIRD-PARTY-NOTICES.txt):
 *     MinGit, its licence, where its source is offered, and every component
 *     listed in MinGit's own etc/package-versions.txt
 *   · mingit-manifest.json     (NOT shipped): every file's size and CRC-32, so
 *     the win32 afterPack can prove the packaged resources\git is exactly what
 *     was verified here — nothing dropped, nothing added, nothing changed.
 *
 * MinGit's LICENSE.txt and etc/package-versions.txt are part of the archive
 * and ship inside resources\git untouched; this script refuses an archive that
 * lacks either (or cmd\git.exe).
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *     node lib/fetch-mingit.mjs                 # download to desktop/vendor/
 *     node lib/fetch-mingit.mjs --zip <file>    # use a file you already have
 *     node lib/fetch-mingit.mjs --out <dir>     # write somewhere else
 *
 * A `--zip` file is held to the SAME pin: there is no flag that skips the
 * hash. Tests drive `fetchMinGit()` with their own pin and a fixture zip.
 *
 * Electron-free and src-free, like every other module in desktop/lib, so the
 * offline suite executes it rather than reading it.
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, statSync,
  createWriteStream, unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The pin. Every value here is checked; none is informational only. */
export const MINGIT = Object.freeze({
  version: '2.56.1',
  tag: 'v2.56.1.windows.1',
  asset: 'MinGit-2.56.1-64-bit.zip',
  url: 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/MinGit-2.56.1-64-bit.zip',
  releaseUrl: 'https://github.com/git-for-windows/git/releases/tag/v2.56.1.windows.1',
  sha256: '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd',
  size: 39849768,
});

/** Where The Curator's own releases live (the GPLv2 source is attached there). */
export const CURATOR_RELEASES_URL = 'https://github.com/talirezun/the-curator/releases';

/**
 * The GPLv2 source of the pinned MinGit, as CI attaches it to EVERY Windows
 * release (.github/workflows/desktop-dmg.yml, job publish-windows, through
 * scripts/publish-win-assets.js). The file is GitHub's archive of the
 * git-for-windows/git tag the binary was built from; its top folder is
 * `git-<tag without v>`. Derived from the pin's tag, never typed twice: the
 * notices below name `asset`, and the publish step uploads under the same
 * name, so what the app tells a person to look for is what the release has.
 */
export function mingitSourceFor(pin = MINGIT) {
  const bare = String(pin.tag).replace(/^v/, '');
  return Object.freeze({
    url: `https://github.com/git-for-windows/git/archive/refs/tags/${pin.tag}.tar.gz`,
    asset: `git-for-windows-${bare}-source.tar.gz`,
    topDir: `git-${bare}`,
  });
}
export const MINGIT_SOURCE = mingitSourceFor(MINGIT);

/** The default output folder, relative to desktop/ (gitignored). */
export const DEFAULT_OUT_DIR = path.join(DESKTOP_DIR, 'vendor');
/** Subfolder of the output folder that holds everything the build copies. */
export const STAGE_DIR_NAME = 'mingit';
/** The unmodified MinGit tree, inside STAGE_DIR_NAME → resources\git. */
export const GIT_DIR_NAME = 'git';
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.txt';
export const MANIFEST_FILE = 'mingit-manifest.json';

/** Files a MinGit archive must contain, as zip paths (forward slashes). */
export const REQUIRED_FILES = Object.freeze(['cmd/git.exe', 'LICENSE.txt', 'etc/package-versions.txt']);

/** Hard ceilings: a real MinGit is ~40 MB packed and ~100 MB unpacked. */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
export const MAX_ENTRIES = 50000;

// ── Verification ────────────────────────────────────────────────────────────

/**
 * Check a downloaded archive against the pin. Size first (cheap, and a
 * truncated download is the common failure), then SHA-256. Returns
 * {ok, problems[], size, sha256}; never throws.
 */
export function verifyArchive(buf, pin = MINGIT) {
  const problems = [];
  const size = Buffer.isBuffer(buf) ? buf.length : -1;
  if (size !== pin.size) {
    problems.push(`size is ${size} bytes, the pin says ${pin.size}`);
  }
  const sha256 = Buffer.isBuffer(buf) ? createHash('sha256').update(buf).digest('hex') : null;
  if (sha256 !== String(pin.sha256).toLowerCase()) {
    problems.push(`SHA-256 is ${sha256}, the pin says ${pin.sha256}`);
  }
  return { ok: problems.length === 0, problems, size, sha256 };
}

// ── CRC-32 (table-driven; zlib.crc32 is newer than some supported Nodes) ─────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Zip reading ─────────────────────────────────────────────────────────────

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// Characters Windows refuses in a file name, plus every control character.
// eslint-disable-next-line no-control-regex
const WIN_BAD_CHARS = /[<>:"|?*\\\u0000-\u001f]/;

/**
 * Why a zip entry name is unsafe to write on Windows, or null when it is fine.
 * Exported so the suite can drive every refusal directly.
 */
export function unsafeEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'empty name';
  if (name.includes('\\')) return 'backslash in a zip path';
  if (name.startsWith('/')) return 'absolute path';
  if (/^[a-zA-Z]:/.test(name)) return 'drive-letter path';
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  if (trimmed.length === 0) return 'empty name';
  for (const seg of trimmed.split('/')) {
    if (seg === '') return 'empty path segment';
    if (seg === '.' || seg === '..') return `"${seg}" segment`;
    if (WIN_BAD_CHARS.test(seg)) return `character Windows refuses in "${seg}"`;
    if (/[. ]$/.test(seg)) return `"${seg}" ends in a dot or a space`;
    if (WIN_RESERVED.test(seg)) return `"${seg}" is a reserved Windows name`;
  }
  return null;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - (22 + 0xFFFF));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Read a zip's central directory. Returns entries
 * {name, dir, method, crc, compSize, size, dataStart} or throws with the
 * reason. Supports stored and deflated entries and the zip64 fields some
 * archivers write; refuses everything else.
 */
export function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip file (too short)');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw new Error('multi-disk zip files are not supported');
  }
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== SIG_EOCD64_LOCATOR) throw new Error('zip64 locator missing');
    const off64 = Number(buf.readBigUInt64LE(loc + 8));
    if (off64 + 56 > buf.length || buf.readUInt32LE(off64) !== SIG_EOCD64) throw new Error('zip64 record missing');
    count = Number(buf.readBigUInt64LE(off64 + 32));
    cdSize = Number(buf.readBigUInt64LE(off64 + 40));
    cdOffset = Number(buf.readBigUInt64LE(off64 + 48));
  }
  if (count > MAX_ENTRIES) throw new Error(`too many entries (${count})`);
  if (cdOffset + cdSize > buf.length) throw new Error('central directory runs past the end of the file');

  const entries = [];
  const seen = new Set();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`central directory entry ${i} is damaged`);
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    let localOffset = buf.readUInt32LE(p + 42);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const utf8 = (flags & 0x0800) !== 0;
    if (!utf8 && nameBytes.some((b) => b > 0x7E)) throw new Error(`entry ${i} has a non-ASCII name without the UTF-8 flag`);
    const name = nameBytes.toString(utf8 ? 'utf8' : 'latin1');

    // zip64 extended information (header id 0x0001), in its fixed order.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xFFFFFFFF) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (compSize === 0xFFFFFFFF) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (localOffset === 0xFFFFFFFF) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }

    const where = `"${name}"`;
    if (flags & 0x0001) throw new Error(`${where} is encrypted`);
    const bad = unsafeEntryName(name);
    if (bad) throw new Error(`${where} is not a safe path (${bad})`);
    const hostOs = madeBy >>> 8;
    const unixMode = extAttr >>> 16;
    if (hostOs === 3 && (unixMode & 0o170000) === 0o120000) throw new Error(`${where} is a symbolic link`);
    const dir = name.endsWith('/');
    if (!dir && method !== 0 && method !== 8) throw new Error(`${where} uses compression method ${method}`);
    const key = (dir ? name.slice(0, -1) : name).toLowerCase();
    if (seen.has(key)) throw new Error(`${where} appears twice (names are compared ignoring case, as Windows does)`);
    seen.add(key);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`${where} has no local header where the directory says`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error(`${where} runs past the end of the file`);

    entries.push({ name, dir, method, crc, compSize, size, dataStart });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The bytes of one file entry, CRC- and size-checked. */
export function readEntryData(buf, entry) {
  const raw = buf.subarray(entry.dataStart, entry.dataStart + entry.compSize);
  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size + 1) });
  if (data.length !== entry.size) throw new Error(`"${entry.name}" unpacked to ${data.length} bytes, the archive says ${entry.size}`);
  if (crc32(data) !== entry.crc) throw new Error(`"${entry.name}" fails its CRC-32 check`);
  return data;
}

/**
 * Extract a (verified) zip into `destDir`, which must not exist yet.
 * Returns the manifest {files: {path: {size, crc32}}, dirs: [path]}.
 * Writes with flag 'wx', so nothing pre-existing is ever overwritten.
 */
export function extractZip(buf, destDir) {
  if (existsSync(destDir)) throw new Error(`refusing to extract into an existing folder: ${destDir}`);
  const entries = readZipEntries(buf);
  const total = entries.reduce((n, e) => n + (e.dir ? 0 : e.size), 0);
  if (total > MAX_UNPACKED_BYTES) throw new Error(`archive unpacks to ${total} bytes, over the ${MAX_UNPACKED_BYTES} ceiling`);
  mkdirSync(destDir, { recursive: true });
  const files = {};
  const dirs = [];
  for (const entry of entries) {
    const rel = entry.dir ? entry.name.slice(0, -1) : entry.name;
    const target = path.join(destDir, ...rel.split('/'));
    // Belt and braces after unsafeEntryName(): the resolved target must stay inside.
    const back = path.relative(destDir, target);
    if (back.startsWith('..') || path.isAbsolute(back)) throw new Error(`"${entry.name}" resolves outside the folder`);
    if (entry.dir) {
      mkdirSync(target, { recursive: true });
      dirs.push(rel);
      continue;
    }
    const data = readEntryData(buf, entry);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: 'wx' });
    files[rel] = { size: data.length, crc32: entry.crc };
  }
  return { files, dirs };
}

// ── Notices ─────────────────────────────────────────────────────────────────

/** The component lines of MinGit's etc/package-versions.txt, as written. */
export function parsePackageVersions(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/**
 * The THIRD-PARTY-NOTICES.txt text for the Windows build. Plain text with CRLF
 * line endings, because Notepad is what opens it on Windows.
 */
export function thirdPartyNotices({ pin = MINGIT, components = [], releasesUrl = CURATOR_RELEASES_URL } = {}) {
  const lines = [
    'The Curator for Windows: third-party software',
    '=============================================',
    '',
    'The Curator is open source under the MIT licence (resources\\app\\LICENSE and',
    'resources\\app\\LICENSES\\). The Windows app also contains the third-party software',
    'below. None of it has been modified.',
    '',
    `1. MinGit ${pin.version} (Git for Windows, release ${pin.tag})`,
    '',
    '   Where it is:  resources\\git (in the folder The Curator is installed in)',
    '   What it does: Personal Sync uses it to save your knowledge base to GitHub.',
    '   Licence:      GNU General Public License, version 2 (GPL-2.0). The licence',
    '                 texts of git and of every component are in resources\\git\\LICENSE.txt.',
    `   Upstream:     https://gitforwindows.org/ and ${pin.releaseUrl}`,
    `   The file:     ${pin.asset}, ${pin.size} bytes,`,
    `                 SHA-256 ${pin.sha256}`,
    '                 (checked before it was unpacked into this app).',
    '',
    '   Source code: under section 3 of the GPL, the complete corresponding source',
    `   code of this MinGit build is attached to the GitHub release of The Curator`,
    `   that contains this app, as ${mingitSourceFor(pin).asset}, at ${releasesUrl}`,
    '   The Git for Windows project also publishes it, with its build recipes, at',
    `   ${pin.releaseUrl} and https://github.com/git-for-windows/build-extra`,
    '',
    `   Components (from resources\\git\\etc\\package-versions.txt, ${components.length} entries):`,
    ...components.map((c) => `     ${c}`),
    '',
    '2. Electron, Chromium and Node.js',
    '',
    '   The app runs on Electron. Their licences are in LICENSE.electron.txt and',
    '   LICENSES.chromium.html, in the folder The Curator is installed in.',
    '',
    '3. JavaScript packages',
    '',
    '   The packages in resources\\app\\node_modules each carry their own licence',
    '   file in their own folder.',
    '',
  ];
  return lines.join('\r\n');
}

// ── Download ────────────────────────────────────────────────────────────────

/**
 * Stream `url` to `dest` (overwriting a stale partial), with a byte ceiling.
 * `fetchImpl` is injected by the suite; the default is the global fetch, which
 * follows GitHub's redirect to its download host.
 */
export async function downloadToFile({ url, dest, fetchImpl = globalThis.fetch, maxBytes = MAX_DOWNLOAD_BYTES }) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch available (Node 18+ is required)');
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res || !res.ok) throw new Error(`download failed: HTTP ${res ? res.status : 'no response'} for ${url}`);
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`download is ${declared} bytes, over the ${maxBytes} ceiling`);
  mkdirSync(path.dirname(dest), { recursive: true });
  const out = createWriteStream(dest);
  let got = 0;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > maxBytes) throw new Error(`download passed the ${maxBytes}-byte ceiling`);
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      got = buf.length;
      if (got > maxBytes) throw new Error(`download passed the ${maxBytes}-byte ceiling`);
      out.write(buf);
    }
  } catch (err) {
    out.destroy();
    try { unlinkSync(dest); } catch { /* nothing to remove */ }
    throw err;
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return got;
}

// ── The whole job ───────────────────────────────────────────────────────────

/**
 * Get MinGit into `<outDir>/mingit/` (git/, THIRD-PARTY-NOTICES.txt,
 * mingit-manifest.json). Returns {stageDir, gitDir, manifest, components}.
 *
 *   outDir     default desktop/vendor
 *   zipPath    use this archive instead of downloading (still held to the pin)
 *   pin        the pin (tests pass their own; the CLI never does)
 *   fetchImpl  injected fetch
 *   extract    injected extractor (the suite proves it is never reached on a bad pin)
 */
export async function fetchMinGit({
  outDir = DEFAULT_OUT_DIR,
  zipPath = null,
  pin = MINGIT,
  fetchImpl = globalThis.fetch,
  extract = extractZip,
  log = (m) => console.log(m),
} = {}) {
  mkdirSync(outDir, { recursive: true });
  let archive = zipPath ? path.resolve(zipPath) : path.join(outDir, pin.asset);

  if (!zipPath) {
    let reuse = false;
    if (existsSync(archive)) {
      reuse = verifyArchive(readFileSync(archive), pin).ok;
      if (!reuse) {
        log(`  • ${pin.asset}: the cached copy does not match the pin; downloading it again`);
        rmSync(archive, { force: true });
      }
    }
    if (!reuse) {
      const partial = `${archive}.partial`;
      log(`  • downloading ${pin.url}`);
      await downloadToFile({ url: pin.url, dest: partial, fetchImpl });
      renameSync(partial, archive);
    }
  }

  const buf = readFileSync(archive);
  const v = verifyArchive(buf, pin);
  if (!v.ok) {
    if (!zipPath) rmSync(archive, { force: true });
    throw new Error(
      `MinGit REFUSED — ${path.basename(archive)} is not the pinned file, so nothing was unpacked.\n` +
      v.problems.map((p) => `  · ${p}`).join('\n') +
      (zipPath ? '' : '\n  The download was deleted.')
    );
  }
  log(`  • ${pin.asset}: ${v.size} bytes, SHA-256 ${v.sha256} (matches the pin)`);

  const stageDir = path.join(outDir, STAGE_DIR_NAME);
  const staging = path.join(outDir, `${STAGE_DIR_NAME}.partial-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    const gitStage = path.join(staging, GIT_DIR_NAME);
    const manifest = extract(buf, gitStage);
    for (const req of REQUIRED_FILES) {
      if (!manifest.files[req]) throw new Error(`MinGit REFUSED — the archive has no ${req}`);
    }
    const components = parsePackageVersions(
      readFileSync(path.join(gitStage, ...'etc/package-versions.txt'.split('/')), 'utf8'));
    if (components.length === 0) throw new Error('MinGit REFUSED — etc/package-versions.txt lists no components');
    writeFileSync(path.join(staging, NOTICES_FILE), thirdPartyNotices({ pin, components }));
    writeFileSync(path.join(staging, MANIFEST_FILE), JSON.stringify({
      version: pin.version, tag: pin.tag, asset: pin.asset, sha256: v.sha256, size: v.size,
      files: manifest.files, dirs: manifest.dirs,
    }, null, 2) + '\n');
    rmSync(stageDir, { recursive: true, force: true });
    renameSync(staging, stageDir);
    log(`  • MinGit ${pin.version}: ${Object.keys(manifest.files).length} files unpacked to ${stageDir}`);
    return { stageDir, gitDir: path.join(stageDir, GIT_DIR_NAME), manifest, components };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Prove a copied git folder is exactly the manifest: every file present with
 * its size and CRC-32, and no file the manifest does not name. Returns
 * {ok, problems[]}. Used by the win32 afterPack on the PACKAGED folder.
 */
export function checkTreeAgainstManifest(dir, manifest, { listFiles = listFilesRecursive } = {}) {
  const problems = [];
  if (!manifest || typeof manifest.files !== 'object') return { ok: false, problems: ['no manifest'] };
  const expected = manifest.files;
  let actual;
  try { actual = listFiles(dir); } catch (err) { return { ok: false, problems: [`cannot read ${dir}: ${err.message}`] }; }
  const actualSet = new Set(actual);
  for (const [rel, meta] of Object.entries(expected)) {
    if (!actualSet.has(rel)) { problems.push(`missing: ${rel}`); continue; }
    const data = readFileSync(path.join(dir, ...rel.split('/')));
    if (data.length !== meta.size) problems.push(`changed size: ${rel}`);
    else if (crc32(data) !== meta.crc32) problems.push(`changed bytes: ${rel}`);
  }
  for (const rel of actual) if (!Object.prototype.hasOwnProperty.call(expected, rel)) problems.push(`not in MinGit: ${rel}`);
  return { ok: problems.length === 0, problems };
}

/** Every file under `dir`, as forward-slash relative paths. */
export function listFilesRecursive(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(a);
      if (st.isDirectory()) walk(a, r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const argv = process.argv.slice(2);
  fetchMinGit({
    outDir: argValue(argv, '--out') ? path.resolve(argValue(argv, '--out')) : DEFAULT_OUT_DIR,
    zipPath: argValue(argv, '--zip'),
  }).catch((err) => {
    console.error(`\n  fetch-mingit: ${err.message}\n`);
    process.exit(1);
  });
}
