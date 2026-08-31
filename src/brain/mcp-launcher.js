/**
 * The MCP launcher shim — how Claude Desktop is told to start the My Curator
 * bridge when this copy of The Curator is a packaged app.
 *
 * ── The problem, stated in the two things that are wrong under Electron ─────
 *
 * `src/routes/mcp.js` generates the `mcpServers["my-curator"]` entry that the
 * user pastes into Claude Desktop's config. Today it is:
 *
 *     { command: process.execPath, args: [<APP_ROOT>/mcp/server.js, '--domains-path', <dir>] }
 *
 * In a repo install both halves are correct: `process.execPath` is the user's
 * `node`, and `mcp/server.js` is a plain file on disk. In an Electron bundle
 * BOTH are wrong, for unrelated reasons:
 *
 *   1. `process.execPath` is the APP BINARY. Claude Desktop pointed at it
 *      would launch a second copy of The Curator — window, server, port bind
 *      and all — every time it wanted a tool call.
 *   2. `mcp/server.js` lives inside the `asar` archive, which is a single
 *      file as far as any process that is not Electron is concerned. It has
 *      to be in `asarUnpack`, and its real path then has `.asar.unpacked` in
 *      it — a path no wizard-time snapshot can be trusted to have guessed.
 *
 * Electron solves (1) with `ELECTRON_RUN_AS_NODE=1`, which makes the app
 * binary behave as a bare Node. That still leaves an absolute path to the app
 * binary in Claude Desktop's config — and that path MOVES: an update replaces
 * the bundle, the user drags the app to a different folder, macOS App
 * Translocation runs it from a random read-only mount.
 *
 * ── Why a shim, and why it is regenerated at every launch ───────────────────
 *
 * The config gets ONE stable string — a shell script this app owns and
 * rewrites — and every volatile fact lives inside that script instead.
 *
 * The three candidate places to produce it, and why two lose:
 *
 *   SHIPPED IN THE BUNDLE   — it would live inside a read-only, signed
 *     bundle, so it cannot be rewritten; and it goes stale the instant the
 *     app moves, which is the exact failure being removed. A generated file
 *     inside a signed bundle also breaks the signature.
 *   WRITTEN BY THE WIZARD   — correct only for as long as nothing changes,
 *     and repairable only by the user noticing and re-running the wizard.
 *     "The user must re-run a wizard after every app update" is the failure
 *     mode, not the fix.
 *   GENERATED AT LAUNCH     — correct after an app move, after an update
 *     replaces the bundle, after a Node upgrade, and after a macOS security
 *     policy change moves the binary. The app is the only process that knows
 *     where it currently is, and launch is the only moment it is guaranteed
 *     to be running. It is also idempotent and cheap: a stat, a compare, and
 *     usually no write at all.
 *
 * The one property launch-time generation does NOT buy: the shim is stale
 * between the app moving and its next launch. Claude Desktop can call the MCP
 * with The Curator closed — that is a property users rely on (NEXT-PHASE plan
 * D6) — so a user who moves the app and then uses Claude Desktop before
 * reopening The Curator gets one broken session. That is strictly better than
 * every other option, because opening the app fixes it with no wizard, and it
 * is recorded here rather than glossed.
 *
 * ── Where it lives, and the two ways that could go wrong ────────────────────
 *
 * `paths.js`'s `getMcpLauncherDir()` — `~/Library/Application Support/The
 * Curator/bin`, unconditional, never forked on install mode. Its docblock has
 * the reasoning. This module adds the check that resolver cannot make without
 * an import cycle: the directory must not be inside `getDomainsDir()`.
 *
 * That is not decorative. `getDomainsDir()` is Personal Sync's git WORK-TREE
 * (`sync.js` passes `--work-tree=getDomainsDir()`), and a user is free to
 * point `domainsPath` anywhere — including at the Application Support tree
 * itself. If they do, a shim written under it would be committed and pushed
 * to their GitHub repo: a machine-local absolute path, meaningless on any
 * other machine, in a synced tree. This project has shipped that exact class
 * twice (`.DS_Store` v3.0.16, `.write-lock` v3.0.15), so it is refused at
 * write time rather than argued about.
 *
 * ── Ephemeral locations: refuse, loudly, and write nothing ──────────────────
 *
 * macOS App Translocation runs a quarantined app from a randomly-named
 * read-only mount under `/private/var/folders/.../AppTranslocation/`. A shim
 * written from there records a path that will not exist on the next launch,
 * and Claude Desktop would then fail with a file-not-found the user has no way
 * to interpret. Clearing the quarantine bit disables translocation but leaves
 * `~/Downloads` just as ephemeral — the app is one "clean up my downloads"
 * away from vanishing — so both are refused, and the refusal names the fix.
 *
 * A refusal writes NOTHING. It does not create the directory, does not
 * truncate an existing shim, and does not remove one. An older, still-valid
 * shim from a previous launch out of /Applications is more useful than no
 * shim at all, and destroying it because today's launch happened from a
 * translocated mount would turn a recoverable state into a broken one.
 *
 * ── Discipline ──────────────────────────────────────────────────────────────
 *
 * Never writes to stdout (`console.error` only) — this module sits on the
 * import graph reachable from `src/routes/mcp.js`, and the repo's stdout rule
 * is stated as a property of the graph, not of a file list. It never throws:
 * every entry point returns a result record, because shim generation runs at
 * server startup and a failure there must never take the app down.
 */

