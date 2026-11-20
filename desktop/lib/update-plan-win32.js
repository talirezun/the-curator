/**
 * update-plan-win32.js — every DECISION the Windows updater makes, and no I/O.
 *
 * The Windows twin of update-plan.js, kept separate so the Mac module stays
 * exactly what it was. Electron-free and `src/`-free like every module in this
 * folder, so `npm test` EXECUTES all of it on any platform: every function
 * takes its paths as `path.win32` strings and its environment as an argument,
 * never from `process`.
 *
 * ── THE WINDOWS UPDATE, IN ONE PARAGRAPH ────────────────────────────────────
 *
 * The app downloads the NSIS setup program the release publishes
 * (`TheCurator-X.Y.Z-x64-Windows-Setup.exe`) into
 * `%LOCALAPPDATA%\TheCurator\updates\`, checks its byte length and the SHA-256
 * GitHub publishes for it, reads its ProductVersion, and makes it read-only.
 * On Install it writes a PowerShell helper (built here, as TEXT) and starts it
 * detached, then quits. The helper waits for the app to exit, proves no other
 * process still holds `The Curator.exe` (Claude Desktop keeps a copy running as
 * the MCP bridge), re-checks the setup's SHA-256, and runs it with
 * `/S --updated --force-run`: silent, keep the shortcuts, reopen the app. It
 * makes sure the app is running afterwards and records the outcome in
 * `last-update.json`, which the reopened app reads once (afterStart).
 *
 * ── WHAT IT CANNOT PROMISE, said where the code is ──────────────────────────
 *
 * An NSIS update is NOT atomic and has no rollback: the old version's files are
 * removed and the new ones written in one run. Power lost in the middle can
 * leave the program folder incomplete. Your knowledge base, keys and settings
 * are NOT in the program folder (paths.js keeps them in
 * `%LOCALAPPDATA%\TheCurator\App`), so they are untouched either way; the
 * verified setup stays in `updates\` and the helper offers to run it again. A
 * copy-aside rollback (AgentLink's design) was rejected here: AgentLink owns
 * its NSIS script, The Curator uses electron-builder's, whose update path runs
 * the OLD uninstaller found through the registry; moving the old folder away
 * first would make that step fail in ways nobody has measured.
 */

import path from 'node:path';

import { updateFailure, fillAttempts, UPDATE_FAILURES } from './update-plan.js';

const W = path.win32;

