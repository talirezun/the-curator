/**
 * Which agent tools are on THIS Mac, and which are running (v3.85.0).
 *
 * READ-ONLY. Nothing here writes a file. It answers two questions for the
 * "Tools on this Mac" panel (Settings › MCP bridge › block 5), and the answers
 * only DECIDE which rows are shown under "found" and which restart line is
 * printed — never what is written. The write path (`mcp-install.js`) takes
 * its file list from the adapter table, resolved against home; detection only
 * gates whether a MISSING file may be created (a tool that is not on this Mac
 * gets no new config file).
 *
 * ── INSTALLED: ANY ONE SIGNAL, AND WHICH ONE IS RECORDED ──────────────────
 *   app     a bundle in /Applications or ~/Applications
 *   cli     a command on the LOGIN-shell PATH (cli rows only — one shell per
 *           request, fixed argv, the bin names as positional arguments so
 *           nothing is interpolated into the script, 3 s timeout). A failed
 *           or timed-out shell is `unknown`, never "absent".
 *   config  one of the tool's own USER config files exists.
 * A bare shared directory is NOT a signal: `~/.gemini` alone does not mean
 * Gemini CLI (Antigravity lives there too), `~/.copilot` alone does not mean
 * Copilot CLI. Only the named FILE counts.
 *
 * ── RUNNING: THE EXECUTABLE PATH, NEVER A WORD ─────────────────────────────
 * One `ps -axo pid=,comm=` (execFile, no shell). On macOS `comm` is the full
 * executable path, so a match is `/<Bundle>.app/Contents/MacOS/` — the main
 * executable of THAT bundle. A substring like "cursor" would match
 * `CursorUIViewService` (a system process every Mac runs) and report Cursor
 * running on a machine that has never had it. `checked: false` is "we could
 * not look", which is not the same as "not running".
 *
 * Every probe is injectable (`deps`) so the suites never run a real `ps`,
 * never spawn the user's login shell and never stat the real /Applications.
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { adapterFor, listHarnesses, resolveTemplates } from './harness-adapters.js';

/** App bundles per tool (contract §2). Only the three install-capable tools have one. */
export const APP_BUNDLES = Object.freeze({
  'claude-desktop': Object.freeze(['Claude.app']),
  cursor: Object.freeze(['Cursor.app']),
  antigravity: Object.freeze(['Antigravity.app', 'Antigravity IDE.app']),
});

export const PROBE_TIMEOUT_MS = 3000;
/** PowerShell's cold start alone can pass 3 s on a slow Windows PC. */
export const WIN_PROBE_TIMEOUT_MS = 5000;

/**
 * NO REAL PROBE UNDER TEST (v3.86.0). Every default runner below — `ps`, the
 * login shell, PowerShell — refuses to spawn while CURATOR_TEST_INSTALL_HOME
 * is set, whatever the caller injected or forgot to inject. A suite that
 * forgets a seam gets `checked: false`, never the maintainer's processes or a
 * CI runner's real Appx packages.
 */
export function probesDisabled() { return !!process.env.CURATOR_TEST_INSTALL_HOME; }

let _spawnObserver = null;
/** TEST-ONLY: called with (cmd, argv) every time a default runner REALLY spawns. */
export function __setSpawnObserver(fn) { _spawnObserver = typeof fn === 'function' ? fn : null; }

function spawnProbe(cmd, argv, opts) {
  return new Promise((resolve, reject) => {
    if (probesDisabled()) { reject(new Error('probes disabled under test')); return; }
    if (_spawnObserver) { try { _spawnObserver(cmd, argv); } catch { /* observer only */ } }
    execFile(cmd, argv, opts, (err, out) => { if (err) reject(err); else resolve(String(out)); });
  });
}

const BIN_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/;

/** The CLI binary a `cli` row's vendor command starts with, or null. */
export function cliBinFor(id) {
  const a = adapterFor(id);
  const add = a?.mcpConfig?.installer === 'cli' ? a.mcpConfig.cli?.add : null;
  if (typeof add !== 'string') return null;
  const bin = add.trim().split(/\s+/)[0];
  return BIN_RE.test(bin) ? bin : null;
}

/** The Applications folders to look in. `deps.appsDirs` replaces both (tests). */
export function applicationsDirs(home, deps = {}) {
  if (Array.isArray(deps.appsDirs)) return deps.appsDirs.slice();
  const dirs = ['/Applications'];
  if (home) dirs.push(path.join(home, 'Applications'));
  return dirs;
}