import path from 'path';
import os from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { getMcpLauncherDir, appPath } from './paths.js';
import { getCapabilities } from './install-mode.js';
import { getDomainsDir } from './config.js';

/**
 * The shim's filename. Deliberately matches the MCP server name Claude
 * Desktop knows it by, so a user browsing that folder can tell what it is.
 * No extension: it is an executable, invoked by absolute path.
 */
export const MCP_LAUNCHER_FILENAME = 'my-curator-mcp';

/** Absolute path to the shim. Pure resolver — never creates anything. */
export function getMcpLauncherPath() {
  return path.join(getMcpLauncherDir(), MCP_LAUNCHER_FILENAME);
}

/** Path to the MCP entry point inside the app's own code tree. */
export function getMcpServerPath() {
  return appPath('mcp', 'server.js');
}

/**
 * True when `child` is `parent` or sits inside it.
 *
 * Case-insensitive on darwin, because APFS and HFS+ are case-insensitive by
 * default: a check that treats `/Users/x/Downloads` and `/users/x/downloads`
 * as different directories would let the refusal be walked past by a path the
 * filesystem itself considers identical. Case-SENSITIVE on Linux, where the
 * filesystem genuinely distinguishes them and folding case would make the
 * refusal over-broad.
 *
 * `platform` IS A PARAMETER, and that is not decoration. Reading
 * `process.platform` inside made this function's behaviour depend on the host,
 * so the suite asserted the darwin branch unconditionally and went GREEN on
 * macOS and RED on ubuntu CI — which is exactly how v3.30.0's first release
 * attempt was refused by the gate. A behaviour that differs by platform must be
 * DRIVEN by the test on both platforms, not observed on whichever one happens
 * to be running.
 */
export function isInside(child, parent, platform = process.platform) {
  if (!child || !parent) return false;
  const foldsCase = platform === 'darwin' || platform === 'win32';
  const norm = (p) => {
    const r = path.resolve(p);
    return foldsCase ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Classify where this process is running FROM.
 *
 * Pure and fully parameterised (no reads of `process.execPath` or `os.homedir`
 * inside), so the suite can drive every branch without pretending to be a
 * translocated app. Returns `{ephemeral, reason, message}`; `message` is null
 * when the location is fine, and otherwise NAMES THE FIX rather than only the
 * problem — a user told "refused: translocated" learns nothing actionable.
 */
export function classifyLaunchOrigin(execPath, homeDir, platform = process.platform) {
  const p = typeof execPath === 'string' ? execPath : '';
  if (!p) {
    return {
      ephemeral: true,
      reason: 'no-exec-path',
      message:
        'The Curator could not determine where it is running from, so it did not write the ' +
        'Claude Desktop launcher. Move The Curator to /Applications and reopen it.',
    };
  }
  // The translocation mount point is always a path COMPONENT, never a
  // substring of a filename — matching with separators on both sides keeps a
  // user directory honestly named "AppTranslocation Notes" out of it.
  if (p.split(path.sep).includes('AppTranslocation')) {
    return {
      ephemeral: true,
      reason: 'app-translocation',
      message:
        'macOS is running The Curator from a temporary read-only copy (App Translocation), ' +
        'so a launcher written now would point at a folder that disappears when you quit. ' +
        'Move The Curator to /Applications and reopen it, then the Claude Desktop connection ' +
        'will be set up automatically.',
    };
  }
  if (homeDir && isInside(p, path.join(homeDir, 'Downloads'), platform)) {
    return {
      ephemeral: true,
      reason: 'downloads-folder',
      message:
        'The Curator is running from your Downloads folder. Clearing the download quarantine ' +
        'stops macOS relocating the app, but the folder itself is temporary — a launcher ' +
        'written now would break the next time Downloads is tidied. Move The Curator to ' +
        '/Applications and reopen it, then the Claude Desktop connection will be set up ' +
        'automatically.',
    };
  }
  return { ephemeral: false, reason: null, message: null };
}

/**
 * The shim's contents.
 *
 * `/bin/sh` rather than bash: POSIX sh is guaranteed present, and nothing here
 * needs more. `exec env VAR=1 …` rather than a `VAR=1 exec …` prefix because
 * the latter is not portable across shells for a builtin, and `exec` matters:
 * Claude Desktop tracks the child it spawned, and an extra shell sitting
 * between it and the MCP process would swallow signals on shutdown.
 *
 * `"$@"` is forwarded so the launcher stays a transparent stand-in for the
 * node invocation it replaces — a future client that passes an argument is
 * not silently ignored.
 *
 * Both paths are single-quoted with the standard POSIX escape (`'` becomes
 * `'\''`). `/Applications/The Curator.app/…` contains a space in every real
 * installation, so quoting is load-bearing, not defensive.
 */
export function buildLauncherScript(execPath, serverPath) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    '# Generated by The Curator at launch — DO NOT EDIT.',
    '# Rewritten every time the app starts, so it always names the current',
    '# app binary. Point Claude Desktop at THIS file, not at the binary.',
    '#',
    '# ELECTRON_RUN_AS_NODE makes the app binary behave as a plain Node',
    '# runtime instead of launching a second copy of The Curator.',
    `exec env ELECTRON_RUN_AS_NODE=1 ${q(execPath)} ${q(serverPath)} "$@"`,
    '',
  ].join('\n');
}

