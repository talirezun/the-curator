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
 * command is run only when it is one of exactly two shapes, both of which
 * start THIS app's own bridge and nothing else:
 *
 *   (a) THE LAUNCHER — `command` resolves (realpath) to this app's own
 *       launcher file (getMcpLauncherPath()) and `args` is empty;
 *   (b) NODE + THIS APP'S SERVER — `command` is an ABSOLUTE path whose
 *       basename, and whose realpath's basename, is `node` (`node.exe` on
 *       Windows, any case); `args[0]` resolves (realpath) to THIS install's
 *       own `mcp/server.js`; and the only other args allowed are exactly
 *       `--domains-path <absolute path>`. Node is an interpreter: allowing
 *       "node + any args" would allow `node -e <anything>`, so the script and
 *       the flags are pinned as tightly as the binary.
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
 *   {ok: true, command, args, shape: 'launcher'|'node'}  or
 *   {ok: false, code, message, path?}
 * `ctx`: {platform, launcherPath, serverPath}.
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
  if (!P.isAbsolute(command)) {
    return refuse('not_allowed', `Its entry starts “${command}” by name rather than by full path, so The Curator does not start it — Install for me writes a full path.`);
  }
  const realCmd = realOrNull(command, deps);
  if (!realCmd || !isFile(realCmd, deps)) return refuse('launch_file_missing', `Its entry points at ${command}, which is no longer on this ${win ? 'PC' : 'Mac'}.`, command);

  // (a) the launcher
  const realLauncher = ctx.launcherPath ? realOrNull(ctx.launcherPath, deps) : null;
  if (realLauncher && samePath(realCmd, realLauncher, win)) {
    if (args.length) return refuse('not_allowed', 'Its entry passes arguments to the launcher, which The Curator never writes, so it does not start it.');
    return { ok: true, command, args: [], shape: 'launcher' };
  }

  // (b) node + this install's server
  const nodeName = win ? /^node\.exe$/i : /^node$/;
  if (!nodeName.test(P.basename(command)) || !nodeName.test(P.basename(realCmd))) {
    return refuse('not_allowed', `Its entry starts ${command}, which is neither node nor The Curator’s launcher, so The Curator does not run it.`);
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
        env: deps.env || checkEnv(), cwd: deps.cwd || undefined,
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
