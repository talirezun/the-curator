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
 * reachable from `mcp/` through sync.js). The one exception is
 * gitInvocation() at the end, which on Windows only reads the live install
 * (one marker test) on first use.
 */

import path from 'path';
import { existsSync } from 'fs';
import { APP_ROOT, isBundleInstall } from './paths.js';

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

// ── Git: the bundled copy on the Windows app (2026-11-20) ────────────────────
//
// The Windows app carries its own git (MinGit from Git for Windows), because a
// Windows PC has none by default and the app inherits Explorer's PATH. The
// build places it BESIDE the app's code, in Electron's resources folder:
//
//   <install>\resources\app\              APP_ROOT (the code and the bundle marker, see paths.js)
//   <install>\resources\git\cmd\git.exe   the bundled git (MinGit's launcher)
//
// i.e. `<dirname(APP_ROOT)>\git\cmd\git.exe`. MinGit's `cmd\git.exe` is the
// wrapper that sets up its own folders, the same entry point install.ps1 puts
// on PATH for the browser install. On a Windows bundle it is used FIRST (its
// folder goes at the front of the child's PATH); a git on the user's PATH is
// the fallback. Nothing changes off Windows: there the plan is the v3.87.0 env
// plus GIT_TERMINAL_PROMPT=0 and no extra argument, byte for byte
// (scripts/test-subprocess-env.js §1 and §8).

/** The folder under Electron's resources folder that holds the bundled git. */
export const BUNDLED_GIT_FOLDER = 'git';

/** Where the Windows app's bundled git lives, given APP_ROOT (a win32 path). */
export function bundledGitLocation(appRoot) {
  const root = path.win32.join(path.win32.dirname(String(appRoot || '')), BUNDLED_GIT_FOLDER);
  const binDir = path.win32.join(root, 'cmd');
  return { root, binDir, exe: path.win32.join(binDir, 'git.exe') };
}

/**
 * The `-c` settings every git call carries on Windows (none elsewhere). Our
 * token travels in the remote address and git runs with GIT_TERMINAL_PROMPT=0,
 * so git must never ask anyone for anything. On Windows a credential helper
 * would: MinGit's own system config INCLUDES a full Git for Windows install's
 * `C:/Program Files/Git/etc/gitconfig` (git-for-windows/build-extra,
 * mingit/release.sh), which normally sets `credential.helper=manager`, and Git
 * Credential Manager answers a 401 with a sign-in WINDOW. An empty
 * `credential.helper` resets the helper list (gitcredentials(7)); an empty
 * `core.askPass` stops git falling back to an askpass program (git runs one
 * only when the first of GIT_ASKPASS, core.askPass, SSH_ASKPASS that is SET is
 * also non-empty). The bundled git also uses Windows' own certificate store
 * (schannel), as install.ps1 configures for the browser install's MinGit, so a
 * company's own certificates are trusted.
 */
export function gitConfigArgs({ platform = process.platform, bundled = false } = {}) {
  if (platform !== 'win32') return [];
  const args = ['-c', 'credential.helper=', '-c', 'core.askPass='];
  // The Windows APP's own git only (audit minor 10, 2026-11-20): paths past
  // Windows' 260-character limit work (`core.longpaths`, Git for Windows'
  // setting; a knowledge folder plus `\<domain>\wiki\entities\<page>.md`
  // reaches it). Not added for a git on PATH, so the browser install's git
  // command lines stay as they were.
  if (bundled) args.push('-c', 'http.sslBackend=schannel', '-c', 'core.longpaths=true');
  return args;
}

/** Variables dropped from git's environment on Windows (set again or never wanted). */
const WIN_GIT_DROPPED_VARS = new Set(['GIT_ASKPASS', 'SSH_ASKPASS', 'GCM_INTERACTIVE', 'GIT_TERMINAL_PROMPT']);

