/**
 * win-pack.mjs — the Windows half of the build's artifact checks.
 *
 * electron-builder runs two hooks this file serves, on a `--win` build only:
 *
 *   afterPack (via lib/after-pack.mjs, which branches on
 *   `context.electronPlatformName === 'win32'`; the Mac path is untouched)
 *     · the packed app's version (resources\app\package.json, which carries the
 *       injected `extraMetadata.version`) must equal the ROOT package.json and
 *       must not be the 0.0.0 sentinel
 *     · the app's runtime dependencies must be inside resources\app\node_modules
 *       (the Windows twin of the "launches only inside the checkout" trap)
 *     · resources\git must be EXACTLY the MinGit fetch-mingit.mjs verified
 *       (every file, size and CRC-32; nothing missing, nothing extra)
 *     · resources\THIRD-PARTY-NOTICES.txt and the tray icons must be there
 *     · the RunAsNode fuse must not be configured off, asar must stay off, and
 *       the executable's resource editing must stay on (else afterSign never runs)
 *     · THEN it writes the bundle marker resources\app\.curator-bundle and reads
 *       it back. Without the marker the installed app runs in REPO mode and keeps
 *       the user's wiki INSIDE the program folder, which the next update or
 *       uninstall deletes (src/brain/paths.js, "WINDOWS").
 *
 *   afterSign (named in electron-builder.yml; a no-op on every other platform)
 *     electron-builder writes the exe's version resource (resedit) AFTER
 *     afterPack, in its sign step, so the version a user sees in the file's
 *     Properties can only be checked here. With `asar: false` electron-builder
 *     always reports the Windows sign step as done, so this hook always runs
 *     (verified in app-builder-lib 26.15.3 winPackager.signApp).
 *     · the exe's FileVersion/ProductVersion (fixed info AND strings) must be
 *       the root version (a 4th "build" component is allowed, as Windows wants
 *       four numbers), never 0.0.0
 *     · the exe's Electron fuse wire must have RunAsNode ENABLED — the MCP
 *       bridge Claude Desktop starts is `The Curator.exe` with
 *       ELECTRON_RUN_AS_NODE=1 (decisions-agents.md, D2), and it dies silently
 *       if that fuse is off.
 *
 * Electron-free and src-free, like the rest of desktop/lib: the offline suite
 * (scripts/test-desktop-win-build.js) executes all of it against fabricated
 * trees and fabricated PE files on any OS.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readManifestVersion, repoRootFrom, UNSET_VERSION } from './app-version.js';
import {
  MINGIT, DEFAULT_OUT_DIR, STAGE_DIR_NAME, MANIFEST_FILE, NOTICES_FILE, REQUIRED_FILES,
  checkTreeAgainstManifest,
} from './fetch-mingit.mjs';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── The names other packages rely on (stated once, pinned by the suite) ──────

/** electron-builder.yml `appId`. NSIS stamps it on both shortcuts as their AppUserModelID. */
export const APP_ID = 'com.talirezun.the-curator';
/** What desktop/main.js must pass to app.setAppUserModelId() on win32 (= APP_ID). */
export const APP_USER_MODEL_ID = APP_ID;
/** NSIS's GUID: UUID v5 of APP_ID in electron-builder's namespace (no `nsis.guid` is set). */
export const NSIS_GUID = '80ccaaf9-11be-57fd-99fb-d73402b182f5';
/** The per-user Apps & features key (under HKCU) the installer writes. */
export const UNINSTALL_REGISTRY_KEY = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_GUID}`;
export const PRODUCT_NAME = 'The Curator';
export const EXE_NAME = 'The Curator.exe';
export const UNINSTALLER_NAME = 'Uninstall The Curator.exe';
export const SHORTCUT_NAME = 'The Curator';
/** Install folder: %LOCALAPPDATA%\Programs\<this> (assisted installer → product file name). */
export const INSTALL_DIR_NAME = 'The Curator';
/** The marker src/brain/paths.js looks for at APP_ROOT. */
export const BUNDLE_MARKER_FILE = '.curator-bundle';
/** resources\<this> holds MinGit; src/brain/subprocess-env.js BUNDLED_GIT_FOLDER. */
export const BUNDLED_GIT_DIR = 'git';
/** Shipped to resources\app\build\ so main.js can use path.join(__dirname, 'build', …) packaged and in dev. */
export const TRAY_ICON_FILES = Object.freeze(['tray.ico', 'tray.png', 'tray@2x.png']);
/** Electron's RunAsNode is fuse 0 in the V1 wire. */
export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
export const FUSE_RUN_AS_NODE = 0;

export const MARKER_TEXT =
  'This file marks a packaged copy of The Curator (the Windows app).\r\n' +
  'Written by desktop/lib/win-pack.mjs at build time. Because it is here, the app\r\n' +
  'keeps your knowledge base in %LOCALAPPDATA%\\TheCurator\\App, outside this program\r\n' +
  'folder, so updating or uninstalling the app never touches it. Never copy this\r\n' +
  'file into a checkout of the source code.\r\n';

/** The installer's file name for a version. Pinned against electron-builder.yml's artifactName. */
export function installerFileName(version) {
  return `TheCurator-${version}-x64-Windows-Setup.exe`;
}

// ── Reading a Windows executable ────────────────────────────────────────────

function u16(buf, o) { return buf.readUInt16LE(o); }
function u32(buf, o) { return buf.readUInt32LE(o); }

/**
 * Map an RVA to a file offset through the section table. Returns -1 when no
 * section contains it.
 */
function rvaToOffset(sections, rva) {
  for (const s of sections) {
    const span = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.va && rva < s.va + span) return rva - s.va + s.rawPtr;
  }
  return -1;
}

/** Parse the PE headers far enough to find the resource section. */
export function readPeLayout(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x40 || buf.toString('latin1', 0, 2) !== 'MZ') {
    throw new Error('not a Windows executable (no MZ header)');
  }
  const pe = u32(buf, 0x3C);
  if (pe + 24 > buf.length || buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') {
    throw new Error('not a Windows executable (no PE header)');
  }
  const numSections = u16(buf, pe + 6);
  const optSize = u16(buf, pe + 20);
  const opt = pe + 24;
  const magic = u16(buf, opt);
  let ddCountOff, ddOff;
  if (magic === 0x20B) { ddCountOff = opt + 108; ddOff = opt + 112; }
  else if (magic === 0x10B) { ddCountOff = opt + 92; ddOff = opt + 96; }
  else throw new Error(`unknown optional-header magic 0x${magic.toString(16)}`);
  const ddCount = u32(buf, ddCountOff);
  const sections = [];
  const secTable = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = secTable + i * 40;
    if (s + 40 > buf.length) throw new Error('section table runs past the end of the file');
    sections.push({
      name: buf.toString('latin1', s, s + 8).replace(/\0+$/, ''),
      virtualSize: u32(buf, s + 8), va: u32(buf, s + 12), rawSize: u32(buf, s + 16), rawPtr: u32(buf, s + 20),
    });
  }
  const rsrcRva = ddCount > 2 ? u32(buf, ddOff + 16) : 0;
  return { sections, rsrcRva, rsrcOffset: rsrcRva ? rvaToOffset(sections, rsrcRva) : -1, pe64: magic === 0x20B };
}

function resourceDirEntries(buf, base, dirOff) {
  const named = u16(buf, base + dirOff + 12);
  const ids = u16(buf, base + dirOff + 14);
  const out = [];
  for (let i = 0; i < named + ids; i++) {
    const e = base + dirOff + 16 + i * 8;
    const nameField = u32(buf, e);
    const dataField = u32(buf, e + 4);
    out.push({
      isNamed: (nameField & 0x80000000) !== 0,
      id: nameField & 0x7FFFFFFF,
      isDir: (dataField & 0x80000000) !== 0,
      offset: dataField & 0x7FFFFFFF,
    });
  }
  return out;
}

/** The raw RT_VERSION resource (type 16, first name, first language), or null. */
export function findVersionResource(buf) {
  const layout = readPeLayout(buf);
  if (layout.rsrcOffset < 0) return null;
  const base = layout.rsrcOffset;
  const type = resourceDirEntries(buf, base, 0).find((e) => !e.isNamed && e.id === 16 && e.isDir);
  if (!type) return null;
  const name = resourceDirEntries(buf, base, type.offset).find((e) => e.isDir);
  if (!name) return null;
  const lang = resourceDirEntries(buf, base, name.offset).find((e) => !e.isDir);
  if (!lang) return null;
  const de = base + lang.offset;
  const dataRva = u32(buf, de);
  const size = u32(buf, de + 4);
  const off = rvaToOffset(layout.sections, dataRva);
  if (off < 0 || off + size > buf.length) throw new Error('the version resource points outside the file');
  return buf.subarray(off, off + size);
}

const align4 = (n) => (n + 3) & ~3;

/** One VS_VERSIONINFO-style block: header, UTF-16 key, value, children. */
function parseVersionBlock(v, off) {
  const length = u16(v, off);
  const valueLength = u16(v, off + 2);
  const type = u16(v, off + 4);
  let p = off + 6;
  let key = '';
  while (p + 1 < v.length) {
    const ch = u16(v, p); p += 2;
    if (ch === 0) break;
    key += String.fromCharCode(ch);
  }
  p = align4(p);
  const valueBytes = type === 1 ? valueLength * 2 : valueLength;
  const valueOffset = p;
  const end = off + length;
  const childrenOffset = align4(p + valueBytes);
  return { length, valueLength, type, key, valueOffset, valueBytes, childrenOffset, end };
}

function* childBlocks(v, block) {
  let p = block.childrenOffset;
  while (p + 6 <= block.end && p + 6 <= v.length) {
    const child = parseVersionBlock(v, p);
    if (child.length === 0) break;
    yield child;
    p = align4(p + child.length);
  }
}

const fourPart = (ms, ls) => `${ms >>> 16}.${ms & 0xFFFF}.${ls >>> 16}.${ls & 0xFFFF}`;

/**
 * Read an executable's version resource. Returns
 * { fixed: {fileVersion, productVersion} | null, strings: {Key: value} }
 * or null when the file has no version resource. Throws on a file that is
 * not a PE.
 */
export function readPeVersionInfo(buf) {
  const v = findVersionResource(buf);
  if (!v) return null;
  const root = parseVersionBlock(v, 0);
  if (root.key !== 'VS_VERSION_INFO') throw new Error(`unexpected version block "${root.key}"`);
  let fixed = null;
  if (root.valueBytes >= 52 && u32(v, root.valueOffset) === 0xFEEF04BD) {
    const f = root.valueOffset;
    fixed = {
      fileVersion: fourPart(u32(v, f + 8), u32(v, f + 12)),
      productVersion: fourPart(u32(v, f + 16), u32(v, f + 20)),
    };
  }
  const strings = {};
  for (const sfi of childBlocks(v, root)) {
    if (sfi.key !== 'StringFileInfo') continue;
    for (const table of childBlocks(v, sfi)) {
      for (const s of childBlocks(v, table)) {
        let text = v.toString('utf16le', s.valueOffset, s.valueOffset + s.valueBytes);
        text = text.replace(/\0+$/, '');
        if (!(s.key in strings)) strings[s.key] = text;
      }
    }
  }
  return { fixed, strings };
}

/**
 * The Electron fuse wire in a binary. Returns {version, states: [byte]}.
 * Throws when the sentinel is missing or appears more than once (we would not
 * know which wire Electron reads).
 */
export function readFuseWire(buf) {
  const first = buf.indexOf(FUSE_SENTINEL, 0, 'latin1');
  if (first < 0) throw new Error('no Electron fuse wire in this binary');
  if (buf.lastIndexOf(FUSE_SENTINEL, buf.length, 'latin1') !== first) {
    throw new Error('the Electron fuse sentinel appears more than once');
  }
  const p = first + FUSE_SENTINEL.length;
  const version = buf[p];
  const length = buf[p + 1];
  const states = [...buf.subarray(p + 2, p + 2 + length)];
  return { version, states };
}

/** True when RunAsNode is ENABLED ('1', 0x31) in a V1 fuse wire. */
export function runAsNodeEnabled(wire) {
  return !!wire && wire.version === 1 && wire.states[FUSE_RUN_AS_NODE] === 0x31;
}

/**
 * Decide whether an exe's version resource carries `expected`.
 * Accepts X.Y.Z or X.Y.Z.N (Windows' four-number form); refuses the sentinel,
 * an unreadable value and any other number. Returns {ok, problems[]}.
 */
export function checkExeVersion({ expected, info }) {
  const problems = [];
  if (typeof expected !== 'string' || !expected) {
    return { ok: false, problems: ['no expected version (the root package.json could not be read)'] };
  }
  if (expected === UNSET_VERSION) problems.push(`the root package.json reports the sentinel ${UNSET_VERSION}`);
  if (!info) return { ok: false, problems: [...problems, 'the executable has no version resource'] };
  const esc = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = (val) => typeof val === 'string' && new RegExp(`^${esc}(\\.\\d+)?$`).test(val);
  const sentinel = (val) => typeof val === 'string' && /^0\.0\.0(\.\d+)?$/.test(val);
  const fields = [
    ['fixed FileVersion', info.fixed && info.fixed.fileVersion],
    ['fixed ProductVersion', info.fixed && info.fixed.productVersion],
    ['FileVersion string', info.strings && info.strings.FileVersion],
    ['ProductVersion string', info.strings && info.strings.ProductVersion],
  ];
  for (const [label, val] of fields) {
    if (typeof val !== 'string' || !val) problems.push(`${label} could not be read`);
    else if (sentinel(val)) problems.push(`${label} is ${val}: the sentinel reached the executable`);
    else if (!matches(val)) problems.push(`${label} is ${val} but the root package.json says ${expected}`);
  }
  if (info.strings && info.strings.ProductName !== PRODUCT_NAME) {
    problems.push(`ProductName is ${JSON.stringify(info.strings && info.strings.ProductName)}, expected "${PRODUCT_NAME}"`);
  }
  return { ok: problems.length === 0, problems };
}

// ── The hooks ───────────────────────────────────────────────────────────────

function refuse(title, problems) {
  return new Error(`BUILD REFUSED (Windows) — ${title}\n\n${problems.map((p) => `  · ${p}`).join('\n')}\n`);
}

/**
 * The win32 afterPack. Throws to abort the build (electron-builder awaits
 * hooks with no try/catch). Returns {version, marker} on success.
 *
 *   appOutDir     electron-builder's win-unpacked folder
 *   config        the RESOLVED build config (context.packager.config)
 *   winOptions    the resolved win options (context.packager.platformSpecificBuildOptions)
 *   repoRoot      the repository root (its package.json is the truth)
 *   vendorDir     where fetch-mingit.mjs wrote its stage folder
 */
export function winAfterPack({
  appOutDir,
  config = {},
  winOptions = {},
  repoRoot = repoRootFrom(DESKTOP_DIR),
  vendorDir = DEFAULT_OUT_DIR,
  log = (m) => console.log(m),
}) {
  const problems = [];
  const resources = path.join(appOutDir, 'resources');
  const appDir = path.join(resources, 'app');

  // 1. Version identity: the packed manifest against the root manifest.
  const expected = readManifestVersion(path.join(repoRoot, 'package.json'));
  const packed = readManifestVersion(path.join(appDir, 'package.json'));
  if (!expected) problems.push('the root package.json has no readable version');
  else if (expected === UNSET_VERSION) problems.push(`the root package.json reports the sentinel ${UNSET_VERSION}`);
  if (!packed) problems.push('resources\\app\\package.json has no readable version');
  else if (packed === UNSET_VERSION) {
    problems.push(`resources\\app\\package.json is ${UNSET_VERSION}: no version was injected ` +
      '(build with `npm run dist`, or pass --config.extraMetadata.version)');
  } else if (expected && packed !== expected) {
    problems.push(`resources\\app\\package.json is ${packed} but the root package.json says ${expected}`);
  }

  // 2. Build settings this design depends on.
  if (!existsSync(path.join(appOutDir, EXE_NAME))) problems.push(`${EXE_NAME} is not in ${appOutDir}`);
  if (config.asar !== false) problems.push('`asar` must stay false (electron-builder.yml explains why)');
  if (winOptions.signAndEditExecutable === false) {
    problems.push('`win.signAndEditExecutable` is false: the exe would keep Electron\'s icon and version, ' +
      'and the afterSign version check would never run');
  }
  const fuses = config.electronFuses;
  if (fuses && fuses.runAsNode === false) {
    problems.push('`electronFuses.runAsNode` is false: Claude Desktop starts the MCP bridge as ' +
      `${EXE_NAME} with ELECTRON_RUN_AS_NODE=1, which this fuse would silently disable`);
  }

  // 3. The app's runtime dependencies are inside the bundle.
  let deps = {};
  try { deps = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).dependencies || {}; } catch { /* reported above */ }
  for (const dep of Object.keys(deps)) {
    if (!existsSync(path.join(appDir, 'node_modules', ...dep.split('/'), 'package.json'))) {
      problems.push(`resources\\app\\node_modules has no ${dep} (the app would start only inside the checkout)`);
    }
  }

  // 4. MinGit is exactly what fetch-mingit.mjs verified.
  const manifestPath = path.join(vendorDir, STAGE_DIR_NAME, MANIFEST_FILE);
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch {
    problems.push(`no MinGit manifest at ${manifestPath}: run \`node lib/fetch-mingit.mjs\` before building`);
  }
  if (manifest) {
    if (manifest.sha256 !== MINGIT.sha256 || manifest.version !== MINGIT.version) {
      problems.push(`the MinGit manifest is for ${manifest.version} (${manifest.sha256}), not the pinned ` +
        `${MINGIT.version} (${MINGIT.sha256})`);
    }
    for (const req of REQUIRED_FILES) {
      if (!manifest.files || !manifest.files[req]) problems.push(`the MinGit manifest lists no ${req}`);
    }
    const tree = checkTreeAgainstManifest(path.join(resources, BUNDLED_GIT_DIR), manifest);
    if (!tree.ok) {
      const shown = tree.problems.slice(0, 10);
      problems.push(`resources\\${BUNDLED_GIT_DIR} is not the verified MinGit: ${shown.join('; ')}` +
        (tree.problems.length > shown.length ? ` (and ${tree.problems.length - shown.length} more)` : ''));
    }
  }
  const notices = path.join(resources, NOTICES_FILE);
  if (!existsSync(notices)) problems.push(`resources\\${NOTICES_FILE} is missing`);
  else if (!readFileSync(notices, 'utf8').includes(`MinGit ${MINGIT.version}`)) {
    problems.push(`resources\\${NOTICES_FILE} does not name MinGit ${MINGIT.version}`);
  }

  // 5. Tray icons (desktop/main.js loads them from resources\app\build\).
  for (const f of TRAY_ICON_FILES) {
    if (!existsSync(path.join(appDir, 'build', f))) problems.push(`resources\\app\\build\\${f} is missing`);
  }

  if (problems.length) throw refuse('the packed app is not what ships', problems);

  // 6. The marker, written last and read back.
  const marker = path.join(appDir, BUNDLE_MARKER_FILE);
  writeFileSync(marker, MARKER_TEXT);
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== MARKER_TEXT) {
    throw refuse('the bundle marker did not stick', [`${marker} could not be read back`]);
  }
  log(`  • version identity  version=${expected} (resources\\app\\package.json matches the root package.json)`);
  log(`  • bundled git       MinGit ${MINGIT.version}, ${Object.keys(manifest.files).length} files, unmodified`);
  log(`  • bundle marker     ${marker}`);
  return { version: expected, marker };
}

