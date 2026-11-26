/**
 * "Check entry" (v3.89.0) — start the EXACT my-curator command another agent
 * app's config file names, the way that app would, and say in plain words
 * whether it starts and how many tools it lists.
 *
 * WHY. v3.88.1 found a Claude Desktop entry that read "connected" while Claude
 * Desktop said "My Curator could not start": the entry launched files that had
 * been uninstalled. The status check now catches a missing file; this check
 * catches everything a file check cannot (a node that will not run, a server
 * that crashes on start, a folder it cannot read) by actually starting it.
 *
 * ── THE SECURITY RULE (docs/dev/decisions-app.md § Security) ──────────────
 * This runs a command TAKEN FROM ANOTHER APP'S CONFIG FILE. Anything that can
 * write that file could otherwise make this button run any program, so the
 * command is run only when it is one of exactly three shapes, each of which
 * start THIS app's own bridge and nothing else:
 *
 *   (a) THE LAUNCHER — `command` resolves (realpath) to this app's own
 *       launcher file (getMcpLauncherPath()) and `args` is empty;
 *   (b) NODE + THIS APP'S SERVER — `command` is an ABSOLUTE path whose
 *       basename, and whose realpath's basename, is `node` (`node.exe` on
 *       Windows, any case), AND whose realpath is the node this app itself
 *       runs on and writes into the entry (`ctx.nodePath`, process.execPath
 *       in a source install; v4.1.2 — a file merely NAMED node is not node);
 *       `args[0]` resolves (realpath) to THIS install's
 *       own `mcp/server.js`; and the only other args allowed are exactly
 *       `--domains-path <absolute path>`. Node is an interpreter: allowing
 *       "node + any args" would allow `node -e <anything>`, so the script and
 *       the flags are pinned as tightly as the binary.
 *
 *   (c) THIS WINDOWS APP'S OWN EXE AS NODE — owner-approved 2026-11-20 for
 *       the Windows app (`mcpLaunchStyle: 'app-binary'`, see the end of
 *       src/brain/mcp-launcher.js for why Windows has no launcher). Offered
 *       ONLY when the caller passes `ctx.appExecPath` (the route does so only
 *       when its own launch line is app-binary, i.e. this process IS the
 *       Windows app and `appExecPath` is its own `process.execPath`) and
 *       `ctx.platform` is win32. The entry must be exactly
 *         {command: <this exe>, args: [<this install's mcp/server.js>],
 *          env: {ELECTRON_RUN_AS_NODE: "1"}}
 *       and every one of these must hold, or it is refused:
 *         - `command` and `args[0]` are each in the ONE canonical spelling
 *           (`winPathProblem` below): a drive-letter absolute path with
 *           backslashes only — no UNC / `\\?\` / `\\.\` device path, no
 *           forward slash, no empty, `.` or `..` component, no component
 *           ending in a dot or a space (Windows strips those, so they are
 *           look-alikes), no `~<digit>` (an 8.3 short name), no `:` after the
 *           drive (an NTFS alternate data stream), no reserved device name;
 *         - each EQUALS this process's own path (`ctx.appExecPath` /
 *           `ctx.serverPath`, both canonical) ignoring case only, because
 *           Windows paths are case-insensitive;
 *         - and each is the SAME FILE on disk as ours — same volume and file
 *           id from a bigint stat (non-zero), and the same realpath ignoring
 *           case. Case-folding alone is not enough: NTFS allows per-folder
 *           case sensitivity, where `the curator.exe` can be a different
 *           file, and the identity check catches that (and any Unicode case
 *           mapping where JS and NTFS disagree);
 *         - no other argument at all (no --domains-path: the app never writes
 *           one, and an interpreter must not be handed anything else);
 *         - the entry's `env` is exactly {ELECTRON_RUN_AS_NODE: "1"}. The
 *           entry's env is still NEVER passed (rule below); it is READ only so
 *           a green result is not a lie: without the variable Claude Desktop
 *           would open a second copy of the app instead of My Curator, and
 *           with any other variable (NODE_OPTIONS=--require …) it would run
 *           something this check never ran.
 *       What then runs is OUR strings, not the entry's: `ctx.appExecPath`
 *       with `[ctx.serverPath]`, and runEntryCheck adds
 *       ELECTRON_RUN_AS_NODE=1 to the allow-listed environment ITSELF, as a
 *       constant, only for this shape. Any other exe — another install's
 *       `The Curator.exe`, a copy, a renamed one — is refused, never
 *       "nearly" accepted, and never falls through to another shape.
 *
 * Everything else is REFUSED without running anything: a relative or bare
 * command (`node`, `npx`), any other binary, a node flag, a different copy
 * of My Curator (another install's server.js — said so, by path), a
 * missing launch file (said so, by path — the v3.88.1 case).
 *
 * The entry's own `env` is NEVER passed (NODE_OPTIONS=--require … is code
 * execution). The child gets a small allow-listed environment plus
 * CURATOR_MCP_VIA=self-test, so the check never counts as an agent's session.
 * execFile with an argv array and `shell: false`; a wall-clock timeout; the
 * child killed as soon as tools/list answers (or on timeout); stdout and
 * stderr capped. Nothing here writes to stdout.
 */