/**
 * Everything Sync needs to start git: the environment, the `-c` arguments that
 * go before every git subcommand, and where the bundled git is.
 *
 *   platform, env, execPath  as for buildSubprocessEnv
 *   appRoot                  APP_ROOT (where the bundled git is looked for)
 *   isBundle                 the packaged app (paths.js isBundleInstall())
 *   exists(p)                injected file test (this module does no I/O)
 *
 * Off Windows: { env: { ...buildSubprocessEnv(), GIT_TERMINAL_PROMPT: '0' },
 * configArgs: [], bundledExe: null, bundledPresent: false }, unchanged.
 * On Windows: the bundled git's folder first on PATH when the app is a bundle
 * and the file is there; GIT_ASKPASS / SSH_ASKPASS removed; Git Credential
 * Manager told never to show a window (GCM_INTERACTIVE=never); the `-c`
 * settings from gitConfigArgs().
 */
export function planGit({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  appRoot = '',
  isBundle = false,
  exists = () => false,
} = {}) {
  const base = buildSubprocessEnv({ platform, env, execPath });
  if (platform !== 'win32') {
    return { env: { ...base, GIT_TERMINAL_PROMPT: '0' }, configArgs: [], bundledExe: null, bundledPresent: false };
  }
  const loc = isBundle ? bundledGitLocation(appRoot) : null;
  let present = false;
  if (loc) { try { present = !!exists(loc.exe); } catch { present = false; } }
  const key = pathKeyOf(base, platform);
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (WIN_GIT_DROPPED_VARS.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  if (present) out[key] = [loc.binDir, base[key]].filter(Boolean).join(path.win32.delimiter);
  out.GIT_TERMINAL_PROMPT = '0';
  out.GCM_INTERACTIVE = 'never';
  return {
    env: out,
    configArgs: gitConfigArgs({ platform, bundled: present }),
    bundledExe: loc ? loc.exe : null,
    bundledPresent: present,
  };
}

// ── One git for every other caller (audit M4, 2026-11-20) ────────────────────
//
// Sync (sync.js) and System Check (diagnostics.js) already start git through
// planGit(). Every OTHER git this app starts — Shared Brain's prior-version
// read, the setup check's read-only git, the memory layer's project-checkout
// reads, the CLI's info/exclude lookup — used to start bare `git` from the
// inherited PATH, which in the Windows app (started from Explorer, no Git for
// Windows installed) finds nothing, so each silently answered "nothing".
// gitInvocation() gives them the SAME git Sync runs.
//
// THE WINDOWS APP ONLY. Everywhere else — macOS, Linux, the browser install
// and a checkout on Windows — it returns the call site's own invocation
// unchanged: program `git`, the arguments as given, and `env` exactly what the
// call site passed before (undefined = inherit; `extraEnv` = `{ ...process.env,
// ...extraEnv }`, the object those call sites built themselves). On the Windows
// app: the bundled git first on PATH, no credential helper or askpass window,
// GIT_TERMINAL_PROMPT=0, and planGit's `-c` settings before the arguments
// (`credential.helper=`, `core.askPass=`, schannel, `core.longpaths=true`),
// plus the call site's `extraEnv`. Unlike the rest of this module it reads the
// live install (paths.js), once, on first use, and only on Windows.

let _liveGitInvocation = null;
let _gitInvocationOverride = null;

/** TEST-ONLY: `{ isBundle, plan }` to use instead of the live install; null restores it. */
export function __setGitInvocationForTest(o) {
  _gitInvocationOverride = o ? { isBundle: !!o.isBundle, plan: o.plan || null } : null;
}

function liveGitInvocation() {
  if (_gitInvocationOverride) return _gitInvocationOverride;
  if (process.platform !== 'win32') return { isBundle: false, plan: null };
  if (!_liveGitInvocation) {
    const isBundle = isBundleInstall();
    _liveGitInvocation = {
      isBundle,
      plan: isBundle ? planGit({ appRoot: APP_ROOT, isBundle, exists: existsSync }) : null,
    };
  }
  return _liveGitInvocation;
}

/**
 * `{ file, args, env }` for starting git with `args`. `env` is undefined when
 * the child should inherit this process's environment: pass it on only when
 * defined, so the options object is the one the call site built before.
 */
export function gitInvocation(args, { extraEnv = null } = {}) {
  const list = Array.isArray(args) ? args.slice() : [];
  const { isBundle, plan } = liveGitInvocation();
  if (!isBundle || !plan) {
    return { file: 'git', args: list, env: extraEnv ? { ...process.env, ...extraEnv } : undefined };
  }
  return { file: 'git', args: [...plan.configArgs, ...list], env: { ...plan.env, ...(extraEnv || {}) } };
}
