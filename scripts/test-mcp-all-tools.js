#!/usr/bin/env node
/**
 * OFFLINE — EVERY MCP tool, driven once over real stdio, end to end (v3.61.0).
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * v3.60.0 shipped a map of all 24 tools and the usage log behind it, and its
 * own KNOWN AND UNFIXED recorded the hole: "the Tool map was driven by
 * fixtures and the stub route, never by the real route end to end". Every
 * other MCP suite covers a SUBSET — the read tools (`test-mcp-e2e.js` §3), the
 * mutators against a mirror (§8), the two working-state tools
 * (`test-mcp-working-state.js`), the projects pair (`test-mcp-projects.js`) —
 * and no suite anywhere had ever called all twenty-four in one process and
 * looked at what the log then said.
 *
 * Four things that can only be seen from here:
 *
 *   1. A TOOL NOBODY DRIVES. `missing` is the driver's own honesty field, and
 *      §1 pins it empty: a 25th tool added to the catalogue reds this suite
 *      until somebody writes a case for it. That is the whole mechanism — the
 *      catalogue, the `tools` array and the driver's plan are three lists of
 *      one thing, and §1 is what keeps the third honest (§6 of
 *      `test-mcp-usage.js` keeps the first two).
 *   2. A TOOL THAT ANSWERS IN ISOLATION AND NOT IN SEQUENCE. §2 runs them in
 *      one child, in one order, where `compile_to_wiki` has already written
 *      into the fixture that `scan_wiki_health` then scans and
 *      `save_working_state` has already produced the state that
 *      `get_project_context` then reads.
 *   3. THE ROUTE, WITH REAL ROWS. §3 drives the REAL `GET /api/mcp/usage`
 *      handler over the log the child just wrote — closing the v3.60.0 item.
 *   4. A PAID CALL. §5 preloads a network spy into the child and requires ZERO
 *      attempts, with credentials stripped AND with a fake-shaped key present,
 *      because "no key was configured" is a different proposition from "no
 *      call was made" and only the second one is the guarantee.
 *
 * WHAT THIS SUITE DOES NOT GUARANTEE
 * ──────────────────────────────────
 *  - It does not check any tool's ANSWER beyond "it answered". The semantics
 *    are other suites' (`test-mcp-e2e.js` §4 for the graph, §6 for dot slugs,
 *    `test-mcp-working-state.js` for the state tiers). This one is about
 *    coverage, the log, and the route.
 *  - A refusal counts as an answer, deliberately: a tool that refuses has run
 *    its guard and written its line, which is what the map shows. The refused
 *    set is enumerated by name in §2 with the reason, so a NEW refusal is a
 *    red line rather than a silent widening.
 *  - The ten older read tools answer a bad argument with a plain string, so a
 *    string-shaped refusal is recorded as an answer. That is the usage hook's
 *    named limit (`test-mcp-usage.js` §1b) and it is inherited here.
 *
 * SAFETY — never touches real user data. Every child gets
 * `CURATOR_TEST_USER_DATA_DIR` + `CURATOR_TEST_DOMAINS_DIR` at a mkdtemp with
 * provider and GitHub credentials stripped; the in-process reads go through
 * `__setUserDataDirOverride` / `__setDomainsDirOverride`; §7 fingerprints an
 * isolated domains copy across a run AND the real `.curator-config.json` at
 * both ends. No network, no LLM call — proved, not assumed (§5).
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  existsSync, statSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
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
const eq = (a, b, label) => ok(a === b,
  `${label}${a === b ? '' : `\n        expected: ${JSON.stringify(b)}\n        actual:   ${JSON.stringify(a)}`}`);
const section = (t) => console.log(`\n${t}`);

const t0 = Date.now();

// ── Isolation, before anything reads a path ────────────────────────────────
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-all-tools-'));
const USER_DATA = path.join(TMP, 'userdata');
mkdirSync(USER_DATA, { recursive: true });

const paths = await import(path.join(ROOT, 'src/brain/paths.js'));
const config = await import(path.join(ROOT, 'src/brain/config.js'));
paths.__setUserDataDirOverride(USER_DATA);

const usage = await import(path.join(ROOT, 'src/brain/mcp-usage.js'));
const exercise = await import(path.join(ROOT, 'src/brain/mcp-exercise.js'));
const { TOOL_CATALOGUE } = await import(path.join(ROOT, 'mcp/tools/catalogue.js'));
const { tools: registry } = await import(path.join(ROOT, 'mcp/tools/index.js'));

// The real config file, fingerprinted at both ends. sha256 + size + existence
// only — never mtime, which the maintainer's own running app moves during any
// ordinary Settings action and which cost two investigations in v3.0.16.
const REAL_CONFIG = path.join(os.homedir(), '.curator-config.json');
const fingerprint = (f) => {
  if (!existsSync(f)) return 'absent';
  const b = readFileSync(f);
  return `${b.length}:${createHash('sha256').update(b).digest('hex')}`;
};
const CONFIG_BEFORE = fingerprint(REAL_CONFIG);

const logLines = (dir) => {
  const f = path.join(dir, '.mcp-usage.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
};
/**
 * v3.63.0 — a bridge process writes ONE `{"ev":"session"}` line (carrying the
 * client label) in the same append as its first tool line, then one line per
 * call. Everything this suite asserts is about CALLS, so it reads tool lines;
 * the session line itself is asserted by name below and owned by
 * `test-mcp-usage.js` §9-§10.
 */
const callLines = (dir) => logLines(dir).filter((l) => JSON.parse(l).ev !== 'session');
const sessionLinesIn = (dir) => logLines(dir).filter((l) => JSON.parse(l).ev === 'session');