import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const CHECK_TIMEOUT_MS = 8000;
export const STDOUT_CAP = 2 * 1024 * 1024;
export const STDERR_CAP = 16 * 1024;
/** After SIGTERM, how long a child gets before SIGKILL. */
export const KILL_GRACE_MS = 1500;
/** How many distinct entries one press may start (Antigravity keeps up to three files). */
export const MAX_ENTRIES_PER_CHECK = 3;

/** The environment variables a check passes through. Nothing else reaches the child. */
export const ENV_ALLOW = Object.freeze([
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'windir',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HOMEDRIVE', 'HOMEPATH',
]);

/** The child's environment: the allow-list, the isolation variables a test sets, and the self-test marker. */
export function checkEnv(src = process.env) {
  const env = {};
  for (const k of ENV_ALLOW) if (typeof src[k] === 'string') env[k] = src[k];
  // An isolated test process keeps its isolation in the child, or the child
  // would write the REAL user's usage log.
  for (const k of Object.keys(src)) if (/^CURATOR_TEST_[A-Z0-9_]+$/.test(k) && typeof src[k] === 'string') env[k] = src[k];
  env.CURATOR_MCP_VIA = 'self-test';
  return env;
}

/**
 * Shape (c)'s one environment variable, set BY THE CHECKER as a constant —
 * never read from the entry, never from this process's own environment, and
 * only for a vetted app-binary entry (runEntryCheck).
 */
export const APP_BINARY_CHILD_ENV = Object.freeze({ ELECTRON_RUN_AS_NODE: '1' });

/** Windows' reserved device names: `NUL.exe` and `CON` open a device, not a file. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/**
 * Is `p` NOT in the one canonical Windows spelling shape (c) accepts? Returns
 * null when it is, else a short clause saying why (it reads after "which").
 * Pure, string-only. Exported for mcp-launcher.js (which refuses to WRITE an
 * entry Check entry would refuse) and for the suites.
 */
