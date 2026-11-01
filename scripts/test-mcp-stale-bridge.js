#!/usr/bin/env node
/**
 * OFFLINE — the stale-bridge reading (v3.64.0): detection, the route field,
 * the two notes on the bridge page, and `doctor`'s section.
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * On 2026-09-20 the maintainer's Mac was running a `my-curator` bridge that
 * Claude Desktop had spawned on 2026-09-18 and never restarted. It survived
 * five in-app updates and was still serving pre-v3.59.0 code — 22 tools, no
 * `get_project_context`, no `save_foundation` — while the files on disk were
 * v3.63.0. Every surface the app has said the install was healthy, correctly:
 * the pill reads the SAVED launch line, the self-test spawns a FRESH child.
 * Neither can see a long-lived process, and the process's parent is the
 * client, not The Curator, so the app can only report it.
 *
 * FOUR THINGS CAN GO WRONG, and three of them are silent:
 *
 *   1. A FALSE NEGATIVE THAT LOOKS LIKE A CLEAN BILL. `checked: false` means
 *      "we did not look". If anything downstream renders that as "no stale
 *      bridge", the app makes a claim it has no basis for — the same defect
 *      `mcp-usage.js` avoids with "not used since this log began". §1 and §3
 *      drive every refusal arm and require the consumers to stay silent.
 *   2. A FALSE POSITIVE. Telling a user to restart Claude Desktop for nothing
 *      costs the reading its credibility on the day it is right. §2 drives a
 *      bridge started one second AFTER the code changed and requires `fresh`.
 *   3. A PATH BECOMING A PROGRAM. This is the only place in the app that
 *      reads a process list. §5 proves the argv is a fixed array, that no
 *      shell is reachable, and that a directory whose name contains regex
 *      metacharacters still matches exactly.
 *   4. A REAL `ps` IN A TEST. The answer would depend on what the maintainer
 *      had open, so a guard's expected value would move — which is not a
 *      guard. Every arm here injects a FAKE `execFile` through the deps seam,
 *      and §6 proves the real one is never reached by failing the injected
 *      call outright.
 *
 * The one-shot check against the REAL process table was taken by hand during
 * development and is recorded in the release row, not here.
 *
 * SAFETY — reads nothing of the user's, spawns nothing, writes nothing. The
 * `doctor` arm redirects user data to a mkdtemp through
 * `CURATOR_TEST_USER_DATA_DIR`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
};
const eq = (a, b, label) => ok(a === b, `${label}${a === b ? '' : `\n        expected: ${JSON.stringify(b)}\n        actual:   ${JSON.stringify(a)}`}`);
const section = (t) => console.log(`\n${t}`);

const t0 = Date.now();

const B = await import(path.join(ROOT, 'src/brain/mcp-bridge-status.js'));

// ── The fake process table ─────────────────────────────────────────────────
//
// Byte-shaped like real `ps -axo pid=,ppid=,lstart=,command=` output on macOS,
// including the leading column padding and the five-token `lstart`. The
// chain is the one measured on 2026-11-01: each of Claude Desktop's bridges
// is a child of Claude.app's `Helpers/disclaimer`, whose parent is
// `Claude.app/Contents/MacOS/Claude` — and the bridge itself is ALSO inside a
// bundle (`The Curator.app`), which is why the walk starts at the parent.
const SERVER = '/Applications/The Curator.app/Contents/Resources/app/mcp/server.js';
const NODE = '/Applications/The Curator.app/Contents/MacOS/The Curator';
const CLAUDE = '/Applications/Claude.app/Contents/MacOS/Claude';
const DISCLAIMER = '/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /Users/x/Library/Application Support/The Curator/bin/my-curator-mcp';
const psRow = (pid, ppid, when, command) => `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${when} ${command}`;
const REAL_TABLE = [
  psRow(1, 0, 'Mon Sep  1 09:00:00 2026', '/sbin/launchd'),
  psRow(29000, 1, 'Fri Sep 18 10:10:00 2026', CLAUDE),
  psRow(29120, 29000, 'Fri Sep 18 10:10:34 2026', DISCLAIMER),
  psRow(29123, 29120, 'Fri Sep 18 10:10:34 2026', `${NODE} ${SERVER}`),
  psRow(97320, 29000, 'Sun Sep 20 08:54:17 2026', DISCLAIMER),
  psRow(97330, 97320, 'Sun Sep 20 08:54:17 2026', `${NODE} ${SERVER}`),
  psRow(4242, 1, 'Sun Sep 20 08:00:00 2026', '/usr/bin/node /somewhere/else/mcp/server.js'),
].join('\n') + '\n';

/** A fake `execFile` that answers `ps` with `stdout`, or fails with `err`. */
function fakePs({ stdout, err, spy }) {
  return (file, args, opts, cb) => {
    if (spy) spy.push({ file, args, opts });
    setImmediate(() => (err ? cb(new Error(err), '') : cb(null, stdout)));
  };
}

