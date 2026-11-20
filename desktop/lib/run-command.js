/**
 * run-command.js — the updater's `runCommand`: run a program, collect its
 * output, never throw.
 *
 * Moved out of main.js (Windows app, 2026-11-20) so the offline suite can run
 * it: `spawn` is injected. On macOS it behaves as main.js's inline version did
 * (same stdio, same output cap, same exit-status rules). Two additions, both
 * for Windows and inert on the Mac:
 *
 *   • `windowsHide: true`: without it every PowerShell call the Windows engine
 *     makes flashes a console window. Node ignores it off Windows.
 *   • `opts.timeoutMs`: a hung child is killed and the call resolves
 *     `{status: 124}` (the `timeout` command's status), so a PowerShell that
 *     never returns cannot hang Prepare. The Mac engine passes no timeout,
 *     so nothing there changes.
 *
 * Imports nothing from Electron.
 */

/** The status a timed-out run resolves with (as `timeout(1)` uses). */
export const TIMEOUT_STATUS = 124;

/**
 * @param {Function} spawnImpl  node:child_process.spawn (or a fake)
 * @param {string} cmd
 * @param {string[]} args
 * @param {{maxOutput?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{status: number, stdout: string, stderr: string, timedOut?: boolean}>}
 */
export function runCommandWith(spawnImpl, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      finish({ status: 127, stdout: '', stderr: String(err && err.message ? err.message : err) });
      return;
    }
    const o = opts || {};
    const cap = Number.isFinite(o.maxOutput) ? o.maxOutput : 64 * 1024;
    let stdout = ''; let stderr = '';
    if (child.stdout) child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d.toString(); });
    child.on('error', (err) => finish({ status: 127, stdout, stderr: String(err && err.message ? err.message : err) }));
    child.on('close', (code) => finish({ status: typeof code === 'number' ? code : 1, stdout, stderr }));
    if (Number.isFinite(o.timeoutMs) && o.timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ status: TIMEOUT_STATUS, stdout, stderr, timedOut: true });
      }, o.timeoutMs);
    }
  });
}