export function winPathProblem(p) {
  if (typeof p !== 'string' || !p) return 'is not a path';
  if (/[\u0000-\u001f]/.test(p)) return 'contains a control character';
  if (!/^[A-Za-z]:\\/.test(p)) return 'is not a full path on a drive (a network share or device path is not accepted)';
  if (p.includes('/')) return 'uses forward slashes';
  const parts = p.slice(3).split('\\');
  for (const c of parts) {
    if (!c) return 'has an empty folder name';
    if (c === '.' || c === '..') return 'has a relative step in it';
    if (/[. ]$/.test(c)) return 'has a name ending in a dot or a space';
    if (/[<>:"|?*]/.test(c)) return 'has a character Windows does not allow in a name';
    if (/~\d/.test(c)) return 'uses a short (8.3) name';
    if (WIN_RESERVED.test(c)) return 'names a Windows device';
  }
  return null;
}

/** Same volume and same non-zero file id (bigint stat), or false. */
function sameFile(a, b, deps) {
  try {
    const st = deps.stat || statSync;
    const x = st(a, { bigint: true });
    const y = st(b, { bigint: true });
    if (!x || !y || !x.isFile() || !y.isFile()) return false;
    const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));
    const xi = big(x.ino), yi = big(y.ino);
    return xi !== 0n && xi === yi && big(x.dev) === big(y.dev);
  } catch { return false; }
}

/**
 * Shape (c). Called only with `ctx.appExecPath` set on win32 and an entry
 * whose command equals it ignoring case. Every failure refuses; nothing falls
 * through to shapes (a) or (b). See the header for the rule and its reasons.
 */
function vetAppBinary(entry, args, ctx, deps, refuse) {
  const ours = ctx.appExecPath;
  const server = ctx.serverPath;
  const command = entry.command;
  // Our own two paths must themselves be canonical, or no entry can match.
  if (winPathProblem(ours) || winPathProblem(server)) {
    return refuse('not_allowed', 'The Curator is running from a folder it cannot check entries in (a network share or a short name), so it does not start this one. Reinstall The Curator with its installer.');
  }
  const cmdProblem = winPathProblem(command);
  if (cmdProblem) return refuse('not_allowed', `Its entry names The Curator in a form The Curator does not start (the path ${cmdProblem}). Install for me writes the exact path.`);
  if (command.toLowerCase() !== ours.toLowerCase()) {
    return refuse('other_install', `Its entry starts a different copy of The Curator (${command}), not this app, so The Curator does not run it. Install for me points it at this app.`, command);
  }
  if (!isFile(command, deps)) return refuse('launch_file_missing', `Its entry points at ${command}, which is no longer on this PC.`, command);
  const realCmd = realOrNull(command, deps);
  const realOurs = realOrNull(ours, deps);
  if (!sameFile(command, ours, deps) || !samePath(realCmd, realOurs, true)) {
    return refuse('other_install', `Its entry starts ${command}, which is not this app's own program file, so The Curator does not run it. Install for me points it at this app.`, command);
  }
  if (args.length !== 1) {
    return refuse('not_allowed', 'Its entry passes arguments to The Curator that it never writes, so The Curator does not run it. Install for me rewrites it.');
  }
  const script = args[0];
  const scriptProblem = winPathProblem(script);
  if (scriptProblem) return refuse('not_allowed', `Its entry names My Curator's server in a form The Curator does not start (the path ${scriptProblem}). Install for me writes the exact path.`);
  if (script.toLowerCase() !== server.toLowerCase()) {
    return refuse('other_install', `Its entry starts a different copy of My Curator (${script}), not this app's own, so The Curator does not run it. Install for me points it at this app.`, script);
  }
  if (!isFile(script, deps)) return refuse('launch_file_missing', `Its entry points at ${script}, which is no longer on this PC.`, script);
  if (!sameFile(script, server, deps) || !samePath(realOrNull(script, deps), realOrNull(server, deps), true)) {
    return refuse('other_install', `Its entry starts ${script}, which is not this app's own My Curator server, so The Curator does not run it.`, script);
  }
  // The entry's env: READ to keep the answer honest, never passed (header).
  const env = entry.env;
  const envOk = env && typeof env === 'object' && !Array.isArray(env)
    && Object.keys(env).length === 1 && env.ELECTRON_RUN_AS_NODE === '1';
  if (!envOk) {
    const names = env && typeof env === 'object' && !Array.isArray(env)
      ? Object.keys(env).filter((k) => k !== 'ELECTRON_RUN_AS_NODE').slice(0, 5) : [];
    if (names.length) {
      return refuse('not_allowed', `Its entry sets environment variables The Curator never writes (${names.join(', ')}), so The Curator does not run it: Claude Desktop would start something this check cannot vouch for. Install for me rewrites it.`);
    }
    return refuse('not_allowed', 'Its entry starts The Curator without ELECTRON_RUN_AS_NODE=1, so Claude Desktop would open a second copy of the app instead of My Curator. Install for me fixes it.');
  }
  // OUR strings, never the entry's.
  return { ok: true, command: ours, args: [server], shape: 'app-binary' };
}

