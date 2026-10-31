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
  const run = deps.runPs || (() => new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,comm='], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) reject(err); else resolve(String(out));
    });
  }));
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
  const run = deps.runShell || ((names) => new Promise((resolve, reject) => {
    const shell = typeof process.env.SHELL === 'string' && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
    // The script is a CONSTANT; the names arrive as "$@", never interpolated.
    const script = 'for b in "$@"; do printf "%s=%s\\n" "$b" "$(command -v -- "$b" 2>/dev/null)"; done';
    execFile(shell, ['-lc', script, 'curator-detect', ...names], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, out) => {
      if (err) reject(err); else resolve(String(out));
    });
  }));
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
