#!/usr/bin/env node
/**
 * test-desktop-update-win32.js — OFFLINE guard for the Windows in-app updater.
 *
 * Covers desktop/lib/update-engine.js (the per-platform front door),
 * update-install-win32.js, update-plan-win32.js, update-download.js, and the
 * platform-aware parts of update-plan.js and update-release.js.
 *
 * ── METHOD ──────────────────────────────────────────────────────────────────
 * Both Windows hooks are EXECUTED end to end on any platform. The download
 * really streams from a real `Response`, the SHA-256 is really computed, the
 * setup program really lands in a temp `updates` folder and is really made
 * read-only, the helper script is really written. What is faked is exactly
 * what only Windows has: PowerShell (runCommand), the detached spawn, the
 * process list, and quitting. The release is resolved by the REAL
 * src/routes/config.js picker, and Settings' check (the REAL
 * updateCheckHandler) is driven on the same payloads to prove the two name
 * the same release.
 *
 * §9 runs ONLY on Windows (the windows-latest job, package I): it EXECUTES the
 * generated PowerShell helper against a fake install folder and a fake setup
 * program, including the exe-in-use refusal. Set CURATOR_REQUIRE_WIN_HELPER=1
 * there so a skipped §9 is RED rather than silent.
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0  modules load; the Mac adapter is the v3.99.3 engine byte for byte
 *   §1  createUpdateInstaller: one surface, per platform
 *   §2  asset naming: .exe tokens, the Mac default untouched
 *   §3  resolveInstallerRelease on win32 vs darwin, and Settings agrees
 *   §4  classifyWin32InstallTarget (path.win32 strings)
 *   §5  who holds the exe: classifyInstallProcesses + parseProcessList
 *   §6  the helper TEXT: validation, quoting, arguments, step order
 *   §7  prepareUpdate / installUpdate, EXECUTED, every refusal
 *   §8  afterStart: the outcome record and update cleanup
 *   §9  (Windows only) the helper EXECUTED by real PowerShell
 *   §10 words and source discipline
 */

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function section(t) { console.log(`\n${t}`); }
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
function stripJsComments(src) {
  return src.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-update-win32-'));
process.on('exit', () => {
  try { chmodRec(TMP); rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});
function chmodRec(p) {
  try { chmodSync(p, 0o755); } catch { /* */ }
  let st; try { st = statSync(p); } catch { return; }
  if (st.isDirectory()) for (const n of readdirSync(p)) chmodRec(path.join(p, n));
  else { try { chmodSync(p, 0o644); } catch { /* */ } }
}
let seq = 0;
function tmpdir(name) { const p = path.join(TMP, `${name}-${seq++}`); mkdirSync(p, { recursive: true }); return p; }

let plan, planWin, release, engine, darwin, win, download, cfg, installMode;
try {
  plan = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'update-plan.js')).href);
  planWin = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'update-plan-win32.js')).href);
  release = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'update-release.js')).href);
  engine = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'update-engine.js')).href);
  darwin = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'update-install-darwin.js')).href);
  win = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'update-install-win32.js')).href);
  download = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'update-download.js')).href);
  cfg = await import(pathToFileURL(path.join(ROOT, 'src', 'routes', 'config.js')).href);
  installMode = await import(pathToFileURL(path.join(ROOT, 'src', 'brain', 'install-mode.js')).href);
} catch (err) {
  console.log(`\n  ✗ FATAL — could not import the update modules: ${err.stack}`);
  process.exit(1);
}

const PKG_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const MAC_WORDS = planWin.MAC_ONLY_WORDS;

