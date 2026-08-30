/**
 * Locate and launch a Chromium-family browser for the visual harness.
 *
 * NO DEPENDENCY IS ADDED. We drive whatever Chrome/Chromium/Edge is already on
 * the machine, in headless mode, with a throwaway profile on an ephemeral
 * debugging port. If no browser is found we return null and the caller
 * SELF-SKIPS with exit 0 — the same contract a live suite uses for a missing
 * API key.
 *
 * PROCESS SAFETY (this repo has been burned here):
 * A previous agent killed the maintainer's live app with an over-broad pkill.
 * This module therefore only ever signals the exact ChildProcess it spawned.
 * There is no pkill, no killall, and no pattern matching against the process
 * table anywhere in this directory.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { setTimeout as delay } from 'timers/promises';

/**
 * Candidate binaries, most-preferred first. An explicit
 * CURATOR_VISUAL_BROWSER always wins so a machine with a browser somewhere
 * unusual (or a CI image) can point at it without editing this list.
 */
export function browserCandidates() {
  const fromEnv = process.env.CURATOR_VISUAL_BROWSER;
  // An explicit override is AUTHORITATIVE, not a preference. Falling back to
  // the default list when the named binary is missing would silently measure a
  // browser the caller did not ask for, and would make the self-skip path
  // untestable. If you name it and it is not there, that is a skip.
  if (fromEnv) return [fromEnv];
  const list = [];
  if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    );
  } else {
    list.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge', '/snap/bin/chromium',
    );
  }
  return list;
}

/** @returns {string|null} path to a usable browser binary, or null. */
export function findBrowser() {
  for (const c of browserCandidates()) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/**
 * Launch headless Chrome with remote debugging on an EPHEMERAL port
 * (--remote-debugging-port=0), reading the port Chrome actually chose out of
 * DevToolsActivePort in the throwaway profile. Port 0 matters: a fixed debug
 * port would collide with another agent's browser on a shared machine, and
 * this repo runs several agents at once.
 *
 * @returns {Promise<{binary, wsUrl, close}|null>} null when no browser exists.
 */
export async function launchBrowser({ headless = true } = {}) {
  const binary = findBrowser();
  if (!binary) return null;

  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'curator-visual-profile-'));
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--metrics-recording-only',
    '--no-sandbox',
    // NOTE: --hide-scrollbars is deliberately NOT passed. Scrollbar rendering
    // is a thing this app has actually shipped a bug about (v3.19.0), so
    // hiding it would blind the harness to the very class of defect it exists
    // to catch.
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString().slice(0, 2000); });
  child.on('error', () => { /* surfaced below as "never wrote DevToolsActivePort" */ });

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  let wsUrl = null;
  for (let i = 0; i < 100; i++) {      // up to ~20s
    if (existsSync(portFile)) {
      const lines = readFileSync(portFile, 'utf8').split('\n');
      const port = lines[0]?.trim();
      const wsPath = lines[1]?.trim();
      if (port && wsPath) { wsUrl = `ws://127.0.0.1:${port}${wsPath}`; break; }
    }
    if (child.exitCode !== null) break;
    await delay(200);
  }

  const close = async () => {
    // Signal ONLY the process we spawned. Never a pattern, never a port sweep.
    if (child.exitCode === null && child.pid) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      for (let i = 0; i < 25 && child.exitCode === null; i++) await delay(100);
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  if (!wsUrl) {
    await close();
    throw new Error(
      `Browser at ${binary} never published DevToolsActivePort.` +
      (stderr ? `\n  stderr: ${stderr.trim().slice(0, 500)}` : '')
    );
  }
  return { binary, wsUrl, pid: child.pid, close };
}
