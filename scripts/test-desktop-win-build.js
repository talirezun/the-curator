#!/usr/bin/env node
/**
 * test-desktop-win-build.js — OFFLINE suite for the Windows app's BUILD:
 * electron-builder.yml's `win`/`nsis` blocks, the win32 afterPack/afterSign
 * (desktop/lib/win-pack.mjs), MinGit's fetch-and-verify
 * (desktop/lib/fetch-mingit.mjs), the generated icons (desktop/build/), and
 * the Mac path staying exactly as it was.
 *
 * Nothing here builds a Windows executable or downloads anything. Every rule
 * is driven against fabricated inputs: a fake `win-unpacked` tree, a PE file
 * this suite assembles byte by byte (with a real VS_VERSIONINFO and an Electron
 * fuse wire), zip files this suite writes itself, and an injected fetch. Where
 * the developer machine happens to have desktop/node_modules (resedit, js-yaml,
 * builder-util-runtime, a real Electron binary, electron-builder's NSIS
 * templates), a DUMB CROSS-CHECK runs against the real thing; in CI it says it
 * was skipped. What only the windows-latest build can prove is listed at the end.
 *
 * Sections:
 *   §1  electron-builder.yml: the win/nsis shape the owner asked for
 *   §2  the names other packages rely on (AUMID, GUID, marker, git folder, exe)
 *   §3  the PE version reader and the fuse-wire reader, on assembled files
 *   §4  the win32 afterPack on a fake unpacked tree: success, every refusal
 *   §5  the win32 afterSign: version resource and RunAsNode, every refusal
 *   §6  the Mac path: untouched by both hooks
 *   §7  fetch-mingit: the pin, verify-before-extract, the zip reader's refusals
 *   §8  the icons: regenerated in memory, compared pixel by pixel
 *   §9  dist: --win on win32, --mac everywhere else
 *   §10 installer.nsh macros (source scan, weak) + template cross-check
 *   §11 what only the windows-latest build proves
 */

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, chmodSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deflateRawSync, inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const EB_YML = path.join(DESKTOP, 'electron-builder.yml');
const DESKTOP_NM = path.join(DESKTOP, 'node_modules');
const imp = (p) => import(pathToFileURL(p).href);

const wp = await imp(path.join(DESKTOP, 'lib', 'win-pack.mjs'));
const fm = await imp(path.join(DESKTOP, 'lib', 'fetch-mingit.mjs'));
const ap = await imp(path.join(DESKTOP, 'lib', 'after-pack.mjs'));
const av = await imp(path.join(DESKTOP, 'lib', 'app-version.js'));
const icons = await imp(path.join(DESKTOP, 'build', 'make-win-icons.mjs'));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  const good = JSON.stringify(a) === JSON.stringify(b);
  if (good) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
}
function section(t) { console.log(`\n${t}`); }
function skip(label) { console.log(`  ⊘ ${label}`); }
function throwsMsg(fn) { try { fn(); return null; } catch (e) { return e.message; } }
async function rejectsMsg(fn) { try { await fn(); return null; } catch (e) { return e.message; } }

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'curator-winbuild-'));
process.on('exit', () => { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ } });
const quiet = () => {};

// ── YAML: comment stripping and block reading (no YAML library offline) ─────