/**
 * The win32 check after electron-builder edited the exe's resources. Throws on
 * refusal; returns {version, info, wire}.
 */
export function winAfterSign({ appOutDir, repoRoot = repoRootFrom(DESKTOP_DIR), log = (m) => console.log(m) }) {
  const exe = path.join(appOutDir, EXE_NAME);
  let buf;
  try { buf = readFileSync(exe); } catch (err) {
    throw refuse('the executable cannot be read', [`${exe}: ${err.message}`]);
  }
  const expected = readManifestVersion(path.join(repoRoot, 'package.json'));
  const problems = [];
  let info = null;
  try { info = readPeVersionInfo(buf); } catch (err) { problems.push(`version resource: ${err.message}`); }
  const verdict = checkExeVersion({ expected, info });
  problems.push(...verdict.problems);
  let wire = null;
  try { wire = readFuseWire(buf); } catch (err) { problems.push(`fuses: ${err.message}`); }
  if (wire && !runAsNodeEnabled(wire)) {
    problems.push(`the RunAsNode fuse is not enabled (wire v${wire.version}, state ` +
      `${JSON.stringify(String.fromCharCode(wire.states[FUSE_RUN_AS_NODE] ?? 63))}): ` +
      'Claude Desktop could not start the MCP bridge');
  }
  if (!existsSync(path.join(appOutDir, 'resources', 'app', BUNDLE_MARKER_FILE))) {
    problems.push('the bundle marker is gone (afterPack wrote it)');
  }
  if (problems.length) throw refuse(`${EXE_NAME} does not say what it should`, problems);
  log(`  • exe version       ${info.strings.ProductVersion} (${EXE_NAME} matches the root package.json)`);
  log('  • fuses             RunAsNode enabled (the MCP bridge can start)');
  return { version: expected, info, wire };
}

/**
 * electron-builder's `afterSign` hook (named in electron-builder.yml). Does
 * nothing at all unless the platform is win32, so the Mac build is unchanged.
 */
export async function afterSign(context) {
  if (!context || context.electronPlatformName !== 'win32') return undefined;
  return winAfterSign({ appOutDir: context.appOutDir });
}

export default afterSign;