/**
 * Ensure the launcher shim exists and is current.
 *
 * Called at server startup. In repo mode it is a NO-OP that touches no
 * filesystem path at all — the capability says `node-script`, the config entry
 * points straight at `process.execPath`, and there is nothing to generate.
 * That is what makes this whole change a proven no-op for every user today.
 *
 * Never throws. Returns:
 *   { ok, written, path, reason, message, style }
 *
 *   reason: 'not-needed'          repo mode — no shim in this launch style
 *           'app-translocation'   refused, wrote nothing
 *           'downloads-folder'    refused, wrote nothing
 *           'no-exec-path'        refused, wrote nothing
 *           'inside-domains'      refused — the target sits in the synced tree
 *           'unchanged'           already correct, nothing written
 *           'written'             created or updated
 *           'write-failed'        attempted and failed (message carries why)
 *
 * `opts` exists only so the suite can drive every branch without being a
 * translocated Electron app: production passes nothing.
 */
export function ensureMcpLauncherShim(opts = {}) {
  const style = opts.launchStyle || getCapabilities().mcpLaunchStyle;
  const target = opts.launcherPath || getMcpLauncherPath();

  if (style !== 'launcher-script') {
    return { ok: true, written: false, path: null, reason: 'not-needed', message: null, style };
  }

  const execPath = Object.hasOwn(opts, 'execPath') ? opts.execPath : process.execPath;
  const homeDir = Object.hasOwn(opts, 'homeDir') ? opts.homeDir : os.homedir();

  const origin = classifyLaunchOrigin(execPath, homeDir);
  if (origin.ephemeral) {
    // Refuse LOUDLY — stderr, never stdout. Nothing is created, nothing is
    // truncated, and an existing shim from a healthier launch is left alone.
    console.error(`[The Curator] MCP launcher not written: ${origin.message}`);
    return { ok: false, written: false, path: target, reason: origin.reason, message: origin.message, style };
  }

  // The check paths.js cannot make. `domainsPath` is user-settable, so this is
  // a reachable configuration, not a theoretical one.
  let domainsDir = null;
  try { domainsDir = opts.domainsDir || getDomainsDir(); } catch { domainsDir = null; }
  if (domainsDir && isInside(target, domainsDir)) {
    const message =
      `The Claude Desktop launcher would be written inside your knowledge base folder ` +
      `(${domainsDir}), which Personal Sync commits and pushes. Refusing: that file names a ` +
      `path that only exists on this Mac. Point your knowledge base somewhere else, or move it.`;
    console.error(`[The Curator] MCP launcher not written: ${message}`);
    return { ok: false, written: false, path: target, reason: 'inside-domains', message, style };
  }

  const contents = buildLauncherScript(execPath, opts.serverPath || getMcpServerPath());

  try {
    // Already correct? Do not rewrite. Startup runs on every launch and an
    // unconditional write would churn mtime for no reason — and, more to the
    // point, would rewrite the file while Claude Desktop might be executing it.
    if (existsSync(target)) {
      let current = null;
      try { current = readFileSync(target, 'utf8'); } catch { current = null; }
      if (current === contents) {
        // Re-assert the mode anyway: cheap, and a shim that lost its execute
        // bit is indistinguishable from a missing one to Claude Desktop.
        try { chmodSync(target, 0o700); } catch {}
        return { ok: true, written: false, path: target, reason: 'unchanged', message: null, style };
      }
    }
    // 0700 on both: the shim names an absolute path inside the user's account
    // and is executed by another application. Owner-only, like every other
    // file this app creates outside the wiki.
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, contents, { mode: 0o700 });
    chmodSync(target, 0o700);   // writeFileSync's mode is subject to umask
    return { ok: true, written: true, path: target, reason: 'written', message: null, style };
  } catch (err) {
    const message = `Could not write the Claude Desktop launcher at ${target}: ${err.message}`;
    console.error(`[The Curator] ${message}`);
    return { ok: false, written: false, path: target, reason: 'write-failed', message, style };
  }
}