function stripYamlComments(src) {
  return src.split('\n').map((line) => {
    let out = '', qc = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (qc) { out += ch; if (ch === qc && line[i - 1] !== '\\') qc = null; continue; }
      if (ch === '"' || ch === "'") { qc = ch; out += ch; continue; }
      if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
      out += ch;
    }
    return out.replace(/\s+$/, '');
  }).join('\n');
}
/** The lines of one top-level block (`key:` at column 0), comments stripped. */
function topBlock(src, key) {
  const lines = stripYamlComments(src).split('\n');
  const start = lines.findIndex((l) => l === `${key}:`);
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    if (lines[i].trim()) out.push(lines[i]);
  }
  return out;
}
/** `  key: value` pairs at exactly two spaces of indentation. */
function scalars(block) {
  const o = {};
  for (const l of block || []) {
    const m = l.match(/^ {2}([A-Za-z]+):\s+(.+)$/);
    if (m) o[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return o;
}
const ymlSrc = readFileSync(EB_YML, 'utf8');
const ymlCode = stripYamlComments(ymlSrc);
const topScalar = (k) => { const m = ymlCode.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : null; };

// ═════════════════════════════════════════════════════════════════════════════
section('§1  electron-builder.yml: the Windows target and the installer the owner asked for');
// ═════════════════════════════════════════════════════════════════════════════

const winBlock = topBlock(ymlSrc, 'win');
const nsisBlock = topBlock(ymlSrc, 'nsis');
ok(winBlock && winBlock.length > 0, 'a top-level `win:` block exists');
ok(nsisBlock && nsisBlock.length > 0, 'a top-level `nsis:` block exists');
const win = scalars(winBlock);
const nsis = scalars(nsisBlock);
eq(win.icon, 'build/icon.ico', 'win.icon is the generated build/icon.ico');
eq(win.signAndEditExecutable, 'true', 'win.signAndEditExecutable is true (icon + version written into the exe; no certificate)');
const winText = (winBlock || []).join('\n');
ok(/^ {2}target:\n {4}- target: nsis\n {6}arch:\n {8}- x64$/m.test(winText), 'win.target is exactly NSIS, x64 only (D6)');
ok(!/arm64|ia32|portable|squirrel|appx|msi/.test(winText), 'no other Windows target or architecture');
eq(nsis.oneClick, 'false', 'nsis.oneClick false: an assisted installer with Welcome/Finish pages');
eq(nsis.perMachine, 'false', 'nsis.perMachine false: per user');
eq(nsis.allowElevation, 'false', 'nsis.allowElevation false: never a UAC prompt');
eq(nsis.allowToChangeInstallationDirectory, 'false', 'no folder choice (the install path is fixed and known to the updater)');
eq(nsis.createDesktopShortcut, 'true', 'a Desktop shortcut');
eq(nsis.createStartMenuShortcut, 'true', 'a Start-menu shortcut');
eq(nsis.shortcutName, 'The Curator', 'both shortcuts are named "The Curator" (D3)');
eq(nsis.runAfterFinish, 'true', 'runAfterFinish: "Run The Curator" on the Finish page, so the app opens');
eq(nsis.deleteAppDataOnUninstall, 'false', 'deleteAppDataOnUninstall false (pinned explicitly, not left to the default)');
eq(nsis.differentialPackage, 'false', 'no blockmap (nothing reads one; no electron-updater)');
eq(nsis.artifactName, 'TheCurator-${version}-${arch}-Windows-Setup.${ext}', 'the installer is named TheCurator-<X.Y.Z>-x64-Windows-Setup.exe');
eq(nsis.include, 'build/installer.nsh', 'nsis.include is build/installer.nsh');
ok(existsSync(path.join(DESKTOP, 'build', 'installer.nsh')), '  └─ and that file exists');
ok(!/^\s*(guid|menuCategory|perMachine:\s*true|oneClick:\s*true)/m.test((nsisBlock || []).join('\n').replace(/^ {2}perMachine: false$/m, '')),
  'no nsis.guid (the GUID is derived from appId), no menu folder');
eq(topScalar('afterSign'), './lib/win-pack.mjs', 'afterSign is lib/win-pack.mjs (the exe version + fuse check)');
eq(topScalar('afterPack'), './lib/after-pack.mjs', 'afterPack is still lib/after-pack.mjs');
eq(topScalar('asar'), 'false', 'asar stays false');
eq(topScalar('publish'), 'null', 'publish stays null (no latest.yml, no upload)');
ok(!/^electronFuses:/m.test(ymlCode) && !/^\s+electronFuses:/m.test(ymlCode),
  'NO electronFuses anywhere: the RunAsNode fuse stays at Electron\'s default, ON (the MCP bridge needs it)');
{
  // extraResources, as parsed pairs.
  const pairs = [];
  const lines = winBlock || [];
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^ {4}- from: (.+)$/);
    const t = lines[i + 1] && lines[i + 1].match(/^ {6}to: (.+)$/);
    if (f && t) pairs.push([f[1], t[1]]);
  }
  eq(pairs, [
    ['vendor/mingit/git', 'git'],
    ['vendor/mingit/THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES.txt'],
    ['build/tray.ico', 'app/build/tray.ico'],
    ['build/tray.png', 'app/build/tray.png'],
    ['build/tray@2x.png', 'app/build/tray@2x.png'],
  ], 'win.extraResources: MinGit → resources\\git, the notices, and the tray icons → resources\\app\\build');
  // The top-level extraResources (node_modules) is untouched.
  const top = topBlock(ymlSrc, 'extraResources').join('\n');
  ok(/- from: \.\.\/node_modules\n {4}to: app\/node_modules/.test(top), 'the top-level extraResources still ships node_modules → app/node_modules');
}
// The DUMB CROSS-CHECK: the real YAML parser (developer machine only).
{
  const yamlPath = path.join(DESKTOP_NM, 'js-yaml');
  if (existsSync(yamlPath)) {
    const req = createRequire(path.join(DESKTOP, 'package.json'));
    const cfg = req('js-yaml').load(ymlSrc);
    eq([cfg.win.target, cfg.nsis.oneClick, cfg.nsis.perMachine, cfg.nsis.runAfterFinish, cfg.nsis.artifactName, cfg.afterSign, cfg.electronFuses],
      [[{ target: 'nsis', arch: ['x64'] }], false, false, true, 'TheCurator-${version}-${arch}-Windows-Setup.${ext}', './lib/win-pack.mjs', undefined],
      'CROSS-CHECK: js-yaml reads the same win/nsis values as the line reader above');
    try {
      const { validateConfiguration } = req('app-builder-lib/out/util/config/config.js');
      const { DebugLogger } = req('builder-util');
      const err = await rejectsMsg(() => validateConfiguration(cfg, new DebugLogger(false)));
      ok(err === null, `CROSS-CHECK: electron-builder 26's own schema accepts the config${err ? ` (${err})` : ''}`);
    } catch (e) { skip(`electron-builder schema check unavailable (${e.message})`); }
  } else {
    skip('js-yaml / electron-builder schema cross-check: desktop/node_modules is not installed here (CI)');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
section('§2  The names other packages rely on');
// ═════════════════════════════════════════════════════════════════════════════

eq(topScalar('appId'), wp.APP_ID, `appId is ${wp.APP_ID}`);
eq(wp.APP_USER_MODEL_ID, topScalar('appId'), 'APP_USER_MODEL_ID (what main.js must pass to setAppUserModelId) equals appId, which NSIS stamps on the shortcuts');
eq(topScalar('productName'), wp.PRODUCT_NAME, 'productName is "The Curator"');
eq(wp.EXE_NAME, `${topScalar('productName')}.exe`, 'the exe is "<productName>.exe" = "The Curator.exe" (no executableName override)');
ok(!/^\s*executableName:/m.test(ymlCode), '  └─ and no executableName anywhere to change it');
eq(wp.INSTALL_DIR_NAME, 'The Curator', 'install folder %LOCALAPPDATA%\\Programs\\The Curator');
eq(wp.UNINSTALLER_NAME, 'Uninstall The Curator.exe', 'the uninstaller F uses to recognise an NSIS install');
{
  // UUID v5 (RFC 4122) of appId in electron-builder's namespace, computed here
  // from first principles.
  const ns = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex');
  const h = createHash('sha1').update(Buffer.concat([ns, Buffer.from(wp.APP_ID, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  const v5 = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  eq(wp.NSIS_GUID, v5, `NSIS_GUID is UUID v5(appId) = ${v5}`);
  eq(wp.UNINSTALL_REGISTRY_KEY, `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${v5}`, 'the HKCU Apps & features key install.ps1 (D3) can look for');
  if (existsSync(path.join(DESKTOP_NM, 'builder-util-runtime'))) {
    const req = createRequire(path.join(DESKTOP, 'package.json'));
    const { UUID } = req('builder-util-runtime');
    eq(UUID.v5(wp.APP_ID, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')), wp.NSIS_GUID, 'CROSS-CHECK: electron-builder\'s own UUID.v5 agrees');
  } else skip('builder-util-runtime GUID cross-check: not installed here');
}
const paths = await imp(path.join(ROOT, 'src', 'brain', 'paths.js'));
eq(wp.BUNDLE_MARKER_FILE, paths.BUNDLE_MARKER_FILE, 'the marker afterPack writes is the one src/brain/paths.js reads');
const senv = await imp(path.join(ROOT, 'src', 'brain', 'subprocess-env.js'));
eq(wp.BUNDLED_GIT_DIR, senv.BUNDLED_GIT_FOLDER, 'resources\\git is where src/brain/subprocess-env.js looks for the bundled git');
eq(senv.bundledGitLocation('C:\\P\\The Curator\\resources\\app').exe, 'C:\\P\\The Curator\\resources\\git\\cmd\\git.exe',
  '  └─ which resolves to resources\\git\\cmd\\git.exe, a file fetch-mingit REQUIRES in the archive');
ok(fm.REQUIRED_FILES.includes('cmd/git.exe'), '  └─ (cmd/git.exe is in REQUIRED_FILES)');
eq(wp.installerFileName('3.99.3'), 'TheCurator-3.99.3-x64-Windows-Setup.exe', 'installerFileName(3.99.3)');
eq(nsis.artifactName.replace('${version}', '3.99.3').replace('${arch}', 'x64').replace('${ext}', 'exe'),
  wp.installerFileName('3.99.3'), '  └─ equals the artifactName macro expanded the way electron-builder does');

// ═════════════════════════════════════════════════════════════════════════════
section('§3  Reading a Windows executable: version resource and fuse wire');
// ═════════════════════════════════════════════════════════════════════════════

/** A VS_VERSIONINFO-style block, built here independently of the reader. */
function vblock(key, { value = Buffer.alloc(0), type = 0, valueLength = null, children = [] } = {}) {
  const keyBuf = Buffer.from(`${key}\0`, 'utf16le');
  const pad = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const head = Buffer.alloc(6);
  let body = pad(Buffer.concat([head, keyBuf]));
  body = Buffer.concat([body, value]);
  body = pad(body);
  for (const c of children) body = Buffer.concat([body, pad(c)]);
  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(valueLength ?? value.length, 2);
  body.writeUInt16LE(type, 4);
  return body;
}
function vstring(key, text) {
  const v = Buffer.from(`${text}\0`, 'utf16le');
  return vblock(key, { value: v, type: 1, valueLength: text.length + 1 });
}
function versionResource({ file = [3, 99, 3, 0], product = [3, 99, 3, 0], strings = {} } = {}) {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xFEEF04BD, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  fixed.writeUInt32LE(((file[0] << 16) | file[1]) >>> 0, 8);
  fixed.writeUInt32LE(((file[2] << 16) | file[3]) >>> 0, 12);
  fixed.writeUInt32LE(((product[0] << 16) | product[1]) >>> 0, 16);
  fixed.writeUInt32LE(((product[2] << 16) | product[3]) >>> 0, 20);
  const table = vblock('040904b0', { type: 1, children: Object.entries(strings).map(([k, v]) => vstring(k, v)) });
  const sfi = vblock('StringFileInfo', { type: 1, children: [table] });
  const translation = Buffer.alloc(4); translation.writeUInt16LE(0x0409, 0); translation.writeUInt16LE(1200, 2);
  const vfi = vblock('VarFileInfo', { type: 1, children: [vblock('Translation', { value: translation })] });
  return vblock('VS_VERSION_INFO', { value: fixed, children: [sfi, vfi] });
}
/** A minimal PE32+ file with one .rsrc section holding RT_VERSION, plus optional trailing bytes. */
function assemblePe(versionRes, { trailer = Buffer.alloc(0), pe32 = false } = {}) {
  const VA = 0x1000, RAW = 0x400;
  // Resource tree: root → type 16 → name 1 → lang 0x409 → data entry → data.
  const dir = (entries) => {
    const b = Buffer.alloc(16 + 8 * entries.length);
    b.writeUInt16LE(entries.length, 14);
    entries.forEach(([id, off], i) => { b.writeUInt32LE(id, 16 + i * 8); b.writeUInt32LE(off >>> 0, 20 + i * 8); });
    return b;
  };
  const d1 = 0, d2 = 24, d3 = 48, de = 72, data = 88;
  const rsrc = Buffer.concat([
    dir([[16, (d2 | 0x80000000) >>> 0]]), dir([[1, (d3 | 0x80000000) >>> 0]]), dir([[0x409, de]]),
    (() => { const b = Buffer.alloc(16); b.writeUInt32LE(VA + data, 0); b.writeUInt32LE(versionRes.length, 4); return b; })(),
    versionRes,
  ]);
  void d1;
  const optSize = pe32 ? 224 : 240;
  const headers = Buffer.alloc(RAW);
  headers.write('MZ', 0, 'latin1');
  headers.writeUInt32LE(0x80, 0x3C);
  const pe = 0x80;
  headers.write('PE\0\0', pe, 'latin1');
  headers.writeUInt16LE(pe32 ? 0x14C : 0x8664, pe + 4);
  headers.writeUInt16LE(1, pe + 6);
  headers.writeUInt16LE(optSize, pe + 20);
  const opt = pe + 24;
  headers.writeUInt16LE(pe32 ? 0x10B : 0x20B, opt);
  const ddCount = pe32 ? opt + 92 : opt + 108;
  const dd = pe32 ? opt + 96 : opt + 112;
  headers.writeUInt32LE(16, ddCount);
  headers.writeUInt32LE(VA, dd + 16);
  headers.writeUInt32LE(rsrc.length, dd + 20);
  const sec = opt + optSize;
  headers.write('.rsrc', sec, 'latin1');
  headers.writeUInt32LE(rsrc.length, sec + 8);
  headers.writeUInt32LE(VA, sec + 12);
  headers.writeUInt32LE(rsrc.length, sec + 16);
  headers.writeUInt32LE(RAW, sec + 20);
  return Buffer.concat([headers, rsrc, trailer]);
}
function fuseWire(states = '101100011') {
  return Buffer.concat([Buffer.from('xx' + wp.FUSE_SENTINEL, 'latin1'), Buffer.from([1, states.length]), Buffer.from(states, 'latin1'), Buffer.from('yy')]);
}
const GOOD_STRINGS = { FileDescription: 'The Curator', ProductName: 'The Curator', FileVersion: '3.99.3', ProductVersion: '3.99.3.0', LegalCopyright: 'x' };

{
  const exe = assemblePe(versionResource({ strings: GOOD_STRINGS }), { trailer: fuseWire() });
  const info = wp.readPeVersionInfo(exe);
  eq(info.fixed, { fileVersion: '3.99.3.0', productVersion: '3.99.3.0' }, 'fixed FileVersion/ProductVersion read from VS_FIXEDFILEINFO');
  eq([info.strings.FileVersion, info.strings.ProductVersion, info.strings.ProductName], ['3.99.3', '3.99.3.0', 'The Curator'],
    'StringFileInfo values read (FileVersion, ProductVersion, ProductName)');
  const info32 = wp.readPeVersionInfo(assemblePe(versionResource({ strings: GOOD_STRINGS }), { pe32: true }));
  eq(info32.fixed.productVersion, '3.99.3.0', 'a PE32 (not PE32+) header is read too');
  ok(/MZ/.test(throwsMsg(() => wp.readPeVersionInfo(Buffer.from('not an exe at all, just text..........................................'))) || ''),
    'a non-executable is refused with a reason');
  const noRes = Buffer.from(exe); noRes.writeUInt32LE(0, 0x80 + 24 + 112 + 16); // resource RVA = 0
  eq(wp.readPeVersionInfo(noRes), null, 'an exe with no resource directory has no version info (null)');
  const wire = wp.readFuseWire(exe);
  eq([wire.version, wire.states.length, wp.runAsNodeEnabled(wire)], [1, 9, true], 'fuse wire: v1, 9 fuses, RunAsNode enabled');
  eq(wp.runAsNodeEnabled(wp.readFuseWire(fuseWire('001100011'))), false, 'RunAsNode "0" (disabled) is detected');
  eq(wp.runAsNodeEnabled(wp.readFuseWire(fuseWire('r01100011'))), false, 'RunAsNode "r" (removed) is detected');
  ok(/more than once/.test(throwsMsg(() => wp.readFuseWire(Buffer.concat([fuseWire(), fuseWire()]))) || ''), 'two fuse sentinels are refused (which one would Electron read?)');
  ok(/no Electron fuse/.test(throwsMsg(() => wp.readFuseWire(Buffer.from('nothing here'))) || ''), 'no sentinel is refused');

  // checkExeVersion
  eq(wp.checkExeVersion({ expected: '3.99.3', info }).ok, true, 'checkExeVersion accepts 3.99.3 / 3.99.3.0');
  const bad = (strings, fixed) => wp.checkExeVersion({ expected: '3.99.3', info: { fixed: fixed ?? info.fixed, strings: { ...GOOD_STRINGS, ...strings } } });
  ok(!bad({ ProductVersion: '43.8.3.0' }).ok, 'refuses Electron\'s own version left in ProductVersion');
  ok(!bad({ FileVersion: '0.0.0' }).ok && /sentinel/.test(bad({ FileVersion: '0.0.0' }).problems.join()), 'refuses the 0.0.0 sentinel, naming it');
  ok(!bad({}, { fileVersion: '3.99.30.0', productVersion: '3.99.3.0' }).ok, 'refuses 3.99.30 (a prefix is not a match)');
  ok(!bad({ ProductName: 'Electron' }).ok, 'refuses ProductName "Electron"');
  ok(!bad({ ProductVersion: undefined }).ok, 'refuses an unreadable ProductVersion');
  ok(!wp.checkExeVersion({ expected: '0.0.0', info }).ok, 'refuses when the ROOT says 0.0.0');
  ok(!wp.checkExeVersion({ expected: '3.99.3', info: null }).ok, 'refuses an exe with no version resource');
  ok(bad({ ProductVersion: '3.99.3.7' }).ok, 'accepts a fourth (build) number: Windows wants four');
}
// CROSS-CHECK against electron-builder's own resource editor on a real PE.
{
  const resedit = path.join(DESKTOP_NM, 'resedit');
  const realExe = path.join(DESKTOP_NM, 'electron-winstaller', 'vendor', '7z.exe');
  if (existsSync(resedit) && existsSync(realExe)) {
    const req = createRequire(path.join(DESKTOP, 'package.json'));
    const R = req('resedit');
    const exe = R.NtExecutable.from(readFileSync(realExe));
    const res = R.NtExecutableResource.from(exe);
    const viList = R.Resource.VersionInfo.fromEntries(res.entries);
    const vi = viList.length ? viList[0] : R.Resource.VersionInfo.createEmpty();
    const langs = vi.getAllLanguagesForStringValues();
    const lang = langs.length ? langs[0] : { lang: 0x409, codepage: 1200 };
    // Exactly what app-builder-lib/out/util/resEdit.js does.
    vi.setStringValues(lang, { FileDescription: 'The Curator', ProductName: 'The Curator', LegalCopyright: 'c' });
    vi.setFileVersion('3.99.3');
    vi.setProductVersion('3.99.3.0');
    vi.setStringValues(lang, { FileVersion: '3.99.3' });
    vi.outputToResourceEntries(res.entries);
    res.outputResource(exe);
    const out = Buffer.from(exe.generate());
    const info = wp.readPeVersionInfo(out);
    eq([info.fixed.fileVersion, info.fixed.productVersion, info.strings.FileVersion, info.strings.ProductVersion, info.strings.ProductName],
      ['3.99.3.0', '3.99.3.0', '3.99.3', '3.99.3.0', 'The Curator'],
      'CROSS-CHECK: a real PE edited by resedit the way electron-builder edits The Curator.exe reads back right');
    eq(wp.checkExeVersion({ expected: '3.99.3', info }).ok, true, '  └─ and passes checkExeVersion');
  } else skip('resedit cross-check on a real PE: desktop/node_modules is not installed here (CI)');
  const fw = path.join(DESKTOP_NM, 'electron', 'dist', 'Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework');
  if (existsSync(fw)) {
    const wire = wp.readFuseWire(readFileSync(fw));
    eq([wire.version, wp.runAsNodeEnabled(wire)], [1, true], 'CROSS-CHECK: the real Electron binary\'s fuse wire reads v1 with RunAsNode ON (the default we keep)');
  } else skip('real Electron fuse-wire cross-check: no Electron binary here (CI)');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§4  The win32 afterPack on a fake unpacked tree');
// ═════════════════════════════════════════════════════════════════════════════

const ROOT_VERSION = '3.99.3';
const FAKE_DEPS = { dotenv: '^16', '@scope/pkg': '^1' };
function makeRepoRoot(dir, version = ROOT_VERSION) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version, dependencies: FAKE_DEPS }));
  return dir;
}
const GIT_FILES = {
  'cmd/git.exe': Buffer.from('MZ fake git launcher'),
  'LICENSE.txt': Buffer.from('GNU GENERAL PUBLIC LICENSE\nVersion 2\n'),
  'etc/package-versions.txt': Buffer.from('git 2.56.1.windows.1\ncurl 8.0\n'),
  'mingw64/bin/git.exe': Buffer.alloc(3000, 7),
};
function makeVendor(dir, files = GIT_FILES) {
  const stage = path.join(dir, fm.STAGE_DIR_NAME);
  mkdirSync(stage, { recursive: true });
  const manifest = { version: fm.MINGIT.version, tag: fm.MINGIT.tag, sha256: fm.MINGIT.sha256, size: fm.MINGIT.size, files: {}, dirs: [] };
  for (const [rel, data] of Object.entries(files)) manifest.files[rel] = { size: data.length, crc32: fm.crc32(data) };
  writeFileSync(path.join(stage, fm.MANIFEST_FILE), JSON.stringify(manifest));
  return dir;
}
function makeUnpacked(dir, { version = ROOT_VERSION, files = GIT_FILES, exe = true, deps = Object.keys(FAKE_DEPS), notices = true, tray = wp.TRAY_ICON_FILES } = {}) {
  const res = path.join(dir, 'resources');
  const app = path.join(res, 'app');
  mkdirSync(app, { recursive: true });
  if (exe) writeFileSync(path.join(dir, wp.EXE_NAME), assemblePe(versionResource({ strings: GOOD_STRINGS }), { trailer: fuseWire() }));
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'the-curator-desktop', version, main: 'main.js' }));
  for (const d of deps) {
    mkdirSync(path.join(app, 'node_modules', ...d.split('/')), { recursive: true });
    writeFileSync(path.join(app, 'node_modules', ...d.split('/'), 'package.json'), '{}');
  }
  for (const [rel, data] of Object.entries(files)) {
    const t = path.join(res, 'git', ...rel.split('/'));
    mkdirSync(path.dirname(t), { recursive: true });
    writeFileSync(t, data);
  }
  if (notices) writeFileSync(path.join(res, fm.NOTICES_FILE), fm.thirdPartyNotices({ components: ['git 2.56.1.windows.1'] }));
  mkdirSync(path.join(app, 'build'), { recursive: true });
  for (const f of tray) writeFileSync(path.join(app, 'build', f), 'x');
  return dir;
}
const GOOD_CONFIG = { asar: false };
let caseN = 0;
function packCase(mutate = {}) {
  const base = path.join(SCRATCH, `pack-${++caseN}`);
  const repo = makeRepoRoot(path.join(base, 'repo'), mutate.rootVersion ?? ROOT_VERSION);
  const vendor = mutate.noVendor ? path.join(base, 'vendor-none') : makeVendor(path.join(base, 'vendor'), mutate.vendorFiles ?? GIT_FILES);
  if (mutate.vendorManifest) {
    const p = path.join(vendor, fm.STAGE_DIR_NAME, fm.MANIFEST_FILE);
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), ...mutate.vendorManifest }));
  }
  const out = makeUnpacked(path.join(base, 'win-unpacked'), mutate.unpacked || {});
  if (mutate.after) mutate.after(out);
  const marker = path.join(out, 'resources', 'app', wp.BUNDLE_MARKER_FILE);
  const err = throwsMsg(() => wp.winAfterPack({
    appOutDir: out, repoRoot: repo, vendorDir: vendor, log: quiet,
    config: mutate.config ?? GOOD_CONFIG, winOptions: mutate.winOptions ?? { signAndEditExecutable: true },
  }));
  return { err, marker, markerWritten: existsSync(marker), out, repo, vendor };
}
{
  const good = packCase();
  ok(good.err === null, `a correct tree passes${good.err ? ` (${good.err})` : ''}`);
  ok(good.markerWritten, 'and resources\\app\\.curator-bundle is WRITTEN');
  eq(readFileSync(good.marker, 'utf8'), wp.MARKER_TEXT, '  └─ with the explanatory text, read back');
  // paths.js really takes that tree for a bundle (marker = the only signal on win32).
  const appRoot = path.join(good.out, 'resources', 'app');
  ok(existsSync(path.join(appRoot, paths.BUNDLE_MARKER_FILE)), '  └─ at the APP_ROOT paths.js probes (resources\\app)');
}
const REFUSALS = [
  ['the packed version is the 0.0.0 sentinel', { unpacked: { version: '0.0.0' } }, /sentinel|no version was injected/],
  ['the packed version differs from the root', { unpacked: { version: '3.99.2' } }, /3\.99\.2.*3\.99\.3/],
  ['the root version is the sentinel', { rootVersion: '0.0.0' }, /sentinel/],
  ['The Curator.exe is missing', { unpacked: { exe: false } }, /The Curator\.exe is not/],
  ['a runtime dependency is missing from resources\\app\\node_modules', { unpacked: { deps: ['dotenv'] } }, /@scope\/pkg/],
  ['asar is not false', { config: { asar: true } }, /asar/],
  ['signAndEditExecutable is false (afterSign would never run)', { winOptions: { signAndEditExecutable: false } }, /signAndEditExecutable/],
  ['electronFuses turns RunAsNode off', { config: { asar: false, electronFuses: { runAsNode: false } } }, /RunAsNode|runAsNode/],
  ['no MinGit manifest (fetch-mingit never ran)', { noVendor: true }, /fetch-mingit/],
  ['the manifest is for another MinGit', { vendorManifest: { sha256: 'f'.repeat(64) } }, /not the pinned/],
  ['a MinGit file changed after verification', { after: (o) => writeFileSync(path.join(o, 'resources', 'git', 'LICENSE.txt'), 'GNU GENERAL PUBLIC LICENSE\nVersion 3\n') }, /changed (bytes|size): LICENSE\.txt/],
  ['a MinGit file is missing from the package', { after: (o) => rmSync(path.join(o, 'resources', 'git', 'mingw64', 'bin', 'git.exe')) }, /missing: mingw64\/bin\/git\.exe/],
  ['an extra file appeared in resources\\git', { after: (o) => writeFileSync(path.join(o, 'resources', 'git', 'evil.dll'), 'x') }, /not in MinGit: evil\.dll/],
  ['the manifest lacks LICENSE.txt', { vendorFiles: Object.fromEntries(Object.entries(GIT_FILES).filter(([k]) => k !== 'LICENSE.txt')), after: (o) => rmSync(path.join(o, 'resources', 'git', 'LICENSE.txt')) }, /LICENSE\.txt/],
  ['THIRD-PARTY-NOTICES.txt is missing', { unpacked: { notices: false } }, /THIRD-PARTY-NOTICES/],
  ['the notices do not name the pinned MinGit', { after: (o) => writeFileSync(path.join(o, 'resources', fm.NOTICES_FILE), 'MinGit 1.0') }, /does not name MinGit/],
  ['a tray icon is missing', { unpacked: { tray: ['tray.ico'] } }, /tray\.png/],
];
for (const [label, mutate, re] of REFUSALS) {
  const r = packCase(mutate);
  ok(r.err !== null && re.test(r.err) && /BUILD REFUSED \(Windows\)/.test(r.err) && !r.markerWritten,
    `REFUSED, no marker written: ${label}${r.err && !re.test(r.err) ? ` (said: ${r.err.split('\n').slice(0, 3).join(' ')})` : ''}${r.err ? '' : ' (it PASSED)'}`);
}
{
  // Against the REAL root package.json: its real dependency list must be checked.
  const realDeps = Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies);
  const base = path.join(SCRATCH, 'pack-real');
  const vendor = makeVendor(path.join(base, 'vendor'));
  const out = makeUnpacked(path.join(base, 'win-unpacked'), { version: JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, deps: realDeps.slice(1) });
  const err = throwsMsg(() => wp.winAfterPack({ appOutDir: out, vendorDir: vendor, log: quiet, config: GOOD_CONFIG }));
  ok(err && err.includes(realDeps[0]), `with the real root manifest, a missing ${realDeps[0]} (of ${realDeps.length} real dependencies) is refused`);
}