function isDirOrBundle(p, deps) {
  const exists = deps.exists || existsSync;
  try { return exists(p); } catch { return false; }
}

function isFile(p, deps) {
  const lstat = deps.lstat || lstatSync;
  try { const st = lstat(p); return st.isFile() || st.isSymbolicLink(); } catch { return false; }
}

/**
 * `ps` once → `{checked, byId: {id: bool}}`. Never throws, never rejects.
 * `deps.runPs()` (tests) resolves to the ps text or rejects.
 */
export async function detectRunning(deps = {}) {
  const run = deps.runPs || (() => spawnProbe('ps', ['-axo', 'pid=,comm='], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }));
  let text;
  try { text = await run(); } catch { return { checked: false, byId: {} }; }
  if (typeof text !== 'string') return { checked: false, byId: {} };
  const lines = text.split('\n');
  const byId = {};
  for (const [id, bundles] of Object.entries(APP_BUNDLES)) {
    byId[id] = bundles.some((b) => {
      const needle = `/${b}/Contents/MacOS/`;
      return lines.some((l) => l.includes(needle));
    });
  }
  return { checked: true, byId };
}

/**
 * The login shell's `command -v` for every cli row's bin, in ONE spawn.
 * `{checked, byBin: {bin: path|null}}`. Never throws.
 */
export async function detectClis(bins, deps = {}) {
  const list = [...new Set((bins || []).filter((b) => typeof b === 'string' && BIN_RE.test(b)))];
  if (!list.length) return { checked: true, byBin: {} };
  const run = deps.runShell || ((names) => {
    const shell = typeof process.env.SHELL === 'string' && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
    // The script is a CONSTANT; the names arrive as "$@", never interpolated.
    const script = 'for b in "$@"; do printf "%s=%s\\n" "$b" "$(command -v -- "$b" 2>/dev/null)"; done';
    return spawnProbe(shell, ['-lc', script, 'curator-detect', ...names], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  });
  let text;
  try { text = await run(list); } catch { return { checked: false, byBin: {} }; }
  const byBin = {};
  for (const b of list) byBin[b] = null;
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const b = line.slice(0, i);
    const p = line.slice(i + 1).trim();
    if (b in byBin && p && path.isAbsolute(p)) byBin[b] = p;
  }
  return { checked: true, byBin };
}

/**
 * Every MCP-capable tool → `{id, detected: {by, path} | null, cliChecked}`.
 * `by` priority: app, cli, config. `home` is required; with no home nothing
 * is detected by config or ~/Applications. `configFiles[id]` narrows the
 * config signal to the files the caller treats as this tool's on this OS
 * (Claude Desktop's Linux path is not evidence of Claude Desktop on a Mac).
 */