function realOrNull(p, deps) {
  try { return (deps.realpath || realpathSync)(p); } catch { return null; }
}
function isFile(p, deps) {
  try { return (deps.stat || statSync)(p).isFile(); } catch { return false; }
}
const samePath = (a, b, win) => !!a && !!b && (win ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Decide whether an entry may be started. Pure apart from the file probes in
 * `deps` ({realpath, stat}). Returns
 *   {ok: true, command, args, shape: 'launcher'|'node'|'app-binary'}  or
 *   {ok: false, code, message, path?}
 * `ctx`: {platform, launcherPath, serverPath, nodePath?, appExecPath?}.
 * `nodePath` (the node the installer writes, source installs only) turns
 * shape (b) on; `appExecPath` (this process's own exe, Windows app only)
 * turns shape (c) on and shapes (a) and (b) off.
 */
export function vetEntry(entry, ctx, deps = {}) {
  const win = ctx.platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const refuse = (code, message, p) => ({ ok: false, code, message, ...(p ? { path: p } : {}) });
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return refuse('no_entry', 'This file has no my-curator entry to start.');
  const command = entry.command;
  const args = entry.args === undefined ? [] : entry.args;
  if (typeof command !== 'string' || !command || command.includes('\0')) return refuse('not_allowed', 'Its entry names no program to start.');
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string' && !a.includes('\0'))) {
    return refuse('not_allowed', 'Its entry’s arguments are not a plain list of words, so The Curator does not start it.');
  }
  // (c) — only in the Windows app, and for any entry whose program is named
  // like this exe (any case, any folder): from here on it is shape (c) or a
  // refusal, never another shape, so a near-miss is told apart in words.
  // "Named like": the file name as Windows would open it — case folded, an
  // `:stream` suffix and trailing dots/spaces dropped — so `The Curator.exe.`
  // and `The Curator.exe:x` get shape (c)'s refusal in words too.
  const appExe = win && typeof ctx.appExecPath === 'string' && ctx.appExecPath ? ctx.appExecPath : null;
  const openedName = (p) => P.basename(p).split(':')[0].replace(/[. ]+$/, '').toLowerCase();
  if (appExe && (command.toLowerCase() === appExe.toLowerCase() || openedName(command) === openedName(appExe))) {
    return vetAppBinary(entry, args, ctx, deps, refuse);
  }
  if (!P.isAbsolute(command)) {
    return refuse('not_allowed', `Its entry starts “${command}” by name rather than by full path, so The Curator does not start it — Install for me writes a full path.`);
  }
  const realCmd = realOrNull(command, deps);
  if (!realCmd || !isFile(realCmd, deps)) return refuse('launch_file_missing', `Its entry points at ${command}, which is no longer on this ${win ? 'PC' : 'Mac'}.`, command);

  // (a) the launcher — never in the Windows app, which has none: a file that
  // happened to sit at the launcher path there would otherwise run with no
  // check of what it is.
  const realLauncher = ctx.launcherPath && !appExe ? realOrNull(ctx.launcherPath, deps) : null;
  if (realLauncher && samePath(realCmd, realLauncher, win)) {
    if (args.length) return refuse('not_allowed', 'Its entry passes arguments to the launcher, which The Curator never writes, so it does not start it.');
    return { ok: true, command, args: [], shape: 'launcher' };
  }

  // (b) node + this install's server — never in the Windows app either (audit
  // minor 4, 2026-11-20). There the only entry The Curator writes is shape
  // (c), so the rule is exactly "(c) or refuse": a node.exe from anywhere on
  // the PC that merely names this install's server is not started. macOS and
  // the browser install (no appExecPath) keep shape (b) unchanged.
  if (appExe) {
    return refuse('not_allowed', `Its entry starts ${command}, not The Curator itself, so The Curator does not run it. Install for me writes the entry this app runs.`);
  }
  const nodeName = win ? /^node\.exe$/i : /^node$/;
  if (!nodeName.test(P.basename(command)) || !nodeName.test(P.basename(realCmd))) {
    return refuse('not_allowed', `Its entry starts ${command}, which is neither node nor The Curator’s launcher, so The Curator does not run it.`);
  }
  // A real node is THE node this app runs on (v4.1.2, audit M1): a file is
  // not node because it is NAMED node. `ctx.nodePath` is the node the
  // installer writes into the entry (`process.execPath` in a source install),
  // and the entry's command must resolve to that same file. No nodePath (the
  // Mac app writes its launcher, never a node line) → shape (b) is off.
  const realNode = typeof ctx.nodePath === 'string' && ctx.nodePath ? realOrNull(ctx.nodePath, deps) : null;
  if (!realNode || !samePath(realCmd, realNode, win) || (win && !sameFile(realCmd, realNode, deps))) {
    return refuse('not_allowed', `Its entry starts ${command}, which is not the node The Curator runs on${realNode ? ` (${ctx.nodePath})` : ''}, so The Curator does not run it. Install for me points it at this app’s own node.`);
  }
  const script = args[0];
  if (typeof script !== 'string' || !P.isAbsolute(script)) {
    return refuse('not_allowed', 'Its entry starts node without the full path of My Curator’s server, so The Curator does not run it.');
  }
  const realScript = realOrNull(script, deps);
  if (!realScript || !isFile(realScript, deps)) return refuse('launch_file_missing', `Its entry points at ${script}, which is no longer on this ${win ? 'PC' : 'Mac'}.`, script);
  const realServer = ctx.serverPath ? realOrNull(ctx.serverPath, deps) : null;
  if (!samePath(realScript, realServer, win)) {
    return refuse('other_install', `Its entry starts a different copy of My Curator (${script}), not this app’s own, so The Curator does not run it. Install for me points it at this app.`, script);
  }
  const rest = args.slice(1);
  const restOk = rest.length === 0 || (rest.length === 2 && rest[0] === '--domains-path' && P.isAbsolute(rest[1]));
  if (!restOk) return refuse('not_allowed', 'Its entry passes node arguments The Curator never writes, so it does not run it.');
  return { ok: true, command, args: args.slice(), shape: 'node' };
}

/** A person's words for a failed start. Pure. */
export function failureWords(r) {
  const tail = (s) => {
    const lines = String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const pick = lines.find((l) => /error|cannot|not found|denied|ENOENT|EACCES/i.test(l)) || lines[lines.length - 1] || '';
    return pick.length > 240 ? pick.slice(0, 237) + '…' : pick;
  };
  if (r.spawnError === 'ENOENT') return 'The program its entry names could not be found.';
  if (r.spawnError === 'EACCES') return 'The program its entry names is not allowed to run.';
  if (r.spawnError) return `It could not be started (${r.spawnError}).`;
  if (r.timedOut) return `It did not answer within ${Math.round(CHECK_TIMEOUT_MS / 1000)} seconds.` + (tail(r.stderr) ? ' It said: ' + tail(r.stderr) : '');
  if (r.exited && !r.initialized) {
    return 'It stopped before it answered' + (Number.isInteger(r.exitCode) ? ` (exit code ${r.exitCode})` : '') + '.'
      + (tail(r.stderr) ? ' It said: ' + tail(r.stderr) : '');
  }
  if (r.initialized && !r.listed) return 'It started but did not list its tools.' + (tail(r.stderr) ? ' It said: ' + tail(r.stderr) : '');
  return 'It did not answer as My Curator.';
}

/**
 * Start a vetted entry and speak MCP to it: initialize, then tools/list.
 * Resolves `{starts, toolCount, serverName, serverVersion, stderr, message,
 * durationMs}`. Never rejects. `deps.execFile` and `deps.now` are seams.
 */
export function runEntryCheck(vetted, deps = {}) {
  const run = deps.execFile || execFile;
  const now = deps.now || Date.now;
  const timeoutMs = deps.timeoutMs || CHECK_TIMEOUT_MS;
  const t0 = now();
  // The checker's own environment; for a vetted app-binary entry, plus the one
  // constant that makes the exe behave as Node. Never the entry's env.
  const baseEnv = deps.env || checkEnv();
  const childEnv = vetted && vetted.shape === 'app-binary' ? { ...baseEnv, ...APP_BINARY_CHILD_ENV } : baseEnv;
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const st = { initialized: false, listed: false, toolCount: null, serverName: null, serverVersion: null,
      exited: false, exitCode: null, timedOut: false, spawnError: null };
    let child;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child && child.kill(); } catch { /* already gone */ }
      // A child that ignores SIGTERM is killed outright (v4.1.2, audit M9).
      if (child && child.exitCode === null && child.signalCode === null) {
        const hard = setTimeout(() => {
          try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
        }, KILL_GRACE_MS);
        if (typeof hard.unref === 'function') hard.unref();
      }
      const starts = st.initialized && st.listed;
      resolve({
        starts, toolCount: st.toolCount, serverName: st.serverName, serverVersion: st.serverVersion,
        stderr: err ? err.slice(-1200) : null,
        message: starts ? null : failureWords({ ...st, stderr: err }),
        durationMs: Math.max(0, now() - t0),
      });
    };
    const timer = setTimeout(() => { st.timedOut = true; finish(); }, timeoutMs);
    try {
      child = run(vetted.command, vetted.args, {
        shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: STDOUT_CAP, killSignal: 'SIGTERM',
        env: childEnv, cwd: deps.cwd || undefined,
      }, (e) => {
        if (e && e.code && typeof e.code === 'string' && !st.exited && !st.initialized) st.spawnError = e.code;
        st.exited = true;
        finish();
      });
    } catch (e) {
      st.spawnError = (e && e.code) || 'error';
      finish();
      return;
    }
    if (!child || !child.stdout || !child.stdin) { st.spawnError = 'error'; finish(); return; }
    child.on('error', (e) => { st.spawnError = (e && e.code) || 'error'; finish(); });
    child.on('exit', (code) => { st.exited = true; st.exitCode = code; setTimeout(finish, 20); });
    let buf = '';
    child.stdout.on('data', (d) => {
      if (out.length > STDOUT_CAP) return;
      const s = d.toString('utf8');
      out += s;
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id === 1 && msg.result) {
          st.initialized = true;
          const si = msg.result.serverInfo || {};
          st.serverName = typeof si.name === 'string' ? si.name.slice(0, 80) : null;
          st.serverVersion = typeof si.version === 'string' ? si.version.slice(0, 40) : null;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (msg && msg.id === 2 && msg.result) {
          st.listed = true;
          st.toolCount = Array.isArray(msg.result.tools) ? msg.result.tools.length : 0;
          finish();
        }
      }
    });
    if (child.stderr) child.stderr.on('data', (d) => { if (err.length < STDERR_CAP) err += d.toString('utf8').slice(0, STDERR_CAP - err.length); });
    function send(obj) { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* closed */ } }
    child.stdin.on('error', () => { /* the child went away; exit/close decide */ });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'curator-check-entry', version: '1' } } });
  });
}
