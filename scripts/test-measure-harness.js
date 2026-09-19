#!/usr/bin/env node
/**
 * OFFLINE — scripts/measure-harness.js (v3.63.0, Package M).
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * measure-harness.js is the one thing standing between "we shipped an
 * adapter" and "we know an agent actually reads and unprompted-saves through
 * it" (CLAUDE.md's Decision A/Q5 rule for this release). A measuring
 * instrument that silently over- or under-counts is worse than no instrument,
 * because a wrong `measured-yes` becomes a claim in the product and the docs.
 * This suite drives the real exported functions (never a source-regex check
 * — v3.0.17's rule) and the real CLI end to end, against hand-built log
 * fixtures whose right answer is known before the script ever runs.
 *
 * Covered, in order: the four-word verdict ladder at its exact boundaries;
 * self-test exclusion; the legacy (no-`sid`) bucket; a mis-labelled client
 * counted separately rather than merged into the row it doesn't belong to; a
 * `mixed`-client session (a bug in the field itself, surfaced rather than
 * silently resolved one way); the `--since` window's inclusive/exclusive
 * edge, to the millisecond; rotated-log-file merging; every CLI validation
 * path exiting 0 with a named error (never a silent wrong answer, never a
 * process that fails a caller's script); `--json` stdout purity (nothing on
 * stdout that is not the one JSON value); and a POSITIVE CONTROL — a fixture
 * built so the tool is EXPECTED to report `measured-no`, proving this suite
 * would notice if the script always said yes.
 *
 * SAFETY — never touches the real usage log. Every fixture is a tempfile
 * this suite writes and removes; the one test of the DEFAULT log-path
 * resolution runs the CLI as a child with CURATOR_TEST_USER_DATA_DIR set to
 * a tempdir it created, never the ambient environment. No network, no LLM,
 * no writes outside os.tmpdir().
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'measure-harness.js');

let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
};
const eq = (a, b, label) => ok(
  JSON.stringify(a) === JSON.stringify(b),
  `${label}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n        expected: ${JSON.stringify(b)}\n        actual:   ${JSON.stringify(a)}`}`,
);
const section = (t) => console.log(`\n${t}`);

const t0 = Date.now();
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-measure-harness-'));

function writeLog(name, lines) {
  const file = path.join(TMP, name);
  writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
  return file;
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, CURATOR_TEST_USER_DATA_DIR: undefined },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    // execFileSync throws on non-zero exit, but this script exits 0 always —
    // if we land here, that guard has already failed and the test asserting
    // exit code will report it.
    return { stdout: err.stdout ? err.stdout.toString() : '', stderr: err.stderr ? err.stderr.toString() : '', status: err.status };
  }
}

function line(sid, tool, { ts, ok: okVal = true, client, via } = {}) {
  const rec = { ts, tool, domain: 'd', ok: okVal, refused: false, ms: 1 };
  if (sid !== undefined) rec.sid = sid;
  if (client !== undefined) rec.client = client;
  if (via !== undefined) rec.via = via;
  return JSON.stringify(rec);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§0  the exported units, imported directly (never a source regex)');
// ═══════════════════════════════════════════════════════════════════════════
const mod = await import(path.join(ROOT, 'scripts', 'measure-harness.js'));
const {
  parseUsageLine, bucketLines, summariseSession, buildHarnessRow, buildAllRows,
  parseArgs, validateArgs, formatTable, run, VERDICTS, DEFAULT_MIN_SESSIONS,
} = mod;
ok(typeof run === 'function', 'run() is exported for direct, in-process driving');
eq(DEFAULT_MIN_SESSIONS, 4, 'the default gate is 4 sessions (Q5\'s working answer)');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  parseUsageLine — defensive against fields Package S has not shipped yet');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { record, malformed } = parseUsageLine(line('abc123', 'get_project_context', { ts: '2026-09-20T00:00:00.000Z', client: 'claude-code' }));
  ok(!malformed, 'a well-formed line with sid+client parses');
  eq(record.sid, 'abc123', 'sid read through');
  eq(record.client, 'claude-code', 'client read through');

  const legacy = parseUsageLine(JSON.stringify({ ts: '2026-09-20T00:00:00.000Z', tool: 'list_domains', domain: 'd', ok: true, refused: false, ms: 1 }));
  ok(!legacy.malformed, 'a pre-Package-S line (no sid, no client) is NOT malformed');
  eq(legacy.record.sid, null, '…its sid reads as null (legacy), not a thrown error');
  eq(legacy.record.client, null, '…and its client reads as null');

  ok(parseUsageLine('not json at all').malformed, 'unparseable JSON is malformed');
  ok(parseUsageLine(JSON.stringify({ tool: 'x' })).malformed, 'a line with no ts is malformed');
  ok(parseUsageLine(JSON.stringify({ ts: 'not a date', tool: 'x' })).malformed, 'an unparseable ts is malformed');
  eq(parseUsageLine('').record, null, 'a blank line parses to null');
  ok(!parseUsageLine('').malformed, '…and is not counted as malformed (it is not a line at all)');

  const emptySid = parseUsageLine(JSON.stringify({ ts: '2026-09-20T00:00:00.000Z', tool: 'x', sid: '' }));
  eq(emptySid.record.sid, null, 'an empty-string sid reads as absent, not as a zero-length session id');

  const selfTest = parseUsageLine(line('s1', 'get_working_state', { ts: '2026-09-20T00:00:00.000Z', via: 'self-test' }));
  eq(selfTest.record.via, 'self-test', 'the self-test literal is recognised');
  const badVia = parseUsageLine(line('s1', 'get_working_state', { ts: '2026-09-20T00:00:00.000Z', via: 'anything-else' }));
  eq(badVia.record.via, null, 'any other via value normalises to null, exactly as mcp-usage.js\'s own normaliseVia does');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  bucketLines — self-test excluded, legacy excluded, window is [since, +∞)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const sinceMs = Date.parse('2026-09-20T00:00:00.000Z');
  const raw = [
    line('a1', 'get_project_context', { ts: '2026-09-20T00:00:00.000Z', client: 'claude-code' }),   // exactly at since — IN
    line('a1', 'save_working_state', { ts: '2026-09-20T00:00:01.000Z', client: 'claude-code' }),
    line('b1', 'get_project_context', { ts: '2026-09-19T23:59:59.999Z', client: 'claude-code' }),    // 1ms before since — OUT, entirely
    line(undefined, 'list_domains', { ts: '2026-09-20T00:00:02.000Z' }),                             // no sid — legacy
    line('c1', 'get_working_state', { ts: '2026-09-20T00:00:03.000Z', via: 'self-test' }),           // self-test — excluded
    'not even json',                                                                                  // malformed
  ];
  const b = bucketLines(raw, sinceMs);
  eq(b.legacyLines, 1, 'exactly one legacy line (no sid)');
  eq(b.selfTestLines, 1, 'exactly one self-test line');
  eq(b.malformedLines, 1, 'exactly one malformed line');
  eq(b.sessionsBySid.size, 1, 'only ONE session in the window (b1 is entirely excluded, not just uncounted)');
  ok(b.sessionsBySid.has('a1'), 'the in-window session is a1');
  ok(!b.sessionsBySid.has('b1'), 'the pre-window session never appears at all — it is not "session with 0 lines", it does not exist here');

  // The boundary, pinned exactly: one line at `since`, one line 1ms earlier.
  const boundary = bucketLines([
    line('x', 'get_project_context', { ts: '2026-09-20T00:00:00.000Z' }),
    line('y', 'get_project_context', { ts: '2026-09-19T23:59:59.999Z' }),
  ], sinceMs);
  eq(boundary.sessionsBySid.size, 1, 'inclusive lower bound: the line AT since counts, the line 1ms before does not');
  ok(boundary.sessionsBySid.has('x'), 'the surviving session is the one at the boundary, not the one before it');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  summariseSession — client agreement, and disagreement (mixed)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const s1 = summariseSession([
    { tool: 'get_project_context', ok: true, client: 'claude-code', atMs: 100 },
    { tool: 'save_working_state', ok: true, client: 'claude-code', atMs: 200 },
  ]);
  eq(s1.client, 'claude-code', 'one client value across the session -> that value');
  eq(s1.hasRead, true, 'read tool + ok:true -> hasRead');
  eq(s1.hasSaved, true, 'save tool + ok:true -> hasSaved');
  eq(s1.firstAtMs, 100, 'firstAtMs is the min');
  eq(s1.lastAtMs, 200, 'lastAtMs is the max');

  const noClient = summariseSession([{ tool: 'get_project_context', ok: true, client: null, atMs: 1 }]);
  eq(noClient.client, null, 'no client on any line -> null (unlabeled), not a guess');

  const mixed = summariseSession([
    { tool: 'get_project_context', ok: true, client: 'claude-code', atMs: 1 },
    { tool: 'save_working_state', ok: true, client: 'codex', atMs: 2 },
  ]);
  eq(mixed.client, 'mixed', 'two distinct client values for one sid -> the literal "mixed", surfaced rather than picked');

  const failedRead = summariseSession([{ tool: 'get_project_context', ok: false, client: 'claude-code', atMs: 1 }]);
  eq(failedRead.hasRead, false, 'ok:false does not count as a read — matches the E.1 protocol table exactly');

  const savedNotUnprompted = summariseSession([{ tool: 'save_working_state', ok: true, client: 'claude-code', atMs: 1 }]);
  eq(savedNotUnprompted.hasRead, false, 'a save with no read line is still just a save (no read invented)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  the verdict ladder, at its exact boundaries — Decision A\'s four words');
// ═══════════════════════════════════════════════════════════════════════════
function sessionsOf(n, { read = true, saved = true } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(summariseSession([
      ...(read ? [{ tool: 'get_project_context', ok: true, client: 'h', atMs: i }] : []),
      ...(saved ? [{ tool: 'save_working_state', ok: true, client: 'h', atMs: i + 1000 }] : []),
    ]));
  }
  return out;
}
function fold(sessions, minSessions = 4) {
  // Exercise the row builder via a synthetic bucket rather than re-deriving
  // foldSessions by hand — same code path buildHarnessRow uses.
  const bucketed = { sessionsBySid: new Map(sessions.map((s, i) => [`s${i}`, [
    ...(s.hasRead ? [{ tool: 'get_project_context', ok: true, client: 'h', atMs: s.firstAtMs }] : []),
    ...(s.hasSaved ? [{ tool: 'save_working_state', ok: true, client: 'h', atMs: s.lastAtMs }] : []),
  ]])) };
  return buildHarnessRow(bucketed, 'h', { minSessions });
}

eq(fold([], 4).verdict, VERDICTS.NOT_MEASURED, '0 sessions -> not-measured');
eq(fold(sessionsOf(3, { saved: false }), 4).verdict, VERDICTS.NO, 'sessions ran, none saved -> measured-no');
eq(fold([...sessionsOf(2), ...sessionsOf(1, { saved: false })], 4).verdict, VERDICTS.PARTIAL, '2 of 3 both, gate 4 -> measured-partial');
eq(fold(sessionsOf(3), 4).verdict, VERDICTS.PARTIAL, 'exactly one below the gate (3 of 4) -> measured-partial, never yes');
eq(fold(sessionsOf(4), 4).verdict, VERDICTS.YES, 'exactly at the gate (4 of 4) -> measured-yes');
eq(fold(sessionsOf(5), 4).verdict, VERDICTS.YES, 'above the gate -> still measured-yes');
eq(fold(sessionsOf(4), 5).verdict, VERDICTS.PARTIAL, 'the SAME 4-of-4 run reads as measured-partial against a stricter --min-sessions 5 -- the gate moves the word, not the data');

// ═══════════════════════════════════════════════════════════════════════════
section('§5  buildHarnessRow — a mis-labelled client is tallied, never merged in');
// ═══════════════════════════════════════════════════════════════════════════
{
  const bucketed = {
    sessionsBySid: new Map([
      ['s1', [{ tool: 'get_project_context', ok: true, client: 'claude-code', atMs: 1 }, { tool: 'save_working_state', ok: true, client: 'claude-code', atMs: 2 }]],
      ['s2', [{ tool: 'get_project_context', ok: true, client: 'other', atMs: 3 }]],
      ['s3', [{ tool: 'get_project_context', ok: true, client: 'other', atMs: 4 }]],
      ['s4', [{ tool: 'get_project_context', ok: true, client: null, atMs: 5 }]],
    ]),
  };
  const row = buildHarnessRow(bucketed, 'claude-code', { minSessions: 4 });
  eq(row.sessions, 1, 'only s1 counted toward claude-code');
  eq(row.otherClients, { other: 2, unlabeled: 1 }, 'the other three are tallied by their own label, not folded into claude-code and not dropped');
  eq(row.sessionsBoth, 1, 'and the fold is still correct: 1 session with both read and save');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  buildAllRows — one row per distinct client label present');
// ═══════════════════════════════════════════════════════════════════════════
{
  const bucketed = {
    sessionsBySid: new Map([
      ['s1', [{ tool: 'get_project_context', ok: true, client: 'claude-code', atMs: 1 }]],
      ['s2', [{ tool: 'get_project_context', ok: true, client: 'codex', atMs: 2 }]],
      ['s3', [{ tool: 'get_project_context', ok: true, client: null, atMs: 3 }]],
    ]),
  };
  const rows = buildAllRows(bucketed, { minSessions: 4 });
  eq(rows.map((r) => r.harness), ['claude-code', 'codex', 'unlabeled'], 'sorted labels, unlabeled included as its own row');
  eq(rows.every((r) => r.sessions === 1), true, 'one session per label in this fixture');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  positive control — a fixture this script is EXPECTED to call measured-no');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Three real sessions on the fixture harness, every one of which reads and
  // then closes without saving -- the exact failure mode B12 exists to catch.
  // If this suite only ever asserted "yes" fixtures it could not tell a
  // script that always answers yes from one that actually measures.
  const bucketed = {
    sessionsBySid: new Map([
      ['s1', [{ tool: 'get_project_context', ok: true, client: 'goose', atMs: 1 }]],
      ['s2', [{ tool: 'get_project_context', ok: true, client: 'goose', atMs: 2 }]],
      ['s3', [{ tool: 'get_project_context', ok: true, client: 'goose', atMs: 3 }]],
    ]),
  };
  const row = buildHarnessRow(bucketed, 'goose', { minSessions: 4 });
  eq(row.verdict, VERDICTS.NO, 'positive control: three sessions, all read, none saved -> measured-no, not yes');
  eq(row.sessions, 3, '…and the sessions themselves are still counted honestly (not zeroed by the failure)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  rotated log files — the .1 generation is read too, oldest first');
// ═══════════════════════════════════════════════════════════════════════════
{
  const older = writeLog('rot.jsonl.1', [line('old1', 'get_project_context', { ts: '2026-09-20T00:00:00.000Z', client: 'claude-code' })]);
  const current = older.replace(/\.1$/, '');
  writeFileSync(current, line('new1', 'save_working_state', { ts: '2026-09-20T00:01:00.000Z', client: 'claude-code' }) + '\n');
  const res = await run(['--harness', 'claude-code', '--since', '2026-09-20T00:00:00Z', '--log', current, '--json']);
  const payload = JSON.parse(res.stdout);
  eq(payload.sessions, 2, 'both the rotated generation and the live file contribute sessions');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  CLI argument validation — every path exits 0 (this script REPORTS, never fails a caller)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const cases = [
    { args: [], want: /--harness .* or --all/ },
    { args: ['--all', '--harness', 'x', '--since', '2026-01-01'], want: /mutually exclusive/ },
    { args: ['--harness', 'x'], want: /--since/ },
    { args: ['--harness', 'x', '--since', 'not-a-date'], want: /not a parseable date/ },
    { args: ['--harness', 'has a space', '--since', '2026-01-01'], want: /must look like a slug/ },
    { args: ['--all', '--since', '2026-01-01', '--min-sessions', '0'], want: /positive integer/ },
    { args: ['--all', '--since', '2026-01-01', '--min-sessions', 'abc'], want: /positive integer/ },
    { args: ['--all', '--since', '2026-01-01', '--wat'], want: /unrecognised argument/ },
  ];
  for (const c of cases) {
    const res = await run(c.args);
    ok(res.exitCode === 0, `exit 0 for: ${JSON.stringify(c.args)}`);
    ok(c.want.test(res.stderr), `error names the problem: ${JSON.stringify(c.args)} -> ${res.stderr.trim() || '(empty)'}`);
  }
  // The same validation failure, with --json: the error is JSON, not mixed text.
  const jsonErr = await run(['--since', '2026-01-01', '--json']);
  eq(jsonErr.exitCode, 0, '--json validation failure also exits 0');
  eq(jsonErr.stderr, '', '--json validation failure writes NOTHING to stderr that a caller parsing stdout would miss (all in stdout)');
  const parsed = JSON.parse(jsonErr.stdout);
  ok(typeof parsed.error === 'string' && parsed.error.length > 0, '--json validation failure is a parseable {error} object');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10  a missing log file is not an error — 0 sessions, not-measured');
// ═══════════════════════════════════════════════════════════════════════════
{
  const missing = path.join(TMP, 'nope', 'does-not-exist.jsonl');
  const res = await run(['--harness', 'claude-code', '--since', '2026-01-01', '--log', missing, '--json']);
  eq(res.exitCode, 0, 'missing log -> still exit 0');
  const payload = JSON.parse(res.stdout);
  eq(payload.sessions, 0, 'no file -> zero sessions');
  eq(payload.verdict, VERDICTS.NOT_MEASURED, '…and the honest verdict is not-measured, never an error masquerading as a reading');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11  the real CLI, over a real child process — stdout purity with --json');
// ═══════════════════════════════════════════════════════════════════════════
{
  const log = writeLog('cli.jsonl', [
    line('s1', 'get_project_context', { ts: '2026-09-20T00:00:00.000Z', client: 'claude-code' }),
    line('s1', 'save_working_state', { ts: '2026-09-20T00:00:01.000Z', client: 'claude-code' }),
  ]);
  const { stdout, stderr, status } = runCli(['--harness', 'claude-code', '--since', '2026-09-20T00:00:00Z', '--log', log, '--json']);
  eq(status, 0, 'real child process exits 0');
  let parseErr = null;
  try { JSON.parse(stdout); } catch (e) { parseErr = e; }
  ok(parseErr === null, `stdout is exactly one parseable JSON value, nothing else: ${parseErr ? stdout : 'ok'}`);
  eq(stdout.trim().split('\n').length, 1, 'stdout is a single line with --json — no banner, no extra prints mixed in');

  // The plain-table path, smoke-tested for the words a human would look for.
  const { stdout: tableOut, status: tableStatus } = runCli(['--harness', 'claude-code', '--since', '2026-09-20T00:00:00Z', '--log', log]);
  eq(tableStatus, 0, 'table mode also exits 0');
  ok(/measured-partial/.test(tableOut), 'the table names the verdict word (1 of 4 sessions both -> measured-partial at the default gate)');
  ok(/claude-code/.test(tableOut), 'the table names the harness');

  // --help exits 0 and never touches the log at all.
  const { stdout: helpOut, status: helpStatus } = runCli(['--help']);
  eq(helpStatus, 0, '--help exits 0');
  ok(/Usage:/.test(helpOut), '--help prints usage');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§12  --protocol is recorded verbatim, never inferred, and defaults to null');
// ═══════════════════════════════════════════════════════════════════════════
{
  const log = writeLog('proto.jsonl', [line('s1', 'get_project_context', { ts: '2026-09-20T00:00:00.000Z', client: 'claude-code' })]);
  const withProto = await run(['--harness', 'claude-code', '--since', '2026-09-20T00:00:00Z', '--log', log, '--protocol', 'arm-c-neutral-task', '--json']);
  eq(JSON.parse(withProto.stdout).protocol, 'arm-c-neutral-task', 'a supplied --protocol is carried through byte-for-byte');
  const withoutProto = await run(['--harness', 'claude-code', '--since', '2026-09-20T00:00:00Z', '--log', log, '--json']);
  eq(JSON.parse(withoutProto.stdout).protocol, null, 'an omitted --protocol is null, never guessed from the data');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§13  default log path honours CURATOR_TEST_USER_DATA_DIR (never the real usage log)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const userData = mkdtempSync(path.join(os.tmpdir(), 'curator-measure-harness-userdata-'));
  const defaultLog = path.join(userData, '.mcp-usage.jsonl');
  writeFileSync(defaultLog, line('s1', 'get_project_context', { ts: '2026-09-20T00:00:00.000Z', client: 'claude-code' }) + '\n');
  const stdout = execFileSync(process.execPath, [SCRIPT, '--harness', 'claude-code', '--since', '2026-09-20T00:00:00Z', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, CURATOR_TEST_USER_DATA_DIR: userData },
  });
  const payload = JSON.parse(stdout);
  eq(payload.logPath, defaultLog, 'with no --log, the default path resolves under CURATOR_TEST_USER_DATA_DIR, exactly as getMcpUsageLogPath() promises');
  eq(payload.sessions, 1, '…and it actually read that file');
  rmSync(userData, { recursive: true, force: true });
}

// ── Cleanup ──────────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true });

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed (${Date.now() - t0}ms)`);
if (failed > 0) process.exit(1);