const CODE_AT = Date.parse('Sat Sep 19 13:48:42 2026');   // the .app's mtime
const NOW = Date.parse('Sun Sep 20 09:20:00 2026');
const CURRENT = { version: '3.88.0', toolsHash: 'aaaa1111', toolCount: 24 };
/** A session line as `parseLines` returns it. */
const sess = (pid, when, tsig, v = '3.88.0', client = 'claude-desktop') => ({ ev: 'session', pid, at: Date.parse(when), tsig, v, client });

const baseDeps = {
  platform: 'darwin',
  serverPath: SERVER,
  serverMtimeMs: CODE_AT,
  packageMtimeMs: CODE_AT - 1000,
  now: NOW,
  current: CURRENT,
  sessions: [],
  selfPid: 999999,
};

// ─────────────────────────────────────────────────────────────────────────
section('§1  The real table — two bridges, both Claude Desktop\'s, classified by SIGNATURE');
// ─────────────────────────────────────────────────────────────────────────
{
  const spy = [];
  // 29123: started before the code changed, serves the SAME tools (an older
  // version). 97330: started after it, serves a DIFFERENT tool list.
  const sessions = [
    sess(29123, 'Fri Sep 18 10:10:35 2026', CURRENT.toolsHash, '3.86.0'),
    sess(97330, 'Sun Sep 20 08:54:18 2026', 'bbbb2222', '3.87.1', 'other'),
  ];
  const r = await B.detectBridgeProcesses({ ...baseDeps, sessions, execFile: fakePs({ stdout: REAL_TABLE, spy }) });
  eq(r.checked, true, 'the reading was taken');
  eq(r.reason, null, '…with no reason, because nothing refused');
  eq(r.running, 2, 'both bridges launched from THIS install are counted');
  const [a, b] = r.bridges;
  eq(a.pid, 29123, 'oldest first');
  eq(a.app.id, 'claude-desktop', 'the walk from the bridge\'s PARENT (disclaimer) reaches Claude.app → Claude Desktop');
  eq(a.app.label, 'Claude Desktop', '…by the adapter\'s own label');
  eq(a.tools, 'same', 'its signature equals the code on disk → "same", although it predates the code (the v3.87 false alarm)');
  eq(a.olderThanCode, true, '…the mtime fact is still reported, as a fact');
  eq(a.notice, 'quiet', '…so it gets ONE quiet line (older version, same tools) — never a warning');
  eq(a.remedy, null, '…and no remedy');
  eq(a.version, '3.86.0', '…naming the version it was started from');
  eq(b.tools, 'different', 'a different signature → "different", although it STARTED AFTER the code changed');
  eq(b.notice, 'warn', '…which is the only warning');
  eq(b.client, 'other', '…and its own client label rides along (Claude Desktop\'s Code tab reads `other`)');
  ok(/^Quit Claude Desktop \(Claude › Quit, or ⌘Q — closing the window is not enough\) and reopen it\. This also ends Claude Code sessions in its Code tab\.$/.test(b.remedy),
    '…with the remedy naming the app, the exact quit step, and what the quit costs', b.remedy);
  eq(r.stale.length, 1, '`stale` (the old field) now lists ONLY the proven-different bridge');
  eq(r.stale[0].pid, 97330, '…by pid');
  eq(JSON.stringify(Object.keys(r.stale[0])), JSON.stringify(['pid', 'startedAt', 'ageMs']), '…in its old shape, so old readers still work');
  eq(r.codeChangedAt, new Date(CODE_AT).toISOString(), 'the mtime point is still disclosed');
  eq(r.serverPath, SERVER, '…and so is what was matched');
  eq(JSON.stringify(r.current), JSON.stringify(CURRENT), 'and what the code on disk serves');

  const other = await B.detectBridgeProcesses({
    ...baseDeps, serverPath: '/somewhere/else/mcp/server.js', execFile: fakePs({ stdout: REAL_TABLE }),
  });
  eq(other.running, 1, 'a different install sees only ITS own bridge');
  eq(other.bridges[0].app.label, 'another app', '…whose parent (launchd) is no app');

  eq(spy.length, 1, 'ps was run exactly once');
  eq(spy[0].file, 'ps', '…as the program `ps`');
  eq(JSON.stringify(spy[0].args), JSON.stringify(['-axo', 'pid=,ppid=,lstart=,command=']),
    '…with the fixed argv ARRAY, ppid included — no shell, nothing interpolated');
  ok(spy[0].opts && spy[0].opts.timeout > 0, '…under a timeout, so a wedged ps cannot hang a route');

  const byApp = B.bridgesByApp(r.bridges);
  eq(byApp['claude-desktop'].count, 2, 'per app: both bridges belong to Claude Desktop');
  eq(byApp['claude-desktop'].notice, 'warn', '…and the WORST notice is the app\'s');
  eq(byApp['claude-desktop'].oldestStartedAt, a.startedAt, '…with the oldest start');
}