// ═════════════════════════════════════════════════════════════════════════════
section('§5  The win32 afterSign: the exe\'s version and its RunAsNode fuse');
// ═════════════════════════════════════════════════════════════════════════════

function signCase({ strings = GOOD_STRINGS, fixed, fuses = '101100011', marker = true, rootVersion = ROOT_VERSION, exe = true } = {}) {
  const base = path.join(SCRATCH, `sign-${++caseN}`);
  const repo = makeRepoRoot(path.join(base, 'repo'), rootVersion);
  const out = path.join(base, 'win-unpacked');
  mkdirSync(path.join(out, 'resources', 'app'), { recursive: true });
  if (exe) {
    const vr = versionResource({ strings, ...(fixed ? { file: fixed, product: fixed } : {}) });
    writeFileSync(path.join(out, wp.EXE_NAME), assemblePe(vr, { trailer: fuses ? fuseWire(fuses) : Buffer.alloc(0) }));
  }
  if (marker) writeFileSync(path.join(out, 'resources', 'app', wp.BUNDLE_MARKER_FILE), wp.MARKER_TEXT);
  return throwsMsg(() => wp.winAfterSign({ appOutDir: out, repoRoot: repo, log: quiet }));
}
ok(signCase() === null, 'a correct exe (version 3.99.3, RunAsNode on, marker present) passes');
const SIGN_REFUSALS = [
  ['the exe still carries Electron\'s version', { strings: { ...GOOD_STRINGS, ProductVersion: '43.8.3.0', FileVersion: '43.8.3' }, fixed: [43, 8, 3, 0] }, /43\.8\.3/],
  ['the exe says 0.0.0', { strings: { ...GOOD_STRINGS, ProductVersion: '0.0.0.0', FileVersion: '0.0.0' }, fixed: [0, 0, 0, 0] }, /sentinel/],
  ['the root says something else', { rootVersion: '3.99.4' }, /3\.99\.4/],
  ['the RunAsNode fuse is off', { fuses: '001100011' }, /RunAsNode/],
  ['there is no fuse wire', { fuses: null }, /fuse/],
  ['the marker is gone', { marker: false }, /marker/],
  ['the exe is missing', { exe: false }, /cannot be read/],
];
for (const [label, opts, re] of SIGN_REFUSALS) {
  const err = signCase(opts);
  ok(err !== null && re.test(err), `REFUSED: ${label}${err === null ? ' (it PASSED)' : (re.test(err) ? '' : ` (said: ${err.split('\n').slice(0, 3).join(' ')})`)}`);
}
{
  const base = path.join(SCRATCH, 'sign-hook');
  const out = path.join(base, 'win-unpacked');
  mkdirSync(path.join(out, 'resources', 'app'), { recursive: true });
  writeFileSync(path.join(out, wp.EXE_NAME), assemblePe(versionResource({ strings: { ...GOOD_STRINGS, ProductVersion: '43.8.3.0' } }), { trailer: fuseWire() }));
  const err = await rejectsMsg(() => wp.afterSign({ electronPlatformName: 'win32', appOutDir: out }));
  ok(err !== null && /43\.8\.3/.test(err), 'the afterSign HOOK (what electron-builder calls) refuses on win32');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§6  The Mac path: untouched by both hooks');
// ═════════════════════════════════════════════════════════════════════════════

{
  // afterSign on anything but win32 returns without reading anything: given a
  // folder that does not exist, it must neither throw nor create it.
  const ghost = path.join(SCRATCH, 'does-not-exist');
  for (const plat of ['darwin', 'mas', 'linux', undefined]) {
    const err = await rejectsMsg(() => wp.afterSign({ electronPlatformName: plat, appOutDir: ghost }));
    ok(err === null && !existsSync(ghost), `afterSign is a no-op for electronPlatformName=${plat}`);
  }
  // afterPack with a darwin (or absent) platform runs the MAC body: on a
  // Windows-shaped tree it fails the way the Mac body fails (no .app) and
  // writes NO marker; with win32 the same tree passes.
  for (const plat of ['darwin', undefined]) {
    const r = packCase();
    rmSync(r.marker, { force: true });
    const err = await rejectsMsg(() => ap.afterPack({
      electronPlatformName: plat, appOutDir: r.out,
      packager: { platformSpecificBuildOptions: { identity: null }, config: { asar: false } },
    }));
    ok(err !== null && /\.app/.test(err) && !existsSync(r.marker),
      `afterPack with electronPlatformName=${plat} takes the Mac path (looks for the .app), writes no marker`);
  }
  // And win32 never reaches codesign: a fake `codesign` first on PATH records any call.
  if (process.platform !== 'win32') {
    const bin = path.join(SCRATCH, 'spybin');
    const spy = path.join(SCRATCH, 'codesign-called');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'codesign'), `#!/bin/sh\ntouch "${spy}"\nexit 0\n`);
    chmodSync(path.join(bin, 'codesign'), 0o755);
    const r = packCase();
    rmSync(r.marker, { force: true });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    let err;
    try {
      // win-pack's default vendorDir/repoRoot are real; call the composer's branch
      // through the same function it calls, with the fake tree's inputs.
      err = throwsMsg(() => wp.winAfterPack({ appOutDir: r.out, repoRoot: r.repo, vendorDir: r.vendor, log: quiet, config: GOOD_CONFIG }));
      const viaComposer = await rejectsMsg(() => ap.afterPack({
        electronPlatformName: 'win32', appOutDir: r.out,
        packager: { platformSpecificBuildOptions: { signAndEditExecutable: true }, config: GOOD_CONFIG },
      }));
      // The composer uses the REAL repo root and vendor dir, so on a machine
      // with no fetched MinGit it refuses for THAT reason — not for a .app.
      ok(viaComposer === null || (/BUILD REFUSED \(Windows\)/.test(viaComposer) && !/\.app/.test(viaComposer)),
        'afterPack({electronPlatformName:"win32"}) reaches the Windows checks, never the .app/Info.plist ones');
    } finally { process.env.PATH = oldPath; }
    ok(err === null && !existsSync(spy), 'the win32 path never runs codesign (a spy codesign on PATH was not called)');
  } else skip('codesign spy: not meaningful on Windows');
  // The Mac body's source is byte-for-byte the code that was there: the only
  // change to after-pack.mjs is the early-return block in front of it.
  const src = readFileSync(path.join(DESKTOP, 'lib', 'after-pack.mjs'), 'utf8');
  const macBody = src.slice(src.indexOf('  const version = verifyPackedVersion('));
  eq(createHash('sha256').update(macBody).digest('hex'),
    'd5728d5c9850d4d058566f9980cb50bc41d232101989c054750437d0032dddfa', // = the body at win-integration 85f2041
    'the Mac body of afterPack (from verifyPackedVersion to the end) is unchanged');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§7  fetch-mingit: the pin, verify BEFORE extracting, a strict zip reader');
