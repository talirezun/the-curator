/**
 * Is a bridge process still running the code this install has already replaced?
 *
 * ── THE MEASUREMENT THIS MODULE EXISTS BECAUSE OF ──────────────────────────
 *
 * On 2026-09-20 the maintainer's Mac was running TWO `my-curator` bridges, both
 * spawned by Claude Desktop from the installed `.app`:
 *
 *     29123  Fri Sep 18 10:10:34 2026  …/Contents/Resources/app/mcp/server.js
 *     97330  Sun Sep 20 08:54:17 2026  …/Contents/Resources/app/mcp/server.js
 *
 * The files on disk were v3.63.0. The older process had been alive across FIVE
 * in-app updates and was still serving pre-v3.59.0 code — 22 tools, no
 * `get_project_context`, no `save_foundation` — to the desktop app and to its
 * Code tab. Nothing in the app, in the self-test or in `my-curator doctor` said
 * so, and nothing could: every one of those surfaces reports on the FILES, and
 * a long-lived child process is the one thing an auto-updater cannot reach.
 * The update lands, the app restarts itself, and the bridge — whose parent is
 * Claude Desktop, not The Curator — keeps running the code it was started with
 * until the user quits the client that spawned it.
 *
 * That is not a bug to fix here. It is a FACT to report: a stale bridge is
 * indistinguishable, from inside the app, from a healthy one, and the remedy
 * (restart the app that launched it) is something only the user can do.
 *
 * ── READ-ONLY, AND EVERY WORD OF THAT ──────────────────────────────────────
 *
 * It lists processes and it stats two files. It never signals, kills, spawns,
 * writes or logs anything, and it takes no argument that could name a process.
 * `execFile` with an argv ARRAY — never `exec`, never a shell, never a string
 * built from a path — so nothing on disk can become a command. The only
 * external program it runs is `ps`, with fixed arguments.
 *
 * ── IT NEVER THROWS AND IT NEVER GUESSES ───────────────────────────────────
 *
 * Every failure answers `{checked: false, reason}` with `running: 0` and an
 * EMPTY `stale`. "We did not look" and "we looked and found nothing" are
 * different facts and must never share a presentation — the same rule
 * `working-state.js` applies to an absent age and `mcp-usage.js` applies to a
 * tool with no line. A surface that renders `checked: false` as "no stale
 * bridge" is asserting something this module did not say.
 *
 * PLATFORMS (v3.88.0). macOS is measured. Windows (PowerShell
 * `Get-CimInstance Win32_Process`, by absolute path, the same safe runner
 * shape as `harness-detect.js`) and Linux (`ps -eo`, procps spelling) are
 * BEST EFFORT and unmeasured on a real machine: any failure there is
 * `checked: false` with the reason, exactly like a macOS failure, never a
 * silent wrong answer. Any other platform is `checked: false`.
 *
 * ── WHAT MAKES A BRIDGE STALE — v3.88.0: ITS TOOL LIST, NOT A FILE'S MTIME ──
 *
 * MEASURED 2026-11-01: the rule below (mtimes) re-flagged EVERY open bridge on
 * EVERY release, because a Mac-app update rewrites every file in the bundle —
 * a Windows-only release included. The page then told the owner Claude
 * Desktop "still offers the older tool list" while both of its bridges served
 * the same 24 tools (`git diff v3.86.0 HEAD -- mcp/` was empty), and the
 * remedy — quit Claude Desktop — also ends the Claude Code sessions in its
 * Code tab. So since v3.88.0 each bridge writes its pid, version and
 * tool-list signature on its usage-log session line (`mcp/tool-signature.js`),
 * this module joins those lines to the live processes BY PID (guarded by the
 * process's start time, so a reused pid cannot inherit a dead bridge's line),
 * and `tools` is `same | different | unknown` by SIGNATURE. `stale` now lists
 * only the PROVEN-different ones. The mtime survives as `olderThanCode` — a
 * fact, used for one decision only: whether an `unknown` bridge (no signature:
 * started before v3.88.0) is worth a soft warning. Each bridge also gets its
 * PARENT APP, by walking `ppid` up to the first `.app` bundle (or a known
 * vendor CLI), so the remedy names the app to quit.
 *
 * THE v3.64.0 RULE, kept for the record — its start time predates the NEWER of `mcp/server.js`'s and `package.json`'s
 * mtime. Two files rather than one because neither alone is sufficient: a
 * release that changes no MCP source at all still moves `package.json` (the
 * version), and a hand-edit of `mcp/server.js` during development moves only
 * that. `mcp/server.js` is the process's own entry point, so its mtime is the
 * closest thing to "the code this child is running" that a file can express —
 * but the bridge's reachable import graph is ~13 `src/brain` modules deep and
 * this module deliberately does NOT walk it: a directory scan on every Settings
 * entry to sharpen a reading whose remedy is the same either way would be
 * paying for precision nobody spends.
 *
 * The comparison is therefore CONSERVATIVE in the safe direction. A bridge
 * started one second after the update lands but before a later file changed is
 * read as fresh; the cost of that is one under-report, and the cost of the
 * other direction is telling a user to restart Claude Desktop for nothing.
 *
 * ── WHY IT LIVES IN `src/brain` AND NOT IN THE ROUTE ────────────────────────
 *
 * `src/cli/doctor.js` reports it too, and a CLI must not import the Express
 * graph (doctor's own docblock records that rule about `buildCuratorEntry`).
 * One implementation, two callers — the same shape as `summariseSessions()`'s
 * three.
 */