// ─────────────────────────────────────────────────────────────────────────
section('§2  Unknown, pid reuse, and the mtime used for ONE decision only');
// ─────────────────────────────────────────────────────────────────────────
{
  // No session line at all: a bridge started before v3.88.0.
  const r = await B.detectBridgeProcesses({ ...baseDeps, execFile: fakePs({ stdout: REAL_TABLE }) });
  eq(r.bridges[0].tools, 'unknown', 'no signature → "unknown", never "same"');
  eq(r.bridges[0].notice, 'soft', '…and started before the code changed → ONE soft warning');
  ok(/^Quit Claude Desktop/.test(r.bridges[0].remedy), '…which carries the remedy');
  eq(r.bridges[1].notice, 'none', 'unknown but started AFTER the code changed → nothing (it loaded the files on disk)');
  eq(r.stale.length, 0, 'unknown is never in `stale`: only a PROVEN difference is');

  // A REUSED pid: a line written by a dead process with the same pid, BEFORE
  // this one started, must not be inherited.
  const reused = await B.detectBridgeProcesses({
    ...baseDeps, execFile: fakePs({ stdout: REAL_TABLE }),
    sessions: [sess(97330, 'Sat Sep 19 07:00:00 2026', 'bbbb2222')],
  });
  eq(reused.bridges[1].tools, 'unknown', 'a session line older than the process is a DEAD process\'s — not joined');
  eq(reused.stale.length, 0, '…so no false "different"');
  // …and the newest signature-bearing line of the live process wins.
  const two = await B.detectBridgeProcesses({
    ...baseDeps, execFile: fakePs({ stdout: REAL_TABLE }),
    sessions: [sess(97330, 'Sun Sep 20 08:54:18 2026', 'bbbb2222'), sess(97330, 'Sun Sep 20 09:00:00 2026', CURRENT.toolsHash, '3.88.0')],
  });
  eq(two.bridges[1].tools, 'same', 'the NEWEST line with a signature wins');
  eq(two.bridges[1].notice, 'none', 'same tools and the same version → nothing to say');

  // The code on disk could not be signed: every bridge is unknown, never same.
  const noCur = await B.detectBridgeProcesses({
    ...baseDeps, current: { version: null, toolsHash: null, toolCount: null }, execFile: fakePs({ stdout: REAL_TABLE }),
    sessions: [sess(29123, 'Fri Sep 18 10:10:35 2026', 'aaaa1111')],
  });
  eq(noCur.bridges[0].tools, 'unknown', 'with no current signature, a bridge\'s signature proves nothing → unknown');

  eq(B.classifyTools('aaaa1111', 'aaaa1111'), 'same', 'classifyTools: equal → same');
  eq(B.classifyTools('aaaa1111', 'bbbb2222'), 'different', 'classifyTools: unequal → different');
  eq(B.classifyTools(null, 'bbbb2222'), 'unknown', 'classifyTools: missing → unknown');
}