// ═════════════════════════════════════════════════════════════════════════════

eq([fm.MINGIT.version, fm.MINGIT.tag, fm.MINGIT.asset, fm.MINGIT.size, fm.MINGIT.sha256],
  ['2.56.1', 'v2.56.1.windows.1', 'MinGit-2.56.1-64-bit.zip', 39849768, '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd'],
  'the pin: MinGit 2.56.1, 39,849,768 bytes, SHA-256 4a92850b…');
eq(fm.MINGIT.url, `https://github.com/git-for-windows/git/releases/download/${fm.MINGIT.tag}/${fm.MINGIT.asset}`, 'the URL is the git-for-windows release asset for that tag');

/** A zip writer, written here so the reader is tested against something it did not produce. */
function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, e.utf8 ? 'utf8' : 'latin1');
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? (e.name.endsWith('/') ? 0 : 8);
    const comp = method === 8 ? deflateRawSync(data) : (e.rawComp ?? data);
    const crc = e.crc ?? fm.crc32(data);
    const flags = (e.flags ?? 0) | (e.utf8 ? 0x800 : 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.size ?? data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.madeBy ?? 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.size ?? data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((e.extAttr ?? 0) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const FIXTURE = [
  { name: 'cmd/' }, { name: 'etc/' },
  { name: 'cmd/git.exe', data: GIT_FILES['cmd/git.exe'] },
  { name: 'LICENSE.txt', data: GIT_FILES['LICENSE.txt'], method: 0 },
  { name: 'etc/package-versions.txt', data: Buffer.from('# header\ngit 2.56.1.windows.1\r\ncurl 8.14.1-1\n\nopenssl 3.5.0-1\n') },
  { name: 'mingw64/bin/git.exe', data: Buffer.alloc(5000, 9) },
  { name: 'mingw64/share/naïve.txt', data: Buffer.from('utf8 name'), utf8: true },
];
const fixtureZip = makeZip(FIXTURE);
const fixturePin = { ...fm.MINGIT, size: fixtureZip.length, sha256: createHash('sha256').update(fixtureZip).digest('hex') };
const zipFile = path.join(SCRATCH, 'fixture.zip');
writeFileSync(zipFile, fixtureZip);
{
  eq(fm.verifyArchive(fixtureZip, fixturePin).ok, true, 'verifyArchive accepts the pinned bytes');
  const tampered = Buffer.from(fixtureZip); tampered[40] ^= 1;
  const v = fm.verifyArchive(tampered, fixturePin);
  ok(!v.ok && v.problems.length === 1 && /SHA-256/.test(v.problems[0]), 'one flipped bit (same size) is refused on SHA-256');
  const short = fm.verifyArchive(fixtureZip.subarray(0, fixtureZip.length - 1), fixturePin);
  ok(!short.ok && /size/.test(short.problems[0]), 'a truncated file is refused on size first');

  let extractCalls = 0;
  const spyExtract = (b, d) => { extractCalls++; return fm.extractZip(b, d); };
  const outA = path.join(SCRATCH, 'mingit-a');
  const r = await fm.fetchMinGit({ outDir: outA, zipPath: zipFile, pin: fixturePin, extract: spyExtract, log: quiet });
  eq(extractCalls, 1, 'the pinned zip is extracted once');
  const stage = path.join(outA, fm.STAGE_DIR_NAME);
  const gitDir = path.join(stage, fm.GIT_DIR_NAME);
  ok(FIXTURE.filter((e) => e.data).every((e) => readFileSync(path.join(gitDir, ...e.name.split('/'))).equals(e.data)),
    'every file is written byte-for-byte as in the archive (stored, deflated and UTF-8-named)');
  eq(fm.listFilesRecursive(gitDir), FIXTURE.filter((e) => e.data).map((e) => e.name).sort(), 'and nothing else is written into git/');
  eq(r.components, ['git 2.56.1.windows.1', 'curl 8.14.1-1', 'openssl 3.5.0-1'], 'package-versions.txt components parsed (comments, blank lines, CRLF)');
  const notices = readFileSync(path.join(stage, fm.NOTICES_FILE), 'utf8');
  ok(notices.includes('MinGit 2.56.1') && notices.includes('GNU General Public License, version 2') &&
     notices.includes(fm.CURATOR_RELEASES_URL) && notices.includes(fm.MINGIT.releaseUrl) &&
     r.components.every((c) => notices.includes(`     ${c}`)) && notices.includes('\r\n'),
    'THIRD-PARTY-NOTICES.txt: MinGit, GPL-2.0, where the source is offered, every component, CRLF');
  const manifest = JSON.parse(readFileSync(path.join(stage, fm.MANIFEST_FILE), 'utf8'));
  eq([manifest.sha256, Object.keys(manifest.files).length], [fixturePin.sha256, 5], 'the manifest records the verified hash and all 5 files');
  eq(fm.checkTreeAgainstManifest(gitDir, manifest).ok, true, 'checkTreeAgainstManifest: the extracted tree matches');

  // Wrong hash / wrong size: refused BEFORE extracting, nothing created.
  for (const [label, pin] of [['wrong SHA-256', { ...fixturePin, sha256: '0'.repeat(64) }], ['wrong size', { ...fixturePin, size: fixturePin.size + 1 }]]) {
    extractCalls = 0;
    const outB = path.join(SCRATCH, `mingit-${label.replace(/\W/g, '')}`);
    const err = await rejectsMsg(() => fm.fetchMinGit({ outDir: outB, zipPath: zipFile, pin, extract: spyExtract, log: quiet }));
    ok(err && /REFUSED/.test(err) && extractCalls === 0 && !existsSync(path.join(outB, fm.STAGE_DIR_NAME)),
      `${label}: REFUSED, the extractor was never called, no mingit/ folder exists`);
  }
  // Download path, with an injected fetch.
  const fetchOf = (bytes, status = 200) => async () => new Response(bytes, { status, headers: { 'content-length': String(bytes.length) } });
  const outC = path.join(SCRATCH, 'mingit-dl');
  await fm.fetchMinGit({ outDir: outC, pin: fixturePin, fetchImpl: fetchOf(fixtureZip), log: quiet });
  ok(existsSync(path.join(outC, fixturePin.asset)) && existsSync(path.join(outC, fm.STAGE_DIR_NAME, fm.GIT_DIR_NAME, 'cmd', 'git.exe')),
    'download: the verified zip is kept as a cache and unpacked');
  let fetched = 0;
  await fm.fetchMinGit({ outDir: outC, pin: fixturePin, fetchImpl: async () => { fetched++; throw new Error('no network'); }, log: quiet });
  eq(fetched, 0, 'a cached copy that matches the pin is reused without a download');
  const outD = path.join(SCRATCH, 'mingit-dl-bad');
  extractCalls = 0;
  const tamperedDl = Buffer.from(fixtureZip); tamperedDl[60] ^= 0xFF;
  const errD = await rejectsMsg(() => fm.fetchMinGit({ outDir: outD, pin: fixturePin, fetchImpl: fetchOf(tamperedDl), extract: spyExtract, log: quiet }));
  ok(errD && /REFUSED/.test(errD) && /deleted/.test(errD) && extractCalls === 0 && !existsSync(path.join(outD, fixturePin.asset)) && !existsSync(path.join(outD, fm.STAGE_DIR_NAME)),
    'download of tampered bytes: REFUSED, the download DELETED, nothing extracted');
  const err404 = await rejectsMsg(() => fm.fetchMinGit({ outDir: path.join(SCRATCH, 'mingit-404'), pin: fixturePin, fetchImpl: fetchOf(Buffer.from('nope'), 404), log: quiet }));
  ok(err404 && /HTTP 404/.test(err404), 'an HTTP error is reported with its status');
  // A stale cached copy that does not match is replaced, not trusted.
  const outE = path.join(SCRATCH, 'mingit-stale');
  mkdirSync(outE, { recursive: true });
  writeFileSync(path.join(outE, fixturePin.asset), 'stale');
  await fm.fetchMinGit({ outDir: outE, pin: fixturePin, fetchImpl: fetchOf(fixtureZip), log: quiet });
  ok(readFileSync(path.join(outE, fixturePin.asset)).equals(fixtureZip), 'a cached copy that does NOT match is downloaded again');

  // Required files.
  for (const req of fm.REQUIRED_FILES) {
    const z = makeZip(FIXTURE.filter((e) => e.name !== req));
    const pin = { ...fm.MINGIT, size: z.length, sha256: createHash('sha256').update(z).digest('hex') };
    const f = path.join(SCRATCH, `noreq-${req.replace(/\W/g, '')}.zip`);
    writeFileSync(f, z);
    const outF = path.join(SCRATCH, `mingit-noreq-${req.replace(/\W/g, '')}`);
    const err = await rejectsMsg(() => fm.fetchMinGit({ outDir: outF, zipPath: f, pin, log: quiet }));
    ok(err && err.includes(req) && !existsSync(path.join(outF, fm.STAGE_DIR_NAME)) &&
       readdirSync(outF).every((n) => !n.startsWith(`${fm.STAGE_DIR_NAME}.partial`)),
      `an archive without ${req} is refused and leaves no staging folder behind`);
  }
  // The CLI has no way around the pin.
  const cli = spawnSync(process.execPath, [path.join(DESKTOP, 'lib', 'fetch-mingit.mjs'), '--zip', zipFile, '--out', path.join(SCRATCH, 'mingit-cli')], { encoding: 'utf8' });
  ok(cli.status === 1 && /REFUSED/.test(cli.stderr) && !existsSync(path.join(SCRATCH, 'mingit-cli', fm.STAGE_DIR_NAME)),
    'the CLI given a --zip that is not the pinned file exits 1, REFUSED, nothing unpacked');
}
{
  // The zip reader's refusals (each a single-entry archive).
  const R = (entry) => throwsMsg(() => fm.readZipEntries(makeZip([entry])));
  const d = Buffer.from('x');
  const cases = [
    ['a "../" path', { name: '../escape.txt', data: d }, /not a safe path \("\.\." segment\)/],
    ['a nested "../"', { name: 'cmd/../../escape.txt', data: d }, /not a safe path \("\.\." segment\)/],
    ['an absolute path', { name: '/etc/passwd', data: d }, /absolute/],
    ['a drive-letter path', { name: 'C:/Windows/x.dll', data: d }, /drive-letter/],
    ['a backslash path', { name: 'cmd\\git.exe', data: d }, /backslash/],
    ['a reserved name (CON)', { name: 'etc/CON', data: d }, /reserved/],
    ['a reserved name with an extension (aux.txt)', { name: 'aux.txt', data: d }, /reserved/],
    ['a name ending in a dot', { name: 'cmd/git.', data: d }, /dot or a space/],
    ['a character Windows refuses', { name: 'a<b.txt', data: d }, /character/],
    ['a symbolic link', { name: 'link', data: Buffer.from('target'), madeBy: 0x0314, extAttr: (0o120777 << 16) >>> 0 }, /symbolic link/],
    ['an encrypted entry', { name: 'secret.txt', data: d, flags: 1 }, /encrypted/],
    ['an unknown compression method', { name: 'x.bin', data: d, method: 12, rawComp: d }, /compression method 12/],
    ['a non-ASCII name without the UTF-8 flag', { name: 'caf\u00e9.txt', data: d }, /non-ASCII/],
  ];
  for (const [label, entry, re] of cases) {
    const err = R(entry);
    ok(err && re.test(err), `refused: ${label}${err && !re.test(err) ? ` (said: ${err})` : ''}${err ? '' : ' (ACCEPTED)'}`);
  }
  const dup = throwsMsg(() => fm.readZipEntries(makeZip([{ name: 'A.txt', data: d }, { name: 'a.TXT', data: d }])));
  ok(dup && /twice/.test(dup), 'refused: two names that differ only in case (Windows would merge them)');
  const crcBad = makeZip([{ name: 'x.txt', data: Buffer.from('hello'), crc: 1234 }]);
  const e = fm.readZipEntries(crcBad)[0];
  ok(/CRC-32/.test(throwsMsg(() => fm.readEntryData(crcBad, e)) || ''), 'refused: a CRC-32 mismatch');
  ok(/too short|no end-of-central/.test(throwsMsg(() => fm.readZipEntries(Buffer.from('PK not really a zip file, no directory record here'))) || ''), 'refused: not a zip');
  const into = path.join(SCRATCH, 'exists');
  mkdirSync(into, { recursive: true });
  ok(/existing folder/.test(throwsMsg(() => fm.extractZip(fixtureZip, into)) || ''), 'extractZip refuses to extract into an existing folder');
  eq(fm.unsafeEntryName('mingw64/libexec/git-core/git-remote-https.exe'), null, 'an ordinary MinGit path is accepted');
  eq(fm.crc32(Buffer.from('123456789')).toString(16), 'cbf43926', 'CRC-32 check value (123456789 → cbf43926)');
}
{
  // checkTreeAgainstManifest's own failures.
  const gitDir = path.join(SCRATCH, 'mingit-a', fm.STAGE_DIR_NAME, fm.GIT_DIR_NAME);
  const manifest = JSON.parse(readFileSync(path.join(SCRATCH, 'mingit-a', fm.STAGE_DIR_NAME, fm.MANIFEST_FILE), 'utf8'));
  writeFileSync(path.join(gitDir, 'LICENSE.txt'), 'GNU GENERAL PUBLIC LICENSE\nVersion 3\n');
  ok(!fm.checkTreeAgainstManifest(gitDir, manifest).ok, 'a changed byte (same size) fails the manifest check');
}
// CROSS-CHECK: a zip made by the system's own `zip` (deflate), when there is one.
{
  const which = spawnSync('zip', ['-v'], { encoding: 'utf8' });
  if (which.status === 0) {
    const src = path.join(SCRATCH, 'zipsrc');
    mkdirSync(path.join(src, 'cmd'), { recursive: true });
    writeFileSync(path.join(src, 'cmd', 'git.exe'), Buffer.alloc(20000, 3));
    writeFileSync(path.join(src, 'LICENSE.txt'), 'GPL text '.repeat(500));
    const zf = path.join(SCRATCH, 'system.zip');
    spawnSync('zip', ['-r', '-X', '-q', zf, '.'], { cwd: src });
    const dest = path.join(SCRATCH, 'system-out');
    fm.extractZip(readFileSync(zf), dest);
    ok(readFileSync(path.join(dest, 'cmd', 'git.exe')).equals(readFileSync(path.join(src, 'cmd', 'git.exe'))) &&
       readFileSync(path.join(dest, 'LICENSE.txt'), 'utf8') === readFileSync(path.join(src, 'LICENSE.txt'), 'utf8'),
      'CROSS-CHECK: a zip written by the system `zip` tool extracts byte-for-byte');
  } else skip('system `zip` cross-check: no zip tool here');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§8  The icons: regenerated in memory and compared pixel by pixel');
// ═════════════════════════════════════════════════════════════════════════════

/** An ICO reader written here: directory, then each entry as BMP or PNG. */
function readIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ico');
  const n = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    const w = buf[e] || 256, h = buf[e + 1] || 256;
    const size = buf.readUInt32LE(e + 8), off = buf.readUInt32LE(e + 12);
    const blob = buf.subarray(off, off + size);
    out.push({ w, h, bpp: buf.readUInt16LE(e + 6), png: blob.readUInt32BE(0) === 0x89504E47, blob });
  }
  return out;
}
/** Decode an unfiltered (filter 0) RGBA PNG, the only kind rgba-png.js writes. */
function readPlainPng(buf) {
  let p = 8, w = 0, h = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); }
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 4 + 1)] !== 0) throw new Error('filtered row');
    raw.copy(data, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  }
  return { w, h, data };
}
/** Decode a 32-bit BMP icon entry to top-down RGBA, checking the AND mask agrees with alpha. */
function readBmpEntry(blob, w, h) {
  if (blob.readUInt32LE(0) !== 40 || blob.readInt32LE(4) !== w || blob.readInt32LE(8) !== 2 * h || blob.readUInt16LE(14) !== 32) throw new Error('bad BMP header');
  const px = blob.subarray(40, 40 + w * h * 4);
  const maskStride = Math.ceil(w / 32) * 4;
  const mask = blob.subarray(40 + w * h * 4);
  if (mask.length !== maskStride * h) throw new Error('bad mask length');
  const data = Buffer.alloc(w * h * 4);
  let maskAgrees = true;
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (row * w + x) * 4, d = (y * w + x) * 4;
      data[d] = px[s + 2]; data[d + 1] = px[s + 1]; data[d + 2] = px[s]; data[d + 3] = px[s + 3];
      const bit = (mask[row * maskStride + (x >> 3)] >> (7 - (x & 7))) & 1;
      if (bit !== (px[s + 3] === 0 ? 1 : 0)) maskAgrees = false;
    }
  }
  return { data, maskAgrees };
}
{
  // Self-tests of the resampler: it must be able to fail.
  const solid = { width: 10, height: 10, data: Buffer.alloc(400) };
  for (let i = 0; i < 100; i++) solid.data.set([200, 100, 50, 255], i * 4);
  const s = icons.resampleArea(solid, 3, 3);
  ok([...Array(9).keys()].every((i) => s.data[i * 4] === 200 && s.data[i * 4 + 1] === 100 && s.data[i * 4 + 3] === 255), 'resampler: a solid colour stays exactly that colour');
  const half = { width: 2, height: 1, data: Buffer.from([255, 0, 0, 255, 0, 255, 0, 0]) };
  const hr = icons.resampleArea(half, 1, 1);
  eq([...hr.data], [255, 0, 0, 128], 'resampler: opaque red beside TRANSPARENT green averages to red at half alpha (premultiplied; no green bleed)');
  eq([icons.insetFor(16), icons.insetFor(32), icons.insetFor(48), icons.insetFor(256)], [0, 0, 1, 5], 'inset rule = scripts/windows/make-icons.py (0 up to 32 px, then 2%)');

  const { outputs, tile } = icons.buildIcons();
  eq(tile.box, [100, 100, 923, 923], 'the tile is cropped out of the 1024 px icns image (the Mac grid margin removed)');
  for (const [name, spec] of Object.entries(icons.OUTPUTS)) {
    const file = path.join(DESKTOP, 'build', name);
    ok(existsSync(file), `desktop/build/${name} is committed`);
    if (!existsSync(file)) continue;
    const committed = readFileSync(file);
    if (spec.kind === 'ico') {
      const entries = readIco(committed);
      eq(entries.map((e) => e.w), spec.sizes, `${name}: sizes ${spec.sizes.join(', ')}`);
      ok(entries.every((e) => e.w === e.h && e.bpp === 32), `${name}: square, 32-bit entries`);
      ok(entries.every((e) => e.png === (e.w >= 256)), `${name}: 256 px is PNG, smaller sizes are BMP (what NSIS and every Windows reader accept)`);
      let same = true, masks = true;
      for (const e of entries) {
        const want = outputs[name].frames.get(e.w).data;
        const got = e.png ? readPlainPng(e.blob).data : readBmpEntry(e.blob, e.w, e.h);
        const gotData = e.png ? got : got.data;
        if (!e.png && !got.maskAgrees) masks = false;
        if (!gotData.equals(want)) same = false;
      }
      ok(same, `${name}: every pixel of every size equals what the generator makes now (no drift from images/applet.icns)`);
      ok(masks, `${name}: each BMP's AND mask is set exactly where alpha is 0`);
    } else {
      const png = readPlainPng(committed);
      eq([png.w, png.h], [spec.size, spec.size], `${name}: ${spec.size} px`);
      ok(png.data.equals(outputs[name].frames.get(spec.size).data), `${name}: pixels equal the generator's`);
    }
  }
  // A DUMB look at the pictures themselves.
  const i256 = readIco(readFileSync(path.join(DESKTOP, 'build', 'icon.ico'))).find((e) => e.w === 256);
  const px = readPlainPng(i256.blob).data;
  const at = (x, y) => [...px.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
  ok(at(2, 128)[3] === 0 && at(128, 2)[3] === 0, '256 px: the 5 px inset is transparent');
  ok(at(128, 250)[3] === 255 && at(128, 250)[0] < 60 && at(128, 250)[2] < 60, '256 px: the tile body is opaque and dark (the brand tile)');
  ok(at(5, 5)[3] < 255, '256 px: the rounded corner is not a square corner');
  const lilac = (() => { let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 3] === 255 && px[i] > 150 && px[i + 2] > 200) n++; return n; })();
  ok(lilac > 500, `256 px: the light-violet network lines are there (${lilac} pixels)`);
  eq(path.basename(winBlock.join('\n').match(/from: build\/(tray\.ico)/)[1]), wp.TRAY_ICON_FILES[0], 'the tray files win-pack checks are the ones the yml ships');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§9  dist: --win on Windows, --mac everywhere else');
