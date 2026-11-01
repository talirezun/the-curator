/**
 * linux-folder-dialog.js — the native folder dialog on Linux (v3.89.1).
 *
 * The Linux twin of win-folder-dialog.js. Before this, a repo install on Linux
 * fell through to `osascript`, failed, and answered 500 with a macOS-only hint
 * ("System Settings > Privacy & Security"). Now the server tries the folder
 * dialog tools a desktop already has, in this order:
 *
 *   1. zenity   --file-selection --directory --title=<prompt>
 *   2. kdialog  --getexistingdirectory <home> --title <prompt>
 *   3. yad      --file-selection --directory --title=<prompt>
 *
 * ── HOW IT RUNS ───────────────────────────────────────────────────────────
 *   • `execFile` with an ARGV ARRAY, never a shell. The prompt is one of the
 *     server's own literals (config.js), and is a single argv element anyway.
 *   • Each tool is looked up on PATH by `findOnPath()`, which walks the PATH
 *     entries ITSELF and accepts only ABSOLUTE ones (an empty or relative
 *     entry means "the current folder" and is skipped) holding a regular,
 *     executable file. The child is started by that absolute path, so a
 *     planted `./zenity` can never run. A missing tool is skipped; a tool that
 *     fails to start (ENOENT/EACCES) moves on to the next.
 *   • NO DISPLAY (neither DISPLAY nor WAYLAND_DISPLAY): nothing is spawned,
 *     the answer is `unavailable` — a dialog with nowhere to appear would only
 *     hang until the timeout.
 *   • A ten-minute timeout. A dialog left open that long is a cancel, and the
 *     child is killed so it can never hold the route.
 *   • stdout is read as UTF-8 and trimmed of the trailing newline only (a
 *     folder name may legitimately end in a space, so no further trimming
 *     other than the line terminator).
 *   • Exit 1 (zenity, kdialog, yad) or 252 (yad, Esc) with no output is a
 *     cancel. Exit 1 whose stderr says the display could not be opened is a
 *     failure, not a cancel.
 *
 * Contract: `pickFolderLinux({prompt}, deps)` resolves to
 *   {kind:'picked', path} · {kind:'cancelled', timedOut?} ·
 *   {kind:'unavailable', message} (no tool, or no display) ·
 *   {kind:'failed', message}
 * and never throws. `deps` is the test seam: {execFile, env, platform-free
 * findOnPath, home, timeoutMs}; null in production.
 */
import { execFile as realExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LINUX_PICK_TIMEOUT_MS = 10 * 60 * 1000;

export const LINUX_NO_DIALOG_MESSAGE =
  'This computer has no folder dialog The Curator can open — paste the folder\'s full path instead.';

/** The tools, in the order they are tried. PURE: returns the argv for one tool. */
export const LINUX_DIALOG_TOOLS = Object.freeze(['zenity', 'kdialog', 'yad']);

export function linuxDialogArgs(tool, prompt, home) {
  const title = String(prompt || '');
  if (tool === 'zenity') return ['--file-selection', '--directory', '--title=' + title];
  if (tool === 'kdialog') return ['--getexistingdirectory', String(home || '/'), '--title', title];
  if (tool === 'yad') return ['--file-selection', '--directory', '--title=' + title];
  return null;
}

/** Find `name` on PATH. Absolute PATH entries only; a regular executable file. Returns an absolute path or null. */
export function findOnPath(name, envPath, fsApi = fs) {
  for (const dir of String(envPath || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const full = path.join(dir, name);
    try {
      if (!fsApi.statSync(full).isFile()) continue;
      fsApi.accessSync(full, fs.constants.X_OK);
      return full;
    } catch { /* not here */ }
  }
  return null;
}

/** PURE. True when the environment names a display to open a window on. */
export function hasDisplay(env) {
  return !!(env && (env.DISPLAY || env.WAYLAND_DISPLAY));
}

const DISPLAY_ERROR = /cannot open display|unable to init server|failed to open display|could not connect to display|no protocol specified|cannot connect to x server|display .* not set/i;

export function pickFolderLinux({ prompt } = {}, deps = null) {
  const execFile = (deps && deps.execFile) || realExecFile;
  const env = (deps && deps.env) || process.env;
  const find = (deps && deps.findOnPath) || ((n) => findOnPath(n, env.PATH));
  const home = (deps && deps.home) || os.homedir();
  const timeout = (deps && deps.timeoutMs) || LINUX_PICK_TIMEOUT_MS;

  const unavailable = () => ({ kind: 'unavailable', message: LINUX_NO_DIALOG_MESSAGE });
  if (!hasDisplay(env)) return Promise.resolve(unavailable());

  const tools = [];
  for (const t of LINUX_DIALOG_TOOLS) {
    let p = null;
    try { p = find(t); } catch { p = null; }
    if (p && path.isAbsolute(p)) tools.push({ tool: t, file: p });
  }
  if (!tools.length) return Promise.resolve(unavailable());

  const runOne = ({ tool, file }) => new Promise((resolve) => {
    try {
      execFile(file, linuxDialogArgs(tool, prompt, home), {
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        env,
      }, (err, stdout, stderr) => {
        const out = String(stdout == null ? '' : stdout).replace(/\r?\n$/, '');
        if (err) {
          if (err.killed === true) return resolve({ kind: 'cancelled', timedOut: true });
          if (err.code === 'ENOENT' || err.code === 'EACCES') return resolve({ kind: 'skip' });
          const errText = String(stderr || '').trim();
          if (!out && (err.code === 1 || err.code === 252) && !DISPLAY_ERROR.test(errText)) {
            return resolve({ kind: 'cancelled' });
          }
          return resolve({ kind: 'failed', message: errText || err.message || 'The folder dialog failed.' });
        }
        return resolve(out ? { kind: 'picked', path: out } : { kind: 'cancelled' });
      });
    } catch { resolve({ kind: 'skip' }); }
  });

  return (async () => {
    for (const t of tools) {
      const r = await runOne(t);
      if (r.kind !== 'skip') return r;
    }
    return unavailable();
  })();
}
