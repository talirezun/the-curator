/**
 * update-install-win32.js — the Windows adapter of the in-app updater.
 *
 * Same contract as the Mac adapter (update-install-darwin.js): two hooks,
 * `prepareUpdate` (resolve → download → verify; reversible, nothing replaced)
 * and `installUpdate({token})` (hand off to a helper that outlives the app,
 * then quit), plus `discardPrepared` and `describe`. Neither hook ever rejects;
 * every failure is a NAMED reason with a Windows sentence
 * (update-plan-win32.js `WIN32_UPDATE_FAILURES`).
 *
 * Windows-only additions, all safe to call on any platform:
 *   checkInUse()          are AI app connections (Claude Desktop's MCP bridge,
 *                         which runs `The Curator.exe` as Node) or another
 *                         copy holding the exe? Facts only, never a path.
 *   afterStart({currentVersion})  read ONCE what the helper recorded about the
 *                         last update, say it in plain words, and tidy
 *                         `updates\` (old setup programs, scripts).
 *
 * The design, the limits (an NSIS update is not atomic) and why the helper is
 * PowerShell are in update-plan-win32.js's header. Nothing in `src/` knows how
 * this works; it knows only that the two hooks exist.
 *
 * Imports nothing from Electron and nothing from `src/`. Every effect (fetch,
 * file system, subprocess, quitting, the write registry) is injected, so
 * scripts/test-desktop-update-win32.js EXECUTES both hooks end to end on any
 * platform.
 */

import fsp from 'node:fs/promises';
import nodePath from 'node:path';

import { progressOf } from './update-plan.js';
import {
  win32Failure, localizeFailure, classifyWin32InstallTarget, classifyInstallProcesses,
  buildProcessListCommand, parseProcessList, buildVersionCommand, normaliseProductVersion,
  buildWin32InstallScript, buildProbeScript, helperArgs, helperEnv, powershellPath, explorerPath,
  describeInstallOutcome, INSTALL_PROBE_PREFIX,
} from './update-plan-win32.js';
import { createDownloader, hashFile } from './update-download.js';

/** What the helper records, inside `workDir`. */
export const RESULT_FILE = 'last-update.json';
/** The helper script, inside `workDir`. */
export const HELPER_SCRIPT = 'install-update.ps1';

const noop = () => {};

/** A file name made only of safe characters. A release payload names the
 *  asset and the tag; neither may steer where the file lands. */
function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 160);
}