// ─────────────────────────────────────────────────────────────────────────────
//  Words
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Windows sentence for a reason, where the Mac table's would be wrong.
 *
 * Two kinds of entry. (1) A reason the Mac table already has whose sentence
 * names something a Windows user does not have ("this Mac", "Applications
 * folder"). (2) A reason only Windows can produce. Every sentence says what
 * happened, whether anything changed, and the one next step (the v3.99.2
 * rule). The route relays `message` verbatim (config.js `updateFailureCopy`),
 * so this table IS the user-facing text.
 */
export const WIN32_UPDATE_FAILURES = Object.freeze({
  // ── (1) Mac sentences, said for a PC ──
  'no-asset-for-arch': 'The newest release does not include a Windows installer for this PC. Download it from the releases page instead.',
  'download-cancelled': 'The update was cancelled. Nothing on this PC was changed.',
  'install-dir-not-writable': 'The folder The Curator is installed in cannot be written to, so the update cannot be put in place. Download the installer from the releases page and run it, or ask whoever manages this PC.',
  'internal-error': 'Something went wrong while preparing the update, so nothing on this PC was changed. Try again, or download the update from the releases page.',

  // ── (2) Windows only ──
  'not-installed-copy': 'This copy of The Curator was not set up with its installer, so it cannot update itself. Install The Curator with the installer from the releases page.',
  'install-per-machine': 'The Curator is installed for every user of this PC, so updating it needs an administrator. Download the installer from the releases page and run it, or ask whoever manages this PC.',
  'install-path-unsupported': 'The Curator is running from a network folder or an unusual location, so it cannot update itself. Install it on this PC with the installer from the releases page.',
  'digest-missing': 'GitHub did not publish a checksum for this download, so it was not installed. Download the installer from the releases page instead.',
  'installer-check-failed': 'The downloaded installer could not be checked, so it was not run and nothing was changed. Try again, or download the installer from the releases page.',
  'helper-unavailable': 'Windows did not let The Curator run the final step of the update on this PC (this is usually a setting made by whoever manages it), so nothing was changed. Download the installer from the releases page and run it.',
  'in-use-by-ai-app': 'An AI app connected to The Curator, such as Claude Desktop, is using it right now, so the update cannot replace it. Quit that app, then choose Install update again. Nothing was changed.',
  'in-use-other': 'Another copy of The Curator is running on this PC, so the update cannot replace it. Quit the other copy, then choose Install update again. Nothing was changed.',
});

/** Words a Windows sentence must never contain. Asserted over every reason
 *  the win32 engine can return (scripts/test-desktop-update-win32.js). */
export const MAC_ONLY_WORDS = /\bMac\b|macOS|Applications folder|Finder|disk image|\.dmg\b/;

/**
 * A failure, worded for `platform`. TOTAL: anything that is not a failure is
 * returned untouched, and a reason with no Windows sentence keeps the shared
 * one. `{attempts}` is re-filled from the record so the retry count survives.
 */
export function localizeFailure(result, platform) {
  if (platform !== 'win32' || !result || typeof result !== 'object' || result.ok !== false) return result;
  if (!Object.hasOwn(WIN32_UPDATE_FAILURES, result.reason)) return result;
  return { ...result, message: fillAttempts(WIN32_UPDATE_FAILURES[result.reason], result.attempts) };
}

/** `updateFailure`, worded for Windows. */
export function win32Failure(reason, detail = null, extra = null) {
  return localizeFailure(updateFailure(reason, detail, extra), 'win32');
}

/**
 * Every reason the win32 engine can return. Listed so the suite can hold each
 * one to MAC_ONLY_WORDS; the suite also DRIVES the engine into each reachable
 * one, so a reason missing from this list is caught by the drive, not trusted.
 */
export const WIN32_REACHABLE_REASONS = Object.freeze([
  'network-unreachable', 'github-error', 'unexpected-response', 'no-installable-release', 'no-update',
  'local-ahead', 'not-comparable', 'local-version-unreadable', 'no-asset-for-arch', 'asset-unusable',
  'no-exec-path', 'not-installed-copy', 'install-per-machine', 'install-path-unsupported',
  'install-dir-not-writable', 'helper-unavailable',
  'download-failed', 'download-server-error', 'download-not-found', 'download-truncated', 'download-oversized',
  'download-cancelled', 'download-write-failed',
  'size-mismatch', 'digest-mismatch', 'digest-missing', 'staged-version-mismatch', 'installer-check-failed',
  'not-prepared', 'stale-token', 'writes-in-progress', 'in-use-by-ai-app', 'in-use-other',
  'helper-write-failed', 'helper-spawn-failed', 'relaunch-unavailable', 'internal-error',
]);

/** The sentence a reachable reason shows on Windows. */
export function win32MessageFor(reason) {
  if (Object.hasOwn(WIN32_UPDATE_FAILURES, reason)) return WIN32_UPDATE_FAILURES[reason];
  if (Object.hasOwn(UPDATE_FAILURES, reason)) return UPDATE_FAILURES[reason];
  return null;
}

/**
 * What the reopened app says about the update the helper ran, by the helper's
 * recorded `result`. `null` = nothing to say (it worked). The helper shows the
 * same sentence in a Windows message box on every failure, so a failure is
 * never silent even when no app comes back to say it.
 */
export const WIN32_INSTALL_OUTCOMES = Object.freeze({
  'exe-in-use': 'The Curator was not updated, because an AI app connected to it (such as Claude Desktop) was still using it. Quit that app, then open The Curator and choose Install update again. Nothing was changed.',
  'app-did-not-quit': 'The Curator did not close in time, so the update was not installed. Nothing was changed. Quit The Curator, open it again and choose Install update.',
  'installer-changed': 'The downloaded installer changed after it was checked, so it was not run. Nothing was changed. Check for updates again.',
  'installer-failed': 'The update could not be completed. Your notes, keys and settings are safe: they are kept outside the program folder. To repair The Curator, run the installer again, or download it from the releases page.',
  'installer-timeout': 'The update did not finish in time. Your notes, keys and settings are safe: they are kept outside the program folder. If The Curator does not open, run the installer again, or download it from the releases page.',
  'not-updated': 'The update did not finish, and The Curator is still on the previous version. Your notes, keys and settings are safe. Check for updates again, or download the installer from the releases page.',
});

/** The question the helper adds when a kept installer can repair the app. */
export const WIN32_RUN_INSTALLER_QUESTION = 'Run the installer now?';

/** Results the helper can record that mean "the installer ran and exited 0". */
const SUCCESS_RESULTS = new Set(['installed']);

/**
 * Pure. The helper's record + the version this app now runs → what to say.
 *
 * The version decides, not the record. A record of `installed` read by an
 * app still on the old version is a failure whatever the helper believed, and
 * a record of `installing` (the helper writes it before the setup runs) read by
 * the NEW version is a success: the setup reopened the app before the helper
 * got to write `installed`.
 */
export function describeInstallOutcome(record, currentVersion) {
  if (!record || typeof record !== 'object' || typeof record.version !== 'string') return null;
  const result = typeof record.result === 'string' ? record.result : '';
  if (record.version === currentVersion) {
    return { status: 'updated', result, version: record.version, message: null };
  }
  if (Object.hasOwn(WIN32_INSTALL_OUTCOMES, result) && !SUCCESS_RESULTS.has(result)) {
    return { status: 'failed', result, version: record.version, message: WIN32_INSTALL_OUTCOMES[result] };
  }
  return { status: 'failed', result: result || 'unknown', version: record.version, message: WIN32_INSTALL_OUTCOMES['not-updated'] };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Where we are installed
// ─────────────────────────────────────────────────────────────────────────────

/** A local drive path, `C:\…`, normalised, no `..`, no UNC, no device path. */
export function isPlainDrivePath(p) {
  return typeof p === 'string'
    && /^[A-Za-z]:\\/.test(p)
    && W.normalize(p) === p
    && !p.endsWith('\\')
    && !/[\0"*?<>|\r\n]/.test(p.slice(2));
}

/** `TheCurator-3.100.0-x64-Windows-Setup.exe`'s folder name for files we put
 *  INSIDE the install folder (only the writability probe). One literal, so the
 *  writer and the sweeper cannot disagree. */
export const INSTALL_PROBE_PREFIX = '.the-curator-update-probe-';

function startsWithFolder(child, parent) {
  if (!isPlainDrivePath(parent)) return false;
  const a = child.toLowerCase();
  const b = parent.toLowerCase();
  return a === b || a.startsWith(`${b}\\`);
}

/**
 * May this install replace itself? Pure; the engine checks the file system.
 *
 *   no-exec-path              nothing to go on
 *   install-path-unsupported  UNC/network, relative, device or un-normalised
 *   not-installed-copy        a `win-unpacked` build folder, or not an .exe
 *                             (the engine also requires the NSIS uninstaller
 *                             beside the exe: that is the positive proof)
 *   install-per-machine       under Program Files: a silent per-user update
 *                             cannot write there without an administrator
 *
 * `env` supplies ProgramFiles / ProgramFiles(x86) / ProgramW6432, read
 * case-insensitively as Windows does.
 */
export function classifyWin32InstallTarget({ execPath = null, env = {} } = {}) {
  if (typeof execPath !== 'string' || !execPath) return win32Failure('no-exec-path', 'empty execPath');
  if (!isPlainDrivePath(execPath)) return win32Failure('install-path-unsupported', 'not a local drive path');
  const exeName = W.basename(execPath);
  if (!/\.exe$/i.test(exeName)) return win32Failure('not-installed-copy', 'execPath is not an .exe');
  const installDir = W.dirname(execPath);
  const parts = installDir.toLowerCase().split('\\');
  if (parts.includes('win-unpacked')) return win32Failure('not-installed-copy', 'a win-unpacked build folder');
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    const v = envGet(env, key);
    if (v && startsWithFolder(installDir, v)) return win32Failure('install-per-machine', key);
  }
  const stem = exeName.replace(/\.exe$/i, '');
  return {
    ok: true,
    exePath: execPath,
    exeName,
    installDir,
    // electron-builder's NSIS writes `Uninstall <productName>.exe` beside the
    // exe; `electron .` and `win-unpacked` have none. Positive proof that the
    // setup we are about to run is the thing that put this copy here.
    uninstallerPath: W.join(installDir, `Uninstall ${stem}.exe`),
    warning: null,
  };
}

/** Case-insensitive environment read (a copied Windows env keeps its keys'
 *  original casing; Windows itself does not care). */
export function envGet(env, key) {
  if (!env || typeof env !== 'object') return null;
  if (typeof env[key] === 'string') return env[key];
  const k = Object.keys(env).find((x) => x.toLowerCase() === key.toLowerCase());
  return k && typeof env[k] === 'string' ? env[k] : null;
}

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, by absolute
 *  path (never PATH: v3.86.0's rule), or null when SystemRoot is unusable. */
export function powershellPath(env) {
  const root = envGet(env, 'SystemRoot') || envGet(env, 'windir');
  if (!isPlainDrivePath(root)) return null;
  return W.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** `%SystemRoot%\explorer.exe`: reopening the app through Explorer gives it the
 *  person's own environment, not the helper's (AgentLink's lesson). */
export function explorerPath(env) {
  const root = envGet(env, 'SystemRoot') || envGet(env, 'windir');
  if (!isPlainDrivePath(root)) return null;
  return W.join(root, 'explorer.exe');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Who else is running this exe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure. Split the processes running THIS install's exe into the ones that are
 * ours (this app and its Electron helpers: renderer, GPU, crashpad, which all
 * share the exe name) and the ones that are not.
 *
 * Ours = `selfPid` and everything whose parent chain reaches it. Of the rest,
 * a process whose command line runs `mcp\server.js` is an MCP bridge: an AI
 * app (Claude Desktop) started `The Curator.exe` as Node through
 * ELECTRON_RUN_AS_NODE. Anything else is another copy of the app.
 *
 * `processes`: `[{pid, ppid, cmd}]`, already filtered to this exe's path.
 */
export function classifyInstallProcesses({ processes = [], selfPid = null } = {}) {
  const list = Array.isArray(processes) ? processes.filter((p) => p && Number.isInteger(p.pid) && p.pid > 0) : [];
  const parentOf = new Map(list.map((p) => [p.pid, Number.isInteger(p.ppid) ? p.ppid : null]));
  const ours = (pid) => {
    const seen = new Set();
    let cur = pid;
    while (cur !== null && cur !== undefined && !seen.has(cur)) {
      if (cur === selfPid) return true;
      seen.add(cur);
      cur = parentOf.has(cur) ? parentOf.get(cur) : null;
    }
    return false;
  };
  const bridges = [];
  const others = [];
  for (const p of list) {
    if (ours(p.pid)) continue;
    const cmd = typeof p.cmd === 'string' ? p.cmd.toLowerCase() : '';
    if (/mcp[\\/]server\.js/.test(cmd)) bridges.push(p.pid);
    else others.push(p.pid);
  }
  return { bridges, others };
}

/** PowerShell single-quoted literal. The only escape inside '…' is '' . */
export function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** The read-only listing of the processes running `exePath`, as JSON on
 *  stdout. Filtered in PowerShell so the output stays small (runCommand caps
 *  it) and so no other program's command line is ever read into this app. */
export function buildProcessListCommand(exePath) {
  return [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$e = ${psQuote(exePath)}`,
    '$p = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $e, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; cmd = [string]$_.CommandLine } })',
    'ConvertTo-Json -InputObject $p -Compress',
  ].join('; ');
}

/** Pure. The listing's stdout → `[{pid, ppid, cmd}]`, or null when unreadable. */
export function parseProcessList(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (!text) return [];
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  const arr = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : null);
  if (!arr) return null;
  return arr.filter((p) => p && typeof p === 'object').map((p) => ({
    pid: Number(p.pid), ppid: Number(p.ppid), cmd: typeof p.cmd === 'string' ? p.cmd : '',
  })).filter((p) => Number.isInteger(p.pid));
}

/** The setup program's ProductVersion, on stdout. */
export function buildVersionCommand(filePath) {
  return [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `(Get-Item -LiteralPath ${psQuote(filePath)}).VersionInfo.ProductVersion`,
  ].join('; ');
}

/** `3.100.0.0` → `3.100.0`; `v3.100.0` → `3.100.0`; anything else trimmed. */
export function normaliseProductVersion(v) {
  if (typeof v !== 'string') return '';
  let s = v.trim().replace(/^v(?=\d)/, '');
  const m = s.match(/^(\d+\.\d+\.\d+)\.0$/);
  if (m) s = m[1];
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
//  How the helper is started
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The installer's arguments, and the only ones it is ever given.
 *   /S           NSIS silent install
 *   --updated    electron-builder: an update, keep the existing shortcuts
 *   --force-run  electron-builder: start the app again after a silent install
 * The helper ALSO reopens the app itself if, 15 s after the setup exits, no
 * copy is running: `--force-run`'s behaviour is recalled from
 * electron-builder's sources, not measured on 26.x (package I's CI measures).
 */
export const INSTALLER_ARGS = Object.freeze(['/S', '--updated', '--force-run']);

/**
 * `powershell.exe` arguments that run a script FILE we wrote, without the
 * execution policy deciding: `-File` is subject to it (a Group Policy that
 * sets it wins over `-ExecutionPolicy Bypass`), a script block built from
 * the file's text is not. No `-EncodedCommand`: it is the shape malware uses,
 * and security software flags it. The probe (`buildProbeScript`) runs through
 * this exact form before the app quits, so a PC where it cannot work is told
 * so with nothing changed.
 */
export function helperArgs(scriptPath) {
  const boot = `& ([ScriptBlock]::Create([IO.File]::ReadAllText(${psQuote(scriptPath)}, [Text.Encoding]::UTF8)))`;
  return ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', boot];
}

/** A tiny script that writes the language mode to `markerPath`. The helper
 *  needs FullLanguage (Add-Type for its message box, [IO.File]); a PC locked
 *  to ConstrainedLanguage writes something else and is refused up front. */
export function buildProbeScript(markerPath) {
  return [
    '# The Curator: checks that the update helper can run on this PC. Deleted after use.',
    `[IO.File]::WriteAllText(${psQuote(markerPath)}, [string]$ExecutionContext.SessionState.LanguageMode)`,
    '',
  ].join('\r\n');
}

/**
 * The environment the helper (and so the app the setup reopens) gets: this
 * process's, minus what main.js set for itself and anything that would turn
 * the reopened exe into Node. Case-insensitive, as Windows is.
 */
export function helperEnv(env) {
  const out = {};
  const drop = (k) => /^(PORT|CURATOR_NO_OPEN|NODE_OPTIONS)$/i.test(k) || /^ELECTRON_/i.test(k);
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string' || drop(k)) continue;
    out[k] = v;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The helper
// ─────────────────────────────────────────────────────────────────────────────

/** Seconds the helper waits for this app to exit (the Mac helper: 120). */
export const HELPER_WAIT_SECONDS = 120;
/** Seconds it waits for the exe to be free after the app exited (Electron's
 *  own helper processes, antivirus scans). */
export const HELPER_LOCK_WAIT_SECONDS = 30;
/** Seconds the setup may run. Not killed after: a setup stopped half way is
 *  worse than one that finishes late. */
export const HELPER_INSTALL_TIMEOUT_SECONDS = 600;
/** Seconds after the setup exits before the helper opens the app itself. */
export const HELPER_REOPEN_WAIT_SECONDS = 15;

/** What the helper records, besides `installed`. Exit code per result. */
export const HELPER_EXIT_CODES = Object.freeze({
  installed: 0, 'app-did-not-quit': 3, 'exe-in-use': 4, 'installer-changed': 5,
  'installer-timeout': 6, 'installer-failed': 7,
});

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * The PowerShell helper's text.
 *
 * Every value is validated, then embedded as a single-quoted literal; nothing
 * is interpolated into code. Steps, each with a recorded outcome:
 *
 *   1. wait (≤ 120 s) for this app's PID to exit; still running → record
 *      `app-did-not-quit`, change nothing, open nothing (the app IS open);
 *   2. stop the MCP bridges the person agreed to stop, each only if it is
 *      still a process of THIS exe;
 *   3. prove the exe is free: open it for exclusive write (Windows refuses
 *      while any process runs it); still held after 30 s → `exe-in-use`,
 *      reopen the old app, say so;
 *   4. the setup must still be the verified file (size + SHA-256), else
 *      `installer-changed`, reopen the old app, say so;
 *   5. record `installing`, run the setup with INSTALLER_ARGS, wait ≤ 10 min;
 *   6. exit 0 and the exe exists → `installed`; make sure the app runs;
 *      remove the setup. Otherwise `installer-failed` / `installer-timeout`,
 *      reopen whatever is there, and offer to run the kept setup.
 *
 * Every failure is shown in a message box as well as recorded, so it is never
 * silent, even when the program folder no longer holds a runnable app.
 */
export function buildWin32InstallScript(opts = {}) {
  const {
    pid, exePath, installerPath, sha256, size, version, resultPath, logPath = null,
    explorer, stopPids = [], scriptPath = null,
    waitSeconds = HELPER_WAIT_SECONDS, lockWaitSeconds = HELPER_LOCK_WAIT_SECONDS,
    installTimeoutSeconds = HELPER_INSTALL_TIMEOUT_SECONDS, reopenWaitSeconds = HELPER_REOPEN_WAIT_SECONDS,
    showMessages = true,
  } = opts;

  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('buildWin32InstallScript: pid is required');
  for (const [k, v] of Object.entries({ exePath, installerPath, resultPath, explorer })) {
    if (typeof v !== 'string' || !v || /[\0\r\n]/.test(v)) throw new Error(`buildWin32InstallScript: ${k} is required`);
  }
  if (logPath !== null && (typeof logPath !== 'string' || /[\0\r\n]/.test(logPath))) throw new Error('buildWin32InstallScript: bad logPath');
  if (scriptPath !== null && (typeof scriptPath !== 'string' || /[\0\r\n]/.test(scriptPath))) throw new Error('buildWin32InstallScript: bad scriptPath');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('buildWin32InstallScript: sha256 must be 64 lowercase hex');
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('buildWin32InstallScript: size is required');
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error('buildWin32InstallScript: bad version');
  if (!Array.isArray(stopPids) || !stopPids.every((p) => Number.isSafeInteger(p) && p > 0 && p !== pid)) {
    throw new Error('buildWin32InstallScript: stopPids must be positive integers other than pid');
  }
  for (const [k, v] of Object.entries({ waitSeconds, lockWaitSeconds, installTimeoutSeconds, reopenWaitSeconds })) {
    if (!Number.isSafeInteger(v) || v < 0 || v > 3600) throw new Error(`buildWin32InstallScript: bad ${k}`);
  }

  const M = WIN32_INSTALL_OUTCOMES;
  const lines = [
    '# The Curator: update installer (Windows).',
    '# Generated at install time by desktop/lib/update-plan-win32.js. Not shipped, not',
    '# edited by hand. It runs the setup program The Curator already downloaded and',
    '# checked against the SHA-256 GitHub publishes, after The Curator has quit.',
    'Set-StrictMode -Version 2',
    "$ErrorActionPreference = 'Continue'",
    '',
    `$AppPid = ${pid}`,
    `$Exe = ${psQuote(exePath)}`,
    `$Installer = ${psQuote(installerPath)}`,
    `$Sha256 = ${psQuote(sha256)}`,
    `$Size = ${size}`,
    `$Version = ${psQuote(version)}`,
    `$ResultPath = ${psQuote(resultPath)}`,
    `$LogPath = ${logPath ? psQuote(logPath) : '$null'}`,
    `$ScriptPath = ${scriptPath ? psQuote(scriptPath) : '$null'}`,
    `$Explorer = ${psQuote(explorer)}`,
    `$StopPids = @(${stopPids.join(', ')})`,
    `$InstallerArgs = @(${INSTALLER_ARGS.map(psQuote).join(', ')})`,
    `$WaitSeconds = ${waitSeconds}`,
    `$LockWaitSeconds = ${lockWaitSeconds}`,
    `$InstallTimeoutSeconds = ${installTimeoutSeconds}`,
    `$ReopenWaitSeconds = ${reopenWaitSeconds}`,
    `$ShowMessages = ${showMessages ? '$true' : '$false'}`,
    `$MsgInUse = ${psQuote(M['exe-in-use'])}`,
    `$MsgChanged = ${psQuote(M['installer-changed'])}`,
    `$MsgFailed = ${psQuote(M['installer-failed'])}`,
    `$MsgTimeout = ${psQuote(M['installer-timeout'])}`,
    `$RunQuestion = ${psQuote(WIN32_RUN_INSTALLER_QUESTION)}`,
    '',
    '# Never fails the script: a log that cannot be written must not stop an update.',
    'function Log([string]$m) {',
    '  if (-not $LogPath) { return }',
    "  try { Add-Content -LiteralPath $LogPath -Value ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + ' update-install: ' + $m) -Encoding UTF8 } catch {}",
    '}',
    '',
    '# The outcome, written atomically, read once by the reopened app (afterStart).',
    'function Write-Result([string]$result, [int]$code) {',
    '  try {',
    "    $o = [ordered]@{ result = $result; version = $Version; at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); exitCode = $code }",
    "    $tmp = $ResultPath + '.tmp'",
    '    [IO.File]::WriteAllText($tmp, ($o | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))',
    '    Move-Item -LiteralPath $tmp -Destination $ResultPath -Force',
    "  } catch { Log ('could not record the outcome: ' + $result) }",
    '}',
    '',
    'function Show-Message([string]$text, [bool]$offerRun) {',
    '  if (-not $ShowMessages) { return }',
    '  try {',
    '    Add-Type -AssemblyName System.Windows.Forms',
    '    $top = [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly',
    '    if ($offerRun -and (Test-Path -LiteralPath $Installer -PathType Leaf)) {',
    "      $r = [System.Windows.Forms.MessageBox]::Show($text + [Environment]::NewLine + [Environment]::NewLine + $RunQuestion, 'The Curator', 'YesNo', 'Warning', 'Button1', $top)",
    "      if ([string]$r -eq 'Yes') { try { Start-Process -FilePath $Installer } catch { Log 'could not start the installer' } }",
    '    } else {',
    "      [void][System.Windows.Forms.MessageBox]::Show($text, 'The Curator', 'OK', 'Warning', 'Button1', $top)",
    '    }',
    "  } catch { Log 'could not show the message' }",
    '}',
    '',
    '# Through Explorer, so the app gets the person\'s own environment.',
    'function Start-App {',
    '  if (Test-Path -LiteralPath $Exe -PathType Leaf) {',
    "    try { Start-Process -FilePath $Explorer -ArgumentList ('\"' + $Exe + '\"') } catch { Log 'could not reopen the app' }",
    '  }',
    '}',
    '',
    '# Windows refuses to open a running program for exclusive write.',
    'function Test-ExeFree {',
    '  if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $true }',
    "  try { $s = [IO.File]::Open($Exe, 'Open', 'ReadWrite', 'None'); $s.Close(); return $true } catch { return $false }",
    '}',
    '',
    'function Get-ExeProcesses {',
    '  try { @(Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $Exe, [StringComparison]::OrdinalIgnoreCase) }) } catch { @() }',
    '}',
    '',
    '# The app itself: not an Electron helper (--type=) and not an MCP bridge.',
    'function Test-AppRunning {',
    "  foreach ($p in (Get-ExeProcesses)) { $c = [string]$p.CommandLine; if ($c -notmatch '--type=' -and $c -notmatch 'mcp[\\\\/]server\\.js') { return $true } }",
    '  return $false',
    '}',
    '',
    'function Remove-Quietly([string]$p) {',
    '  if (-not $p) { return }',
    '  for ($i = 1; $i -le 12; $i++) {',
    '    if (-not (Test-Path -LiteralPath $p)) { return }',
    '    try { Set-ItemProperty -LiteralPath $p -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $p -Force -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds ([Math]::Min(2000, 250 * $i)) }',
    '  }',
    "  Log 'could not remove a file; the next start of The Curator removes it'",
    '}',
    '',
    '# ── 1. Wait for The Curator to exit ──',
    "Log ('waiting for pid ' + $AppPid)",
    '$deadline = (Get-Date).AddSeconds($WaitSeconds)',
    'while (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) {',
    '  if ((Get-Date) -gt $deadline) {',
    "    Log 'REFUSED: The Curator is still running; nothing was changed'",
    `    Write-Result 'app-did-not-quit' ${HELPER_EXIT_CODES['app-did-not-quit']}`,
    `    exit ${HELPER_EXIT_CODES['app-did-not-quit']}`,
    '  }',
    '  Start-Sleep -Milliseconds 200',
    '}',
    '',
    '# ── 2. Stop the connections the person agreed to stop, only if still ours ──',
    'foreach ($sp in $StopPids) {',
    '  foreach ($p in (Get-ExeProcesses)) {',
    "    if ([int]$p.ProcessId -eq [int]$sp -and ([string]$p.CommandLine) -match 'mcp[\\\\/]server\\.js') {",
    "      try { Stop-Process -Id ([int]$sp) -Force -ErrorAction Stop; Log ('stopped an AI app connection, pid ' + $sp) } catch { Log ('could not stop pid ' + $sp) }",
    '    }',
    '  }',
    '}',
    '',
    '# ── 3. Nothing may still be running this program ──',
    '$deadline = (Get-Date).AddSeconds($LockWaitSeconds)',
    'while (-not (Test-ExeFree)) {',
    '  if ((Get-Date) -gt $deadline) {',
    "    Log 'REFUSED: the program is still in use (an AI app connection?); nothing was changed'",
    `    Write-Result 'exe-in-use' ${HELPER_EXIT_CODES['exe-in-use']}`,
    '    Start-App',
    '    Show-Message $MsgInUse $false',
    `    exit ${HELPER_EXIT_CODES['exe-in-use']}`,
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    '',
    '# ── 4. Still the setup program that was checked ──',
    "$h = ''",
    '$len = -1',
    "try { $len = (Get-Item -LiteralPath $Installer -ErrorAction Stop).Length; $h = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() } catch { $h = '' }",
    'if ($len -ne $Size -or $h -ne $Sha256) {',
    "  Log 'REFUSED: the setup program is not the one that was checked; nothing was changed'",
    `  Write-Result 'installer-changed' ${HELPER_EXIT_CODES['installer-changed']}`,
    '  Start-App',
    '  Show-Message $MsgChanged $false',
    `  exit ${HELPER_EXIT_CODES['installer-changed']}`,
    '}',
    '',
    '# ── 5. Run it ──',
    "Write-Result 'installing' -1",
    "Log ('running the setup for ' + $Version)",
    '$proc = $null',
    'try { $proc = Start-Process -FilePath $Installer -ArgumentList $InstallerArgs -PassThru -WindowStyle Hidden; $null = $proc.Handle } catch { $proc = $null }',
    'if ($null -eq $proc) {',
    "  Log 'FAILED: the setup program could not be started'",
    `  Write-Result 'installer-failed' ${HELPER_EXIT_CODES['installer-failed']}`,
    '  Start-App',
    '  Show-Message $MsgFailed $true',
    `  exit ${HELPER_EXIT_CODES['installer-failed']}`,
    '}',
    'if (-not $proc.WaitForExit($InstallTimeoutSeconds * 1000)) {',
    "  Log 'FAILED: the setup program did not finish in time'",
    `  Write-Result 'installer-timeout' ${HELPER_EXIT_CODES['installer-timeout']}`,
    '  Show-Message $MsgTimeout $true',
    `  exit ${HELPER_EXIT_CODES['installer-timeout']}`,
    '}',
    '$code = $proc.ExitCode',
    'if ($code -ne 0 -or -not (Test-Path -LiteralPath $Exe -PathType Leaf)) {',
    "  Log ('FAILED: the setup program exited ' + $code)",
    `  Write-Result 'installer-failed' ${HELPER_EXIT_CODES['installer-failed']}`,
    '  Start-App',
    '  Show-Message $MsgFailed $true',
    `  exit ${HELPER_EXIT_CODES['installer-failed']}`,
    '}',
    '',
    '# ── 6. Installed: make sure The Curator is open again, then tidy up ──',
    `Write-Result 'installed' 0`,
    "Log ('installed ' + $Version)",
    '$deadline = (Get-Date).AddSeconds($ReopenWaitSeconds)',
    '$running = $false',
    'while ((Get-Date) -lt $deadline) { if (Test-AppRunning) { $running = $true; break }; Start-Sleep -Milliseconds 500 }',
    "if (-not $running) { Log 'the setup did not reopen The Curator; opening it'; Start-App }",
    'Remove-Quietly $Installer',
    'Remove-Quietly $ScriptPath',
    'exit 0',
    '',
  ];
  return lines.join('\r\n');
}