export async function detectTools({ home, configFiles = {}, deps = {} } = {}) {
  const ids = listHarnesses().filter((id) => adapterFor(id)?.mcpConfig);
  const bins = ids.map(cliBinFor).filter(Boolean);
  const clis = await detectClis(bins, deps);
  const apps = applicationsDirs(home, deps);
  const out = {};
  for (const id of ids) {
    const a = adapterFor(id);
    let detected = null;
    for (const b of APP_BUNDLES[id] || []) {
      for (const dir of apps) {
        const p = path.join(dir, b);
        if (!detected && isDirOrBundle(p, deps)) detected = { by: 'app', path: p };
      }
    }
    const bin = cliBinFor(id);
    if (!detected && bin && clis.checked && clis.byBin[bin]) detected = { by: 'cli', path: clis.byBin[bin] };
    if (!detected && home) {
      const files = Array.isArray(configFiles[id]) ? configFiles[id] : resolveTemplates(a.mcpConfig.user || [], { home });
      for (const f of files) {
        if (!detected && isFile(f, deps)) detected = { by: 'config', path: f };
      }
    }
    out[id] = { id, detected, cliChecked: bin ? clis.checked : null };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// WINDOWS (v3.86.0) — Claude Desktop only
// ─────────────────────────────────────────────────────────────────────────
//
// Two read-only PowerShell probes, each one `powershell.exe -NoProfile
// -NonInteractive -Command <CONSTANT>` through execFile (no shell, nothing
// interpolated, 5 s timeout, window hidden), run in parallel:
//
//   INSTALLED  `Get-AppxPackage` for the two MSIX names Anthropic publishes
//              (`Claude`, and the Microsoft Store's `AnthropicPBC.Claude`).
//              Never `-AllUsers` (needs elevation). The answer is the
//              PackageFamilyName, compared EXACTLY against the adapter row.
//   RUNNING    `Get-CimInstance Win32_Process` for `claude.exe`, by
//              EXECUTABLE PATH. `claude.exe` is also the Claude Code CLI
//              (`~\.local\bin`, WinGet, npm) and the copy Claude Desktop
//              bundles under its own data folder, so a name match proves
//              nothing; only the three install locations below count. A
//              process whose path could not be read makes the answer
//              `checked: false` — never "not running".
//
// A failed or timed-out probe is `checked: false`. Both are disabled under
// CURATOR_TEST_INSTALL_HOME (see `probesDisabled`).

const WIN_APPX_SCRIPT = "$ErrorActionPreference='SilentlyContinue'; "
  + "@(Get-AppxPackage -Name 'Claude'; Get-AppxPackage -Name 'AnthropicPBC.Claude') "
  + '| ForEach-Object { $_.PackageFamilyName }';
const WIN_PROC_SCRIPT = "$ErrorActionPreference='SilentlyContinue'; "
  + "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" "
  + "| ForEach-Object { 'P|' + $_.ExecutablePath }";

/** Lower-cased executable paths that ARE Claude Desktop (contract §2). */
export const WIN_CLAUDE_EXE_PATTERNS = Object.freeze([
  /\\windowsapps\\claude_[^\\]+__pzs8sxrjxfjjc\\/,
  /\\windowsapps\\anthropicpbc\.claude_[^\\]+__fnn82j28hfe8t\\/,
  /\\appdata\\local\\anthropicclaude\\app-[^\\]+\\claude\.exe$/,
]);

/** Is this Win32_Process ExecutablePath Claude Desktop's own executable? */
export function isClaudeDesktopExe(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const l = p.trim().toLowerCase();
  return WIN_CLAUDE_EXE_PATTERNS.some((re) => re.test(l));
}

/**
 * Windows PowerShell 5.1 by ABSOLUTE path, never by bare name: a bare
 * `powershell.exe` is resolved through the current folder and PATH, where any
 * `powershell.exe` placed earlier would run instead. %SystemRoot% is set on
 * every Windows session; C:\\Windows is the fallback. path.win32 so the path
 * is a Windows path on every host (the suites check it on a Mac too).
 */
export function powershellPath() {
  const root = typeof process.env.SystemRoot === 'string' && path.win32.isAbsolute(process.env.SystemRoot)
    ? process.env.SystemRoot : 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runPowerShell(script) {
  return spawnProbe(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: WIN_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true,
  });
}

/**
 * `{checked, families: [PackageFamilyName…]}` — only the families named in
 * `wanted` (case-insensitive), in their canonical spelling. Never throws.
 * `deps.runAppx()` (tests) resolves to the probe's text or rejects.
 */
export async function detectWinAppx(wanted, deps = {}) {
  const run = deps.runAppx || (() => runPowerShell(WIN_APPX_SCRIPT));
  let text;
  try { text = await run(); } catch { return { checked: false, families: [] }; }
  if (typeof text !== 'string') return { checked: false, families: [] };
  const got = new Set(text.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean));
  return { checked: true, families: (wanted || []).filter((f) => got.has(String(f).toLowerCase())) };
}

/**
 * `{checked, running}` for Claude Desktop on Windows. Never throws.
 * `deps.runWinProcs()` (tests) resolves to lines `P|<ExecutablePath>`.
 */
export async function detectWinClaudeRunning(deps = {}) {
  const run = deps.runWinProcs || (() => runPowerShell(WIN_PROC_SCRIPT));
  let text;
  try { text = await run(); } catch { return { checked: false, running: false }; }
  if (typeof text !== 'string') return { checked: false, running: false };
  let unreadable = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('P|')) continue;
    const p = line.slice(2).trim();
    if (!p) { unreadable = true; continue; }
    if (isClaudeDesktopExe(p)) return { checked: true, running: true };
  }
  // A claude.exe whose path we could not read might be the app: we cannot say "not running".
  return unreadable ? { checked: false, running: false } : { checked: true, running: false };
}
