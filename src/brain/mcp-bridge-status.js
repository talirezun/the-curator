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
 * Non-macOS is one of those failures, deliberately: `ps -axo lstart=` is a BSD
 * spelling. It exists on Linux too and would very likely work, but "very
 * likely" is not a measurement, and this release has measured exactly one
 * platform. A Linux user gets `checked: false` with the reason, not a silent
 * wrong answer.
 *
 * ── WHAT MAKES A BRIDGE STALE ──────────────────────────────────────────────
 *
 * Its start time predates the NEWER of `mcp/server.js`'s and `package.json`'s
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
import { statSync } from 'node:fs';
import path from 'node:path';
import { appPath } from './paths.js';

/** `ps` is given this long before it is abandoned. It answers in ~15 ms. */
export const PS_TIMEOUT_MS = 3000;

/** A `ps` table larger than this is not a machine we can report honestly on. */
export const PS_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The fixed argv. `pid=`, `lstart=` and `command=` each suppress their own
 * header (that is what the trailing `=` means), so the output is pure rows and
 * a header line can never be parsed as a process.
 *
 * `-ax`, not `-e`: `-e` is the System V spelling and macOS's `ps` accepts it,
 * but `-ax` is the BSD one this platform documents. `command=` must come LAST
 * — it is the only field that contains spaces, so everything after the fifth
 * `lstart` token is the command and the parse needs no quoting rules at all.
 */
export const PS_ARGS = Object.freeze(['-axo', 'pid=,lstart=,command=']);

/**
 * The remedy sentence. ONE constant, because the route, the bridge page and
 * `doctor` all say it and three hand-written copies of one instruction is the
 * drift shape this repository records most often.
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
 * One `ps` row → `{pid, startedAt, command}`, or null.
 *
 * The row is `  <pid> <dow> <mon> <day> <hh:mm:ss> <year> <command…>`. Five
 * whitespace-separated tokens of `lstart`, then the rest. `Date.parse` reads
 * `Fri Sep 18 10:10:34 2026` as LOCAL time, which is what `ps` prints —
 * verified against a real row (`1789719034000` = 2026-09-18T08:10:34Z on a
 * UTC+2 machine).
 *
 * An unparseable row is DROPPED rather than reported with a null time: a
 * process whose start time we cannot read cannot be called stale, and calling
 * it fresh would be the same guess in the other direction.
 */
export function parsePsRow(line) {
  const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line);
  if (!m) return null;
  const pid = Number(m[1]);
  const at = Date.parse(m[2]);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(at)) return null;
  return { pid, startedAtMs: at, startedAt: new Date(at).toISOString(), command: m[3] };
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
 * ONE KNOWN OVER-COUNT, stated: a shell running `grep …/mcp/server.js` matches.
 * It would have to have been started before the last update to be called
 * stale, which a grep never is, so it can inflate `running` and never `stale`.
 * Not special-cased — the alternative is a list of program names to exclude,
 * which is a second table to maintain for a case nobody has hit.
 */
export function commandMatches(command, serverPath) {
  if (typeof command !== 'string' || !serverPath) return false;
  let from = 0;
  for (;;) {
    const i = command.indexOf(serverPath, from);
    if (i === -1) return false;
    const before = i === 0 ? ' ' : command[i - 1];
    const afterIdx = i + serverPath.length;
    const after = afterIdx >= command.length ? ' ' : command[afterIdx];
    if (/\s/.test(before) && /\s/.test(after)) return true;
    from = i + 1;
  }
}

function mtimeOf(file) {
  try { return statSync(file).mtimeMs; } catch { return null; }
}

/** `ps` as a promise. Never rejects — a failure comes back as `{error}`. */
function runPs(psExec) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      psExec('ps', PS_ARGS, { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, encoding: 'utf8' },
        (err, stdout) => finish(err && !stdout ? { error: err.message || String(err) } : { stdout: stdout || '' }));
    } catch (err) {
      finish({ error: err?.message || String(err) });
    }
  });
}

/**
 * Bridge processes launched from THIS install, and which of them predate its
 * current code.
 *
 *   {
 *     checked,          // false = we did not look. NEVER read as "none".
 *     reason,           // why not, when checked is false; null otherwise
 *     running,          // how many bridges from this install are alive
 *     stale: [{pid, startedAt, ageMs}],
 *     codeChangedAt,    // the ISO time the comparison is made against
 *     serverPath,       // what was matched — so a report can show its work
 *   }
 *
 * `deps` is the TEST-ONLY seam, the same shape and for the same reason as
 * `compileConversation`'s `opts.generateText`: the suite MUST NOT read a real
 * process list, because the answer would depend on what the maintainer happens
 * to have open, and a guard whose expected value moves is not a guard. Every
 * arm below — a stale bridge, a fresh one, both at once, a missing `ps`, an
 * unparseable table — is driven through a fake `execFile`.
 */
export async function detectBridgeProcesses(deps = {}) {
  const platform = deps.platform || process.platform;
  const serverPath = deps.serverPath || appPath('mcp', 'server.js');
  const packageJsonPath = deps.packageJsonPath || appPath('package.json');
  const base = { running: 0, stale: [], codeChangedAt: null, serverPath };

  if (platform !== 'darwin') {
    return {
      ...base,
      checked: false,
      reason: `the process listing is only measured on macOS; this machine reports "${platform}".`,
    };
  }

  const serverMtime = deps.serverMtimeMs !== undefined ? deps.serverMtimeMs : mtimeOf(serverPath);
  const pkgMtime = deps.packageMtimeMs !== undefined ? deps.packageMtimeMs : mtimeOf(packageJsonPath);
  const codeAt = Math.max(serverMtime || 0, pkgMtime || 0);
  if (!codeAt) {
    return {
      ...base,
      checked: false,
      reason: `neither ${path.basename(serverPath)} nor package.json could be read, so there is nothing to compare a start time against.`,
    };
  }
  base.codeChangedAt = new Date(codeAt).toISOString();

  const res = await runPs(deps.execFile || execFile);
  if (res.error) {
    return { ...base, checked: false, reason: `the process listing could not be read (${res.error}).` };
  }

  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const running = [];
  const stale = [];
  for (const line of String(res.stdout).split('\n')) {
    if (!line.trim()) continue;
    const row = parsePsRow(line);
    if (!row || !commandMatches(row.command, serverPath)) continue;
    running.push(row);
    if (row.startedAtMs < codeAt) {
      stale.push({ pid: row.pid, startedAt: row.startedAt, ageMs: Math.max(0, now - row.startedAtMs) });
    }
  }
  // Oldest first: the one a reader most wants named is the one that has been
  // wrong the longest.
  stale.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return { ...base, checked: true, reason: null, running: running.length, stale };
}