// ═════════════════════════════════════════════════════════════════════════════

eq(av.distArgv('3.99.3', [], 'win32').slice(0, 4), ['--win', '--config', 'electron-builder.yml', '--config.extraMetadata.version=3.99.3'], 'distArgv on win32 builds --win with the injected version');
eq(av.distArgv('3.99.3', [], 'darwin'), ['--mac', '--config', 'electron-builder.yml', '--config.extraMetadata.version=3.99.3'], 'distArgv on darwin is exactly the Mac argv');
eq(av.distArgv('3.99.3', [], 'linux')[0], '--mac', 'distArgv on linux (CI) is --mac, as before');
if (process.platform !== 'win32') eq(av.distArgv('3.99.3')[0], '--mac', 'distArgv with no platform argument on this host is --mac');
ok(throwsMsg(() => av.distArgv('0.0.0', [], 'win32')) !== null, 'distArgv on win32 still refuses the sentinel');

// ═════════════════════════════════════════════════════════════════════════════
section('§10 build/installer.nsh (SOURCE SCAN — weak by nature) and the template hooks it relies on');
// ═════════════════════════════════════════════════════════════════════════════

{
  const nsh = readFileSync(path.join(DESKTOP, 'build', 'installer.nsh'), 'utf8').split('\n').filter((l) => !/^\s*;/.test(l)).join('\n');
  const macro = (name) => { const m = nsh.match(new RegExp(`!macro ${name}\\n([\\s\\S]*?)!macroend`)); return m ? m[1] : null; };
  ok(/!insertmacro MUI_PAGE_WELCOME/.test(macro('customWelcomePage') || ''), 'customWelcomePage inserts the MUI Welcome page');
  ok(/StrCpy \$isForceCurrentInstall "1"/.test(macro('customInstallMode') || ''), 'customInstallMode forces the current-user install (no "all users" page, no UAC)');
  ok(/\$LOCALAPPDATA\\TheCurator"/.test(macro('curatorCheckInstDir') || ''), 'the data guard compares $INSTDIR with %LOCALAPPDATA%\\TheCurator');
  for (const m of ['customInit', 'customUnInit']) ok(/curatorCheckInstDir[\s\S]*Quit/.test(macro(m) || ''), `${m} runs the guard and quits on a bad folder`);
  ok(/curatorCheckInstDir[\s\S]*Abort/.test(macro('customUnInstall') || ''), 'customUnInstall runs the guard again and aborts before $INSTDIR is removed');
  // audit minor 1: the guard judges the FULL, LONG spelling and what is IN the folder.
  const full = macro('curatorFullPath') || '';
  ok(/kernel32::GetFullPathNameW\(w R5, i \$\{NSIS_MAX_STRLEN\}, w \.R4, p 0\) i \.R3/.test(full)
    && /kernel32::GetLongPathNameW\(w R5, w \.R4, i \$\{NSIS_MAX_STRLEN\}\) i \.R3/.test(full),
    'curatorFullPath: GetFullPathNameW (`..`, `.`, forward slashes) then GetLongPathNameW (8.3 names)');
  ok(/\$\{andIf\} \$R3 < \$\{NSIS_MAX_STRLEN\}\s*StrCpy \$R5 \$R4/.test(full), '…each result taken only when the call succeeded and fitted (else the spelling is kept)');
  const guard = macro('curatorCheckInstDir') || '';
  ok(/StrCpy \$R5 "\$INSTDIR"\s*!insertmacro curatorFullPath\s*StrCpy \$R1 \$R5/.test(guard)
    && /StrCpy \$R5 "\$LOCALAPPDATA\\TheCurator"\s*!insertmacro curatorFullPath\s*StrCpy \$R8 \$R5/.test(guard),
    'the guard normalises BOTH $INSTDIR and the data folder before comparing');
  ok(/StrCpy \$R6 \$R1 \$R7\s*\$\{if\} \$R6 == \$R8/.test(guard), '…and compares the normalised prefix');
  for (const f of ['$INSTDIR\\domains\\*.*', '$INSTDIR\\.curator-config.json', '$INSTDIR\\App\\*.*', '$INSTDIR\\App\\domains\\*.*']) {
    ok(guard.includes(`\${FileExists} "${f}"`), `the guard refuses a folder that already holds ${f.replace(/\\\*\.\*$/, '')}`);
  }
  ok(/\$\{orIf\} \$R1 == "\$LOCALAPPDATA\\Programs"/.test(guard) && /\$\{orIf\} "\$INSTDIR" == "\$LOCALAPPDATA\\Programs"/.test(guard),
    'the shared-folder list is checked on both spellings');
  const tpl = path.join(DESKTOP_NM, 'app-builder-lib', 'templates', 'nsis');
  if (existsSync(tpl)) {
    const all = ['assistedInstaller.nsh', 'multiUserUi.nsh', 'installer.nsi', 'uninstaller.nsh'].map((f) => readFileSync(path.join(tpl, f), 'utf8')).join('\n');
    for (const m of ['customWelcomePage', 'customInstallMode', 'customInit', 'customUnInit', 'customUnInstall']) {
      ok(new RegExp(`!insertmacro ${m}\\b`).test(all), `CROSS-CHECK: electron-builder 26.15.3's templates really insert ${m}`);
    }
    ok(/Var isForceCurrentInstall/.test(all), 'CROSS-CHECK: $isForceCurrentInstall is a variable the template declares');
    ok(/WinShell::SetLnkAUMI "\$newStartMenuLink" "\$\{APP_ID\}"/.test(readFileSync(path.join(tpl, 'include', 'installer.nsh'), 'utf8')),
      'CROSS-CHECK: the template stamps APP_ID (= appId) on the shortcuts as their AppUserModelID');
    const un = readFileSync(path.join(tpl, 'uninstaller.nsh'), 'utf8');
    ok(/!ifdef DELETE_APP_DATA_ON_UNINSTALL/.test(un) && !/TheCurator/.test(un),
      'CROSS-CHECK: the template deletes app data only under DELETE_APP_DATA_ON_UNINSTALL / --delete-app-data, and never names TheCurator');
  } else skip('electron-builder NSIS template cross-check: desktop/node_modules is not installed here (CI)');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§11 What only the windows-latest build proves (NOT ENFORCED here)');
// ═════════════════════════════════════════════════════════════════════════════

for (const line of [
  'makensis compiles build/installer.nsh with electron-builder\'s -WX (warnings are errors)',
  'the real MinGit archive matches the pin, has LICENSE.txt + etc/package-versions.txt at its root, and contains no zip64/symlink surprise',
  'afterSign really runs on the --win build and reads the real The Curator.exe (version resource + fuse wire)',
  'dist\\win-unpacked\\resources\\app\\.curator-bundle exists and is inside the installer payload',
  'the installer\'s pages (Welcome, Finish with "Run The Curator"), the shortcuts, HKCU only, no UAC prompt',
  'a silent uninstall leaves %LOCALAPPDATA%\\TheCurator untouched',
]) console.log(`  ⊘ ${line}`);

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) process.exit(1);
console.log('✅ Windows build: config, hooks, MinGit and icons hold');