// ─────────────────────────────────────────────────────────────────────────
section('§3  Every refusal answers `checked: false` with an EMPTY stale list');
// ─────────────────────────────────────────────────────────────────────────
{
  const arms = [
    ['a platform the listing is not read on',
      { ...baseDeps, platform: 'freebsd', execFile: fakePs({ stdout: REAL_TABLE }) }, 'freebsd'],
    ['ps missing or refusing',
      { ...baseDeps, execFile: fakePs({ err: 'spawn ps ENOENT' }) }, 'ENOENT'],
  ];
  for (const [label, deps, needle] of arms) {
    const r = await B.detectBridgeProcesses(deps);
    eq(r.checked, false, `${label} → checked false`);
    eq(r.running, 0, '…running 0');
    eq(r.stale.length, 0, '…stale empty');
    eq(r.bridges.length, 0, '…bridges empty');
    ok(typeof r.reason === 'string' && r.reason.includes(needle),
      `…and a reason naming ${needle} (${JSON.stringify(r.reason)})`);
  }
  // Neither mtime readable is no longer a refusal: the signature does the
  // classifying. `olderThanCode` is then null, and an unknown bridge warns softly.
  const noMtime = await B.detectBridgeProcesses({ ...baseDeps, serverMtimeMs: null, packageMtimeMs: null, execFile: fakePs({ stdout: REAL_TABLE }) });
  eq(noMtime.checked, true, 'no readable mtime → still checked (the classification no longer needs one)');
  eq(noMtime.codeChangedAt, null, '…with no comparison point disclosed');
  eq(noMtime.bridges[0].olderThanCode, null, '…and olderThanCode null, not false');
  eq(noMtime.bridges[0].notice, 'soft', '…so an unknown bridge still gets its one soft warning');

  const thrown = await B.detectBridgeProcesses({
    ...baseDeps, execFile: () => { throw new Error('spawning is not permitted here'); },
  });
  eq(thrown.checked, false, 'a synchronous throw from execFile refuses rather than rejecting');
  ok(thrown.reason.includes('not permitted'), '…naming what happened');
}

// ─────────────────────────────────────────────────────────────────────────
section('§4  The parser — junk in, nothing out');
// ─────────────────────────────────────────────────────────────────────────
{
  ok(B.parsePsRow('') === null, 'an empty line is not a process');
  ok(B.parsePsRow('  PID  PPID STARTED COMMAND') === null, 'a header row is not a process');
  ok(B.parsePsRow('   123   1 not a date at all /bin/thing') === null,
    'a row whose start time cannot be read is DROPPED, never reported with a guessed time');
  ok(B.parsePsRow('     0     1 Fri Sep 18 10:10:34 2026 /bin/x') === null, 'pid 0 is refused');
  ok(B.parsePsRow('    42 Fri Sep 18 10:10:34 2026 /bin/x') === null, 'a row without a ppid column is refused');
  const good = B.parsePsRow(psRow(42, 7, 'Fri Sep 18 10:10:34 2026', '/bin/x --with args'));
  eq(good.pid, 42, 'a good row yields its pid');
  eq(good.ppid, 7, '…its parent');
  eq(good.command, '/bin/x --with args', '…and the whole command, spaces and all');

  const garbage = await B.detectBridgeProcesses({
    ...baseDeps, execFile: fakePs({ stdout: 'not\na ps\ntable at all\n' }),
  });
  eq(garbage.checked, true, 'an unparseable table is still a reading that was TAKEN');
  eq(garbage.running, 0, '…answering zero, because no row parsed');
}