export function createWin32UpdateEngine(deps = {}) {
  const {
    resolveRelease,
    fetchImpl = globalThis.fetch,
    sleepImpl,
    execPath = null,
    arch = null,
    env = {},
    workDir,
    logPath = null,
    runCommand,
    spawnDetached,
    quitApp = null,
    writeRegistry = {},
    pid = process.pid,
    randomId = () => Math.random().toString(36).slice(2, 10),
    // TEST-ONLY seams. Production uses the real file system with native
    // paths (which ARE win32 paths on Windows). The suite runs on macOS and
    // Linux with POSIX temp folders, so it passes `pathImpl: path` and a
    // `classifyTarget` that returns the same shape for a POSIX fixture.
    pathImpl = nodePath,
    classifyTarget = classifyWin32InstallTarget,
    fs = fsp,
    showMessages = true,
  } = deps;

  const P = pathImpl;
  const downloader = createDownloader({ fetchImpl, ...(sleepImpl ? { sleepImpl } : {}) });
  const ps = powershellPath(env);
  const explorer = explorerPath(env);

  let prepared = null;

  const emitter = (onProgress) => {
    const fn = typeof onProgress === 'function' ? onProgress : noop;
    return (phase, received, total) => {
      try { fn(progressOf(phase, received, total)); } catch { /* the UI is not load-bearing */ }
    };
  };

  const run = async (cmd, args, opts = {}) => {
    if (typeof runCommand !== 'function') return { status: 127, stdout: '', stderr: 'no runCommand' };
    try { return await runCommand(cmd, args, opts); } catch (err) { return { status: 127, stdout: '', stderr: String(err && err.message) }; }
  };

  /** Remove a file or folder. The read-only bit goes first: on Windows a
   *  read-only file cannot be deleted (EPERM), and this engine makes the setup
   *  program read-only on purpose. Retried, because antivirus and the search
   *  indexer hold a fresh file open for a moment (AgentLink 0.5.8). */
  const remove = async (p) => {
    try { await fs.chmod(p, 0o666); } catch { /* a folder, or gone */ }
    try { await fs.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); return true; } catch { return false; }
  };

  async function readRecord() {
    try {
      const text = await fs.readFile(P.join(workDir, RESULT_FILE), 'utf8');
      if (text.length > 4096) return null;
      const v = JSON.parse(text.replace(/^﻿/, ''));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Checks that need the PC
  // ───────────────────────────────────────────────────────────────────────────

  /** Can PowerShell run our helper here at all? Measured, not assumed: the
   *  exact invocation the helper will use runs a two-line script that writes
   *  its language mode to a marker. A Group Policy, AppLocker or WDAC setting
   *  that would stop the helper stops this probe first, with nothing changed. */
  async function probeHelper() {
    if (!ps || !explorer) return win32Failure('helper-unavailable', 'SystemRoot is not usable');
    const id = randomId();
    const script = P.join(workDir, `probe-${id}.ps1`);
    const marker = P.join(workDir, `probe-${id}.txt`);
    try {
      await fs.mkdir(workDir, { recursive: true });
      await fs.writeFile(script, `﻿${buildProbeScript(marker)}`, 'utf8');
    } catch (err) {
      return win32Failure('download-write-failed', err && err.code);
    }
    const r = await run(ps, helperArgs(script), { timeoutMs: 30000 });
    let mode = '';
    try { mode = String(await fs.readFile(marker, 'utf8')).trim(); } catch { mode = ''; }
    await remove(script);
    await remove(marker);
    if (r.status !== 0 || mode !== 'FullLanguage') {
      return win32Failure('helper-unavailable', `status ${r.status}, mode ${mode || 'none'}`);
    }
    return { ok: true };
  }

  /** Who else runs this exe. `{ok, connections, others, bridgePids}`; when the
   *  listing itself fails, `{ok:false}` and the caller decides (the helper's
   *  exclusive-open check is the backstop). */
  async function listHolders(exePath) {
    if (!ps) return { ok: false };
    const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', buildProcessListCommand(exePath)], { timeoutMs: 30000 });
    if (r.status !== 0) return { ok: false };
    const procs = parseProcessList(r.stdout);
    if (!procs) return { ok: false };
    const { bridges, others } = classifyInstallProcesses({ processes: procs, selfPid: pid });
    return { ok: true, connections: bridges.length, others: others.length, bridgePids: bridges };
  }

  /** Where are we, and is it the NSIS install the setup will update? */
  async function locate() {
    const target = classifyTarget({ execPath, env });
    if (!target.ok) return localizeFailure(target, 'win32');
    try {
      const st = await fs.stat(target.uninstallerPath);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      return win32Failure('not-installed-copy', 'no NSIS uninstaller beside the exe');
    }
    return target;
  }

  /** Create and remove one file in the install folder: a measurement, not
   *  `access(W_OK)`, for the same reason the Mac engine creates its real
   *  staging folder (ACLs and Controlled Folder Access decide, not mode bits). */
  async function probeWritable(installDir) {
    const probe = P.join(installDir, `${INSTALL_PROBE_PREFIX}${randomId()}`);
    try {
      await fs.writeFile(probe, '');
    } catch (err) {
      return win32Failure('install-dir-not-writable', err && err.code);
    }
    await remove(probe);
    return { ok: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  prepareUpdate
  // ───────────────────────────────────────────────────────────────────────────

  async function prepareUpdate(opts = {}) {
    try {
      return await prepareUpdateInner(opts);
    } catch (err) {
      return win32Failure('internal-error', err && err.stack ? err.stack.split('\n')[0] : String(err));
    }
  }

  async function prepareUpdateInner(opts = {}) {
    const emit = emitter(opts.onProgress);
    const signal = opts.signal || null;

    // ── 0. Can we install AT ALL? Before any network. ──
    const target = await locate();
    if (!target.ok) return target;

    emit('resolving', 0, null);

    // ── 1. Which release, which setup program. Wholly delegated. ──
    if (typeof resolveRelease !== 'function') {
      return win32Failure('unexpected-response', 'no release resolver was provided');
    }
    let release;
    try {
      release = await resolveRelease({ arch, signal });
    } catch (err) {
      return win32Failure('network-unreachable', err && err.message);
    }
    if (!release || !release.ok) return localizeFailure(release || win32Failure('unexpected-response', 'resolver returned nothing'), 'win32');
    const { asset } = release;
    if (!asset || typeof asset.name !== 'string' || !/\.exe$/i.test(asset.name)) {
      return win32Failure('no-asset-for-arch', 'the resolved asset is not a Windows setup program');
    }
    // REQUIRED on Windows. The Mac path tolerates an absent digest for
    // releases that predate GitHub's field; every Windows release is new, and
    // the SHA-256 is the only authenticity this unsigned setup has.
    if (!asset.digest || asset.digest.algorithm !== 'sha256') {
      return win32Failure('digest-missing', 'GitHub published no sha256 for the asset');
    }

    // ── 2. Clean slate, then the cheap local measurements. ──
    await discardPrepared();
    try {
      await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return win32Failure('download-write-failed', err && err.code);
    }
    for (const name of await fs.readdir(workDir).catch(() => [])) {
      await remove(P.join(workDir, name));
    }
    await sweepInstallDir(target.installDir);
    const writable = await probeWritable(target.installDir);
    if (!writable.ok) return writable;
    const helper = await probeHelper();
    if (!helper.ok) return helper;

    // ── 3. Download, with a real byte count, hashing as it arrives. ──
    const installerPath = P.join(workDir, `${safeName(release.tagName)}-${safeName(asset.name)}`);
    emit('downloading', 0, asset.size);
    const dl = await downloader.downloadAsset({ asset, filePath: installerPath, signal, emit });
    if (!dl.ok) { await remove(installerPath); return localizeFailure(dl, 'win32'); }

    // ── 4. Verify BEFORE anything runs. ──
    emit('verifying', asset.size, asset.size);
    if (dl.bytes !== asset.size) {
      await remove(installerPath);
      return win32Failure('size-mismatch', `${dl.bytes} != ${asset.size}`);
    }
    if (dl.digest !== asset.digest.hex) {
      await remove(installerPath);
      return win32Failure('digest-mismatch', 'sha256 mismatch');
    }
    // The setup program must say it is the version that was resolved: catches
    // a mislabelled asset that GitHub's digest (of whatever was uploaded)
    // cannot. Read by PowerShell by absolute path, never PATH.
    const v = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', buildVersionCommand(installerPath)], { timeoutMs: 30000 });
    const stagedVersion = v.status === 0 ? normaliseProductVersion(String(v.stdout || '')) : '';
    if (!stagedVersion) {
      await remove(installerPath);
      return win32Failure('installer-check-failed', `version unreadable, status ${v.status}`);
    }
    if (stagedVersion !== release.version) {
      await remove(installerPath);
      return win32Failure('staged-version-mismatch', `${stagedVersion} != ${release.version}`);
    }

    // ── 5. Keep it, read-only, until Install. ──
    emit('staging', 0, null);
    try { await fs.chmod(installerPath, 0o444); } catch { /* the helper re-checks the hash anyway */ }

    prepared = {
      token: `${release.version}:${randomId()}`,
      version: release.version,
      tagName: release.tagName,
      releaseUrl: release.releaseUrl,
      prerelease: release.prerelease === true,
      assetName: asset.name,
      bytes: asset.size,
      sha256: asset.digest.hex,
      verifiedDigest: `sha256:${asset.digest.hex}`,
      installerPath,
      exePath: target.exePath,
      installDir: target.installDir,
    };

    return {
      ok: true,
      token: prepared.token,
      version: prepared.version,
      current: release.current,
      releaseUrl: prepared.releaseUrl,
      prerelease: prepared.prerelease,
      assetName: prepared.assetName,
      bytes: prepared.bytes,
      verifiedDigest: prepared.verifiedDigest,
      verifiedLength: true,
      warning: target.warning || null,
    };
  }

  /** Our own writability probes, if a crash left one. Only that prefix, only
   *  files, only in the install folder: a sweeper in a program folder that is
   *  even slightly loose deletes the program. */
  async function sweepInstallDir(installDir) {
    let entries = [];
    try { entries = await fs.readdir(installDir); } catch { return; }
    for (const name of entries) {
      if (!name.startsWith(INSTALL_PROBE_PREFIX)) continue;
      const p = P.join(installDir, name);
      try { if ((await fs.stat(p)).isFile()) await remove(p); } catch { /* gone */ }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  installUpdate
  // ───────────────────────────────────────────────────────────────────────────

  async function installUpdate(opts = {}) {
    try {
      return await installUpdateInner(opts);
    } catch (err) {
      if (typeof writeRegistry.endUpdate === 'function') { try { writeRegistry.endUpdate(); } catch { /* ignore */ } }
      return win32Failure('internal-error', err && err.stack ? err.stack.split('\n')[0] : String(err));
    }
  }

  async function installUpdateInner(opts = {}) {
    const emit = emitter(opts.onProgress);

    if (!prepared) return win32Failure('not-prepared');
    if (opts.token && opts.token !== prepared.token) return win32Failure('stale-token');

    // Re-checked rather than trusted: it sat on disk since prepare.
    try { await fs.stat(prepared.installerPath); } catch { await discardPrepared(); return win32Failure('not-prepared', 'the setup program is gone'); }
    const now = await hashFile(prepared.installerPath, 'sha256');
    if (now !== prepared.sha256) {
      await discardPrepared();
      return win32Failure('digest-mismatch', 'the setup program changed after it was checked');
    }
    try { await fs.stat(prepared.exePath); } catch { return win32Failure('not-installed-copy', 'the installed app is no longer at its own path'); }

    if (typeof writeRegistry.hasActiveWrites === 'function' && writeRegistry.hasActiveWrites()) {
      let ops = [];
      try { ops = typeof writeRegistry.listActiveWrites === 'function' ? writeRegistry.listActiveWrites() : []; } catch { ops = []; }
      return { ...win32Failure('writes-in-progress'), operations: Array.isArray(ops) ? ops.slice(0, 8) : [] };
    }
    if (typeof quitApp !== 'function') return win32Failure('relaunch-unavailable');
    if (typeof spawnDetached !== 'function') return win32Failure('helper-spawn-failed', 'no spawnDetached');

    // ── Who else holds the exe. Asked BEFORE quitting, so a person whose
    //    Claude Desktop is connected is told so with the app still open. ──
    const holders = await listHolders(prepared.exePath);
    let stopPids = [];
    if (holders.ok) {
      if (holders.others > 0) return { ...win32Failure('in-use-other'), others: holders.others };
      if (holders.connections > 0) {
        if (opts.stopConnections !== true) {
          return { ...win32Failure('in-use-by-ai-app'), connections: holders.connections, canStopConnections: true };
        }
        stopPids = holders.bridgePids.slice(0, 32);
      }
    }
    // A listing that failed is not a refusal: the helper proves the exe is
    // free by opening it, and says so if it is not. Logged as a fact.

    emit('installing', 0, null);

    const scriptPath = P.join(workDir, HELPER_SCRIPT);
    let script;
    try {
      script = buildWin32InstallScript({
        pid,
        exePath: prepared.exePath,
        installerPath: prepared.installerPath,
        sha256: prepared.sha256,
        size: prepared.bytes,
        version: prepared.version,
        resultPath: P.join(workDir, RESULT_FILE),
        logPath,
        explorer,
        stopPids,
        scriptPath,
        showMessages,
      });
      await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
      // A BOM, so Windows PowerShell 5.1 reads the sentences as UTF-8.
      await fs.writeFile(scriptPath, `﻿${script}`, 'utf8');
      try { await fs.rm(P.join(workDir, RESULT_FILE), { force: true }); } catch { /* none */ }
    } catch (err) {
      return win32Failure('helper-write-failed', err && err.code);
    }

    if (typeof writeRegistry.beginUpdate === 'function') {
      try { writeRegistry.beginUpdate(); } catch { /* never blocks the update */ }
    }

    try {
      spawnDetached(ps, helperArgs(scriptPath), { env: helperEnv(env), windowsHide: true });
    } catch (err) {
      if (typeof writeRegistry.endUpdate === 'function') { try { writeRegistry.endUpdate(); } catch { /* ignore */ } }
      return win32Failure('helper-spawn-failed', err && err.message);
    }

    try {
      quitApp();
    } catch (err) {
      if (typeof writeRegistry.endUpdate === 'function') { try { writeRegistry.endUpdate(); } catch { /* ignore */ } }
      return win32Failure('relaunch-unavailable', err && err.message);
    }

    return {
      ok: true,
      installing: true,
      version: prepared.version,
      targetPath: prepared.exePath,
      ...(stopPids.length ? { stoppedConnections: stopPids.length } : {}),
      ...(holders.ok ? {} : { holdersUnchecked: true }),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  The rest of the surface
  // ───────────────────────────────────────────────────────────────────────────

  async function discardPrepared() {
    if (!prepared) return { ok: true, discarded: false };
    await remove(prepared.installerPath);
    prepared = null;
    return { ok: true, discarded: true };
  }

  function describe() {
    return {
      preparedVersion: prepared ? prepared.version : null,
      token: prepared ? prepared.token : null,
      verifiedDigest: prepared ? prepared.verifiedDigest : null,
    };
  }

  /** Facts for the UI before anyone presses Install. Never a path or a PID. */
  async function checkInUse() {
    const target = classifyTarget({ execPath, env });
    if (!target.ok) return { ok: false, reason: target.reason };
    const h = await listHolders(target.exePath);
    if (!h.ok) return { ok: false, reason: 'process-list-unavailable' };
    return { ok: true, connections: h.connections, others: h.others };
  }

  /**
   * At every start of the Windows app (G wires it). Reads ONCE what the
   * helper recorded, decides by the version actually running, removes the
   * record, and tidies `updates\`: every file goes EXCEPT a setup program kept
   * because the last update failed (the repair path). Never throws.
   */
  async function afterStart(o = {}) {
    try {
      const currentVersion = typeof o.currentVersion === 'string' ? o.currentVersion : '';
      const record = await readRecord();
      const outcome = record ? describeInstallOutcome(record, currentVersion) : null;
      const keep = new Set();
      if (outcome && outcome.status === 'failed') {
        for (const name of await fs.readdir(workDir).catch(() => [])) {
          if (/\.exe$/i.test(name) && name.includes(`-${safeName(outcome.version)}-`)) keep.add(name);
        }
      }
      let removed = 0;
      for (const name of await fs.readdir(workDir).catch(() => [])) {
        if (keep.has(name)) continue;
        if (prepared && P.join(workDir, name) === prepared.installerPath) continue;
        if (await remove(P.join(workDir, name))) removed += 1;
      }
      return { ok: true, outcome, removed, kept: keep.size };
    } catch {
      return { ok: true, outcome: null, removed: 0, kept: 0 };
    }
  }

  return { prepareUpdate, installUpdate, discardPrepared, describe, checkInUse, afterStart };
}