import { execFile } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appPath } from './paths.js';
import { APP_BUNDLES, cliBinFor, isClaudeDesktopExe, powershellPath, probesDisabled } from './harness-detect.js';
import { adapterFor, listHarnesses } from './harness-adapters.js';
import { readUsageLinesUnion } from './mcp-usage.js';

/** `ps` is given this long before it is abandoned. It answers in ~15 ms. */
export const PS_TIMEOUT_MS = 3000;

/** PowerShell's cold start alone can pass 3 s on a slow PC (harness-detect's figure). */
export const WIN_PS_TIMEOUT_MS = 5000;

/** A `ps` table larger than this is not a machine we can report honestly on. */
export const PS_MAX_BUFFER = 4 * 1024 * 1024;

/** How far up the parent chain a bridge's app is looked for. */
export const MAX_ANCESTORS = 8;

/**
 * The fixed argv. `pid=`, `ppid=`, `lstart=` and `command=` each suppress
 * their own header (that is what the trailing `=` means), so the output is
 * pure rows and a header line can never be parsed as a process.
 *
 * `-ax`, not `-e`: `-e` is the System V spelling and macOS's `ps` accepts it,
 * but `-ax` is the BSD one this platform documents. `command=` must come LAST
 * — it is the only field that contains spaces, so everything after the fifth
 * `lstart` token is the command and the parse needs no quoting rules at all.
 * `ppid` (v3.88.0) names the parent, which is how a bridge's app is found.
 */
export const PS_ARGS = Object.freeze(['-axo', 'pid=,ppid=,lstart=,command=']);

/** Linux (procps): the same four fields in the System V spelling. Best effort. */
export const PS_ARGS_LINUX = Object.freeze(['-eo', 'pid=,ppid=,lstart=,args=']);

/**
 * Windows: ONE constant script, nothing interpolated. Every process's pid,
 * parent, UTC creation time and executable path; the command line ONLY for a
 * process whose command line names a `server.js` (the bridges), so no other
 * program's arguments are ever read into this process.
 */
export const WIN_PROCS_SCRIPT = "$ErrorActionPreference='SilentlyContinue'; "
  + 'Get-CimInstance Win32_Process | ForEach-Object { '
  + "$c = ''; if ($_.CommandLine -like '*server.js*') { $c = $_.CommandLine }; "
  + "$t = ''; if ($_.CreationDate) { $t = $_.CreationDate.ToUniversalTime().ToString('o') }; "
  + "'P|' + $_.ProcessId + '|' + $_.ParentProcessId + '|' + $t + '|' + $_.ExecutablePath + '|' + $c }";