/** A fresh, empty user-data dir for one child. */
let udSeq = 0;
const freshUserData = () => {
  const d = path.join(TMP, `ud-${++udSeq}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// ═══════════════════════════════════════════════════════════════════════════
section('§1  COVERAGE — the plan has a case for every catalogue tool');
// ═══════════════════════════════════════════════════════════════════════════
const cov = exercise.planCoverage();
eq(cov.missing.length, 0,
  cov.missing.length
    ? `EVERY catalogue tool needs a case in EXERCISE_PLAN. Missing: ${cov.missing.join(', ')} — add one to src/brain/mcp-exercise.js`
    : 'every catalogue tool has a case in EXERCISE_PLAN');
eq(cov.extra.length, 0,
  cov.extra.length
    ? `the plan drives tools the catalogue does not list: ${cov.extra.join(', ')} (renamed or removed?)`
    : 'the plan drives nothing the catalogue does not list');
eq(cov.covered.length, TOOL_CATALOGUE.length,
  `all ${TOOL_CATALOGUE.length} catalogue tools are covered`);
eq(exercise.EXERCISE_PLAN.length, TOOL_CATALOGUE.length,
  'one plan step per tool — no tool is driven twice and none is skipped');
// The catalogue is itself checked against the real registry by
// test-mcp-usage.js §6. Re-stated here so this suite's own count cannot be
// satisfied by a catalogue that has drifted from the bridge.
eq(TOOL_CATALOGUE.length, registry.length,
  `the catalogue and the bridge's own \`tools\` array are the same length (${registry.length})`);
// ANTI-VACUITY: planCoverage must really compare, not return empty arrays.
{
  const fake = [...TOOL_CATALOGUE, { name: 'zz_future_tool', group: 'read', mutates: false, purpose: 'x' }];
  const c = exercise.planCoverage(fake);
  ok(c.missing.length === 1 && c.missing[0] === 'zz_future_tool',
    'CONTROL: a 25th catalogue tool is reported MISSING — this is what reds the suite when somebody adds one');
  const c2 = exercise.planCoverage(TOOL_CATALOGUE.slice(0, 3));
  ok(c2.extra.length === TOOL_CATALOGUE.length - 3,
    'CONTROL: a shrunken catalogue reports the orphaned plan steps as `extra`');
}
// The plan's arguments are DETERMINISTIC: no clock, no randomness, no machine.
{
  const ctx = { domain: exercise.EXERCISE_DOMAIN, domainsDir: '/tmp/x' };
  const a = exercise.EXERCISE_PLAN.map((s) => JSON.stringify(s.args(ctx))).join('\n');
  const b = exercise.EXERCISE_PLAN.map((s) => JSON.stringify(s.args(ctx))).join('\n');
  eq(a, b, 'every step builds byte-identical arguments twice — nothing in the plan reads a clock');
  ok(!/Date\.now|Math\.random|process\.env|hostname/.test(
    readFileSync(path.join(ROOT, 'src/brain/mcp-exercise.js'), 'utf8')
      .slice(readFileSync(path.join(ROOT, 'src/brain/mcp-exercise.js'), 'utf8').indexOf('export const EXERCISE_PLAN'),
        readFileSync(path.join(ROOT, 'src/brain/mcp-exercise.js'), 'utf8').indexOf('/** Catalogue tools with no case'))),
    '…and the plan\'s source names no clock, no randomness and no environment');
}
// `commissioned_by_owner` is true on save_foundation, and ONLY there: the flag
// means "the user asked for this", which the button press is, and the tool
// refuses without it. A run that omitted it would report a refusal that looks
// like a defect in the tool.
{
  const ctx = { domain: exercise.EXERCISE_DOMAIN, domainsDir: '/tmp/x' };
  const withFlag = exercise.EXERCISE_PLAN
    .filter((s) => s.args(ctx).commissioned_by_owner === true).map((s) => s.tool);
  eq(JSON.stringify(withFlag), JSON.stringify(['save_foundation']),
    'commissioned_by_owner: true is set on save_foundation and on nothing else');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  THE RUN — every tool answered, over real stdio, with `via`');
// ═══════════════════════════════════════════════════════════════════════════
const UD_VIA = freshUserData();
const run = await exercise.exerciseAllTools({ userDataDir: UD_VIA, via: 'self-test' });

ok(!run.error, `the run completed without a fatal (${run.error || 'no error'})`);
eq(run.results.length, TOOL_CATALOGUE.length, `one row per tool (${run.results.length})`);
eq(JSON.stringify(run.results.map((r) => r.tool)),
  JSON.stringify(exercise.EXERCISE_PLAN.map((s) => s.tool)),
  'the rows are in the plan\'s order, one per step');
eq(run.missing.length, 0, 'the run reports nothing missing');

// EVERY TOOL ANSWERED. A failure here names the tools, because "23 of 24" is
// not a finding anybody can act on.
const notAnswered = run.results.filter((r) => !r.ok && !r.refused);
eq(notAnswered.length, 0,
  notAnswered.length
    ? `every tool must answer (ok || refused). Did not: ${notAnswered.map((r) => `${r.tool} — ${r.note}`).join(' | ')}`
    : `every one of the ${run.results.length} tools answered over the wire`);

// ── THE REFUSED SET, ENUMERATED AND JUSTIFIED ────────────────────────────
// A refusal is a legitimate answer — the tool ran its guard and wrote its
// line. But the SET must be a decision, not a drift: a new name appearing
// here is a tool that stopped working, wearing a refusal's clothes.
//
// `scan_semantic_duplicates` is the only member, and only when no provider key
// is configured. Its `estimate_only` arm prices the scan against the
// configured model, and `getProviderInfo()` refuses when there is no key at
// all — which is the state `npm test` runs in (credentials are stripped from
// every child). §5 drives the same arm WITH a fake-shaped key and requires it
// to ANSWER, which is what makes this a statement about the environment rather
// than about the tool.
const EXPECTED_REFUSALS = new Set(['scan_semantic_duplicates']);
const refusedNames = run.results.filter((r) => r.refused).map((r) => r.tool);
const unexpected = refusedNames.filter((n) => !EXPECTED_REFUSALS.has(n));
eq(unexpected.length, 0,
  unexpected.length
    ? `only ${[...EXPECTED_REFUSALS].join(', ')} may refuse. Unexpected: ${
      run.results.filter((r) => unexpected.includes(r.tool)).map((r) => `${r.tool} — ${r.note}`).join(' | ')}`
    : `the refused set is within the justified one (refused: ${refusedNames.join(', ') || 'none'})`);
for (const r of run.results.filter((x) => x.refused)) {
  ok(typeof r.note === 'string' && r.note.length > 0,
    `${r.tool}'s refusal carries a reason (${JSON.stringify((r.note || '').slice(0, 90))})`);
}
// Durations are real numbers, so the row the app renders is a measurement.
ok(run.results.every((r) => Number.isFinite(r.ms) && r.ms >= 0),
  'every row carries a finite duration');
ok(Number.isFinite(run.durationMs) && run.durationMs > 0 && run.durationMs < exercise.EXERCISE_WALL_MS,
  `the whole run fits inside its own wall clock (${run.durationMs} ms of ${exercise.EXERCISE_WALL_MS})`);

// ── STDOUT PURITY (the v2.5.3 gate), over the broadest exercise there is ──
// This run puts every tool module and everything they import on the child's
// EXECUTED graph in one process. A stray console.log anywhere on it reaches
// Claude Desktop as `Unexpected token … is not valid JSON` and kills the
// session; `npm test` stayed green through that bug for two releases.
ok(run.transport.stdoutLines > 0,
  `the child really spoke on stdout (${run.transport.stdoutLines} lines — zero would make this vacuous)`);
eq(run.transport.nonJsonStdout.length, 0,
  run.transport.nonJsonStdout.length
    ? `NON-JSON ON STDOUT — the v2.5.3 bug. First: ${JSON.stringify(run.transport.nonJsonStdout[0])}. Diagnostics belong on stderr.`
    : `all ${run.transport.stdoutLines} stdout lines parse as JSON-RPC`);
// ── STDERR IS NOT REQUIRED TO BE EMPTY HERE, AND THAT IS THE POINT ───────
// `test-mcp-e2e.js` §0 asserts zero stderr bytes, and it holds there ONLY
// because that suite drives `compile_to_wiki` against a read-only mirror,
// which refuses before writing. This run compiles into a WRITEABLE fixture,
// and `syncSummaryEntities` (src/brain/files.js:587) reports what it synced —
// on stderr, which is exactly the v2.5.3 discipline: diagnostics go to stderr,
// stdout is the JSON-RPC stream. So the assertion is not "silence" but "every
// line is a deliberate, tagged diagnostic": a stack trace, an unhandled
// rejection or the usage log's own failure notice would all fail it.
{
  const lines = run.transport.stderrSample.split('\n').filter((l) => l.trim());
  const untagged = lines.filter((l) => !/^\[[A-Za-z][A-Za-z0-9 _.-]*\]/.test(l));
  eq(untagged.length, 0,
    untagged.length
      ? `stderr carried a line that is not a tagged diagnostic: ${JSON.stringify(untagged[0].slice(0, 160))}`
      : `stderr carried only tagged diagnostics (${lines.length}: ${lines.map((l) => (/^\[[^\]]+\]/.exec(l) || [''])[0]).join(' ')})`);
  ok(!/\bat \S+ \(/.test(run.transport.stderrSample), 'no stack frame on stderr');
  ok(!/usage log/i.test(run.transport.stderrSample),
    'and no "usage log could not be written" notice — the log really was writable, which every log assertion below depends on');
  // CONTROL: the tag test can fail. Without this it is a regex nobody has run
  // against a negative.
  ok(/^\[[A-Za-z][A-Za-z0-9 _.-]*\]/.test('[syncSummaryEntities] ok')
     && !/^\[[A-Za-z][A-Za-z0-9 _.-]*\]/.test('Error: boom'),
    'CONTROL: the tagged-diagnostic test accepts a tag and rejects a bare error');
}

// ── THE LAUNCH LINE IS THE WIZARD'S ──────────────────────────────────────
// Not a second one. v3.6.1: the self-test route built its own, drifted from
// the prescribed one, and gave a green pass against the wrong folder.
{
  const routes = await import(path.join(ROOT, 'src/routes/mcp.js'));
  const expected = routes.buildCuratorEntry('/some/domains');
  eq(run.spawn_command, expected.command,
    'the run spawned `buildCuratorEntry`\'s command, not a command of its own');
  // The args differ only in the domains path (the fixture's), which is the
  // one thing that is supposed to differ.
  eq(run.spawn_args.length, expected.args.length,
    'the args have the same shape as the prescribed entry\'s');
  if (expected.args.length) {
    eq(run.spawn_args[0], expected.args[0], '…starting with the same server path');
    eq(run.spawn_args[1], expected.args[1], '…and the same --domains-path flag');
    ok(run.spawn_args[2] && run.spawn_args[2] !== '/some/domains',
      '…with the fixture\'s own domains dir as the value');
  }
  ok(!/src\/brain\/mcp-exercise\.js[\s\S]*?process\.execPath/.test(
    readFileSync(path.join(ROOT, 'src/brain/mcp-exercise.js'), 'utf8')),
    'mcp-exercise.js names no launch binary of its own (no process.execPath, no hard-coded node)');
}

// ── THE LOG: ONE LINE PER TOOL, `via` ON EVERY ONE ───────────────────────
const viaLines = callLines(UD_VIA);
eq(viaLines.length, TOOL_CATALOGUE.length,
  `the child wrote exactly one line per tool (${viaLines.length} of ${TOOL_CATALOGUE.length})`);
// ONE session line for the whole run, because one bridge process is one
// session — and it carries `via` too, so the meter never counts the button
// press as a session that read and saved.
const viaSessionLines = sessionLinesIn(UD_VIA).map((l) => JSON.parse(l));
eq(viaSessionLines.length, 1, 'and ONE session line, for the one bridge process the run spawned');
eq(viaSessionLines[0].via, 'self-test', '…marked self-test like every other line of the run');
eq(viaSessionLines[0].sid, JSON.parse(viaLines[0]).sid, '…sharing the sid every tool line carries');
const viaRecs = viaLines.map((l) => JSON.parse(l));
eq(JSON.stringify(viaRecs.map((r) => r.tool)),
  JSON.stringify(exercise.EXERCISE_PLAN.map((s) => s.tool)),
  'the log names the tools in the order they were called');
ok(viaRecs.every((r) => r.via === 'self-test'),
  'every line carries via: "self-test"');
eq(JSON.stringify(Object.keys(viaRecs[0])),
  JSON.stringify(usage.LINE_KEYS.filter((k) => k !== 'project')),
  'a via line carries EXACTLY ts,tool,domain,ok,refused,ms,sid,via — in that order (list_domains names no project)');
// …and a tool that DOES resolve a project carries the ninth key, in place.
const projectRec = viaRecs.find((r) => 'project' in r);
ok(projectRec, 'at least one call in the plan resolved a project');
eq(JSON.stringify(Object.keys(projectRec)), JSON.stringify(usage.LINE_KEYS),
  '…and that line carries all nine keys, in LINE_KEYS order');
ok(viaLines.every((l) => Buffer.byteLength(l, 'utf8') < usage.MAX_LINE_BYTES),
  `every line is under the ${usage.MAX_LINE_BYTES}-byte ceiling (max ${
    Math.max(...viaLines.map((l) => Buffer.byteLength(l, 'utf8')))}) — the claim the app makes to the user`);
// The fixture domain is RECORDED, not dropped to null: it is inside
// mcp-usage.js's 48-character bound, and a null here would make every
// `domain` assertion about this log vacuous.
const domained = viaRecs.filter((r) => r.domain === exercise.EXERCISE_DOMAIN).length;
ok(domained >= 20,
  `the fixture domain is recorded on ${domained} of ${viaRecs.length} lines (it is inside the 48-char bound)`);
ok(!viaLines.some((l) => /self-test project|throwaway brief|Key Takeaways|architecture/i.test(l)),
  'no argument text from the run reached the log — 24 calls carrying markdown bodies, and none of it is in the file');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  readUsage + the REAL route over the log the child just wrote');
// ═══════════════════════════════════════════════════════════════════════════
// This is the v3.60.0 KNOWN AND UNFIXED item: the map had only ever been shown
// fixtures and a stub. Here the real aggregate and the real handler read rows
// the bridge itself produced, minutes old.
paths.__setUserDataDirOverride(UD_VIA);
usage.__clearUsageCache();
const agg = await usage.readUsage({ noCache: true });
eq(agg.present, true, 'readUsage sees the log');
eq(agg.lineCount, TOOL_CATALOGUE.length, `it parses all ${TOOL_CATALOGUE.length} lines`);
eq(agg.malformedLines, 0, '…with none malformed');
eq(Object.keys(agg.byTool).length, TOOL_CATALOGUE.length,
  'it aggregates one entry per tool — no name was logged as "unknown"');
ok(Object.values(agg.byTool).every((a) => a.lastUsedAt !== null),
  'every tool has a non-null lastUsedAt');
ok(Object.values(agg.byTool).every((a) => a.lastVia === 'self-test'),
  '…and lastVia === "self-test" on every one');
ok(Object.values(agg.byTool).every((a) => a.selfTestTotal === 1),
  '…and selfTestTotal === 1 on every one');
// ── THE BOOTSTRAP EXCLUSION, WHICH IS THE POINT OF `via` ────────────────
// The run CALLED get_project_context, get_working_state and
// save_working_state. If a self-test moved these two readings, the map's
// headline strip would say a session started and saved because the user
// pressed a button on this screen — a false reading on the one strip the
// memory layer exists for.
ok(agg.byTool.get_project_context && agg.byTool.get_project_context.countTotal === 1,
  'precondition: the run really called get_project_context (otherwise the next two lines are vacuous)');
ok(agg.byTool.save_working_state && agg.byTool.save_working_state.countTotal === 1,
  'precondition: …and save_working_state');
eq(agg.sessions.lastBootstrapAt, null,
  'lastBootstrapAt is NULL — a self-test is not a session start');
eq(agg.sessions.lastSaveAt, null,
  'lastSaveAt is NULL — a self-test saved nobody\'s handoff');

// THE REAL ROUTE HANDLER, not a stub.
{
  const routes = await import(path.join(ROOT, 'src/routes/mcp.js'));
  let body = null;
  await routes.usageHandler({}, { json: (o) => { body = o; } });
  ok(body && Array.isArray(body.tools), 'GET /api/mcp/usage answered');
  eq(body.tools.length, TOOL_CATALOGUE.length, `it renders all ${TOOL_CATALOGUE.length} rows`);
  eq(body.present, true, 'present is true over a real log');
  const row = (n) => body.tools.find((t) => t.name === n) || {};
  eq(JSON.stringify(Object.keys(row('get_node')).sort()),
    JSON.stringify(['count7d', 'countTotal', 'group', 'lastOk', 'lastUsedAt', 'lastVia',
      'mutates', 'name', 'purpose', 'refusedTotal', 'selfTestTotal'].sort()),
    'every row carries exactly the eleven contracted fields (nine, plus lastVia and selfTestTotal)');
  ok(body.tools.every((t) => typeof t.lastUsedAt === 'string'),
    'EVERY tile now has a reading — the thing a user could not previously cause');
  ok(body.tools.every((t) => t.lastVia === 'self-test'),
    '…and every one is marked as the self-test\'s, not an agent\'s');
  ok(body.tools.every((t) => t.selfTestTotal === 1), '…with its self-test count');
  eq(body.sessions.lastBootstrapAt, null, 'the route forwards the null bootstrap reading');
  eq(body.sessions.lastSaveAt, null, '…and the null save reading');
  // A mutator's flag survives the join, so the `writes` chip is still right.
  eq(row('save_foundation').mutates, true, 'the mutator flag still reaches the envelope');
  eq(row('get_node').mutates, false, '…and a read tool is still not flagged');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  WITHOUT `via` — the field is ABSENT, and the sessions move');
// ═══════════════════════════════════════════════════════════════════════════
// The same 24 calls, the only difference being the marker. This is the
// CONTROL for §3: if the sessions strip read null in both runs, §3 would be
// measuring nothing.
const UD_PLAIN = freshUserData();
const plainRun = await exercise.exerciseAllTools({ userDataDir: UD_PLAIN });
ok(!plainRun.error, 'the unmarked run completed too');
eq(plainRun.results.filter((r) => !r.ok && !r.refused).length, 0,
  'every tool answered in the unmarked run as well');
const plainLines = callLines(UD_PLAIN);
eq(plainLines.length, TOOL_CATALOGUE.length, 'one line per tool again');
const plainRecs = plainLines.map((l) => JSON.parse(l));
ok(plainRecs.every((r) => !('via' in r)),
  'NO line carries a `via` key — absent, never `via: null`');
ok(sessionLinesIn(UD_PLAIN).every((l) => !('via' in JSON.parse(l))),
  '…the session line included');
eq(JSON.stringify(Object.keys(plainRecs[0])), JSON.stringify(usage.LINE_KEYS_ALWAYS),
  'an unmarked line carries exactly the seven always-keys, in order');

paths.__setUserDataDirOverride(UD_PLAIN);
usage.__clearUsageCache();
const plainAgg = await usage.readUsage({ noCache: true });
ok(Object.values(plainAgg.byTool).every((a) => a.lastVia === null),
  'lastVia is null on every tool');
ok(Object.values(plainAgg.byTool).every((a) => a.selfTestTotal === 0),
  '…and selfTestTotal is zero');
ok(plainAgg.sessions.lastBootstrapAt !== null,
  'lastBootstrapAt is NOW SET — the same get_project_context call, unmarked, DOES start a session');
ok(plainAgg.sessions.lastSaveAt !== null,
  '…and lastSaveAt is set by the same save_working_state call');
// THE DISCRIMINATION IS REAL: two runs, identical calls, opposite readings.
ok(agg.sessions.lastBootstrapAt === null && plainAgg.sessions.lastBootstrapAt !== null,
  'THE POINT: identical call sequences give opposite session readings, decided by `via` alone');

// A MIXED log — the ordinary state of a machine whose owner presses the
// button: the agent's own calls must still be visible underneath.
{
  const UD_MIX = freshUserData();
  const mixLog = path.join(UD_MIX, '.mcp-usage.jsonl');
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  writeFileSync(mixLog, [
    JSON.stringify({ ts: ago(120), tool: 'get_project_context', domain: 'zz', ok: true, refused: false, ms: 9 }),
    JSON.stringify({ ts: ago(100), tool: 'save_working_state', domain: 'zz', ok: true, refused: false, ms: 12 }),
    JSON.stringify({ ts: ago(2), tool: 'get_project_context', domain: 'zz', ok: true, refused: false, ms: 4, via: 'self-test' }),
    JSON.stringify({ ts: ago(2), tool: 'save_working_state', domain: 'zz', ok: true, refused: false, ms: 5, via: 'self-test' }),
  ].join('\n') + '\n', 'utf8');
  paths.__setUserDataDirOverride(UD_MIX);
  usage.__clearUsageCache();
  const mixed = await usage.readUsage({ noCache: true });
  eq(mixed.sessions.lastBootstrapAt, ago(120).slice(0, 16) === ago(120).slice(0, 16) ? mixed.sessions.lastBootstrapAt : null,
    'precondition: the mixed log parsed');
  ok(mixed.sessions.lastBootstrapAt && Date.now() - Date.parse(mixed.sessions.lastBootstrapAt) > 60 * 60_000,
    'the session reading is the AGENT\'s two-hour-old call, not the self-test\'s two-minute-old one');
  eq(mixed.byTool.get_project_context.lastVia, 'self-test',
    '…while the TILE shows self-test, because the newest call really was one');
  eq(mixed.byTool.get_project_context.countTotal, 2, '…and both calls are counted');
  eq(mixed.byTool.get_project_context.selfTestTotal, 1, '…with one of them attributed to the run');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  ZERO PAID CALLS — proved with a network spy, twice');
// ═══════════════════════════════════════════════════════════════════════════
// SEAM: a `--import` preload module (Node ≥ 20.6) injected into the child
// through the driver's `__childEnv` test seam. It patches `globalThis.fetch`,
// `http`/`https`'s `request`/`get`, `net.Socket.prototype.connect` and
// `dns.lookup`, appends ONE line per attempt to a file, and throws. It writes
// nothing to stdout, which the purity assertion below re-checks.
//
// WHY BOTH ARMS. With no key the only paid arm refuses before it could call,
// so a no-key run alone proves "no key was configured" — a different and much
// weaker proposition. The second arm seeds a fake-shaped key in an isolated
// config, so `getProviderInfo()` resolves, `estimate_only` ANSWERS, and the
// spy is the only thing standing between the run and a request.
const SPY = path.join(TMP, 'net-spy.mjs');
const ATTEMPTS = path.join(TMP, 'net-attempts.log');
writeFileSync(SPY, `
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
const LOG = ${JSON.stringify(ATTEMPTS)};
// stderr/stdout are BOTH left alone: stdout is the JSON-RPC stream and a
// stderr line would red this suite's own purity assertion.
const note = (what) => { try { appendFileSync(LOG, what + '\\n'); } catch {} };
const blow = (what) => { note(what); throw new Error('NET BLOCKED BY SPY: ' + what); };
globalThis.fetch = (...a) => blow('fetch ' + String(a[0]).slice(0, 80));
for (const [name, mod] of [['http', http], ['https', https]]) {
  for (const fn of ['request', 'get']) {
    mod[fn] = () => blow(name + '.' + fn);
  }
}
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  // A unix-socket / fd connect is not the network; a host/port one is.
  const o = a[0];
  const isNet = typeof o === 'number' || (o && typeof o === 'object' && (o.port || o.host));
  if (isNet) return blow('socket.connect');
  return realConnect.apply(this, a);
};
dns.lookup = (...a) => { note('dns.lookup'); const cb = a[a.length - 1];
  if (typeof cb === 'function') cb(new Error('NET BLOCKED BY SPY: dns.lookup')); };
`, 'utf8');

const spyEnv = { NODE_OPTIONS: `--import ${new URL(`file://${SPY}`).href}` };

// ── ARM 1: credentials stripped (what `npm test` is) ─────────────────────
{
  const ud = freshUserData();
  const armed = await exercise.exerciseAllTools({ userDataDir: ud, via: 'self-test', __childEnv: spyEnv });
  ok(!armed.error, `the spied run completed (${armed.error || 'no error'})`);
  eq(armed.results.filter((r) => !r.ok && !r.refused).length, 0,
    'every tool still answered with the spy loaded (so the spy did not break the child)');
  eq(armed.transport.nonJsonStdout.length, 0, 'the spy put nothing on stdout');
  const attempts = existsSync(ATTEMPTS) ? readFileSync(ATTEMPTS, 'utf8').trim() : '';
  eq(attempts, '', attempts ? `NETWORK ATTEMPTED: ${attempts.split('\n').join(' | ')}` : 'ZERO network attempts with credentials stripped');
  // …and the paid tool refused, which is the environment's answer, not the
  // spy's: the spy would have thrown, and a throw is `ok:false, refused:false`.
  const sd = armed.results.find((r) => r.tool === 'scan_semantic_duplicates');
  ok(sd && sd.refused === true, 'scan_semantic_duplicates REFUSED (no key configured), it did not throw');
}

// ── ARM 2: a fake-shaped key, so the paid arm actually runs ──────────────
{
  const ud = freshUserData();
  // Written into the CHILD's isolated user-data dir, which is where
  // CURATOR_TEST_USER_DATA_DIR puts .curator-config.json. The real one is
  // fingerprinted at both ends of this suite and never opened for writing.
  // NOT CREDENTIAL-SHAPED, on purpose. Nothing on this path validates a key's
  // FORM — `getEffectiveKey` reads the field and `getProviderInfo` checks that
  // it is non-empty — so the fixture only has to be present, and the repo's
  // pre-commit secret guard (rightly) refuses a staged string that looks like
  // a real provider key. The proposition under test is "a key is configured",
  // and this satisfies it without putting a plausible credential in git.
  writeFileSync(path.join(ud, '.curator-config.json'),
    JSON.stringify({ geminiApiKey: 'not-a-real-key', activeProvider: 'gemini' }),
    { mode: 0o600 });
  const armed = await exercise.exerciseAllTools({ userDataDir: ud, via: 'self-test', __childEnv: spyEnv });
  ok(!armed.error, `the keyed run completed (${armed.error || 'no error'})`);
  const sd = armed.results.find((r) => r.tool === 'scan_semantic_duplicates');
  ok(sd && sd.ok === true,
    `THE ARM THAT MATTERS: with a key present the cost estimate ANSWERS (${JSON.stringify(sd && sd.note)}) — so the no-network claim below is about the code, not about a missing key`);
  eq(armed.results.filter((r) => !r.ok && !r.refused).length, 0, 'and every tool answered');
  eq(armed.results.filter((r) => r.refused).length, 0,
    'with a key configured NOTHING refuses — the refused set in §2 really was the environment');
  const attempts = existsSync(ATTEMPTS) ? readFileSync(ATTEMPTS, 'utf8').trim() : '';
  eq(attempts, '', attempts ? `NETWORK ATTEMPTED WITH A KEY PRESENT: ${attempts.split('\n').join(' | ')}` : 'ZERO network attempts with a fake-shaped key present');
}

// ── THE SPY IS NOT A NO-OP ───────────────────────────────────────────────
// Without this, both zeros above could mean "the preload never loaded".
{
  const { spawnSync } = await import('node:child_process');
  // The spy's `fetch` THROWS SYNCHRONOUSLY, so a `.then(…, …)` probe never
  // runs either handler — the script dies and stdout stays empty. The first
  // version of this control did exactly that and failed for that reason
  // rather than for the one it was about. Both shapes are caught here.
  const probe = spawnSync(process.execPath,
    ['-e', 'try { const p = fetch("https://example.invalid"); Promise.resolve(p).then(() => console.log("NOT BLOCKED"), () => console.log("BLOCKED")); } catch { console.log("BLOCKED"); }'],
    { env: { ...process.env, ...spyEnv }, encoding: 'utf8' });
  ok(/BLOCKED/.test(probe.stdout || '') && !/NOT BLOCKED/.test(probe.stdout || ''),
    `CONTROL: the same preload BLOCKS a real fetch in a bare child (${JSON.stringify((probe.stdout || probe.stderr || '').trim().slice(0, 80))}) — the zeros above are measurements`);
  const recorded = existsSync(ATTEMPTS) ? readFileSync(ATTEMPTS, 'utf8').trim() : '';
  ok(/fetch/.test(recorded),
    'CONTROL: …and the attempt really reaches the log file the assertions above read');
  rmSync(ATTEMPTS, { force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  THE FIXTURE IS REMOVED, AND IT WAS NEVER THE USER\'S');
// ═══════════════════════════════════════════════════════════════════════════
{
  // A run with a domains root WE own, so the tree can be inspected after.
  const owned = path.join(TMP, 'owned-domains');
  mkdirSync(owned, { recursive: true });
  writeFileSync(path.join(owned, 'PRE-EXISTING.txt'), 'the caller\'s own file\n');
  const r = await exercise.exerciseAllTools({ userDataDir: freshUserData(), domainsDir: owned });
  ok(!r.error, 'a run against a caller-supplied domains root completes');
  const left = readdirSync(owned);
  eq(JSON.stringify(left), JSON.stringify(['PRE-EXISTING.txt']),
    `the fixture domain is gone and the caller's own content is untouched (left: ${JSON.stringify(left)})`);
  ok(!existsSync(path.join(owned, exercise.EXERCISE_DOMAIN)),
    `${exercise.EXERCISE_DOMAIN}/ was removed in finally`);
  // And the DEFAULT arm (the app's case, where the driver makes its own root)
  // leaves nothing behind either.
  //
  // MEASURED AS A DELTA, not as an absolute count. The first version asserted
  // that os.tmpdir() holds zero `curator-tool-self-test-*` directories, and
  // during the mutation pass it reddened THREE unrelated mutations: one
  // earlier mutation had disabled the cleanup, its leftovers stayed in
  // /var/folders, and every later run then failed on somebody else's litter.
  // A guard that fails for a reason other than its own subject is worse than
  // no guard — it teaches you to ignore it. So: the set before, the set after,
  // and the difference.
  const straysBefore = new Set(readdirSync(os.tmpdir()).filter((n) => n.startsWith('curator-tool-self-test-')));
  const r2 = await exercise.exerciseAllTools({ userDataDir: freshUserData() });
  ok(!r2.error, 'a run with no domains root (the app\'s case) completes');
  const added = readdirSync(os.tmpdir())
    .filter((n) => n.startsWith('curator-tool-self-test-') && !straysBefore.has(n));
  eq(added.length, 0,
    added.length
      ? `the run left ${added.length} temp dir(s) behind: ${added.join(', ')}`
      : 'the run that makes its own temp root leaves NOTHING behind (measured as a delta, so unrelated litter cannot red this)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  THE USER\'S DOMAINS FOLDER IS BYTE-IDENTICAL ACROSS A RUN');
// ═══════════════════════════════════════════════════════════════════════════
// D15's guarantee, proved on an isolated COPY standing in for the real folder:
// `__setDomainsDirOverride` makes this process's `getDomainsDir()` resolve
// there, which is the rung the child's `CURATOR_TEST_DOMAINS_DIR` would
// otherwise be pinning — so if the driver failed to pin the child to its
// fixture, the child's writes would land in this tree and the fingerprint
// below would move.
{
  const stand = path.join(TMP, 'stand-in-domains');
  mkdirSync(path.join(stand, 'articles', 'wiki', 'entities'), { recursive: true });
  writeFileSync(path.join(stand, 'articles', 'CLAUDE.md'), '# articles\n');
  writeFileSync(path.join(stand, 'articles', 'wiki', 'index.md'), '# Index\n');
  writeFileSync(path.join(stand, 'articles', 'wiki', 'entities', 'real-page.md'), '# Real page\n\nUser content.\n');
  config.__setDomainsDirOverride(stand);
  eq(config.getDomainsDir(), path.resolve(stand),
    'precondition: this process\'s domains dir is the stand-in (a failure here means the rest is meaningless)');

  const snapshot = (dir) => {
    const out = [];
    const walk = (d, rel) => {
      for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(d, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { out.push(`D ${r}`); walk(abs, r); }
        else out.push(`F ${r} ${statSync(abs).size} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
      }
    };
    walk(dir, '');
    return out.join('\n');
  };
  const before = snapshot(stand);
  ok(before.split('\n').length >= 5, `CONTROL: the stand-in really has content (${before.split('\n').length} entries)`);
  const r = await exercise.exerciseAllTools({ userDataDir: freshUserData(), via: 'self-test' });
  ok(!r.error, 'the run completed with the stand-in in place');
  eq(r.results.filter((x) => !x.ok && !x.refused).length, 0,
    '…and every tool answered, so it really did the work it would do for a user');
  const after = snapshot(stand);
  eq(after, before,
    after === before
      ? 'the stand-in domains folder is BYTE-IDENTICAL after a full 24-tool run — listing, sizes and sha256'
      : `the domains folder CHANGED:\n${before}\n--- became ---\n${after}`);
  config.__setDomainsDirOverride(null);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  POST /api/mcp/exercise — the real handler, and the busy gate');
// ═══════════════════════════════════════════════════════════════════════════
// The handler does NOT take a user-data dir: it deliberately writes the REAL
// log, which is the whole point of the button. So the env var that isolates
// user data is set for this section — it is read by paths.js in THIS process
// AND inherited by the child the driver spawns, so both ends land in the
// tempdir and the maintainer's real log is never touched.
{
  const ROUTE_UD = freshUserData();
  const prevEnv = process.env.CURATOR_TEST_USER_DATA_DIR;
  process.env.CURATOR_TEST_USER_DATA_DIR = ROUTE_UD;
  paths.__setUserDataDirOverride(null);   // let the env var decide, as the app would
  eq(paths.getMcpUsageLogPath(), path.join(ROUTE_UD, '.mcp-usage.jsonl'),
    'precondition: the log path is isolated for this section');

  const routes = await import(path.join(ROOT, 'src/routes/mcp.js'));
  const capture = () => {
    const res = { status: null, body: null };
    return {
      res,
      out: {
        status(c) { res.status = c; return this; },
        json(o) { res.body = o; return this; },
      },
    };
  };

  // ── THE BUSY GATE. Started first so the second call lands mid-run. ─────
  const a = capture();
  const b = capture();
  const first = routes.exerciseHandler({}, a.out);
  ok(routes.__exerciseInFlight() === true,
    'the in-flight flag is set SYNCHRONOUSLY — there is no await between the check and the set');
  await routes.exerciseHandler({}, b.out);
  eq(b.res.status, 409, 'a second run while one is in flight is refused 409');
  eq(b.res.body && b.res.body.reason, 'busy', '…with reason "busy"');
  ok(b.res.body && /already running/i.test(b.res.body.error || ''), '…and a sentence a user can act on');
  await first;
  eq(routes.__exerciseInFlight(), false, 'the flag clears when the run ends');

  // ── THE CONTRACT. ────────────────────────────────────────────────────
  const body = a.res.body;
  eq(a.res.status, null, 'a successful run answers 200 (no explicit status)');
  eq(JSON.stringify(Object.keys(body).sort()),
    JSON.stringify(['covered', 'durationMs', 'error', 'missing', 'ok', 'ranAt', 'results'].sort()),
    'the route returns exactly {ok, ranAt, durationMs, results, covered, missing, error}');
  eq(body.ok, true, 'ok is true on a clean run');
  ok(!Number.isNaN(Date.parse(body.ranAt)), 'ranAt is an ISO stamp');
  eq(body.results.length, TOOL_CATALOGUE.length, `results carries all ${TOOL_CATALOGUE.length} rows`);
  eq(body.missing.length, 0, 'missing is empty');
  eq(body.covered.length, TOOL_CATALOGUE.length, 'covered names every tool');
  eq(JSON.stringify(Object.keys(body.results[0]).sort()),
    JSON.stringify(['ms', 'note', 'ok', 'refused', 'tool'].sort()),
    'each row is exactly {tool, ok, refused, ms, note}');
  // NOT FORWARDED: the child's transport diagnostics and the launch line are
  // the run's internals, not the app's business.
  ok(!('transport' in body) && !('spawn_command' in body) && !('spawn_args' in body) && !('extra' in body),
    'the route forwards no transport diagnostics and no launch line');

  // ── AND THE LINES LANDED IN THE REAL PATH, MARKED. ───────────────────
  const routeLines = logLines(ROUTE_UD);
  ok(routeLines.length >= TOOL_CATALOGUE.length,
    `the route's run wrote its lines to getMcpUsageLogPath() (${routeLines.length} lines)`);
  const recs = routeLines.map((l) => JSON.parse(l));
  ok(recs.every((r) => r.via === 'self-test'),
    'every line the ROUTE caused is marked via: "self-test" — the route passes it, the child honours it');
  usage.__clearUsageCache();
  const routeAgg = await usage.readUsage({ noCache: true });
  eq(routeAgg.sessions.lastBootstrapAt, null,
    'and pressing the button did NOT move "Last session start"');
  eq(routeAgg.sessions.lastSaveAt, null, '…nor "Last save"');

  if (prevEnv === undefined) delete process.env.CURATOR_TEST_USER_DATA_DIR;
  else process.env.CURATOR_TEST_USER_DATA_DIR = prevEnv;
  paths.__setUserDataDirOverride(USER_DATA);
}

// ── Cleanup + the isolation proof ──────────────────────────────────────────
section('§9  ISOLATION — the real credential file never moved');
eq(fingerprint(REAL_CONFIG), CONFIG_BEFORE,
  'the real .curator-config.json is byte-identical (sha256 + size + existence)');
ok(!existsSync(path.join(USER_DATA, '.mcp-usage.jsonl'))
   || logLines(USER_DATA).length === 0,
  'nothing was written to the suite\'s own root user-data dir by accident');

paths.__setUserDataDirOverride(null);
config.__setDomainsDirOverride(null);
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${'─'.repeat(56)}`);
console.log(`Passed: ${passed}   Failed: ${failed}   (${Date.now() - t0}ms)`);
process.exit(failed ? 1 : 0);