// ═══════════════════════════════════════════════════════════════════════════
section('§0 modules load; the Mac adapter is the v3.99.3 engine, byte for byte');
// ═══════════════════════════════════════════════════════════════════════════
{
  ok(typeof engine.createUpdateInstaller === 'function', 'update-engine exports createUpdateInstaller');
  ok(engine.createUpdateEngine === darwin.createUpdateEngine,
    'update-engine re-exports the Mac adapter\'s createUpdateEngine itself (every existing importer keeps it)');
  // The owner's requirement: the Mac adapter is MOVED, not edited. Proved
  // against git where the baseline is present (a local clone); a shallow CI
  // checkout has no v3.99.3 and says so rather than passing silently.
  const BASE = '1143961d108192b61126f23ca1a859dae8d6070ca4c57384e4d73e3d7ddfb8bf';
  const now = sha256(readFileSync(path.join(DESKTOP, 'lib', 'update-install-darwin.js')));
  const g = spawnSync('git', ['-C', ROOT, 'show', 'v3.99.3:desktop/lib/update-engine.js'], { encoding: 'buffer' });
  if (g.status === 0) {
    eq(sha256(g.stdout), BASE, '§0 v3.99.3\'s update-engine.js has the recorded sha-256 (the baseline is the real one)');
    if (now !== BASE) {
      console.log('    note: update-install-darwin.js has been edited since the Windows split. If that was deliberate, this check has done its job: drop it.');
    }
    eq(now, BASE, '§0 update-install-darwin.js is byte-identical to v3.99.3\'s update-engine.js');
  } else {
    console.log('    note: v3.99.3 is not in this clone (shallow checkout); the byte-identity check is local-only');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 createUpdateInstaller: one surface, per platform');
// ═══════════════════════════════════════════════════════════════════════════
const SURFACE = ['afterStart', 'checkInUse', 'describe', 'discardPrepared', 'installUpdate', 'prepareUpdate'];
{
  const mac = engine.createUpdateInstaller('darwin', { workDir: tmpdir('mac') });
  const w = engine.createUpdateInstaller('win32', { workDir: tmpdir('win') });
  eq(Object.keys(mac).sort(), SURFACE, 'darwin: the six methods');
  eq(Object.keys(w).sort(), SURFACE, 'win32: the SAME six methods, so the shell wires one shape');
  eq(engine.createUpdateInstaller('linux', {}), null, 'linux: no updater at all (null), so the hooks are not registered');
  eq(engine.createUpdateInstaller(undefined, {}), null, 'no platform: null');
  eq(await mac.afterStart({ currentVersion: '1.0.0' }), { ok: true, outcome: null, removed: 0, kept: 0 }, 'darwin afterStart is a harmless no-op');
  eq(await mac.checkInUse(), { ok: true, connections: 0, others: 0 }, 'darwin checkInUse is a harmless no-op');
  const r = await mac.prepareUpdate({});
  eq(r.reason, 'no-exec-path', 'darwin prepareUpdate is the Mac engine (refuses with no classifier, exactly as before)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 asset naming: .exe tokens, the Mac default untouched');
// ═══════════════════════════════════════════════════════════════════════════
{
  const A = plan.archFromAssetName;
  eq(A('TheCurator-3.100.0-x64-Windows-Setup.exe', { ext: '.exe' }), 'x64', 'the Windows setup name reads as x64');
  eq(A('The-Curator-Setup-3.100.0-x64.exe', { ext: '.exe' }), 'x64', 'the brief\'s alternative name reads as x64 too');
  eq(A('TheCurator-3.100.0-x64-Windows-Setup.EXE', { ext: '.exe' }), 'x64', 'case-insensitive extension');
  eq(A('TheCurator-3.100.0-x64-Windows-Setup.exe.sha256', { ext: '.exe' }), null, 'the sidecar is not an installer');
  eq(A('TheCurator-3.100.0-x64-Windows-Setup.exe.blockmap', { ext: '.exe' }), null, 'the blockmap is not an installer');
  eq(A('TheCurator-3.100.0-x64_64-Windows-Setup.exe', { ext: '.exe' }), null, 'x64_64 is not x64 (whole-token rule, as for the DMG)');
  eq(A('TheCurator-3.100.0-arm64-x64-Setup.exe', { ext: '.exe' }), null, 'ambiguity refuses');
  // DEFAULT = the Mac answer, every one of these exactly as before.
  eq(A('TheCurator-3.32.0-arm64-AppleSilicon.dmg'), 'arm64', 'Mac default: arm64 DMG');
  eq(A('TheCurator-3.32.0-x64-Intel.dmg'), 'x64', 'Mac default: x64 DMG');
  eq(A('TheCurator-3.100.0-x64-Windows-Setup.exe'), null, 'Mac default: an .exe is NOT a Mac installer');
  eq(A('TheCurator-3.32.0-x64-Intel.dmg', { ext: '../x' }), 'x64', 'a malformed ext is ignored (the Mac default applies)');
  const exeAsset = { name: 'TheCurator-4.0.0-x64-Windows-Setup.exe', size: 10, browser_download_url: 'https://github.com/o/r/releases/download/v4.0.0/TheCurator-4.0.0-x64-Windows-Setup.exe', digest: `sha256:${'a'.repeat(64)}` };
  const dmgAsset = { name: 'TheCurator-4.0.0-x64-Intel.dmg', size: 10, browser_download_url: 'https://github.com/o/r/releases/download/v4.0.0/TheCurator-4.0.0-x64-Intel.dmg', digest: `sha256:${'b'.repeat(64)}` };
  eq(plan.pickInstallerAsset([dmgAsset, exeAsset], { arch: 'x64', ext: '.exe' }).asset.name, exeAsset.name, 'pickInstallerAsset(.exe) picks the setup program');
  eq(plan.pickInstallerAsset([dmgAsset, exeAsset], { arch: 'x64' }).asset.name, dmgAsset.name, 'pickInstallerAsset() with no ext still picks the DMG');
  eq(plan.pickInstallerAsset([dmgAsset], { arch: 'x64', ext: '.exe' }).reason, 'no-asset-for-arch', 'a DMG-only list is no-asset-for-arch for Windows');
  eq(plan.pickInstallerAsset([dmgAsset], { arch: 'x64', ext: '.exe' }).detail, 'no .exe matched arch=x64', '…with the extension named in the log detail');
  eq(plan.pickInstallerAsset([], { arch: 'x64' }).detail, 'no .dmg matched arch=x64', 'the Mac detail string is unchanged');
  eq(plan.pickInstallerAsset([{ ...exeAsset, browser_download_url: 'http://github.com/x.exe' }], { arch: 'x64', ext: '.exe' }).reason,
    'asset-unusable', 'https-only applies to the setup program as it does to the DMG');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 resolveInstallerRelease on win32 vs darwin, and Settings agrees');
// ═══════════════════════════════════════════════════════════════════════════
const SETUP_BYTES = Buffer.concat([Buffer.from('MZ The Curator fake setup program\n'), Buffer.alloc(300 * 1024, 7)]);
const SETUP_SHA = sha256(SETUP_BYTES);
const [maj, min] = PKG_VERSION.split('.').map(Number);
const V_NEXT = `${maj}.${min + 1}.0`;
const V_NEXT2 = `${maj}.${min + 2}.0`;
const assetUrl = (v, name) => `https://github.com/talirezun/the-curator/releases/download/v${v}/${name}`;
function rel(v, { exe = true, dmg = true, exeDigest = true, prerelease = false, exeSize = SETUP_BYTES.length } = {}) {
  const assets = [];
  if (dmg) {
    for (const a of ['arm64-AppleSilicon', 'x64-Intel']) {
      const name = `TheCurator-${v}-${a}.dmg`;
      assets.push({ name, size: 1000, browser_download_url: assetUrl(v, name), digest: `sha256:${'c'.repeat(64)}` });
    }
  }
  if (exe) {
    const name = `TheCurator-${v}-x64-Windows-Setup.exe`;
    assets.push({ name, size: exeSize, browser_download_url: assetUrl(v, name), ...(exeDigest ? { digest: `sha256:${SETUP_SHA}` } : {}) });
    assets.push({ name: `${name}.sha256`, size: 64, browser_download_url: assetUrl(v, `${name}.sha256`) });
  }
  return {
    tag_name: `v${v}`, name: `v${v}`, draft: false, prerelease,
    html_url: `https://github.com/talirezun/the-curator/releases/tag/v${v}`,
    published_at: '2026-11-20T10:00:00Z', assets,
  };
}
const jsonResponse = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
function releaseFetch(payload, assetResponder = () => new Response(SETUP_BYTES, { status: 200 })) {
  const calls = { api: 0, asset: 0, assetUrls: [] };
  const fn = async (url) => {
    if (String(url) === cfg.RELEASES_API_URL) { calls.api += 1; return jsonResponse(payload); }
    calls.asset += 1; calls.assetUrls.push(String(url));
    return assetResponder(String(url), calls.asset);
  };
  return { fn, calls };
}
async function settingsCheck(payload, platform) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await cfg.updateCheckHandler({}, res, {
    caps: installMode.getCapabilities('bundle', platform),
    fetch: async () => jsonResponse(payload),
    platform,
  });
  return res.body;
}
const resolve = (payload, platform, arch = 'x64') => release.resolveInstallerRelease({
  configModule: cfg, fetchImpl: releaseFetch(payload).fn, currentVersion: PKG_VERSION, arch, platform,
});
{
  const both = [rel(V_NEXT)];
  const r = await resolve(both, 'win32');
  ok(r.ok, `win32 resolves a both-platform release (${r.reason || 'ok'})`);
  eq(r.asset && r.asset.name, `TheCurator-${V_NEXT}-x64-Windows-Setup.exe`, 'win32 takes the setup program, never the sidecar or a DMG');
  eq(r.asset && r.asset.digest, { algorithm: 'sha256', hex: SETUP_SHA }, '…with GitHub\'s published digest parsed');
  const m = await resolve(both, 'darwin');
  eq(m.asset && m.asset.name, `TheCurator-${V_NEXT}-x64-Intel.dmg`, 'darwin on the same payload still takes the x64 DMG');

  // The case the platform argument exists for: a newer DMG-only release.
  const mixed = [rel(V_NEXT2, { exe: false }), rel(V_NEXT, { dmg: false })];
  eq((await resolve(mixed, 'win32')).version, V_NEXT, 'win32 is offered the newest release WITH a setup program, not the newer DMG-only one');
  eq((await resolve(mixed, 'darwin')).version, V_NEXT2, 'darwin is offered the newer DMG-only release');
  eq((await resolve([rel(V_NEXT, { exe: false })], 'win32')).reason, 'no-installable-release', 'win32 with DMGs only: nothing installable');
  eq((await resolve([rel(V_NEXT, { dmg: false })], 'darwin')).reason, 'no-installable-release', 'darwin with an EXE only: nothing installable');
  const arm = await resolve(both, 'win32', 'arm64');
  eq(arm.reason, 'no-asset-for-arch', 'an arm64 Windows build asking for arm64 gets no-asset-for-arch (x64 only in v1)');
  ok(!MAC_WORDS.test(arm.message || ''), `…in Windows words: "${arm.message}"`);

  // No platform passed = process.platform (the brief's rule). On a Mac or the
  // Linux runner that is the Mac answer; on Windows the Windows one.
  const def = await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: releaseFetch(both).fn, currentVersion: PKG_VERSION, arch: 'x64' });
  eq(def.asset && def.asset.name.endsWith(process.platform === 'win32' ? '.exe' : '.dmg'), true,
    `with no platform the resolver uses process.platform (${process.platform})`);

  // SETTINGS AND THE UPDATER NAME THE SAME RELEASE. The real route handler
  // (Settings' "Check for updates") and the real resolver, on one corpus.
  const corpus = {
    'both platforms': [rel(V_NEXT)],
    'newer DMG-only': [rel(V_NEXT2, { exe: false }), rel(V_NEXT, { dmg: false })],
    'newer EXE-only': [rel(V_NEXT2, { dmg: false }), rel(V_NEXT, { exe: false })],
    'newer pre-release EXE': [rel(V_NEXT2, { dmg: false, prerelease: true }), rel(V_NEXT)],
    'out of order': [rel(V_NEXT), rel(V_NEXT2)],
    'same as running': [rel(PKG_VERSION)],
  };
  for (const [label, payload] of Object.entries(corpus)) {
    for (const platform of ['win32', 'darwin']) {
      const s = await settingsCheck(payload, platform);
      const u = await resolve(payload, platform);
      const updaterNames = u.ok ? u.version : (u.reason === 'no-update' ? PKG_VERSION : null);
      eq(updaterNames, s && s.updateAvailable ? s.latest : (s && s.latest === PKG_VERSION ? PKG_VERSION : null),
        `§3 "${label}" on ${platform}: Settings says ${s && s.latest} (update ${s && s.updateAvailable}), the updater ${u.ok ? u.version : u.reason}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 classifyWin32InstallTarget (path.win32 strings)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const C = (execPath, env = {}) => planWin.classifyWin32InstallTarget({ execPath, env });
  const lad = 'C:\\Users\\Žiga Novak\\AppData\\Local';
  const exe = `${lad}\\Programs\\The Curator\\The Curator.exe`;
  const r = C(exe, { ProgramFiles: 'C:\\Program Files' });
  ok(r.ok, 'the per-user NSIS install (spaces, a non-ASCII letter) may update itself');
  eq(r.installDir, `${lad}\\Programs\\The Curator`, '…installDir is the exe\'s folder');
  eq(r.uninstallerPath, `${lad}\\Programs\\The Curator\\Uninstall The Curator.exe`, '…and the NSIS uninstaller is looked for beside it');
  eq(C('').reason, 'no-exec-path', 'empty execPath: no-exec-path');
  eq(C(null).reason, 'no-exec-path', 'null execPath: no-exec-path');
  eq(C('\\\\server\\share\\The Curator\\The Curator.exe').reason, 'install-path-unsupported', 'a UNC/network path is refused');
  eq(C('\\\\?\\C:\\x\\The Curator.exe').reason, 'install-path-unsupported', 'a device path is refused');
  eq(C('The Curator\\The Curator.exe').reason, 'install-path-unsupported', 'a relative path is refused');
  eq(C('C:\\a\\..\\b\\The Curator.exe').reason, 'install-path-unsupported', 'an un-normalised path is refused');
  eq(C('C:\\dev\\the-curator\\desktop\\dist\\win-unpacked\\The Curator.exe').reason, 'not-installed-copy', 'a win-unpacked build folder is a dev build, not an install');
  eq(C('C:\\dev\\node_modules\\electron\\dist\\electron').reason, 'not-installed-copy', 'not an .exe: refused');
  eq(C('C:\\Program Files\\The Curator\\The Curator.exe', { ProgramFiles: 'C:\\Program Files' }).reason, 'install-per-machine', 'Program Files: per-machine, refused with words');
  eq(C('c:\\program files\\The Curator\\The Curator.exe', { PROGRAMFILES: 'C:\\Program Files' }).reason, 'install-per-machine', '…case-insensitively, in the path and in the env key');
  eq(C('C:\\Program Files (x86)\\The Curator\\The Curator.exe', { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }).reason, 'install-per-machine', 'Program Files (x86) too');
  ok(C('C:\\Program Files Extra\\The Curator\\The Curator.exe', { ProgramFiles: 'C:\\Program Files' }).ok, 'a sibling folder that merely starts with the same letters is not Program Files');
  for (const reason of ['install-path-unsupported', 'not-installed-copy', 'install-per-machine']) {
    const msg = planWin.win32MessageFor(reason);
    ok(msg && !MAC_WORDS.test(msg) && /releases page/.test(msg), `"${reason}" says what to do, in Windows words`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 who holds the exe: classifyInstallProcesses + parseProcessList');
// ═══════════════════════════════════════════════════════════════════════════
{
  const SELF = 1000;
  const procs = [
    { pid: SELF, ppid: 4, cmd: '"C:\\P\\The Curator.exe"' },
    { pid: 1001, ppid: SELF, cmd: '"C:\\P\\The Curator.exe" --type=renderer' },
    { pid: 1002, ppid: SELF, cmd: '"C:\\P\\The Curator.exe" --type=gpu-process' },
    { pid: 1003, ppid: 1001, cmd: '"C:\\P\\The Curator.exe" --type=utility' },
    { pid: 2000, ppid: 1500, cmd: '"C:\\P\\The Curator.exe" "C:\\P\\resources\\app\\mcp\\server.js"' },
    { pid: 2001, ppid: 1500, cmd: '"C:\\P\\The Curator.exe" C:/P/resources/app/MCP/Server.js --domains-path X' },
    { pid: 3000, ppid: 9, cmd: '"C:\\P\\The Curator.exe"' },
  ];
  const r = planWin.classifyInstallProcesses({ processes: procs, selfPid: SELF });
  eq(r.bridges, [2000, 2001], 'the two MCP bridges (Claude Desktop\'s, either slash, any case) are named');
  eq(r.others, [3000], 'a second copy of the app is told apart from a bridge');
  eq(planWin.classifyInstallProcesses({ processes: procs.slice(0, 4), selfPid: SELF }), { bridges: [], others: [] },
    'this app and its whole Electron helper tree (grandchildren too) are never "someone else"');
  eq(planWin.classifyInstallProcesses({ processes: [{ pid: 5, ppid: 6, cmd: '' }, { pid: 6, ppid: 5, cmd: '' }], selfPid: SELF }).others, [5, 6],
    'a parent cycle terminates');
  eq(planWin.parseProcessList(''), [], 'empty output = nobody');
  eq(planWin.parseProcessList('{"pid":7,"ppid":1,"cmd":"x"}'), [{ pid: 7, ppid: 1, cmd: 'x' }], 'a single object (PowerShell\'s shape for one) is a list of one');
  eq(planWin.parseProcessList('[{"pid":7,"ppid":1,"cmd":null},{"nope":1}]'), [{ pid: 7, ppid: 1, cmd: '' }], 'junk members are dropped');
  eq(planWin.parseProcessList('Get-CimInstance : Access denied'), null, 'unreadable output = null (the caller treats it as "not checked")');
  const cmd = planWin.buildProcessListCommand("C:\\Users\\O'Brien\\AppData\\Local\\Programs\\The Curator\\The Curator.exe");
  ok(cmd.includes("'C:\\Users\\O''Brien\\AppData\\Local\\Programs\\The Curator\\The Curator.exe'"), 'the exe path is a PowerShell literal with the apostrophe doubled');
  ok(/Where-Object \{ \$_\.ExecutablePath/.test(cmd) && /OrdinalIgnoreCase/.test(cmd), 'filtered to THIS exe, case-insensitively, inside PowerShell');
}

/** A PowerShell '…' literal read back (every doubled quote of the five). */
function psUnquote(lit) { return lit.slice(1, -1).replace(/(['\u2018\u2019\u201A\u201B])\1/g, '$1'); }
/** The script FILE a `helperArgs` boot runs. */
function bootFile(boot) { return psUnquote(boot.match(/ReadAllText\(('(?:[^'\u2018\u2019\u201A\u201B]|''|\u2018\u2018|\u2019\u2019|\u201A\u201A|\u201B\u201B)+')/)[1]); }
/**
 * An INDEPENDENT model of how a Windows program (CommandLineToArgvW, the
 * Microsoft C runtime since 2008) splits a command line. Written from the
 * documented rules, not from winQuoteArg: 2n backslashes + quote → n
 * backslashes and the quote toggles; 2n+1 → n backslashes and a literal
 * quote; other backslashes are literal; "" inside quotes is a literal quote.
 */
function parseWinCommandLine(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i += 1;
    if (i >= line.length) break;
    let arg = ''; let inQ = false;
    while (i < line.length && (inQ || (line[i] !== ' ' && line[i] !== '\t'))) {
      if (line[i] === '\\') {
        let k = 0; while (line[i] === '\\') { k += 1; i += 1; }
        if (line[i] === '"') { arg += '\\'.repeat(k >> 1); if (k & 1) { arg += '"'; i += 1; } } else arg += '\\'.repeat(k);
        continue;
      }
      if (line[i] === '"') { if (inQ && line[i + 1] === '"') { arg += '"'; i += 2; continue; } inQ = !inQ; i += 1; continue; }
      arg += line[i]; i += 1;
    }
    out.push(arg);
  }
  return out;
}
// ═══════════════════════════════════════════════════════════════════════════
section('§6 the helper TEXT: validation, quoting, arguments, step order');
// ═══════════════════════════════════════════════════════════════════════════
const GOOD = {
  pid: 4242, exePath: "C:\\Users\\Žiga O'Brien\\AppData\\Local\\Programs\\The Curator\\The Curator.exe",
  installerPath: "C:\\Users\\Žiga O'Brien\\AppData\\Local\\TheCurator\\updates\\v4.0.0-TheCurator-4.0.0-x64-Windows-Setup.exe",
  sha256: 'a'.repeat(64), size: 123456, version: '4.0.0',
  resultPath: 'C:\\U\\AppData\\Local\\TheCurator\\updates\\last-update.json',
  logPath: 'C:\\U\\AppData\\Local\\TheCurator\\logs\\update-install.log',
  explorer: 'C:\\Windows\\explorer.exe', stopPids: [],
};
{
  const s = planWin.buildWin32InstallScript(GOOD);
  ok(s.includes("$Exe = 'C:\\Users\\Žiga O''Brien\\AppData\\Local\\Programs\\The Curator\\The Curator.exe'"), 'paths are single-quoted literals, apostrophe doubled, non-ASCII kept');
  ok(s.includes("$InstallerArgs = @('/S', '--updated', '--force-run')"), 'the setup gets exactly /S --updated --force-run');
  eq(planWin.INSTALLER_ARGS, ['/S', '--updated', '--force-run'], 'INSTALLER_ARGS is exactly the three');
  ok(s.includes(`$Sha256 = '${'a'.repeat(64)}'`) && s.includes('$Size = 123456'), 'the verified size and SHA-256 travel to the helper');
  ok(s.includes('Get-FileHash -LiteralPath $Installer -Algorithm SHA256'), 'the helper re-hashes the setup right before running it');
  ok(s.includes("[IO.File]::Open($Exe, 'Open', 'ReadWrite', 'None')"), 'the exe-in-use probe is an exclusive open (Windows refuses it while a process runs the exe)');
  ok(s.includes('.WaitForExit($InstallTimeoutSeconds * 1000)') && !/Start-Process[^\n]*-Wait\b/.test(s),
    'it waits for the setup PROCESS only (Start-Process -Wait would also wait for the app the setup reopens)');
  ok(s.includes('$null = $proc.Handle'), 'the process handle is taken at once, so ExitCode is readable afterwards');
  const order = ['while (Get-Process -Id $AppPid', 'foreach ($sp in $StopPids)', 'while (-not (Test-ExeFree))', 'if (-not (Test-InstallerUnchanged))', "Write-Result 'installing'", 'Start-Process -FilePath $Installer -ArgumentList $InstallerArgs', "Write-Result 'installed' 0", 'Test-AppRunning) { $running'];
  const idx = order.map((k) => s.indexOf(k));
  ok(idx.every((i) => i > 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]),
    `the steps are in order: wait → stop agreed connections → exe free → hash → record → run → record → reopen (${idx.join(',')})`);
  ok(/if \(-not \$running\) \{[^\n]*Start-App/.test(s), 'if the setup did not reopen the app, the helper opens it itself');
  ok(s.includes("Start-Process -FilePath $Explorer -ArgumentList ('\"' + $Exe + '\"')"), 'the app is reopened through Explorer (the person\'s own environment)');
  for (const [key, msg] of Object.entries(planWin.WIN32_INSTALL_OUTCOMES)) {
    if (['exe-in-use', 'installer-changed', 'installer-failed', 'installer-timeout'].includes(key)) {
      ok(s.includes(planWin.psQuote(msg)), `the helper shows the "${key}" sentence itself (never silent)`);
    }
  }
  ok(!/EncodedCommand|ExecutionPolicy|Invoke-Expression|\biex\b|DownloadString|Invoke-WebRequest/i.test(s), 'no encoded command, no policy override, no eval, no network in the helper');
  ok(s.includes('$StopPids = @()'), 'no connection is stopped unless the person agreed');
  ok(planWin.buildWin32InstallScript({ ...GOOD, stopPids: [11, 12] }).includes('$StopPids = @(11, 12)'), 'agreed connections are listed by PID');
  ok(/mcp\[\\\\\/\]server\\\.js/.test(s), 'a PID is stopped only while it is still an MCP bridge of this exe');
  const bad = [
    ['pid 0', { pid: 0 }], ['a short sha', { sha256: 'abc' }], ['an upper-case sha', { sha256: 'A'.repeat(64) }],
    ['size 0', { size: 0 }], ['a version with a quote', { version: "4.0.0'; rm" }], ['a path with a newline', { exePath: 'C:\\a\nb.exe' }],
    ['a stop pid equal to our own', { stopPids: [4242] }], ['a non-integer stop pid', { stopPids: ['1; x'] }], ['no explorer', { explorer: '' }],
  ];
  for (const [label, over] of bad) {
    let threw = false; try { planWin.buildWin32InstallScript({ ...GOOD, ...over }); } catch { threw = true; }
    ok(threw, `refuses to build a helper with ${label}`);
  }
  // ── audit minor 8: the "Run the installer now?" answer hashes the kept setup AGAIN ──
  {
    const fn = s.slice(s.indexOf('function Test-InstallerUnchanged'), s.indexOf('function Show-Message'));
    ok(/Get-FileHash -LiteralPath \$Installer -Algorithm SHA256/.test(fn) && /\$len -eq \$Size -and \$h -eq \$Sha256/.test(fn),
      'Test-InstallerUnchanged reads the length and the SHA-256 from the disk and compares both with the checked ones');
    const sm = s.slice(s.indexOf('function Show-Message'), s.indexOf('function Start-App'));
    const yes = sm.slice(sm.indexOf("if ([string]$r -eq 'Yes')"));
    const iTest = yes.indexOf('Test-InstallerUnchanged');
    const iRun = yes.indexOf('Start-Process -FilePath $Installer');
    ok(iTest > 0 && iRun > iTest && /if \(Test-InstallerUnchanged\) \{ try \{ Start-Process -FilePath \$Installer/.test(yes),
      'after "Yes" the kept setup program is run ONLY inside `if (Test-InstallerUnchanged)` (re-hashed at the moment of running)');
    ok(/else \{ Log 'REFUSED: the kept setup program changed; it was not run'; \[void\]\[System\.Windows\.Forms\.MessageBox\]::Show\(\$MsgChanged/.test(yes),
      '…and a changed one is not run: logged, and the "installer-changed" sentence is shown');
    eq((s.match(/Start-Process -FilePath \$Installer(?! -ArgumentList)/g) || []).length, 1,
      'the kept setup is started in exactly one place (the re-hashed one)');
    // DUMB CROSS-CHECK: the main run uses the same test (one hashing rule, not two).
    ok(/\nif \(-not \(Test-InstallerUnchanged\)\) \{\r?\n  Log 'REFUSED: the setup program is not the one that was checked/.test(s),
      'the step-4 check before the silent run is the same Test-InstallerUnchanged');
  }
  // ── audit minor 2: psQuote doubles EVERY quote PowerShell ends a '…' string at ──
  {
    for (const [cp, ch] of [['U+0027', "'"], ['U+2018', '\u2018'], ['U+2019', '\u2019'], ['U+201A', '\u201A'], ['U+201B', '\u201B']]) {
      eq(planWin.psQuote(`O${ch}Brien`), `'O${ch}${ch}Brien'`, `psQuote doubles ${cp}`);
    }
    eq(planWin.psQuote('a\u2019\u2018b\'c'), "'a\u2019\u2019\u2018\u2018b''c'", 'mixed quotes: each doubled in place');
    eq(planWin.psQuote('C:\\Users\\Ana \u017Dagar\\x'), "'C:\\Users\\Ana \u017Dagar\\x'", 'no quote: unchanged (non-ASCII kept)');
    // DUMB CROSS-CHECK, independent of psQuote: a minimal model of PowerShell's single-quoted
    // tokenizer (any of the five ends the string unless doubled) reads every literal back whole.
    const Q = new Set(["'", '\u2018', '\u2019', '\u201A', '\u201B']);
    const readBack = (lit) => {
      if (!Q.has(lit[0])) return null;
      let out = '';
      for (let i = 1; i < lit.length; i++) {
        if (Q.has(lit[i])) { if (Q.has(lit[i + 1])) { out += lit[i]; i++; continue; } return i === lit.length - 1 ? out : null; }
        out += lit[i];
      }
      return null;
    };
    for (const v of ["O'Brien", 'O\u2019Brien', '\u2018quoted\u2019', 'a\u201Ab\u201Bc', "C:\\Users\\Ž O\u2019B'x\\The Curator.exe"]) {
      eq(readBack(planWin.psQuote(v)), v, `the tokenizer model reads ${JSON.stringify(v)} back whole`);
    }
    ok(readBack(`'${'O\u2019Brien'.replace(/'/g, "''")}'`) !== 'O\u2019Brien', 'CONTROL: the old ASCII-only doubling does NOT survive U+2019 (the audit\'s case)');
    const curly = planWin.buildWin32InstallScript({ ...GOOD, exePath: 'C:\\Users\\O\u2019Brien\\AppData\\Local\\Programs\\The Curator\\The Curator.exe' });
    ok(curly.includes("$Exe = 'C:\\Users\\O\u2019\u2019Brien\\AppData\\Local\\Programs\\The Curator\\The Curator.exe'"), 'a user name with U+2019 reaches the helper as one literal');
    ok(planWin.buildProbeScript('C:\\Users\\O\u2019Brien\\x\\probe-1.txt').includes("'C:\\Users\\O\u2019\u2019Brien\\x\\probe-1.txt'"), '…and the probe script too');
  }
  // How it is started.
  const args = planWin.helperArgs("C:\\U\\O'B\\updates\\install-update.ps1");
  eq(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command'], 'powershell flags: no profile, non-interactive, hidden');
  eq(args[5], "& ([ScriptBlock]::Create([IO.File]::ReadAllText('C:\\U\\O''B\\updates\\install-update.ps1', [Text.Encoding]::UTF8)))",
    'the script FILE is run as a script block (not subject to the execution policy), read as UTF-8');
  // ── v3.99.3-wintest.4: observable from the first line, and a boot that catches what the script cannot ──
  {
    const LOG = 'C:\\U\\O\u2019B\\logs\\update-install.log';
    const boot = planWin.helperArgs('C:\\U\\updates\\install-update.ps1', { errorLogPath: LOG });
    eq(boot.slice(0, 5), args.slice(0, 5), 'the helper boot keeps the same flags');
    ok(boot[5].startsWith(`try { ${args[5].replace("O''B\\updates", 'updates')} } catch {`) || boot[5].startsWith('try { & ([ScriptBlock]::Create([IO.File]::ReadAllText('),
      'the helper\'s script block is built and run INSIDE a try');
    ok(boot[5].includes(`[IO.File]::AppendAllText(${planWin.psQuote(LOG)}, `) && boot[5].endsWith(`exit ${planWin.HELPER_EXIT_CODES['helper-error']} }`),
      '…whose catch writes the error to the log (.NET only) and exits helper-error (9)');
    eq(planWin.helperArgs('C:\\p.ps1'), planWin.helperArgs('C:\\p.ps1', {}), 'without errorLogPath the probe\'s boot is unchanged');
    ok(!/"/.test(boot[5]), 'the boot holds no double quote (nothing for a command line to escape)');
    let threw = false; try { planWin.helperArgs('C:\\p.ps1', { errorLogPath: 'C:\\a\nb' }); } catch { threw = true; }
    ok(threw, 'a log path with a newline is refused');

    const st = planWin.buildWin32InstallScript({ ...GOOD, startedPath: 'C:\\U\\updates\\install-update.started', scriptPath: 'C:\\U\\updates\\install-update.ps1' });
    const code = st.split('\r\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    eq(code[0], "try { [IO.File]::WriteAllText('C:\\U\\updates\\install-update.started', [string]$PID) } catch {}",
      'the helper\'s FIRST statement writes its PID to the start marker the launcher waits for');
    ok(/^try \{ \[IO\.File\]::AppendAllText\('C:\\U\\AppData\\Local\\TheCurator\\logs\\update-install\.log', .*' update-install: started, pid ' \+ \$PID/.test(code[1]),
      '…its SECOND appends a "started" line to the log');
    const head = st.slice(0, st.indexOf('Set-StrictMode'));
    ok(head.includes('trap {') && head.indexOf('trap {') > head.indexOf("update-install: started"), 'a trap is set before Set-StrictMode and after the first trace');
    const cmdlet = /\b(?:Add|Get|Set|Move|New|Remove|Out|Write|ConvertTo|Start|Test)-(?!Message\b|App\b)[A-Z]\w*/;
    ok(!cmdlet.test(head.slice(0, head.indexOf('trap {'))), 'nothing before the trap uses a cmdlet (no module has to load for the first trace)');
    const trapBody = head.slice(head.indexOf('trap {'));
    ok(/ERROR at line ' \+ \$err\.InvocationInfo\.ScriptLineNumber/.test(trapBody) && trapBody.includes('"result":"helper-error"') && /exit 9\r\n\}/.test(trapBody),
      'the trap logs the error with its line, records helper-error and exits 9');
    ok(/if \(-not \(Get-Process -Id 4242 [^\n]*\{ Start-App \}/.test(trapBody), '…reopens the old app only when it is no longer running');
    ok(/if \(\$SetupStarted\) \{ Show-Message \$MsgFailed \$true \} else \{ Show-Message \$MsgNotUpdated \$false \}/.test(trapBody) && st.includes(`$MsgNotUpdated = ${planWin.psQuote(planWin.WIN32_INSTALL_OUTCOMES['not-updated'])}`),
      '…and tells the person: "still on the previous version" before the setup ran, the repair offer after');
    ok(st.indexOf('$SetupStarted = $true') > st.indexOf("Write-Result 'installing' -1") && st.indexOf('$SetupStarted = $true') < st.indexOf('Start-Process -FilePath $Installer -ArgumentList'),
      '$SetupStarted turns true just before the setup is started');
    const fnLog = st.slice(st.indexOf('function Log('), st.indexOf('function Test-InstallerUnchanged'));
    ok(!cmdlet.test(fnLog.replace(/function Write-Result/g, '')), 'Log and Write-Result use .NET only (a record never depends on a module loading)');
    ok(st.includes("Remove-Quietly 'C:\\U\\updates\\install-update.started'") && st.indexOf("Log 'done'") > st.indexOf("Write-Result 'installed' 0"), 'after success the marker is removed and "done" logged');
    eq(planWin.describeInstallOutcome({ result: 'helper-error', version: '4.0.0', exitCode: 9 }, '3.0.0').message, planWin.WIN32_INSTALL_OUTCOMES['not-updated'],
      'a helper-error record read by the old version says "still on the previous version"');
  }
  // ── the Windows command line: winQuoteArg against an INDEPENDENT CommandLineToArgvW model ──
  {
    const cases = [
      '-NoProfile', '', 'a b', 'C:\\Program Files\\x\\', 'trail\\\\', 'say "hi"', 'a\\"b', 'a\\\\"b', '\\\\server\\share\\', 'tab\there',
      "& ([ScriptBlock]::Create([IO.File]::ReadAllText('C:\\Users\\Žiga O''Brien\\AppData\\Local\\TheCurator\\updates\\install-update.ps1', [Text.Encoding]::UTF8)))",
      planWin.helperArgs('C:\\Users\\Ana Ž\\updates\\install-update.ps1', { errorLogPath: 'C:\\Users\\Ana Ž\\logs\\update-install.log' })[5],
    ];
    for (const c of cases) eq(parseWinCommandLine(planWin.winCommandLine([c])), [c], `round-trips ${JSON.stringify(c).slice(0, 60)}`);
    const full = planWin.helperArgs("C:\\U\\O'B\\updates\\install-update.ps1", { errorLogPath: 'C:\\U\\logs\\update-install.log' });
    eq(parseWinCommandLine(planWin.winCommandLine(full)), full, 'the helper\'s whole argument list round-trips');
    eq(planWin.winCommandLine(['a', 'b c', '']), 'a "b c" ""', 'known answer: plain, spaced, empty');
    eq(planWin.winQuoteArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"', 'known answer: a trailing backslash before the closing quote is doubled');
    eq(planWin.winQuoteArg('a"b'), '"a\\"b"', 'known answer: a quote is escaped');
    // CONTROL: naive joining (what Start-Process -ArgumentList @(...) does in Windows PowerShell 5.1) does not round-trip.
    ok(JSON.stringify(parseWinCommandLine(full.join(' '))) !== JSON.stringify(full), 'CONTROL: joining the arguments with spaces would split the -Command');
  }
  // ── the launcher TEXT ──
  {
    const L = {
      powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: planWin.helperArgs('C:\\U\\updates\\install-update.ps1'),
      startedPath: 'C:\\U\\updates\\install-update.started', logPath: 'C:\\U\\logs\\update-install.log', workDir: 'C:\\U\\updates',
    };
    const l = planWin.buildWin32LaunchScript(L);
    eq(parseWinCommandLine(psUnquote(l.match(/\$Arguments = ('(?:[^']|'')*')/)[1])), L.args, 'the launcher carries the helper\'s arguments as one command line that reads back exactly');
    ok(l.includes(`$EnvDrop = ${planWin.psQuote(planWin.HELPER_ENV_DROP_SOURCE)}`), 'the launcher drops the same variables as helperEnv');
    const dropRe = new RegExp(planWin.HELPER_ENV_DROP_SOURCE, 'i');
    eq(['PORT', 'port', 'CURATOR_NO_OPEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'electron_x', 'PATH', 'SystemRoot', 'LOCALAPPDATA', 'PORTABLE', 'XPORT'].filter((k) => dropRe.test(k)),
      ['PORT', 'port', 'CURATOR_NO_OPEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'electron_x'], 'the drop rule: exactly those names, any case, and nothing that merely contains them');
    const iMarker = l.indexOf('if ([IO.File]::Exists($Started)) { Say (\'started \'');
    const iKill = l.indexOf('$p.Kill()');
    ok(iMarker > 0 && iKill > iMarker && l.indexOf("Say 'timeout' 23") > iKill && /\$p\.Kill\(\)[\s\S]*\[IO\.File\]::Delete\(\$Started\)[\s\S]*Say 'timeout'/.test(l),
      'only the marker means started; on time-out the helper is stopped and the marker removed before "timeout"');
    ok(/if \(\$p\.HasExited\) \{ if \(\[IO\.File\]::Exists\(\$Started\)\)/.test(l), 'a helper that ended is "started" only if it wrote the marker');
    ok(!/EncodedCommand|ExecutionPolicy|Invoke-Expression|\biex\b|Start-Process/i.test(l), 'no encoded command, no policy override, no eval, no Start-Process (it joins arguments unquoted in 5.1)');
    for (const [label, over] of [['no powershell', { powershell: '' }], ['a newline in an argument', { args: ['a\nb'] }], ['no arguments', { args: [] }], ['wait 0', { waitSeconds: 0 }], ['no workDir', { workDir: '' }]]) {
      let threw = false; try { planWin.buildWin32LaunchScript({ ...L, ...over }); } catch { threw = true; }
      ok(threw, `the launcher refuses ${label}`);
    }
  }
  eq(planWin.powershellPath({ SYSTEMROOT: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'PowerShell by absolute path from SystemRoot (any key case), never PATH');
  eq(planWin.powershellPath({ SystemRoot: '\\\\evil\\share' }), null, 'a UNC SystemRoot is refused');
  eq(planWin.powershellPath({}), null, 'no SystemRoot: no PowerShell');
  const env = planWin.helperEnv({ Path: 'C:\\x', PORT: '5555', curator_no_open: '1', ELECTRON_RUN_AS_NODE: '1', electron_enable_logging: '1', NODE_OPTIONS: '--x', LOCALAPPDATA: 'C:\\L', N: 5 });
  eq(env, { Path: 'C:\\x', LOCALAPPDATA: 'C:\\L' }, 'the helper env drops PORT, CURATOR_NO_OPEN, ELECTRON_*, NODE_OPTIONS (any case) and non-strings');
  eq(planWin.normaliseProductVersion('4.0.0.0'), '4.0.0', 'ProductVersion 4.0.0.0 reads as 4.0.0');
  eq(planWin.normaliseProductVersion(' v4.0.0\r\n'), '4.0.0', 'trimmed, leading v dropped');
  eq(planWin.normaliseProductVersion('4.0.0.1'), '4.0.0.1', 'a real fourth component is kept (and so mismatches)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 prepareUpdate / installUpdate, EXECUTED, every refusal');
// ═══════════════════════════════════════════════════════════════════════════
const IS_WIN = process.platform === 'win32';
function fixture({ uninstaller = true } = {}) {
  const root = tmpdir('fx');
  const installDir = path.join(root, 'Programs', 'The Curator');
  mkdirSync(installDir, { recursive: true });
  const exePath = path.join(installDir, 'The Curator.exe');
  writeFileSync(exePath, 'MZ old app');
  const uninstallerPath = path.join(installDir, 'Uninstall The Curator.exe');
  if (uninstaller) writeFileSync(uninstallerPath, 'MZ uninstaller');
  writeFileSync(path.join(installDir, 'resources.txt'), 'keep me');
  const workDir = path.join(root, 'TheCurator', 'updates');
  return { root, installDir, exePath, uninstallerPath, workDir };
}
/** A fake PowerShell. It understands the four things the engine asks: the
 *  probe (runs the script FILE it is pointed at and writes the language mode
 *  the scenario says), the version read, the process list, and the LAUNCHER
 *  (reads the launcher file, records the helper it would start, and plays
 *  the scenario's `launch` outcome: by default the helper writes its start
 *  marker and the launcher says "started"). */
function fakePowerShell(sc = {}, launched = []) {
  const calls = [];
  const runCommand = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    const c = args[args.length - 1] || '';
    const fileMatch = c.match(/ReadAllText\('((?:[^']|'')+)'/);
    if (fileMatch && readFileSync(fileMatch[1].replace(/''/g, "'"), 'utf8').includes('# The Curator: starts the update helper')) {
      const body = readFileSync(fileMatch[1].replace(/''/g, "'"), 'utf8');
      const lit = (name) => psUnquote(body.match(new RegExp(`\\$${name} = ('(?:[^']|'')*')`))[1]);
      const helper = { cmd: lit('Ps'), args: parseWinCommandLine(lit('Arguments')), started: lit('Started'), body, opts };
      launched.push(helper);
      const mode = sc.launch || 'started';
      if (mode === 'started' || mode === 'started-but-timed-out') writeFileSync(helper.started, '5555');
      if (mode === 'started') return { status: 0, stdout: 'started 5555\r\n', stderr: '' };
      if (mode === 'started-but-timed-out') return { status: 124, stdout: '', stderr: '', timedOut: true };
      if (mode === 'said-started-no-marker') return { status: 0, stdout: 'started 5555\r\n', stderr: '' };
      if (mode === 'exited') return { status: 22, stdout: 'exited 9\r\n', stderr: '' };
      if (mode === 'timeout') return { status: 23, stdout: 'timeout\r\n', stderr: '' };
      return { status: 21, stdout: 'not-started\r\n', stderr: 'C:\\Users\\someone\\secret path' };
    }
    if (fileMatch) {
      if (sc.probeStatus && sc.probeStatus !== 0) return { status: sc.probeStatus, stdout: '', stderr: 'blocked' };
      const scriptFile = fileMatch[1].replace(/''/g, "'");
      const body = readFileSync(scriptFile, 'utf8');
      const marker = body.match(/WriteAllText\('((?:[^']|'')+)'/)[1].replace(/''/g, "'");
      writeFileSync(marker, sc.languageMode || 'FullLanguage');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (/VersionInfo\.ProductVersion/.test(c)) {
      if (sc.versionStatus) return { status: sc.versionStatus, stdout: '', stderr: 'x' };
      return { status: 0, stdout: `${sc.productVersion ?? `${V_NEXT}.0`}\r\n`, stderr: '' };
    }
    if (/Win32_Process/.test(c)) {
      if (sc.listStatus) return { status: sc.listStatus, stdout: '', stderr: 'denied' };
      return { status: 0, stdout: JSON.stringify(sc.processes || []), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  return { runCommand, calls };
}
function makeEngine(fx, over = {}) {
  // `spawned`: the helpers the LAUNCHER started (what used to be a detached
  // spawn). `detached`: calls to spawnDetached, which Windows must never make.
  const spawned = [];
  const detached = [];
  const ps = fakePowerShell(over.ps || {}, spawned);
  const payload = over.payload || [rel(V_NEXT)];
  const net = releaseFetch(payload, over.assetResponder);
  const quits = [];
  const reg = { begins: 0, ends: 0, active: !!over.activeWrites };
  const eng = win.createWin32UpdateEngine({
    resolveRelease: over.resolveRelease || (({ signal }) => release.resolveInstallerRelease({
      configModule: cfg, fetchImpl: net.fn, currentVersion: PKG_VERSION, arch: 'x64', platform: 'win32', signal,
    })),
    fetchImpl: net.fn,
    sleepImpl: async () => {},
    execPath: fx.exePath,
    arch: 'x64',
    env: { SystemRoot: 'C:\\Windows', PORT: '4321', ELECTRON_RUN_AS_NODE: '1', LOCALAPPDATA: 'C:\\L' },
    workDir: fx.workDir,
    logPath: path.join(fx.root, 'update-install.log'),
    runCommand: ps.runCommand,
    spawnDetached: (cmd, args, opts) => { detached.push({ cmd, args, opts }); return {}; },
    quitApp: 'quitApp' in over ? over.quitApp : () => { quits.push(1); },
    writeRegistry: {
      hasActiveWrites: () => reg.active, listActiveWrites: () => [{ domain: 'd', op: 'ingest' }],
      beginUpdate: () => { reg.begins += 1; }, endUpdate: () => { reg.ends += 1; },
    },
    pid: 1000,
    randomId: (() => { let i = 0; return () => `id${i++}`; })(),
    pathImpl: path,
    classifyTarget: () => ({ ok: true, exePath: fx.exePath, exeName: 'The Curator.exe', installDir: fx.installDir, uninstallerPath: fx.uninstallerPath, warning: null }),
    showMessages: false,
  });
  return { eng, ps, net, spawned, detached, quits, reg };
}
const seenReasons = new Set();
const note = (r) => { if (r && r.ok === false) seenReasons.add(r.reason); return r; };
const listWork = (fx) => (existsSync(fx.workDir) ? readdirSync(fx.workDir).sort() : []);
{
  // ── the happy path ──
  const fx = fixture();
  mkdirSync(fx.workDir, { recursive: true });
  writeFileSync(path.join(fx.workDir, 'v0.0.1-TheCurator-0.0.1-x64-Windows-Setup.exe'), 'an OLD setup program');
  writeFileSync(path.join(fx.installDir, `${planWin.INSTALL_PROBE_PREFIX}leftover`), '');
  const t = makeEngine(fx);
  const phases = [];
  const r = await t.eng.prepareUpdate({ onProgress: (p) => phases.push(p.phase) });
  ok(r.ok, `prepareUpdate resolves, downloads and verifies (${r.reason || 'ok'} ${r.detail || ''})`);
  eq(r.version, V_NEXT, '…the version Settings would name');
  eq(r.verifiedDigest, `sha256:${SETUP_SHA}`, '…verified against GitHub\'s SHA-256');
  eq([...new Set(phases)], ['resolving', 'downloading', 'verifying', 'staging'], 'progress runs resolving → downloading → verifying → staging');
  const setupName = `v${V_NEXT}-TheCurator-${V_NEXT}-x64-Windows-Setup.exe`;
  eq(listWork(fx), [setupName], 'updates\\ holds exactly the new setup program: the old one, probes and scripts were swept');
  eq(sha256(readFileSync(path.join(fx.workDir, setupName))), SETUP_SHA, 'the file on disk is the published bytes');
  if (!IS_WIN) eq(statSync(path.join(fx.workDir, setupName)).mode & 0o222, 0, 'it is read-only until Install');
  ok(!existsSync(path.join(fx.installDir, `${planWin.INSTALL_PROBE_PREFIX}leftover`)), 'a leftover writability probe in the install folder was removed');
  eq(readdirSync(fx.installDir).sort(), ['Resources.txt'.toLowerCase(), 'The Curator.exe', 'Uninstall The Curator.exe'].sort(),
    'nothing else in the install folder was touched');
  eq(t.net.calls.assetUrls, [assetUrl(V_NEXT, `TheCurator-${V_NEXT}-x64-Windows-Setup.exe`)], 'exactly one download, of the setup program');
  eq(t.spawned.length + t.quits.length, 0, 'prepare runs nothing and quits nothing');
  eq(engine.createUpdateInstaller('win32', {}).describe(), { preparedVersion: null, token: null, verifiedDigest: null }, 'describe() of a fresh engine is empty');
  eq(t.eng.describe().preparedVersion, V_NEXT, 'describe() names the prepared version, never a path');

  const inst = await t.eng.installUpdate({ token: r.token });
  ok(inst.ok && inst.installing, `installUpdate hands off and quits (${inst.reason || 'ok'})`);
  eq(t.spawned.length, 1, 'one helper is started (by the launcher)');
  eq(t.detached.length, 0, '…and NOTHING is started detached (v3.99.3-wintest.4: a detached helper left no trace)');
  const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const launchPath = path.join(fx.workDir, win.LAUNCH_SCRIPT);
  const launchCalls = t.ps.calls.filter((c) => c.args[c.args.length - 1].includes(planWin.psQuote(launchPath)));
  eq(launchCalls.map((c) => [c.cmd, c.args]), [[PS_EXE, planWin.helperArgs(launchPath)]], 'the launcher runs ONCE, through runCommand (waited for), by PowerShell\'s absolute path, in the probe\'s proven form');
  ok(launchCalls[0].opts.timeoutMs >= (planWin.LAUNCH_WAIT_SECONDS + 10) * 1000, '…with a timeout longer than its own wait for the helper');
  eq(t.spawned[0].cmd, PS_EXE, 'the launcher starts the helper by PowerShell\'s absolute path');
  const scriptPath = path.join(fx.workDir, win.HELPER_SCRIPT);
  const logPath = path.join(fx.root, 'update-install.log');
  eq(t.spawned[0].args, planWin.helperArgs(scriptPath, { errorLogPath: logPath }),
    '…pointed at the script it wrote, with the boot that logs an error the script cannot catch (read back through an independent command-line model)');
  eq(t.spawned[0].started, path.join(fx.workDir, win.HELPER_STARTED), '…and waits for the helper\'s start marker in updates\\');
  ok(t.spawned[0].body.includes('$psi.UseShellExecute = $true') && t.spawned[0].body.includes('[System.Diagnostics.ProcessWindowStyle]::Hidden'),
    '…started through the shell, hidden (no inherited handles: runCommand is not held open by the helper)');
  ok(t.spawned[0].body.includes(`$EnvDrop = ${planWin.psQuote(planWin.HELPER_ENV_DROP_SOURCE)}`) && /SetEnvironmentVariable\(\[string\]\$k, \$null\)/.test(t.spawned[0].body),
    '…with a clean environment: the same drop rule as helperEnv (the reopened app is not told this app\'s port, and is never run as Node)');
  ok(!existsSync(launchPath), 'the launcher file is removed after it ran');
  ok(existsSync(path.join(fx.workDir, win.HELPER_STARTED)), 'the start marker the helper wrote is what let the app quit');
  const scriptBytes = readFileSync(scriptPath);
  eq([...scriptBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the script has a UTF-8 BOM (Windows PowerShell 5.1 would read it as ANSI otherwise)');
  const script = scriptBytes.toString('utf8');
  ok(script.includes('$AppPid = 1000') && script.includes(`$Sha256 = '${SETUP_SHA}'`) && script.includes(`$Size = ${SETUP_BYTES.length}`)
    && script.includes(planWin.psQuote(path.join(fx.workDir, setupName))), 'the script names this PID, the verified setup, its size and SHA-256');
  eq([t.reg.begins, t.reg.ends, t.quits.length], [1, 0, 1], 'beginUpdate is taken, then the app quits');
  eq(t.ps.calls.filter((c) => /Win32_Process/.test(c.args.join(' '))).length, 1, 'who holds the exe was asked once, before quitting');
}
{
  // ── refusals before any network ──
  const fx = fixture({ uninstaller: false });
  const t = makeEngine(fx);
  const r = note(await t.eng.prepareUpdate({}));
  eq(r.reason, 'not-installed-copy', 'no NSIS uninstaller beside the exe: not-installed-copy');
  eq(t.net.calls.api + t.net.calls.asset, 0, '…before any network');
  const fx2 = fixture();
  const t2 = makeEngine(fx2, { ps: { languageMode: 'ConstrainedLanguage' } });
  eq(note(await t2.eng.prepareUpdate({})).reason, 'helper-unavailable', 'a PC locked to ConstrainedLanguage: helper-unavailable');
  eq(t2.net.calls.asset, 0, '…before the download');
  const t3 = makeEngine(fixture(), { ps: { probeStatus: 1 } });
  eq(note(await t3.eng.prepareUpdate({})).reason, 'helper-unavailable', 'PowerShell refusing the helper invocation: helper-unavailable');
  const t4env = win.createWin32UpdateEngine({ execPath: 'x', workDir: tmpdir('noenv'), classifyTarget: () => ({ ok: true, exePath: fx2.exePath, installDir: fx2.installDir, uninstallerPath: fx2.uninstallerPath }), resolveRelease: async () => ({ ok: false, reason: 'no-update', message: 'm' }), env: {} });
  eq(note(await t4env.prepareUpdate({})).reason, 'no-update', 'release refusals pass through (no-update) before the helper probe is needed');
  if (!IS_WIN && process.getuid && process.getuid() !== 0) {
    const fx5 = fixture();
    chmodSync(fx5.installDir, 0o555);
    const t5 = makeEngine(fx5);
    const r5 = note(await t5.eng.prepareUpdate({}));
    chmodSync(fx5.installDir, 0o755);
    eq(r5.reason, 'install-dir-not-writable', 'an install folder that refuses a file: install-dir-not-writable (measured by writing one)');
    eq(t5.net.calls.asset, 0, '…before the download');
  }
}
{
  // ── download and verification failures: nothing kept, nothing run ──
  const cases = [
    ['a wrong SHA-256', { assetResponder: () => new Response(Buffer.concat([SETUP_BYTES.subarray(0, -1), Buffer.from([1])]), { status: 200 }) }, 'digest-mismatch'],
    ['a short body', { assetResponder: () => new Response(SETUP_BYTES.subarray(0, 1000), { status: 200 }) }, 'size-mismatch'],
    ['a body that dies half way', {
      assetResponder: () => new Response(new ReadableStream({
        start(c) { c.enqueue(SETUP_BYTES.subarray(0, 4096)); c.error(new Error('socket hang up')); },
      }), { status: 200 }),
    }, 'download-truncated'],
    ['an oversized body', { assetResponder: () => new Response(Buffer.concat([SETUP_BYTES, Buffer.alloc(10)]), { status: 200 }) }, 'download-oversized'],
    ['a 404', { assetResponder: () => new Response('', { status: 404 }) }, 'download-not-found'],
    ['GitHub 500 three times', { assetResponder: () => new Response('<html>Server Error</html>', { status: 500 }) }, 'download-server-error'],
    ['no digest published', { payload: [rel(V_NEXT, { exeDigest: false })] }, 'digest-missing'],
    ['the setup reports another version', { ps: { productVersion: '9.9.9' } }, 'staged-version-mismatch'],
    ['the setup version cannot be read', { ps: { versionStatus: 1 } }, 'installer-check-failed'],
    ['the setup version is empty', { ps: { productVersion: '' } }, 'installer-check-failed'],
  ];
  for (const [label, over, want] of cases) {
    const fx = fixture();
    const t = makeEngine(fx, over);
    const r = note(await t.eng.prepareUpdate({}));
    eq(r.reason, want, `${label}: ${want}`);
    eq(listWork(fx), [], `${label}: nothing is left in updates\\`);
    ok(!MAC_WORDS.test(r.message || '') && (r.message || '').length > 20, `${label}: a plain Windows sentence ("${r.message}")`);
    eq(t.spawned.length + t.quits.length, 0, `${label}: nothing ran, nothing quit`);
    if (want === 'digest-missing') eq(t.net.calls.asset, 0, 'no digest: the download is never even started');
    if (want === 'download-server-error') ok(/3 times in a row/.test(r.message), '…and it says how many times it asked');
  }
  // Cancelled.
  const fx = fixture();
  const t = makeEngine(fx);
  const ac = new AbortController(); ac.abort();
  const r = note(await t.eng.prepareUpdate({ signal: ac.signal }));
  ok(['download-cancelled', 'network-unreachable'].includes(r.reason), `an aborted check stops at once (${r.reason})`);
  // Cancel mid-download, and the retry ladder.
  const fxc = fixture();
  const ac2 = new AbortController();
  const tc = makeEngine(fxc, {
    assetResponder: () => new Response(new ReadableStream({
      start(c) { c.enqueue(SETUP_BYTES.subarray(0, 1024)); ac2.abort(); c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); },
    }), { status: 200 }),
  });
  const rc = note(await tc.eng.prepareUpdate({ signal: ac2.signal }));
  eq(rc.reason, 'download-cancelled', 'cancelled half way: download-cancelled');
  eq(rc.message, planWin.WIN32_UPDATE_FAILURES['download-cancelled'], '…"Nothing on this PC was changed."');
  eq(listWork(fxc), [], '…and the partial file is gone');
  const fxr = fixture();
  const tr = makeEngine(fxr, { assetResponder: (u, n) => (n === 1 ? new Response('busy', { status: 500 }) : new Response(SETUP_BYTES, { status: 200 })) });
  ok((await tr.eng.prepareUpdate({})).ok, 'one GitHub 500, then the file: the update goes ahead (the Mac ladder, shared)');
  eq(tr.net.calls.asset, 2, '…after exactly two requests');
  const fx429 = fixture();
  const t429 = makeEngine(fx429, { assetResponder: (u, n) => (n === 1 ? new Response('slow', { status: 429 }) : new Response(SETUP_BYTES, { status: 200 })) });
  ok((await t429.eng.prepareUpdate({})).ok, 'a 429 is retried too');
  const fx404 = fixture();
  const t404 = makeEngine(fx404, { assetResponder: () => new Response('', { status: 404 }) });
  await t404.eng.prepareUpdate({});
  eq(t404.net.calls.asset, 1, 'a 404 is never retried');
}
{
  // ── install-time refusals ──
  const prepared = async (over = {}) => {
    const fx = fixture();
    const t = makeEngine(fx, over);
    const r = await t.eng.prepareUpdate({});
    if (!r.ok) throw new Error(`fixture prepare failed: ${r.reason}`);
    return { fx, t, r };
  };
  {
    const t = makeEngine(fixture());
    eq(note(await t.eng.installUpdate({ token: 'x' })).reason, 'not-prepared', 'install with nothing prepared: not-prepared');
  }
  {
    const { t } = await prepared();
    eq(note(await t.eng.installUpdate({ token: 'not-the-token' })).reason, 'stale-token', 'a token that is not the prepared one: stale-token');
    eq(t.spawned.length, 0, '…nothing ran');
  }
  {
    const BRIDGE = { pid: 4242, ppid: 77, cmd: '"C:\\P\\The Curator.exe" "C:\\P\\resources\\app\\mcp\\server.js"' };
    const { t, r } = await prepared({ ps: { processes: [{ pid: 1000, ppid: 1, cmd: 'x' }, { pid: 1001, ppid: 1000, cmd: 'x --type=gpu-process' }, BRIDGE] } });
    const refused = note(await t.eng.installUpdate({ token: r.token }));
    eq(refused.reason, 'in-use-by-ai-app', 'Claude Desktop\'s MCP bridge holds the exe: refused BEFORE quitting');
    eq([refused.connections, refused.canStopConnections], [1, true], '…with the count and the offer to stop it, never a PID or a path');
    ok(/Quit that app/.test(refused.message) && /Nothing was changed/.test(refused.message), `…in plain words: "${refused.message}"`);
    eq([t.spawned.length, t.quits.length, t.reg.begins], [0, 0, 0], '…nothing ran, the app did not quit, no update marker');
    const go = await t.eng.installUpdate({ token: r.token, stopConnections: true });
    ok(go.ok && go.stoppedConnections === 1, 'with the person\'s agreement (stopConnections) it goes ahead');
    ok(readFileSync(bootFile(t.spawned[0].args[5]), 'utf8').includes('$StopPids = @(4242)'),
      '…and the helper is told exactly which connection it may stop');
  }
  {
    const { t, r } = await prepared({ ps: { processes: [{ pid: 3000, ppid: 9, cmd: '"C:\\P\\The Curator.exe"' }] } });
    const x = note(await t.eng.installUpdate({ token: r.token, stopConnections: true }));
    eq(x.reason, 'in-use-other', 'another copy of the app: refused, and stopConnections never stops a copy of the app');
    eq(t.spawned.length, 0, '…nothing ran');
  }
  {
    const { t, r } = await prepared({ ps: { listStatus: 1 } });
    const x = await t.eng.installUpdate({ token: r.token });
    ok(x.ok && x.holdersUnchecked === true, 'when the process list cannot be read the update proceeds, marked unchecked (the helper\'s exclusive open is the backstop)');
  }
  {
    const { t, r } = await prepared({ activeWrites: true });
    const x = note(await t.eng.installUpdate({ token: r.token }));
    eq(x.reason, 'writes-in-progress', 'an ingest is writing: writes-in-progress');
    eq(x.operations, [{ domain: 'd', op: 'ingest' }], '…naming what is running');
    eq(t.spawned.length + t.quits.length, 0, '…nothing ran, nothing quit');
  }
  {
    const { fx, t, r } = await prepared();
    const f = path.join(fx.workDir, readdirSync(fx.workDir)[0]);
    chmodSync(f, 0o644); writeFileSync(f, Buffer.concat([SETUP_BYTES.subarray(0, -1), Buffer.from([9])]));
    const x = note(await t.eng.installUpdate({ token: r.token }));
    eq(x.reason, 'digest-mismatch', 'the setup program changed on disk after it was checked: refused');
    eq(listWork(fx), [], '…and discarded');
    eq(t.spawned.length, 0, '…nothing ran');
  }
  {
    const { fx, t, r } = await prepared();
    rmSync(path.join(fx.workDir, readdirSync(fx.workDir)[0]), { force: true });
    eq(note(await t.eng.installUpdate({ token: r.token })).reason, 'not-prepared', 'the setup program was deleted after prepare: not-prepared');
  }
  {
    const { t, r } = await prepared({ quitApp: null });
    eq(note(await t.eng.installUpdate({ token: r.token })).reason, 'relaunch-unavailable', 'no way to quit: relaunch-unavailable, checked before the helper starts');
    eq(t.spawned.length, 0, '…nothing ran');
  }
  // ── the helper never started: the app does NOT quit, and says so ──
  for (const [mode, label, said] of [
    ['not-started', 'Windows refused to start the helper', 'launcher exited 21: not-started'],
    ['exited', 'the helper ended before its first line (a parse error)', 'launcher exited 22: exited 9'],
    ['timeout', 'the helper did not start in time', 'launcher exited 23: timeout'],
    ['said-started-no-marker', 'the launcher said "started" but no marker exists (stdout is not proof)', 'launcher exited 0: started 5555'],
  ]) {
    const { fx, t, r } = await prepared({ ps: { launch: mode } });
    const x = note(await t.eng.installUpdate({ token: r.token }));
    eq(x.reason, 'helper-spawn-failed', `${label}: helper-spawn-failed`);
    eq([t.reg.begins, t.reg.ends, t.quits.length], [1, 1, 0], '…the update marker is released and the app STAYS OPEN');
    ok(/nothing was changed/.test(x.message), `…in plain words: "${x.message}"`);
    eq(x.detail, said, '…with the launcher\'s own word as the support detail (never its stderr, which can hold paths)');
    ok(!existsSync(path.join(fx.workDir, win.LAUNCH_SCRIPT)), '…the launcher file is removed');
    ok(existsSync(path.join(fx.workDir, readdirSync(fx.workDir).find((n) => n.endsWith('.exe')))), '…and the verified setup is kept, so Install can be pressed again');
  }
  {
    // runCommand's own timeout fired, but the helper HAD written its marker:
    // it is running and waiting for this app to quit, so the app quits.
    const { t, r } = await prepared({ ps: { launch: 'started-but-timed-out' } });
    const x = await t.eng.installUpdate({ token: r.token });
    ok(x.ok && x.installing, 'the marker decides, not the launcher\'s status: a marker after a runCommand timeout = started');
    eq(t.quits.length, 1, '…and the app quits so the helper can go on');
  }
  {
    // A stale marker from an earlier run must not pass for this one.
    const { fx, t, r } = await prepared({ ps: { launch: 'timeout' } });
    writeFileSync(path.join(fx.workDir, win.HELPER_STARTED), '1');
    const x = note(await t.eng.installUpdate({ token: r.token }));
    eq([x.reason, t.quits.length], ['helper-spawn-failed', 0], 'a start marker left from an earlier run is removed before the launcher runs: it never lets the app quit');
  }
  {
    const { t, r } = await prepared({ quitApp: () => { throw new Error('no'); } });
    const x = note(await t.eng.installUpdate({ token: r.token }));
    eq(x.reason, 'relaunch-unavailable', 'quitting threw: relaunch-unavailable');
    eq(t.reg.ends, 1, '…and the update marker is released');
  }
  {
    const { fx, t } = await prepared();
    const d = await t.eng.discardPrepared();
    eq(d, { ok: true, discarded: true }, 'discardPrepared throws the prepared update away');
    eq(listWork(fx), [], '…including the read-only setup program');
  }
  {
    // A hook that throws inside never rejects.
    const t = makeEngine(fixture(), { resolveRelease: () => { throw new TypeError('wired wrong'); } });
    const x = note(await t.eng.prepareUpdate({}));
    ok(x.ok === false && ['network-unreachable', 'internal-error'].includes(x.reason), `a resolver that throws gives a named reason (${x.reason}), never a rejection`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 afterStart: the outcome record and update cleanup');
// ═══════════════════════════════════════════════════════════════════════════
{
  const setup = (v) => `v${v}-TheCurator-${v}-x64-Windows-Setup.exe`;
  const scenario = (record, files) => {
    const fx = fixture();
    mkdirSync(fx.workDir, { recursive: true });
    if (record) writeFileSync(path.join(fx.workDir, win.RESULT_FILE), `\uFEFF${JSON.stringify(record)}`);
    for (const f of files) { const p = path.join(fx.workDir, f); writeFileSync(p, 'x'); chmodSync(p, 0o444); }
    return { fx, eng: makeEngine(fx).eng };
  };
  {
    const { fx, eng } = scenario({ result: 'installed', version: '4.0.0', exitCode: 0 }, [setup('4.0.0'), win.HELPER_SCRIPT]);
    const r = await eng.afterStart({ currentVersion: '4.0.0' });
    eq(r.outcome && r.outcome.status, 'updated', 'the app opened on the new version: updated');
    eq(r.outcome.message, null, '…nothing to warn about');
    eq(listWork(fx), [], '…and updates\\ is empty: the record, the read-only setup and the script are gone');
    eq((await eng.afterStart({ currentVersion: '4.0.0' })).outcome, null, 'the record is read ONCE');
  }
  {
    const { fx, eng } = scenario({ result: 'installing', version: '4.0.0' }, [setup('4.0.0')]);
    eq((await eng.afterStart({ currentVersion: '4.0.0' })).outcome.status, 'updated',
      'the setup reopened the NEW app before the helper wrote "installed": the version decides, so it is a success');
    eq(listWork(fx), [], '…cleaned');
  }
  {
    const { fx, eng } = scenario({ result: 'exe-in-use', version: '4.0.0', exitCode: 4 }, [setup('4.0.0'), setup('3.0.0'), win.HELPER_SCRIPT]);
    const r = await eng.afterStart({ currentVersion: '3.9.0' });
    eq([r.outcome.status, r.outcome.result], ['failed', 'exe-in-use'], 'the helper found the exe in use: the old app says so');
    eq(r.outcome.message, planWin.WIN32_INSTALL_OUTCOMES['exe-in-use'], '…in the catalogue\'s words');
    eq(listWork(fx), [setup('4.0.0')], '…the failed version\'s setup program is KEPT (the repair path); every other file goes');
  }
  {
    const { eng } = scenario({ result: 'installed', version: '4.0.0', exitCode: 0 }, []);
    const r = await eng.afterStart({ currentVersion: '3.9.0' });
    eq([r.outcome.status, r.outcome.result], ['failed', 'installed'], 'the helper said "installed" but the app is still old: a FAILURE, said as one');
    eq(r.outcome.message, planWin.WIN32_INSTALL_OUTCOMES['not-updated'], '…"still on the previous version"');
  }
  {
    const { eng } = scenario({ result: 'installing', version: '4.0.0' }, []);
    eq((await eng.afterStart({ currentVersion: '3.9.0' })).outcome.message, planWin.WIN32_INSTALL_OUTCOMES['not-updated'],
      'a helper that died mid-install (record still "installing", app old): not-updated, never silent');
  }
  {
    const { fx, eng } = scenario(null, ['probe-x.ps1', 'probe-x.txt', setup('2.0.0')]);
    const r = await eng.afterStart({ currentVersion: '3.0.0' });
    eq([r.outcome, listWork(fx)], [null, []], 'no record: nothing to say, and leftovers are swept');
  }
  {
    const fx = fixture();
    mkdirSync(fx.workDir, { recursive: true });
    writeFileSync(path.join(fx.workDir, win.RESULT_FILE), '{not json');
    const r = await makeEngine(fx).eng.afterStart({ currentVersion: '1.0.0' });
    eq(r.outcome, null, 'an unreadable record is no outcome (and never a crash)');
    const missing = await win.createWin32UpdateEngine({ workDir: path.join(TMP, 'does-not-exist') }).afterStart({});
    eq(missing.ok, true, 'afterStart with no updates folder at all: fine');
  }
  // ── audit M3: the sweeps delete ONLY the engine's own files ──
  {
    const fx = fixture();
    mkdirSync(path.join(fx.workDir, 'my-domain', 'wiki', 'concepts'), { recursive: true });
    const page = path.join(fx.workDir, 'my-domain', 'wiki', 'concepts', 'page.md');
    writeFileSync(page, '# a page\n');
    // A FOLDER named like an engine file is not the engine's either.
    mkdirSync(path.join(fx.workDir, win.HELPER_SCRIPT), { recursive: true });
    writeFileSync(path.join(fx.workDir, win.HELPER_SCRIPT, 'inside.md'), 'kept');
    mkdirSync(path.join(fx.workDir, 'v9.9.9-folder.exe'), { recursive: true });
    for (const f of ['notes.txt', 'index.md', 'Setup.exe', 'probe-.ps1', 'probe-x.ps1.bak', 'last-update.json.bak']) writeFileSync(path.join(fx.workDir, f), 'mine');
    const engineFiles = [win.RESULT_FILE, `${win.RESULT_FILE}.tmp`, 'probe-ab12.ps1', 'probe-ab12.txt', setup('2.0.0'), 'v3.100.0-TheCurator-3.100.0-x64-Windows-Setup.exe'];
    for (const f of engineFiles) { const p = path.join(fx.workDir, f); writeFileSync(p, 'x'); chmodSync(p, 0o444); }
    const r = await makeEngine(fx).eng.afterStart({ currentVersion: '3.0.0' });
    eq(r.removed, engineFiles.length, `afterStart removes exactly the ${engineFiles.length} engine files`);
    eq(listWork(fx), [win.HELPER_SCRIPT, 'Setup.exe', 'index.md', 'last-update.json.bak', 'my-domain', 'notes.txt', 'probe-.ps1', 'probe-x.ps1.bak', 'v9.9.9-folder.exe'].sort(),
      '…and keeps everything else: a knowledge folder, files a person put there, folders named like engine files');
    eq(readFileSync(page, 'utf8'), '# a page\n', '…the page inside the knowledge folder is untouched (the audit\'s repro)');
    eq(readFileSync(path.join(fx.workDir, win.HELPER_SCRIPT, 'inside.md'), 'utf8'), 'kept', '…and nothing inside a folder is ever removed (never recursive)');
    // prepareUpdate's clean slate is the same sweep.
    const fx2 = fixture();
    mkdirSync(path.join(fx2.workDir, 'kb', 'wiki'), { recursive: true });
    writeFileSync(path.join(fx2.workDir, 'kb', 'wiki', 'p.md'), 'p');
    writeFileSync(path.join(fx2.workDir, 'readme.txt'), 'mine');
    writeFileSync(path.join(fx2.workDir, setup('0.0.1')), 'old');
    const p2 = await makeEngine(fx2).eng.prepareUpdate({});
    ok(p2.ok, `CONTROL: prepareUpdate succeeded beside a person's files (${p2.reason || 'ok'})`);
    ok(existsSync(path.join(fx2.workDir, 'kb', 'wiki', 'p.md')) && existsSync(path.join(fx2.workDir, 'readme.txt')),
      'prepareUpdate\'s clean slate keeps a knowledge folder and a person\'s file');
    ok(!existsSync(path.join(fx2.workDir, setup('0.0.1'))), '…and still removes the old staged setup program');
    // The name test, directly.
    for (const n of [win.HELPER_SCRIPT, win.LAUNCH_SCRIPT, win.HELPER_STARTED, win.RESULT_FILE, 'probe-id0.ps1', 'probe-id0.txt', 'v4.0.0-TheCurator-4.0.0-x64-Windows-Setup.exe', '4.0.0-x.exe']) {
      ok(win.isEngineFileName(n), `engine file: ${n}`);
    }
    for (const n of ['domains', 'notes.md', 'Setup.exe', 'probe-a/b.ps1', 'v4-x.exe', '.curator-config.json', '', 'probe-x.ps1.bak']) {
      ok(!win.isEngineFileName(n), `not the engine's: ${JSON.stringify(n)}`);
    }
  }
  for (const [k, msg] of Object.entries(planWin.WIN32_INSTALL_OUTCOMES)) {
    ok(!MAC_WORDS.test(msg) && msg.length > 40, `outcome "${k}" is a plain Windows sentence`);
  }
  ok(/safe/.test(planWin.WIN32_INSTALL_OUTCOMES['installer-failed']) && /run the installer again/.test(planWin.WIN32_INSTALL_OUTCOMES['installer-failed']),
    'a failed setup says the data is safe and how to repair');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 (Windows only) the helper EXECUTED by real PowerShell');
// ═══════════════════════════════════════════════════════════════════════════
if (!IS_WIN) {
  console.log('    skipped: not Windows (runs on the windows-latest job; CURATOR_REQUIRE_WIN_HELPER=1 makes a skip RED there)');
} else {
  const PS = planWin.powershellPath(process.env);
  ok(!!PS && existsSync(PS), `Windows PowerShell is at ${PS}`);
  const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  const runHelper = async ({ name, setupBody, holdExe = false, tamper = false }) => {
    const fx = fixture();
    // The "app": a copy of node.exe named The Curator.exe, so a real process
    // can hold it, and Test-AppRunning has a real image to look for.
    copyFileSync(process.execPath, fx.exePath);
    mkdirSync(fx.workDir, { recursive: true });
    const setupPath = path.join(fx.workDir, `${name}-setup.cmd`);
    const argsOut = path.join(fx.root, 'setup-args.txt');
    writeFileSync(setupPath, setupBody(argsOut));
    let bytes = readFileSync(setupPath);
    const sha = sha256(bytes);
    if (tamper) writeFileSync(setupPath, Buffer.concat([bytes, Buffer.from('rem changed\r\n')]));
    const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' });
    let holder = null;
    if (holdExe) holder = spawn(fx.exePath, ['-e', 'setTimeout(() => {}, 20000)', 'mcp\\server.js'], { stdio: 'ignore' });
    const scriptPath = path.join(fx.workDir, win.HELPER_SCRIPT);
    const script = planWin.buildWin32InstallScript({
      pid: app.pid, exePath: fx.exePath, installerPath: setupPath, sha256: sha, size: bytes.length, version: '4.0.0',
      resultPath: path.join(fx.workDir, win.RESULT_FILE), logPath: path.join(fx.root, 'update-install.log'),
      explorer: whoami, scriptPath, lockWaitSeconds: 4, reopenWaitSeconds: 1, showMessages: false,
    });
    writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');
    const r = spawnSync(PS, planWin.helperArgs(scriptPath), { encoding: 'utf8', timeout: 120000, windowsHide: true });
    try { holder && holder.kill(); } catch { /* */ }
    let record = null;
    try { record = JSON.parse(readFileSync(path.join(fx.workDir, win.RESULT_FILE), 'utf8').replace(/^\uFEFF/, '')); } catch { /* */ }
    return { fx, r, record, argsOut, setupPath, scriptPath };
  };
  const okSetup = (out) => `@echo off\r\necho %*> "${out}"\r\nexit /b 0\r\n`;
  const badSetup = (out) => `@echo off\r\necho %*> "${out}"\r\nexit /b 2\r\n`;
  {
    const h = await runHelper({ name: 'ok', setupBody: okSetup });
    eq([h.r.status, h.record && h.record.result], [0, 'installed'], `a setup that exits 0: helper exit 0, recorded "installed" (stderr: ${(h.r.stderr || '').slice(0, 200)})`);
    eq(readFileSync(h.argsOut, 'utf8').trim(), '/S --updated --force-run', 'the setup received exactly /S --updated --force-run');
    ok(!existsSync(h.setupPath) && !existsSync(h.scriptPath), 'the setup program and the script were removed after success');
  }
  {
    const h = await runHelper({ name: 'bad', setupBody: badSetup });
    eq([h.r.status, h.record && h.record.result, h.record && h.record.exitCode], [7, 'installer-failed', 7], 'a setup that exits 2: installer-failed');
    ok(existsSync(h.setupPath), 'the failed setup program is KEPT for the repair');
  }
  {
    const h = await runHelper({ name: 'tamper', setupBody: okSetup, tamper: true });
    eq([h.r.status, h.record && h.record.result], [5, 'installer-changed'], 'a setup changed after it was checked is NEVER run');
    ok(!existsSync(h.argsOut), '…it really did not run');
  }
  {
    const h = await runHelper({ name: 'held', setupBody: okSetup, holdExe: true });
    eq([h.r.status, h.record && h.record.result], [4, 'exe-in-use'], 'THE BRIDGE CASE: a process still running The Curator.exe → exe-in-use, nothing changed');
    ok(!existsSync(h.argsOut), '…the setup never ran');
  }
}
if (!IS_WIN && process.env.CURATOR_REQUIRE_WIN_HELPER === '1') ok(false, '§9 was required (CURATOR_REQUIRE_WIN_HELPER=1) but this is not Windows');

// ═══════════════════════════════════════════════════════════════════════════
section('§9b the launcher, the first trace, the boot catch and the trap, EXECUTED by a real PowerShell');
// ═══════════════════════════════════════════════════════════════════════════
// Windows: Windows PowerShell 5.1 by absolute path. Elsewhere: `pwsh` when it
// is installed (PowerShell 7 runs the same .NET calls), else skipped — a
// developer with pwsh proves it locally; windows-latest proves it on 5.1.
{
  const which = (cmd) => { const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null; };
  const PSX = IS_WIN ? planWin.powershellPath(process.env) : (process.env.CURATOR_PWSH || which('pwsh'));
  if (!PSX || !existsSync(PSX)) {
    console.log('    skipped: no PowerShell here (install pwsh, or set CURATOR_PWSH, to run it off Windows)');
  } else {
    // -WindowStyle exists only on Windows; everything else is the production form.
    const forHere = (args) => (IS_WIN ? args : args.filter((a, i, all) => a !== '-WindowStyle' && all[i - 1] !== '-WindowStyle'));
    const waitFile = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (existsSync(f)) return true; await new Promise((r) => setTimeout(r, 100)); } return existsSync(f); };
    const runPs = (args, env = process.env) => spawnSync(PSX, args, { encoding: 'utf8', timeout: 90000, windowsHide: true, env });
    const setup = () => {
      const dir = tmpdir('ps');
      return { dir, log: path.join(dir, 'update-install.log'), started: path.join(dir, win.HELPER_STARTED), script: path.join(dir, win.HELPER_SCRIPT), launch: path.join(dir, win.LAUNCH_SCRIPT), result: path.join(dir, win.RESULT_FILE) };
    };
    const launch = (d, { waitSeconds } = {}, env) => {
      writeFileSync(d.launch, `\uFEFF${planWin.buildWin32LaunchScript({ powershell: PSX, args: forHere(planWin.helperArgs(d.script, { errorLogPath: d.log })), startedPath: d.started, logPath: d.log, workDir: d.dir, ...(waitSeconds ? { waitSeconds } : {}) })}`, 'utf8');
      return runPs(forHere(planWin.helperArgs(d.launch)), env);
    };
    const realScript = (d, extra = {}) => planWin.buildWin32InstallScript({
      pid: 999999, exePath: path.join(d.dir, 'The Curator.exe'), installerPath: path.join(d.dir, 'setup.exe'), sha256: 'a'.repeat(64), size: 10, version: '4.0.0',
      resultPath: d.result, logPath: d.log, explorer: IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe') : '/usr/bin/true',
      scriptPath: d.script, startedPath: d.started, lockWaitSeconds: 1, reopenWaitSeconds: 1, showMessages: false, ...extra,
    });
    {
      // The real helper, started by the real launcher.
      const d = setup();
      writeFileSync(d.script, `\uFEFF${realScript(d)}`, 'utf8');
      const r = launch(d);
      const m = /^started (\d+)/.exec((r.stdout || '').trim());
      eq([r.status, !!m], [planWin.LAUNCH_EXIT_CODES.started, true], `the launcher starts the real helper and returns "started <pid>" (stdout ${JSON.stringify((r.stdout || '').trim())}, stderr ${JSON.stringify((r.stderr || '').slice(0, 200))})`);
      ok(m && readFileSync(d.started, 'utf8').trim() === m[1], '…the marker holds the helper\'s own PID');
      const lines = readFileSync(d.log, 'utf8').split(/\r?\n/).filter(Boolean);
      ok(/ update-install: started, pid \d+$/.test(lines[0] || ''), `…and the log's FIRST line is the helper's start trace ("${lines[0]}")`);
      ok(await waitFile(d.result, 30000), '…the helper runs on after the launcher returned, and records its outcome');
      let rec = null; try { rec = JSON.parse(readFileSync(d.result, 'utf8')); } catch { /* */ }
      eq(rec && [rec.result, rec.version, rec.exitCode], ['installer-changed', '4.0.0', 5], 'the record is written by .NET (no ConvertTo-Json) and parses (the fake setup is not the checked one: installer-changed)');
    }
    {
      // A helper PowerShell cannot parse: the boot's catch logs it, the launcher says so, no marker.
      const d = setup();
      writeFileSync(d.script, '\uFEFFif ( {\r\n', 'utf8');
      const r = launch(d);
      eq([r.status, (r.stdout || '').trim()], [planWin.LAUNCH_EXIT_CODES.exited, `exited ${planWin.HELPER_EXIT_CODES['helper-error']}`], 'an unparseable helper: the launcher reports "exited 9"');
      ok(/update-install: ERROR, the helper could not run: /.test(readFileSync(d.log, 'utf8')), '…and the parse error is in the log (it used to vanish)');
      ok(!existsSync(d.started), '…no start marker, so the app would not quit');
    }
    {
      // A terminating error inside the real helper: the trap.
      const d = setup();
      const text = realScript(d).replace('Set-StrictMode -Version 2\r\n', "Set-StrictMode -Version 2\r\nthrow 'injected failure'\r\n");
      writeFileSync(d.script, `\uFEFF${text}`, 'utf8');
      const r = runPs(forHere(planWin.helperArgs(d.script, { errorLogPath: d.log })));
      eq(r.status, planWin.HELPER_EXIT_CODES['helper-error'], 'a terminating error in the helper: exit 9');
      const log = readFileSync(d.log, 'utf8');
      ok(/update-install: started, pid/.test(log) && /update-install: ERROR at line \d+: injected failure/.test(log), '…logged after the start trace, with its line');
      let rec = null; try { rec = JSON.parse(readFileSync(d.result, 'utf8')); } catch { /* */ }
      eq(rec && [rec.result, rec.version, rec.exitCode], ['helper-error', '4.0.0', 9], '…and recorded as helper-error for the reopened app');
    }
    {
      // A helper that never writes its marker: stopped at the deadline, nothing left running.
      const d = setup();
      const late = path.join(d.dir, 'late.txt');
      writeFileSync(d.script, `\uFEFF[Threading.Thread]::Sleep(4000)\r\n[IO.File]::WriteAllText(${planWin.psQuote(late)}, 'still ran')\r\n`, 'utf8');
      const r = launch(d, { waitSeconds: 1 });
      eq([r.status, (r.stdout || '').trim()], [planWin.LAUNCH_EXIT_CODES.timeout, 'timeout'], 'no marker in time: the launcher says "timeout"');
      await new Promise((res) => setTimeout(res, 5000));
      ok(!existsSync(late), '…and the helper was stopped: it never did anything later');
    }
    {
      // The environment the helper gets.
      const d = setup();
      const out = path.join(d.dir, 'env.txt');
      writeFileSync(d.script, `\uFEFF[IO.File]::WriteAllText(${planWin.psQuote(out)}, (@([Environment]::GetEnvironmentVariables().GetEnumerator() | Where-Object { [string]$_.Value -ne '' } | ForEach-Object { [string]$_.Key }) -join ','))\r\n[IO.File]::WriteAllText(${planWin.psQuote(d.started)}, [string]$PID)\r\n`, 'utf8');
      const r = launch(d, {}, { ...process.env, PORT: '5555', CURATOR_NO_OPEN: '1', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', CURATOR_KEEP_ME: '1' });
      eq(r.status, 0, 'a helper that writes its marker: started');
      const names = readFileSync(out, 'utf8').split(',').map((k) => k.toUpperCase());
      eq(['PORT', 'CURATOR_NO_OPEN', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].filter((k) => names.includes(k)), [], 'the helper does not inherit PORT, CURATOR_NO_OPEN, ELECTRON_*, NODE_OPTIONS (Windows removes them; .NET on Unix leaves them empty)');
      ok(names.includes('CURATOR_KEEP_ME') && names.some((k) => k === 'PATH'), '…and keeps everything else');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9c the CI rehearsal prints the helper when the update did not complete');
// ═══════════════════════════════════════════════════════════════════════════
{
  const ci = await import(pathToFileURL(path.join(ROOT, 'scripts', 'ci-win-app.mjs')).href);
  const L = planWin.helperArgs('C:\\U\\updates\\launch-update.ps1');
  eq([ci.powershellCallKind(L), ci.powershellCallKind(planWin.helperArgs('C:\\U\\updates\\probe-ab12.ps1')),
    ci.powershellCallKind(['-Command', planWin.buildVersionCommand('C:\\s.exe')]), ci.powershellCallKind(['-Command', planWin.buildProcessListCommand('C:\\x.exe')])],
  ['launcher', 'probe', 'version', 'process-list'], 'each PowerShell call the engine makes is named');
  const script = planWin.buildWin32InstallScript({ ...GOOD, startedPath: 'C:\\U\\updates\\install-update.started' });
  const out = ci.helperDiagnostics({
    calls: [{ kind: 'launcher', status: 22, stdout: 'exited 9\r\n', stderr: 'At line:1 char:6\r\n+ if ( {' }],
    logText: 'a\r\nb\r\nc', resultText: null, startedText: null, scriptText: script,
  }).join('\n');
  ok(out.includes('[launcher] exit 22') && out.includes('out: exited 9') && out.includes('err: At line:1 char:6'), 'the launcher\'s exit code, stdout and stderr are printed');
  ok(/update-install\.log:\n      a\n      b\n      c/.test(out) && out.includes('last-update.json: (none)') && out.includes('install-update.started (the helper PID): (none)'), 'the whole log, and "(none)" for what does not exist');
  ok(out.includes(script.replace(/^\uFEFF/, '').split('\r\n')[0]) && out.includes('trap {') && /… \(\d+ more lines\)/.test(out),
    'the HEAD of the generated script is printed (wintest.4 printed only its tail, where nothing had gone wrong)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 words and source discipline');
// ═══════════════════════════════════════════════════════════════════════════
{
  for (const reason of planWin.WIN32_REACHABLE_REASONS) {
    const msg = planWin.win32MessageFor(reason);
    ok(typeof msg === 'string' && msg.length > 20 && !MAC_WORDS.test(msg) && !/\{attempts\}/.test(planWin.win32Failure(reason, null, { attempts: 2 }).message),
      `"${reason}" has a Windows sentence with no Mac words`);
  }
  const missing = [...seenReasons].filter((r) => !planWin.WIN32_REACHABLE_REASONS.includes(r));
  eq(missing, [], `every reason §7 actually produced is in WIN32_REACHABLE_REASONS (${seenReasons.size} seen)`);
  // The route relays the engine's message; its own two codes must not collide.
  const routeCodes = Object.keys(cfg.UPDATE_FAILURE_COPY);
  eq(Object.keys(planWin.WIN32_UPDATE_FAILURES).filter((c) => routeCodes.includes(c)), [], 'no Windows reason re-uses a route-owned code');
  for (const f of ['update-engine.js', 'update-install-win32.js', 'update-plan-win32.js', 'update-download.js', 'update-release.js']) {
    const src = readFileSync(path.join(DESKTOP, 'lib', f), 'utf8');
    ok(!/from\s+['"]electron['"]/.test(src) && !/from\s+['"][^'"]*\.\.\/\.\.\/src\//.test(src), `desktop/lib/${f} imports neither electron nor src/`);
  }
  const winSrc = stripJsComments(readFileSync(path.join(DESKTOP, 'lib', 'update-plan-win32.js'), 'utf8')
    + readFileSync(path.join(DESKTOP, 'lib', 'update-install-win32.js'), 'utf8'));
  ok(winSrc.length > 5000, `ANTI-VACUITY: ${winSrc.length} chars of the Windows modules survived comment-stripping`);
  ok(!/compareSemver|parseVersionCore|isComparableVersion|localeCompare/.test(winSrc), 'the Windows modules contain no version comparator (config.js owns "newest")');
  ok(!/electron-updater|autoUpdater|latest\.yml/.test(winSrc), 'and nothing reaches for electron-updater');
  ok(!/process\.platform/.test(winSrc), 'and nothing reads process.platform (the platform is chosen once, by createUpdateInstaller)');
}

console.log(`\n  ────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`  ────────────────────────────────────────\n`);
process.exit(failed === 0 ? 0 : 1);