/**
 * The v3.64.0 remedy sentence, KEPT for compatibility (`bridge_stale_remedy`,
 * `doctor`, `/api/setup/machine`). New surfaces use `staleRemedyFor(app)`,
 * which names the app and the exact way to quit it.
 *
 * It names the ACT ("restart"), the usual actor ("usually Claude Desktop") and
 * the reason a user would otherwise not believe it ("it is still running the
 * older code"). It does NOT name The Curator: restarting The Curator is
 * precisely what does not help, and a user who tries that first and sees no
 * change concludes the reading is wrong.
 */
export const STALE_REMEDY =
  'Restart the app that launched it — usually Claude Desktop — so it loads the current version.';

/**
 * The remedy for ONE app (v3.88.0, the owner's decision 3): the app's name and
 * the exact quit step. On macOS closing the window does not quit an app, and
 * its bridges keep running; only Quit (⌘Q) ends them. For Claude Desktop the
 * sentence also says what the quit costs — it ends the Claude Code sessions in
 * its Code tab — because that is a real price the user should see first.
 *
 * `app` is a bridge's `app` object (`{id, label, via}`); `platform` defaults to
 * this process's. Never names The Curator (see STALE_REMEDY).
 */
export function staleRemedyFor(app, platform = process.platform) {
  const a = app && typeof app === 'object' ? app : {};
  const label = typeof a.label === 'string' && a.label && a.id ? a.label : null;
  const isDesktop = a.id === 'claude-desktop';
  const codeTab = isDesktop ? ' This also ends Claude Code sessions in its Code tab.' : '';
  if (!label) return 'Quit the app that started it and reopen it.';
  if (a.via === 'cli') return `End that ${label} session (type /exit, or close its terminal) and start a new one.`;
  if (platform === 'darwin') {
    const menu = isDesktop ? 'Claude › Quit, or ⌘Q' : '⌘Q';
    return `Quit ${label} (${menu} — closing the window is not enough) and reopen it.${codeTab}`;
  }
  if (platform === 'win32') return `Quit ${label} fully (system tray → Quit) and reopen it.${codeTab}`;
  return `Quit ${label} and reopen it.${codeTab}`;
}

/**
 * One `ps` row → `{pid, ppid, startedAtMs, startedAt, command}`, or null.
 *
 * The row is `  <pid> <ppid> <dow> <mon> <day> <hh:mm:ss> <year> <command…>`.
 * Five whitespace-separated tokens of `lstart`, then the rest. `Date.parse`
 * reads `Fri Sep 18 10:10:34 2026` as LOCAL time, which is what `ps` prints —
 * verified against a real row (`1789719034000` = 2026-09-18T08:10:34Z on a
 * UTC+2 machine).
 *
 * An unparseable row is DROPPED rather than reported with a null time: a
 * process whose start time we cannot read cannot be called stale, and calling
 * it fresh would be the same guess in the other direction.
 */
export function parsePsRow(line) {
  const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line);
  if (!m) return null;
  const pid = Number(m[1]);
  const ppid = Number(m[2]);
  const at = Date.parse(m[3]);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(ppid) || !Number.isFinite(at)) return null;
  return { pid, ppid, startedAtMs: at, startedAt: new Date(at).toISOString(), command: m[4] };
}

/** One Windows row (`P|pid|ppid|isoUtc|exe|cmdline`) → the same shape, or null. */
export function parseWinRow(line) {
  if (typeof line !== 'string' || !line.startsWith('P|')) return null;
  const parts = line.replace(/\r$/, '').split('|');
  if (parts.length < 6) return null;
  const pid = Number(parts[1]);
  const ppid = Number(parts[2]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) return null;
  const at = parts[3] ? Date.parse(parts[3]) : NaN;
  return {
    pid, ppid,
    exe: parts[4] || '',
    startedAtMs: Number.isFinite(at) ? at : null,
    startedAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
    command: parts.slice(5).join('|'),
  };
}