// ─────────────────────────────────────────────────────────────────────────
section('§4b The parent walk — CLI before bundle, the self-test, a broken chain, a loop');
// ─────────────────────────────────────────────────────────────────────────
{
  const t = (rows) => new Map(rows.map((r) => [r.pid, r]));
  const row = (pid, ppid, command) => ({ pid, ppid, command, startedAtMs: 0 });
  // Claude Code in Cursor's terminal: claude → zsh → Cursor.app. The CLI is
  // reached first, so it is Claude Code, not Cursor.
  const cli = t([row(10, 1, '/Applications/Cursor.app/Contents/MacOS/Cursor'), row(11, 10, '/bin/zsh -l'), row(12, 11, 'claude --resume'), row(13, 12, `${NODE} ${SERVER}`)]);
  const a = B.parentAppFor(cli.get(13), cli, 'darwin', 999);
  eq(a.id, 'claude-code', 'a `claude` CLI ancestor is Claude Code');
  eq(a.via, 'cli', '…started from a terminal');
  eq(B.staleRemedyFor(a, 'darwin'), 'End that Claude Code session (type /exit, or close its terminal) and start a new one.',
    '…and its remedy is to end THAT session, not to quit an app');
  // `node …/bin/claude` (an npm install) is the same CLI.
  const npm = t([row(20, 1, '/usr/local/bin/node /usr/local/bin/claude'), row(21, 20, `${NODE} ${SERVER}`)]);
  eq(B.parentAppFor(npm.get(21), npm, 'darwin', 999).id, 'claude-code', 'a runtime running the `claude` script is the CLI too');
  const cur = t([row(30, 1, '/Applications/Cursor.app/Contents/MacOS/Cursor'), row(31, 30, '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)'), row(32, 31, `${NODE} ${SERVER}`)]);
  const c = B.parentAppFor(cur.get(32), cur, 'darwin', 999);
  eq(c.id, 'cursor', 'the FIRST `.app/Contents/` is the outer bundle — Cursor, not its helper');
  eq(B.staleRemedyFor(c, 'darwin'), 'Quit Cursor (⌘Q — closing the window is not enough) and reopen it.', '…and its remedy has no Code-tab clause');
  // The self-test: a bridge spawned by this very process, or by The Curator's own bundle.
  const self = t([row(40, 1, 'node src/server.js'), row(41, 40, `${NODE} ${SERVER}`)]);
  ok(B.parentAppFor(self.get(41), self, 'darwin', 40).selfTest === true, 'a bridge whose parent is THIS process is the self-test');
  const app = t([row(50, 1, NODE), row(51, 50, `${NODE} ${SERVER}`)]);
  ok(B.parentAppFor(app.get(51), app, 'darwin', 999).selfTest === true, '…and so is one under The Curator.app (the installed app\'s Test all)');
  // Claude Desktop's OWN binary is `…/Claude.app/Contents/MacOS/Claude`, whose
  // base name lower-cased is the CLI's `claude`. A bridge that is its direct
  // child is Claude Desktop's, not Claude Code's (a real bug, caught here).
  const direct = t([row(90, 1, CLAUDE), row(91, 90, `${NODE} ${SERVER}`)]);
  eq(B.parentAppFor(direct.get(91), direct, 'darwin', 999).id, 'claude-desktop', 'Claude.app\u2019s own `Claude` binary is Claude Desktop, never the `claude` CLI');
  // A parent missing from the table: we could not look.
  const broken = t([row(61, 60, `${NODE} ${SERVER}`)]);
  const br = B.parentAppFor(broken.get(61), broken, 'darwin', 999);
  eq(br.checked, false, 'a parent not in the table → checked false');
  eq(br.id, null, '…and no app is guessed');
  eq(B.staleRemedyFor(br, 'darwin'), 'Quit the app that started it and reopen it.', '…the remedy names no app');
  // A loop terminates.
  const loop = t([row(70, 71, '/bin/a'), row(71, 70, '/bin/b'), row(72, 70, `${NODE} ${SERVER}`)]);
  eq(B.parentAppFor(loop.get(72), loop, 'darwin', 999).label, 'another app', 'a ppid loop ends the walk');
  // Unknown bundle.
  const term = t([row(80, 1, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'), row(81, 80, '/bin/zsh'), row(82, 81, `${NODE} ${SERVER}`)]);
  const tm = B.parentAppFor(term.get(82), term, 'darwin', 999);
  eq(tm.id, null, 'an unmapped bundle is no agent app');
  eq(tm.bundle, 'Terminal.app', '…but its bundle is named');
}

// ─────────────────────────────────────────────────────────────────────────
section('§4c Windows and Linux — best effort, same shapes');
// ─────────────────────────────────────────────────────────────────────────
{
  const WSRV = 'C:\\Users\\a\\AppData\\Local\\TheCurator\\app\\mcp\\server.js';
  const desk = 'C:\\Users\\a\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe';
  const winOut = [
    `P|500|4|2026-09-18T08:00:00.0000000Z|${desk}|`,
    'P|510|500|2026-09-18T08:10:34.0000000Z|C:\\Program Files\\nodejs\\node.exe|"C:\\Program Files\\nodejs\\node.exe" "C:\\USERS\\a\\AppData\\Local\\TheCurator\\app\\mcp\\server.js" --domains-path C:\\d',
    'P|520|4|2026-09-18T08:10:34.0000000Z|C:\\Program Files\\nodejs\\node.exe|"C:\\Program Files\\nodejs\\node.exe" "C:\\other\\mcp\\server.js"',
    'garbage line',
  ].join('\r\n');
  const spy = [];
  const r = await B.detectBridgeProcesses({ ...baseDeps, platform: 'win32', serverPath: WSRV, execFile: fakePs({ stdout: winOut, spy }) });
  eq(r.checked, true, 'Windows: a reading is taken');
  ok(/powershell\.exe$/i.test(spy[0].file) && /System32/i.test(spy[0].file), '…through PowerShell by ABSOLUTE path, never a bare `powershell`', spy[0].file);
  eq(JSON.stringify(spy[0].args.slice(0, 3)), JSON.stringify(['-NoProfile', '-NonInteractive', '-Command']), '…non-interactive, no profile');
  eq(spy[0].args[3], B.WIN_PROCS_SCRIPT, '…running the ONE constant script');
  eq(r.running, 1, '…a quoted, differently-cased path matches; another install\'s does not');
  eq(r.bridges[0].app.id, 'claude-desktop', '…and its parent claude.exe at the AnthropicClaude path is Claude Desktop');
  ok(/system tray → Quit/.test(r.bridges[0].remedy) && /Code tab/.test(r.bridges[0].remedy), '…with the Windows quit step', r.bridges[0].remedy);
  const cliExe = B.parseWinRow('P|9|1|2026-09-18T08:00:00Z|C:\\Users\\a\\.local\\bin\\claude.exe|');
  const tw = new Map([[9, cliExe], [10, { pid: 10, ppid: 9, command: '', exe: '' }]]);
  eq(B.parentAppFor(tw.get(10), tw, 'win32', 999).id, 'claude-code', 'Windows: claude.exe OUTSIDE Claude Desktop\'s paths is the Claude Code CLI');
  ok(B.parseWinRow('P|x|1|||') === null && B.parseWinRow('nope') === null, 'Windows: junk rows are dropped');

  const linOut = [
    psRow(300, 1, 'Fri Sep 18 10:00:00 2026', '/usr/bin/zsh'),
    psRow(301, 300, 'Fri Sep 18 10:00:01 2026', 'claude'),
    psRow(302, 301, 'Fri Sep 18 10:10:34 2026', `/usr/bin/node ${SERVER}`),
  ].join('\n');
  const spy2 = [];
  const l = await B.detectBridgeProcesses({ ...baseDeps, platform: 'linux', execFile: fakePs({ stdout: linOut, spy: spy2 }) });
  eq(JSON.stringify(spy2[0].args), JSON.stringify(['-eo', 'pid=,ppid=,lstart=,args=']), 'Linux: the procps spelling');
  eq(l.bridges[0].app.id, 'claude-code', 'Linux: the CLI ancestor is found the same way');
}

// ─────────────────────────────────────────────────────────────────────────
section('§5  Matching is argument-bounded, and a path is never a pattern');
// ─────────────────────────────────────────────────────────────────────────
{
  const p = '/w/curator/mcp/server.js';
  ok(B.commandMatches(`/usr/bin/node ${p}`, p), 'the plain case matches');
  ok(B.commandMatches(p, p), '…and a command that IS the path matches');
  ok(B.commandMatches(`/usr/bin/node ${p} --domains-path /d`, p), '…and one with arguments after it');
  ok(!B.commandMatches('/usr/bin/node /w/curator-old/mcp/server.js', p),
    'a SIBLING checkout whose path merely contains ours does not match');
  ok(!B.commandMatches(`/usr/bin/node ${p}.bak`, p),
    '…nor a longer path that starts with ours');

  // A path with regex metacharacters in it. Built as a pattern, `.` and `+`
  // would match characters they must not; this is why the match is indexOf.
  const meta = '/Users/a.b/My+Apps (2)/mcp/server.js';
  ok(B.commandMatches(`/usr/bin/node ${meta}`, meta), 'a path full of regex metacharacters matches itself');
  ok(!B.commandMatches('/usr/bin/node /Users/axb/MyXApps X2X/mcp/server.js', meta),
    '…and does NOT match the string a regex built from it would have');

  // The whole module, read as source: no shell, no signal, no write.
  const src = await import('node:fs').then((fs) => fs.readFileSync(path.join(ROOT, 'src/brain/mcp-bridge-status.js'), 'utf8'));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok(code.includes('execFile'), 'the module does spawn something (the scan\'s own control)');
  // Asserted on the IMPORT rather than on a call-shaped regex: `re.exec(line)`
  // is an ordinary RegExp method and a pattern loose enough to catch a bare
  // `exec(` catches that too — a guard that reds for the wrong reason teaches
  // the next reader to loosen it. What can reach a shell is what was imported.
  const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]/g)]
    .flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean));
  eq(imports.join(','), 'execFile', 'the ONLY thing taken from child_process is execFile');
  ok(!/require\(['"](node:)?child_process['"]\)/.test(code), '…and nothing is required at runtime either');
  ok(!/\bshell\s*:/.test(code), 'no `shell:` option is passed anywhere');
  ok(!/execSync|spawnSync|\bspawn\b/.test(code), 'no synchronous or spawn-shaped call at all');
  ok(!/process\.kill|\.kill\(|SIGTERM|SIGKILL/.test(code), 'it never signals a process');
  ok(!/writeFile|appendFile|rmSync|mkdirSync|unlink/.test(code), 'it never writes anything');
}

// ─────────────────────────────────────────────────────────────────────────
section('§6  The route field — GET /api/mcp/config carries it, and its remedy');
// ─────────────────────────────────────────────────────────────────────────
{
  const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-stale-bridge-'));
  process.env.CURATOR_TEST_USER_DATA_DIR = TMP;
  const routes = await import(path.join(ROOT, 'src/routes/mcp.js'));
  const router = routes.default;
  const layer = router.stack.find((l) => l.route && l.route.path === '/config');
  ok(!!layer, 'the /config route is registered');
  const handler = layer.route.stack[0].handle;
  const body = await new Promise((resolve) => { handler({}, { json: resolve }); });

  ok(Object.hasOwn(body, 'bridge_processes'), 'the payload carries bridge_processes');
  ok(body.bridge_processes && typeof body.bridge_processes.checked === 'boolean',
    '…with a boolean `checked`, so a consumer can tell "did not look" from "found none"');
  ok(Array.isArray(body.bridge_processes.stale), '…and an array `stale`');
  ok(Array.isArray(body.bridge_processes.bridges), '…and (v3.88.0) an array `bridges`');
  ok(body.bridge_processes.current && typeof body.bridge_processes.current.toolCount === 'number' && /^[0-9a-f]{8}$/.test(body.bridge_processes.current.toolsHash || ''),
    '…and `current`: the code on disk\u2019s tool count and 8-hex signature, read from the REAL tool list', body.bridge_processes.current);
  // AND IT IS THE REAL DETECTOR'S ANSWER, not a canned one. `serverPath` is a
  // fact only `detectBridgeProcesses` supplies — it is what was MATCHED — so
  // a handler that short-circuits to a clean bill of health reds here. Checked
  // platform-independently: a refusal carries it too.
  eq(body.bridge_processes.serverPath, path.join(ROOT, 'mcp', 'server.js'),
    '…and it names THIS install\'s own mcp/server.js, so the answer came from the detector');
  ok(Object.hasOwn(body.bridge_processes, 'codeChangedAt'),
    '…and discloses the comparison point (or null when it could not be read)');
  eq(body.bridge_stale_remedy, B.STALE_REMEDY,
    'the remedy SENTENCE rides on the payload — the view never authors a second copy');
  ok(/Restart the app that launched it/.test(B.STALE_REMEDY) && /Claude Desktop/.test(B.STALE_REMEDY),
    '…and it names the act and the usual actor');
  ok(!/restart The Curator/i.test(B.STALE_REMEDY),
    '…and NOT The Curator, which is exactly what does not help');

  // Every other field this route has always answered is still there: the
  // handler became async for this and an await in the wrong place would have
  // dropped the tail of the payload.
  for (const k of ['ok', 'mcp_server_path', 'domains_dir', 'installed', 'stale', 'mcp_launch_style']) {
    ok(Object.hasOwn(body, k), `…and the pre-existing field ${k} survived the handler going async`);
  }
  delete process.env.CURATOR_TEST_USER_DATA_DIR;
  rmSync(TMP, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────
// §7 (the bridge page's notes) MOVED in v3.88.0 to scripts/test-next-mcp-bridge-page.js.
// The page no longer derives a stale note from `bridge_processes.stale`: each
// open bridge is told ONCE, on its own app's row, from the backend's `notice`
// (adaptBridges / bridgeRowFact in views/mcp-install.js), and that suite drives
// those builders — including, by mutation, that a same-tools bridge never warns.
// ─────────────────────────────────────────────────────────────────────────
section('§8  `my-curator doctor` reports it, and still exits 0');
// ─────────────────────────────────────────────────────────────────────────
{
  const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-stale-doctor-'));
  mkdirSync(path.join(TMP, 'home'), { recursive: true });
  mkdirSync(path.join(TMP, 'work'), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/curator.js'), 'doctor', '--json'], {
    cwd: path.join(TMP, 'work'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: path.join(TMP, 'home'),
      CURATOR_TEST_USER_DATA_DIR: TMP,
      CURATOR_TEST_DOMAINS_DIR: path.join(TMP, 'domains'),
    },
  });
  eq(r.status, 0, 'doctor exits 0');
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* reported below */ }
  ok(!!j, 'its --json output parses');
  ok(j && Object.hasOwn(j, 'bridgeProcesses'), '…and carries bridgeProcesses');
  ok(j && j.bridgeProcesses && typeof j.bridgeProcesses.checked === 'boolean',
    '…with the same three-state shape the route uses');

  const text = spawnSync(process.execPath, [path.join(ROOT, 'bin/curator.js'), 'doctor'], {
    cwd: path.join(TMP, 'work'),
    encoding: 'utf8',
    env: { ...process.env, HOME: path.join(TMP, 'home'), CURATOR_TEST_USER_DATA_DIR: TMP, CURATOR_TEST_DOMAINS_DIR: path.join(TMP, 'domains') },
  });
  eq(text.status, 0, 'and the human rendering exits 0 too');
  ok(/BRIDGE PROCESSES/.test(text.stdout), '…with a BRIDGE PROCESSES section');
  ok(!/undefined|NaN|\[object Object\]/.test(text.stdout), '…and nothing unrendered in it');
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✓' : '✗'} test-mcp-stale-bridge: ${passed} passed, ${failed} failed  (${Date.now() - t0} ms)`);
process.exit(failed === 0 ? 0 : 1);
