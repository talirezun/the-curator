/**
 * The environment and launch details for the subprocesses this app starts —
 * git, npm and the browser opener — per PLATFORM. (The restart replacement's
 * options stay inline in src/server.js, where test-install-mode.js §5c
 * compiles that handler against fixed collaborators.)
 *
 * ── WHY ONE MODULE (v3.87.0) ────────────────────────────────────────────────
 * `src/brain/sync.js` and `src/routes/config.js` each built the same PATH by
 * hand: the node binary's folder, then the Homebrew / system folders, then the
 * inherited PATH, joined with ':'. That is right on macOS, where AppleScript's
 * `do shell script` launches the server with a bare PATH, and wrong on
 * Windows, where ':' is not the separator (`C:\…` contains one), the POSIX
 * folders do not exist, and the inherited variable is spelled `Path`. Spreading
 * `process.env` and then setting `PATH` there gives the child BOTH `Path` and
 * `PATH`, and which one a Windows child reads is not defined.
 *
 * ── THE macOS STRING IS BYTE-IDENTICAL ──────────────────────────────────────
 * Off win32 this builds exactly what both files built before:
 *   [dirname(execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin',
 *    '/bin', '/usr/sbin', '/sbin', PATH || ''].filter(Boolean).join(':')
 * and `{ ...env, PATH }`. `scripts/test-subprocess-env.js` pins that against a
 * transcribed copy of the old expression, so a change to it goes red.
 *
 * Every function takes the platform, environment and node path as arguments
 * (defaulting to the live process), so a suite on macOS can drive the Windows
 * arm. Pure: no I/O, no spawn, nothing written to stdout (this module is
 * reachable from `mcp/` through sync.js).
 */

import path from 'path';

/** The POSIX folders prepended off Windows (unchanged since v2.3.5). */
export const POSIX_EXTRA_DIRS = Object.freeze([
  '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
]);

/**
 * The name the environment already uses for PATH. On Windows the variable is
 * case-insensitive and normally spelled `Path`; on every other platform it is
 * `PATH`. The FIRST matching key wins, so a child sees one value, not two.
 */
export function pathKeyOf(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return 'PATH';
  const found = Object.keys(env || {}).find((k) => k.toUpperCase() === 'PATH');
  return found || 'Path';
}

/** The PATH string a subprocess gets. */
export function buildSubprocessPath({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
} = {}) {
  if (platform === 'win32') {
    const key = pathKeyOf(env, platform);
    const inherited = (env && env[key]) || '';
    // The node folder first, so `npm` resolves to the npm.cmd that sits beside
    // the node.exe running this server (the private runtime on a one-line
    // install). Nothing POSIX is added: those folders do not exist there.
    return [path.win32.dirname(execPath), inherited].filter(Boolean).join(path.win32.delimiter);
  }
  return [
    path.posix.dirname(execPath),
    ...POSIX_EXTRA_DIRS,
    (env && env.PATH) || '',
  ].filter(Boolean).join(path.posix.delimiter);
}

/**
 * The whole environment a subprocess gets: the inherited one with the PATH
 * replaced. On Windows the existing key's spelling is kept and every other
 * spelling of it is dropped, so the child never carries a `Path`/`PATH` pair.
 */
export function buildSubprocessEnv({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
} = {}) {
  const value = buildSubprocessPath({ platform, env, execPath });
  if (platform !== 'win32') return { ...env, PATH: value };
  const key = pathKeyOf(env, platform);
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (k.toUpperCase() === 'PATH') continue;
    out[k] = v;
  }
  out[key] = value;
  return out;
}

/**
 * How to open `url` in the default browser, as a program and an argv array —
 * never a shell string. `null` means "do not open": CURATOR_NO_OPEN is set
 * (it always wins), the URL is not a plain http://localhost:<port> address,
 * or the platform has no opener we know.
 *
 * Windows uses rundll32's url.dll FileProtocolHandler by its absolute path:
 * it hands the URL to the default browser with no command interpreter in
 * between, so nothing in the URL is ever parsed by cmd.exe.
 */
export function planBrowserOpen({
  url,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (env && env.CURATOR_NO_OPEN) return null;
  if (typeof url !== 'string' || !/^http:\/\/localhost:\d{1,5}$/.test(url)) return null;
  if (platform === 'darwin') return { file: 'open', args: [url] };
  if (platform === 'win32') {
    const root = (env && (env.SystemRoot || env.SYSTEMROOT || env.windir)) || 'C:\\Windows';
    return {
      file: path.win32.join(root, 'System32', 'rundll32.exe'),
      args: ['url.dll,FileProtocolHandler', url],
      options: { windowsHide: true },
    };
  }
  if (platform === 'linux') return { file: 'xdg-open', args: [url] };
  return null;
}