/**
 * Does this command line launch THIS install's bridge?
 *
 * A substring test anchored at both ends to an ARGUMENT boundary, so a
 * checkout at `/w/curator` cannot match a process running `/w/curator-old`'s
 * server. It is deliberately a plain `indexOf` over the path rather than a
 * regex: the path comes from the filesystem and may contain any of `. ( ) [ ] +
 * *`, and building a pattern out of it is how a path becomes a program.
 *
 * Windows (`opts.windows`): the path may be QUOTED on the command line, so a
 * double quote is also a boundary, and the comparison ignores case (the file
 * system does).
 *
 * ONE KNOWN OVER-COUNT, stated: a shell running `grep …/mcp/server.js` matches.
 * It can inflate `running`; it writes no session line, so it reads `unknown`
 * with `olderThanCode: false` and therefore says nothing.
 */
export function commandMatches(command, serverPath, opts = {}) {
  if (typeof command !== 'string' || !serverPath) return false;
  const win = opts.windows === true;
  const hay = win ? command.toLowerCase() : command;
  const needle = win ? String(serverPath).toLowerCase() : serverPath;
  const boundary = (ch) => /\s/.test(ch) || (win && ch === '"');
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) return false;
    const before = i === 0 ? ' ' : hay[i - 1];
    const afterIdx = i + needle.length;
    const after = afterIdx >= hay.length ? ' ' : hay[afterIdx];
    if (boundary(before) && boundary(after)) return true;
    from = i + 1;
  }
}

function mtimeOf(file) {
  try { return statSync(file).mtimeMs; } catch { return null; }
}

/** `ps` (or PowerShell) as a promise. Never rejects — a failure comes back as `{error}`. */
function runProbe(psExec, file, args, opts) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      psExec(file, args, opts,
        (err, stdout) => finish(err && !stdout ? { error: err.message || String(err) } : { stdout: stdout || '' }));
    } catch (err) {
      finish({ error: err?.message || String(err) });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// The parent app
// ─────────────────────────────────────────────────────────────────────────

/** `Claude.app` → `claude-desktop`, from harness-detect's one bundle table. */
const BUNDLE_TO_ID = (() => {
  const m = new Map();
  for (const [id, bundles] of Object.entries(APP_BUNDLES)) for (const b of bundles) m.set(b, id);
  return m;
})();

/** `claude` → `claude-code`, `codex` → `codex`, … from each adapter's own CLI. */
const BIN_TO_ID = (() => {
  const m = new Map();
  for (const id of listHarnesses()) {
    let bin = null;
    try { bin = cliBinFor(id); } catch { bin = null; }
    if (bin && !m.has(bin)) m.set(bin, id);
  }
  return m;
})();

/** The Curator's own Mac bundle: a bridge under it is the self-test. */
const CURATOR_BUNDLE = 'The Curator.app';

/** Windows / Linux executables of the GUI apps, by lower-case base name. */
const EXE_TO_ID = Object.freeze({ cursor: 'cursor', antigravity: 'antigravity' });

function labelOf(id) {
  try { return adapterFor(id)?.label || id; } catch { return id; }
}

/** The first `<Name>.app/Contents/` in a command line, or null. */
export function bundleOf(command) {
  if (typeof command !== 'string') return null;
  const m = /\/([^/]+\.app)\/Contents\//.exec(command);
  return m ? m[1] : null;
}

/**
 * Base names of the first two argv tokens (the program, and a script a
 * runtime runs). CASE-SENSITIVE, and a token inside an app bundle is never a
 * CLI: Claude Desktop's own binary is `Claude.app/Contents/MacOS/Claude`,
 * whose base name lower-cased is the Claude Code CLI's `claude` (caught by
 * this suite's fixture, 2026-11-01).
 */
function argvBases(command) {
  if (typeof command !== 'string') return [];
  return command.trim().split(/\s+/).slice(0, 2)
    .map((t) => t.replace(/^"|"$/g, ''))
    .filter((t) => !/\.app\/Contents\//.test(t))
    .map((t) => path.posix.basename(t));
}

/**
 * One process → the app it IS, or null when it is neither a known bundle nor
 * a known vendor CLI (an intermediate: a shell, a helper, a launcher).
 *
 * The bridge's OWN row is never passed here — on a Mac-app install the bridge
 * itself is `The Curator.app/Contents/MacOS/The Curator`, which is a bundle.
 */
function appOfProcess(row, platform) {
  if (!row) return null;
  if (platform === 'win32') {
    const exe = row.exe || '';
    if (isClaudeDesktopExe(exe)) return { id: 'claude-desktop', label: labelOf('claude-desktop'), via: 'app' };
    const b = path.win32.basename(exe).toLowerCase().replace(/\.exe$/, '');
    if (EXE_TO_ID[b]) return { id: EXE_TO_ID[b], label: labelOf(EXE_TO_ID[b]), via: 'app' };
    if (b && BIN_TO_ID.has(b)) return { id: BIN_TO_ID.get(b), label: labelOf(BIN_TO_ID.get(b)), via: 'cli' };
    return null;
  }
  // A vendor CLI first: `claude` running in Cursor's terminal is Claude Code,
  // not Cursor, and its row is reached before Cursor's in the walk anyway.
  for (const b of argvBases(row.command)) {
    if (BIN_TO_ID.has(b)) return { id: BIN_TO_ID.get(b), label: labelOf(BIN_TO_ID.get(b)), via: 'cli' };
  }
  if (platform === 'darwin') {
    const bundle = bundleOf(row.command);
    // The Curator's own Mac app spawning a bridge is its self-test (the
    // `Test all` runner), never an agent app — measured 2026-11-01: a run
    // from the installed app read as "another app" until this line.
    if (bundle === CURATOR_BUNDLE) return { id: null, label: 'The Curator (self-test)', via: 'self-test', selfTest: true };
    if (bundle) {
      const id = BUNDLE_TO_ID.get(bundle) || null;
      return { id, label: id ? labelOf(id) : 'another app', via: 'app', bundle };
    }
    return null;
  }
  const b = argvBases(row.command)[0];
  if (b && EXE_TO_ID[b]) return { id: EXE_TO_ID[b], label: labelOf(EXE_TO_ID[b]), via: 'app' };
  return null;
}

/**
 * Walk up from a bridge's PARENT to the first process that is an app (at most
 * MAX_ANCESTORS steps). Returns `{id, label, via, checked}`:
 *
 *   checked: false → the chain broke before anything was found (a parent not
 *                    in the table); label "an app", id null.
 *   id: null       → the chain was walked and ended (launchd, pid 1, a loop,
 *                    an unknown bundle) without a known app — "another app".
 *
 * `selfPid` is the web server's own pid: a bridge this process spawned is the
 * self-test, never an agent app's.
 */
export function parentAppFor(row, table, platform, selfPid = process.pid) {
  let cur = row;
  const seen = new Set();
  for (let i = 0; i < MAX_ANCESTORS; i++) {
    const ppid = cur && cur.ppid;
    if (!Number.isInteger(ppid) || ppid <= 1) break;
    if (ppid === selfPid) return { id: null, label: 'The Curator (self-test)', via: 'self-test', checked: true, selfTest: true };
    if (seen.has(ppid)) break;
    seen.add(ppid);
    const parent = table.get(ppid);
    if (!parent) return { id: null, label: 'an app', via: null, checked: false };
    const app = appOfProcess(parent, platform);
    if (app) return { ...app, checked: true };
    cur = parent;
  }
  return { id: null, label: 'another app', via: null, checked: true };
}

// ─────────────────────────────────────────────────────────────────────────
// What the code on disk serves
// ─────────────────────────────────────────────────────────────────────────

let _current = null;

/**
 * The version and tool-list signature of the code ON DISK — the same two
 * facts a bridge writes about itself. The tool modules are imported LAZILY,
 * only when a status is asked for, never at app start, and nothing they load
 * writes to stdout. Cached for the process's life: an update restarts the app.
 */
export async function currentBridgeIdentity() {
  if (_current) return _current;
  let version = null;
  try { version = JSON.parse(readFileSync(appPath('package.json'), 'utf8')).version || null; } catch { version = null; }
  let toolsHash = null;
  let toolCount = null;
  try {
    const [{ tools }, { toolSignature }] = await Promise.all([
      import('../../mcp/tools/index.js'),
      import('../../mcp/tool-signature.js'),
    ]);
    const defs = tools.map((t) => t.definition);
    toolsHash = toolSignature(defs);
    toolCount = defs.length;
  } catch { /* left null: every bridge then reads `unknown`, never `same` */ }
  _current = { version, toolsHash, toolCount };
  return _current;
}

/**
 * The identity a bridge wrote about itself, joined BY PID. Only a session line
 * written at or after the process started (one second of slack: `lstart` has
 * one-second resolution) can belong to it, so a REUSED pid never inherits a
 * dead bridge's line. The newest line carrying a signature wins.
 */
export function identityFor(row, sessions) {
  if (!row || !Array.isArray(sessions)) return { version: null, toolsHash: null, client: null };
  const floor = Number.isFinite(row.startedAtMs) ? row.startedAtMs - 1000 : -Infinity;
  let best = null;
  let client = null;
  let clientAt = -Infinity;
  for (const s of sessions) {
    if (!s || s.pid !== row.pid || !Number.isFinite(s.at) || s.at < floor) continue;
    if (s.tsig && (!best || s.at >= best.at)) best = s;
    if (s.client && s.at >= clientAt) { client = s.client; clientAt = s.at; }
  }
  return { version: best ? best.v || null : null, toolsHash: best ? best.tsig : null, client };
}

/** `same | different | unknown` — by signature only. */
export function classifyTools(bridgeHash, currentHash) {
  if (!bridgeHash || !currentHash) return 'unknown';
  return bridgeHash === currentHash ? 'same' : 'different';
}

/**
 * What the page says about one bridge. Decided HERE so no view re-derives it:
 *
 *   warn  — its tools differ (proven). A loud line on the app's row, with the remedy.
 *   soft  — unknown, and it started before the code on disk changed (or that
 *           cannot be told). One soft warning, with the remedy.
 *   quiet — same tools, but another (or an unknown) version. One quiet line.
 *   none  — nothing to say.
 */
export function noticeFor({ tools, version, olderThanCode, selfTest }, current) {
  if (selfTest) return 'none';
  if (tools === 'different') return 'warn';
  if (tools === 'unknown') return olderThanCode === false ? 'none' : 'soft';
  return version && current && version === current.version ? 'none' : 'quiet';
}

const NOTICE_RANK = Object.freeze({ none: 0, quiet: 1, soft: 2, warn: 3 });

/**
 * Per app: the bridges whose parent is that app, summarised for its row. The
 * worst notice wins; its bridge supplies the version, tools and remedy.
 */
export function bridgesByApp(bridges) {
  const out = {};
  const rank = {};
  for (const b of Array.isArray(bridges) ? bridges : []) {
    const id = b && b.app && b.app.id;
    if (!id) continue;
    const r = NOTICE_RANK[b.notice] || 0;
    const cur = out[id];
    if (!cur) {
      out[id] = { count: 1, notice: b.notice, oldestStartedAt: b.startedAt, version: b.version, tools: b.tools, remedy: b.remedy };
      rank[id] = r;
      continue;
    }
    cur.count += 1;
    if (b.startedAt && (!cur.oldestStartedAt || b.startedAt < cur.oldestStartedAt)) cur.oldestStartedAt = b.startedAt;
    if (r > rank[id]) {
      Object.assign(cur, { notice: b.notice, version: b.version, tools: b.tools, remedy: b.remedy });
      rank[id] = r;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// The reading
// ─────────────────────────────────────────────────────────────────────────

async function readTable(platform, deps) {
  const psExec = deps.execFile || execFile;
  if (platform === 'win32') {
    if (!deps.execFile && probesDisabled()) return { error: 'probes disabled under test' };
    const res = await runProbe(psExec, powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', WIN_PROCS_SCRIPT],
      { timeout: WIN_PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, encoding: 'utf8', windowsHide: true });
    if (res.error) return res;
    return { rows: String(res.stdout).split('\n').map(parseWinRow).filter(Boolean) };
  }
  const args = platform === 'linux' ? PS_ARGS_LINUX : PS_ARGS;
  const res = await runProbe(psExec, 'ps', args, { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, encoding: 'utf8' });
  if (res.error) return res;
  return { rows: String(res.stdout).split('\n').filter((l) => l.trim()).map(parsePsRow).filter(Boolean) };
}

async function readSessions(deps) {
  if (Array.isArray(deps.sessions)) return deps.sessions;
  try {
    const u = await readUsageLinesUnion();
    return (u.records || []).filter((r) => r && r.ev === 'session' && Number.isInteger(r.pid));
  } catch { return []; }
}

/**
 * Bridge processes launched from THIS install: which app started each, and
 * whether each serves the tool list on disk.
 *
 *   {
 *     checked,          // false = we did not look. NEVER read as "none".
 *     reason,           // why not, when checked is false; null otherwise
 *     running,          // how many bridges from this install are alive
 *     stale: [{pid, startedAt, ageMs}],   // v3.88.0: ONLY tools "different"
 *     codeChangedAt,    // the newer mtime of server.js / package.json (a fact)
 *     serverPath,       // what was matched — so a report can show its work
 *     current: {version, toolsHash, toolCount},   // the code on disk
 *     bridges: [{pid, startedAt, ageMs, app, client, version, toolsHash,
 *                tools, olderThanCode, notice, remedy}],
 *   }
 *
 * `deps` is the TEST-ONLY seam: the suite MUST NOT read a real process list,
 * because the answer would depend on what the maintainer happens to have
 * open, and a guard whose expected value moves is not a guard. `execFile`,
 * `sessions`, `current`, `selfPid`, `now`, the mtimes and the platform are
 * all injectable.
 */
export async function detectBridgeProcesses(deps = {}) {
  const platform = deps.platform || process.platform;
  const serverPath = deps.serverPath || appPath('mcp', 'server.js');
  const packageJsonPath = deps.packageJsonPath || appPath('package.json');
  const base = { running: 0, stale: [], codeChangedAt: null, serverPath, current: null, bridges: [] };

  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    return { ...base, checked: false, reason: `the process listing is not read on "${platform}".` };
  }

  const serverMtime = deps.serverMtimeMs !== undefined ? deps.serverMtimeMs : mtimeOf(serverPath);
  const pkgMtime = deps.packageMtimeMs !== undefined ? deps.packageMtimeMs : mtimeOf(packageJsonPath);
  const codeAt = Math.max(serverMtime || 0, pkgMtime || 0) || null;
  base.codeChangedAt = codeAt ? new Date(codeAt).toISOString() : null;

  let current;
  try { current = deps.current || await currentBridgeIdentity(); } catch { current = { version: null, toolsHash: null, toolCount: null }; }
  base.current = current;

  const res = await readTable(platform, deps);
  if (res.error) {
    return { ...base, checked: false, reason: `the process listing could not be read (${res.error}).` };
  }

  const table = new Map(res.rows.map((r) => [r.pid, r]));
  const sessions = await readSessions(deps);
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const selfPid = Number.isInteger(deps.selfPid) ? deps.selfPid : process.pid;
  const windows = platform === 'win32';
  const bridges = [];
  for (const row of res.rows) {
    if (!commandMatches(row.command, serverPath, { windows })) continue;
    const app = parentAppFor(row, table, platform, selfPid);
    const id = identityFor(row, sessions);
    const tools = classifyTools(id.toolsHash, current && current.toolsHash);
    const olderThanCode = codeAt && Number.isFinite(row.startedAtMs) ? row.startedAtMs < codeAt : null;
    const notice = noticeFor({ tools, version: id.version, olderThanCode, selfTest: app.selfTest === true }, current);
    bridges.push({
      pid: row.pid,
      startedAt: row.startedAt,
      ageMs: Number.isFinite(row.startedAtMs) ? Math.max(0, now - row.startedAtMs) : null,
      app: { id: app.id, label: app.label, via: app.via, checked: app.checked, ...(app.bundle ? { bundle: app.bundle } : {}) },
      client: id.client,
      version: id.version,
      toolsHash: id.toolsHash,
      tools,
      olderThanCode,
      notice,
      remedy: notice === 'warn' || notice === 'soft' ? staleRemedyFor(app, platform) : null,
    });
  }
  // Oldest first: the one a reader most wants named is the one that has been
  // wrong the longest.
  bridges.sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
  const stale = bridges.filter((b) => b.tools === 'different')
    .map((b) => ({ pid: b.pid, startedAt: b.startedAt, ageMs: b.ageMs }));
  return { ...base, checked: true, reason: null, running: bridges.length, stale, bridges };
}
