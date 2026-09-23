#!/usr/bin/env node
/**
 * OFFLINE — the MCP tool-usage log (v3.60.0) and the map it feeds.
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * This release puts a new FILE on disk, written from the MCP child process on
 * every tool call, and shows what it says in the app under a privacy claim.
 * Four things can go wrong, and three of them are silent:
 *
 *   1. CONTENT LEAKS IN. The app tells the user "no arguments or content
 *      logged". One `args` spread, one `err.message`, one `query` field, and
 *      that sentence is false on every machine that auto-updates. §1 drives
 *      the REAL dispatch handler with 10 KB arguments and asserts the line's
 *      key set and its size.
 *   2. IT LEAVES THE MACHINE. The log is machine-local exhaust. Inside
 *      `getDomainsDir()` it would be committed and pushed with the wiki by
 *      Personal Sync — the class this repo has shipped seven times. §2.
 *   3. IT BREAKS A TOOL CALL. Observability that can fail a save is worse than
 *      no observability. §3 makes the log path a directory and requires the
 *      call to answer normally, with exactly ONE stderr line per process.
 *   4. THE CATALOGUE DRIFTS. `mcp/tools/catalogue.js` is a second list of the
 *      same 24 tools, and the app labels the map from it. §6 compares it to
 *      the real `tools` array IN ORDER, and its `mutates` column to an
 *      EXECUTED `refuseIfReadonly` census over each handler's own source — the
 *      rule CLAUDE.md states twice: derive mutators from the call sites, never
 *      from prose.
 *
 * §7 then does the whole thing over real stdio JSON-RPC, because everything
 * above runs in-process and cannot see the one property that only exists in
 * the child: that adding a file append to the dispatch path did not put a byte
 * on stdout, where the JSON-RPC framing lives (the v2.5.3 bug).
 *
 * §9-§12 are v3.63.0's, and three of the four are about a reading being FALSE
 * rather than absent, which is the class this log was built to avoid:
 *
 *   §9  `sid`. The meter's one grouping key. If it moves inside a process
 *       every call is a session; if two processes share one, two sessions
 *       merge into a session that read and saved when each did half. Driven
 *       against the real dispatch AND by starting node twice.
 *   §10 `client`. MCP revision 2026-07-28 REMOVED the `initialize` handshake,
 *       so the name is read from two eras — and the app's own self-test only
 *       ever exercises the old one. Each arm is driven ALONE, with a control
 *       proving the other is genuinely unreachable in that case.
 *   §11 That NOTHING branches on it (Decision I, and the specification's own
 *       instruction). A source sweep of `mcp/**` with a planted violation.
 *   §12 `summariseSessions`, over a hand-written log carrying every case: a
 *       refused save, a self-test, legacy lines with no `sid`, a second
 *       project, and a session whose session line is gone.
 *
 * SAFETY — never touches real user data. Every path resolves through
 * `__setUserDataDirOverride` / `__setDomainsDirOverride` at a mkdtemp, and the
 * spawned child gets `CURATOR_TEST_USER_DATA_DIR` + `CURATOR_TEST_DOMAINS_DIR`
 * with provider and GitHub credentials stripped. No network, no LLM call.
 */
import { spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MCP_SERVER = path.join(ROOT, 'mcp', 'server.js');

let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
};
const eq = (a, b, label) => ok(a === b, `${label}${a === b ? '' : `\n        expected: ${JSON.stringify(b)}\n        actual:   ${JSON.stringify(a)}`}`);
const section = (t) => console.log(`\n${t}`);

const t0 = Date.now();

// ── Fixture ────────────────────────────────────────────────────────────────
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-mcp-usage-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
const DOM = 'zz-usage';
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(path.join(DOMAINS, DOM, 'wiki', 'entities'), { recursive: true });
writeFileSync(path.join(DOMAINS, DOM, 'CLAUDE.md'), '# zz-usage\n\nThrowaway fixture.\n');
writeFileSync(path.join(DOMAINS, DOM, 'wiki', 'entities', 'alpha.md'), '# Alpha\n\nA page.\n');

const paths = await import(path.join(ROOT, 'src/brain/paths.js'));
const config = await import(path.join(ROOT, 'src/brain/config.js'));
paths.__setUserDataDirOverride(USER_DATA);
config.__setDomainsDirOverride(DOMAINS);

const usage = await import(path.join(ROOT, 'src/brain/mcp-usage.js'));
const { registerTools, tools: registry } = await import(path.join(ROOT, 'mcp/tools/index.js'));
const { createStorageAdapter } = await import(path.join(ROOT, 'mcp/storage/local.js'));
const { TOOL_CATALOGUE } = await import(path.join(ROOT, 'mcp/tools/catalogue.js'));

const LOG = paths.getMcpUsageLogPath();
const LOG_PREV = `${LOG}.1`;

/** The real dispatch handler, wired exactly as mcp/server.js wires it. */
function dispatchWith(storage) {
  const handlers = new Map();
  registerTools({ setRequestHandler: (schema, fn) => handlers.set(schema, fn) }, storage);
  const fn = handlers.get(CallToolRequestSchema);
  if (!fn) throw new Error('CallToolRequestSchema handler was not registered');
  return (name, args) => fn({ params: { name, arguments: args } });
}
const storage = createStorageAdapter({ domainsPath: DOMAINS });
const call = dispatchWith(storage);

const clearLog = () => {
  for (const f of [LOG, LOG_PREV]) { try { rmSync(f, { recursive: true, force: true }); } catch { /* absent */ } }
  usage.__clearUsageCache();
};
const readLines = (file = LOG) => {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
};
/**
 * v3.63.0 — the log now holds TWO kinds of line. A process writes ONE
 * `{"ev":"session"}` line, in the same append as its first tool line, and a
 * tool line per call after that. Every assertion below that is about a CALL
 * reads tool lines; §9 is where the session line itself is asserted.
 *
 * NOTE `clearLog()` deliberately does NOT re-arm the session line: the module
 * is one process for this whole file, so only the very first call in §1 writes
 * one, and every later section sees exactly the tool lines it caused. §9 and
 * §10 re-arm it EXPLICITLY, which is the only way it is ever written twice.
 */
const toolLines = (file = LOG) => readLines(file).filter((l) => JSON.parse(l).ev !== 'session');
const sessionLines = (file = LOG) => readLines(file).filter((l) => JSON.parse(l).ev === 'session');
/** The append is fire-and-forget; give the microtask + fs write a moment. */
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));
/**
 * §7 spawns a real child process and appends to CHILD_LOG fire-and-forget
 * from inside it (`server.oninitialized`, and the dispatch handler after
 * every call). A fixed `settle()` before reading that file is a race, not a
 * wait: its true duration is runner load, not wall-clock time, so a sleep
 * long enough on a maintainer's Mac can still lose on a slower CI box (seen
 * live on GitHub Actions run 35503086338 — 447 passed / 1 failed at exactly
 * this read). Poll instead: re-read the file every `everyMs` until
 * `predicate` holds or `timeoutMs` passes, then return whatever was last
 * read — a timeout still hands back real (short) state for the existing
 * assertions to name, rather than throwing a generic timeout error.
 *
 * Only valid for a POSITIVE claim ("a line exists" / "N lines exist"). A
 * claim that NOTHING MORE was written cannot be polled — there is no
 * predicate that distinguishes "settled" from "about to grow" — so that kind
 * of read keeps its fixed settle (see the one after the child is killed,
 * below, with a comment explaining why it stays).
 */
const waitForLog = async (file, predicate, { timeoutMs = 5000, everyMs = 25 } = {}) => {
  const read = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()) : []);
  const deadline = Date.now() + timeoutMs;
  let lines = read();
  while (!predicate(lines) && Date.now() < deadline) {
    await settle(everyMs);
    lines = read();
  }
  return lines;
};

// ═══════════════════════════════════════════════════════════════════════════
section('§1  THE LINE — six keys, no content, whatever the caller sends');
// ═══════════════════════════════════════════════════════════════════════════
clearLog();

const BIG = 'x'.repeat(10 * 1024);   // a 10 KB argument, per the invariant

// (a) A successful read.
const okRes = await call('list_domains', {});
ok(!okRes.isError && /zz-usage/.test(okRes.content[0].text), 'list_domains answered normally');
await settle();
let lines = readLines();
eq(lines.length, 2, "a process's FIRST call writes two lines: the session line and the tool line");
eq(JSON.parse(lines[0]).ev, 'session', '…and the session line is FIRST — they go in one append, so the order is guaranteed');
eq(toolLines().length, 1, 'exactly one of them is a CALL');
let rec = JSON.parse(toolLines()[0]);
eq(Object.keys(rec).join(','), usage.LINE_KEYS_ALWAYS.join(','),
  'the line carries EXACTLY ts,tool,domain,ok,refused,ms,sid — in that order');
ok(usage.SID_RE.test(rec.sid), `sid is 12 lowercase hex (${rec.sid})`);
ok(!('project' in rec), 'list_domains names no project, so the key is ABSENT — not null');
// `via` (v3.61.0) is the ONE optional key and is ABSENT unless the app's own
// self-test run asked for it. Absent, never `via: null`: a line written by
// this version and a line written by v3.60.0 are byte-comparable, which is
// what lets the map read an old log without a migration.
ok(!('via' in rec), 'and no `via` key on an ordinary call — absent, not null');
eq(rec.tool, 'list_domains', 'the tool name is recorded');
eq(rec.ok, true, 'a successful call records ok:true');
eq(rec.refused, false, '…and refused:false');
ok(Number.isFinite(rec.ms) && rec.ms >= 0, `ms is a number (${rec.ms})`);
ok(!Number.isNaN(Date.parse(rec.ts)), 'ts parses as a date');

// (b) A REFUSAL — a 10 KB slug on a tool that uses the STRUCTURED envelope.
//     This is the content-freedom case and the refusal-detection case in one.
clearLog();
const refusedRes = await call('get_raw_source', { domain: DOM, slug: BIG, note: BIG });
const refusedBody = JSON.parse(refusedRes.content[0].text);
eq(refusedBody.ok, false, 'a 10 KB slug is refused with the `{ok:false, error}` envelope');
await settle();
lines = toolLines();
eq(lines.length, 1, 'the refused call is still recorded');
rec = JSON.parse(lines[0]);
eq(rec.refused, true, 'a `{ok:false}` result is logged as refused:true');
eq(rec.ok, false, '…and ok:false');
eq(rec.domain, DOM, 'the domain slug is recorded (it is a slug, not content)');
ok(Buffer.byteLength(lines[0], 'utf8') < usage.MAX_LINE_BYTES,
  `a call carrying 10 KB of arguments leaves a ${Buffer.byteLength(lines[0], 'utf8')}-byte line (< ${usage.MAX_LINE_BYTES})`);
ok(!lines[0].includes('xxxxx'), 'no argument text reached the line');

// (b2) THE LIMIT OF refusal detection, pinned rather than left to be
//      discovered. Ten of the older READ tools answer a bad argument with a
//      plain STRING ("Invalid slug …"), not the `{ok:false}` envelope, and a
//      string is indistinguishable from a legitimate string answer without
//      reading its TEXT — which this log will never do. Those calls are
//      therefore logged ok:true / refused:false. Asserted here so the day
//      somebody gives get_node the structured envelope, this line reds and the
//      documentation is corrected with it rather than quietly going stale.
clearLog();
const stringRefusal = await call('get_node', { domain: DOM, slug: BIG });
ok(typeof stringRefusal.content[0].text === 'string'
   && stringRefusal.content[0].text.startsWith('Invalid slug'),
  'get_node refuses a bad slug with a plain STRING, not the {ok:false} envelope');
await settle();
rec = JSON.parse(toolLines()[0]);
eq(rec.refused, false, 'KNOWN LIMIT: a string-shaped refusal is logged refused:false…');
eq(rec.ok, true, '…and ok:true — the log cannot see it without reading the message');

// (c) An oversized DOMAIN argument is dropped, not truncated and not written.
clearLog();
await call('get_node', { domain: BIG, slug: 'alpha' });
await settle();
rec = JSON.parse(toolLines()[0]);
eq(rec.domain, null, 'a 10 KB `domain` argument is recorded as null, never truncated into the line');
ok(Buffer.byteLength(toolLines()[0], 'utf8') < usage.MAX_LINE_BYTES, 'that line is under the ceiling too');

// (d) An unknown tool name is a CLIENT string — logged as "unknown".
clearLog();
const unknownRes = await call(`zz_${BIG}`, {});
ok(unknownRes.isError, 'an unknown tool still returns its error response');
await settle();
rec = JSON.parse(toolLines()[0]);
eq(rec.tool, 'unknown', 'an unknown tool name is logged as "unknown", never as the client string');
ok(!toolLines()[0].includes('zz_x'), 'the client-supplied name is nowhere in the line');
// The 10 KB name above is ALSO caught by buildUsageLine's shape check, so on
// its own it cannot tell the dispatch's `'unknown'` apart from that second
// guard. A SHORT, well-shaped name that is simply not a registered tool can:
// only the dispatch knows the difference between a real tool and a plausible
// invention, and an invented name is still a string the client chose.
clearLog();
await call('zz_not_a_tool', {});
await settle();
eq(JSON.parse(toolLines()[0]).tool, 'unknown',
  'a SHORT, well-shaped but unregistered name is logged as "unknown" too (the dispatch decides, not the shape check)');

// (e) A handler that THROWS is ok:false, refused:false — the third state.
clearLog();
const throwingStorage = {
  ...storage,
  baseExists: async () => { throw new Error('secret-detail-that-must-not-be-logged'); },
};
const throwRes = await dispatchWith(throwingStorage)('list_domains', {});
ok(throwRes.isError, 'a throwing handler returns an isError response');
await settle();
rec = JSON.parse(toolLines()[0]);
eq(rec.ok, false, 'a throw records ok:false');
eq(rec.refused, false, '…and refused:false — a throw is not a refusal');
ok(!toolLines()[0].includes('secret-detail'), 'the error message is NOT in the log');

// (f) buildUsageLine directly — the size proof at the caps, not just in practice.
// The WORST line the caps allow, and it must include `via` — which is why
// v3.61.0 narrowed TOOL_NAME_RE from 40 characters to 32: at 40 the worst line
// with `via` came to 201 bytes and the ⓘ's "under 200 bytes however large the
// call was" would have become false.
const maxLine = usage.buildUsageLine(
  { tool: 'a'.repeat(32), domain: 'b'.repeat(48), project: 'c'.repeat(64),
    sid: '0123456789ab', ok: false, refused: true, ms: 86_400_000, via: 'self-test' },
  '2026-09-18T12:34:56.789Z');
eq(Buffer.byteLength(maxLine, 'utf8'), 291,
  `the WORST line every cap allows is exactly 291 bytes (got ${Buffer.byteLength(maxLine, 'utf8')}) — arithmetic, not a measurement`);
ok(Buffer.byteLength(maxLine, 'utf8') < usage.MAX_LINE_BYTES,
  `…and that is under the ${usage.MAX_LINE_BYTES}-byte ceiling`);
// THE CEILING IS A STATED BOUND, NOT HEADROOM. The app tells the user in as
// many words how large a line can get, so the number has to be the one the
// arithmetic above proves — a cap of 4096 would leave every assertion here
// true while making the product's sentence needlessly loose, which is how a
// figure quoted to a user stops meaning anything. (Found green: this pair is
// what reds when the constant is widened rather than re-derived.)
eq(usage.MAX_LINE_BYTES, 300, 'MAX_LINE_BYTES is 300 — the number the privacy ⓘ and the docs quote');
ok(usage.MAX_LINE_BYTES - Buffer.byteLength(maxLine, 'utf8') <= 16,
  `the ceiling sits within 16 bytes of the proven worst case (${usage.MAX_LINE_BYTES} − ${Buffer.byteLength(maxLine, 'utf8')})`);
eq(usage.MAX_LINE_BYTES_LABEL, '300 bytes',
  'and the label a view would print is DERIVED from it, never typed a second time');
eq(JSON.parse(maxLine).via, 'self-test', '…and that worst line really does carry via');
eq(JSON.parse(maxLine).project, 'c'.repeat(64), '…and a 64-character project slug, the store\'s own ceiling');
eq(JSON.parse(maxLine).sid, '0123456789ab', '…and the session id');
eq(Object.keys(JSON.parse(maxLine)).join(','), usage.LINE_KEYS.join(','),
  '…with every key present, in LINE_KEYS order');
// The WORST SESSION line, bounded by the same ceiling. A 32-character client
// name is longer than any id the allow-list can write, so this is the widest
// the shape permits even though nothing can actually reach it.
const maxSession = JSON.stringify({
  ts: '2026-09-18T12:34:56.789Z', ev: 'session', sid: '0123456789ab',
  client: 'y'.repeat(32), via: 'self-test',
});
eq(Buffer.byteLength(maxSession, 'utf8'), 131,
  `the widest session line the shape allows is 131 bytes (got ${Buffer.byteLength(maxSession, 'utf8')})`);
ok(Buffer.byteLength(maxSession, 'utf8') < usage.MAX_LINE_BYTES, '…under the same one ceiling');
// A 65-character project is over the store's own bound and is DROPPED, never
// truncated — the same trade DOMAIN_SLUG_RE makes, and what keeps 291 a proof.
ok(!('project' in JSON.parse(usage.buildUsageLine({ tool: 'x', ms: 1, project: 'p'.repeat(65) }, 'T'))),
  'a 65-character project slug is dropped, not truncated into the line');
eq(JSON.parse(usage.buildUsageLine({ tool: 'x', ms: 1, project: 'p'.repeat(64) }, 'T')).project, 'p'.repeat(64),
  'CONTROL: 64 characters is accepted — the bound is a bound, not an off-by-one');
ok(!('project' in JSON.parse(usage.buildUsageLine({ tool: 'x', ms: 1, project: '../escape' }, 'T'))),
  'a project slug with a path segment in it is not a project slug');
eq(JSON.parse(usage.buildUsageLine({ tool: 'a'.repeat(33), ms: 1 }, 'T')).tool, 'unknown',
  'a 33-character tool name is over the bound and is logged as "unknown" (the bound is what makes the size a proof)');
eq(JSON.parse(usage.buildUsageLine({ tool: 'a'.repeat(32), ms: 1 }, 'T')).tool, 'a'.repeat(32),
  'CONTROL: 32 characters is accepted — the narrowing is a bound, not an off-by-one');
eq(JSON.parse(usage.buildUsageLine({ tool: 'scan_semantic_duplicates', ms: 1 }, 'T')).tool,
  'scan_semantic_duplicates',
  'CONTROL: the longest REAL tool name (24) is comfortably inside it');
eq(JSON.parse(usage.buildUsageLine({ tool: 'get node', ms: -5 }, 'T')).tool, 'unknown',
  'a tool name with a space is not a tool name');
eq(JSON.parse(usage.buildUsageLine({ tool: 'x', ms: Infinity }, 'T')).ms, 0,
  'a non-finite ms becomes 0 rather than "null" or an unbounded string');

// ═══════════════════════════════════════════════════════════════════════════
section('§2  LOCAL ONLY — the path is under user-data and outside domains/');
// ═══════════════════════════════════════════════════════════════════════════
eq(path.basename(LOG), '.mcp-usage.jsonl', 'the log is named .mcp-usage.jsonl');
eq(path.dirname(LOG), USER_DATA, 'it resolves under the (isolated) user-data dir');
ok(path.relative(config.getDomainsDir(), LOG).startsWith('..'),
  'it is OUTSIDE the domains folder, which is the synced working tree');
// Re-resolved per call, so a seam set after import still wins — the M1 rule.
const otherDir = path.join(TMP, 'other');
mkdirSync(otherDir, { recursive: true });
paths.__setUserDataDirOverride(otherDir);
eq(paths.getMcpUsageLogPath(), path.join(otherDir, '.mcp-usage.jsonl'),
  'the path is resolved per call, not snapshotted at import');
paths.__setUserDataDirOverride(USER_DATA);

// ═══════════════════════════════════════════════════════════════════════════
section('§3  BEST EFFORT — an unwritable log never costs a tool call');
// ═══════════════════════════════════════════════════════════════════════════
clearLog();
mkdirSync(LOG);   // a DIRECTORY where the file should be: every append fails

const realErr = console.error;
const stderrLines = [];
console.error = (...a) => { stderrLines.push(a.join(' ')); };
usage.__resetUsageWarning();
let blockedRes;
try {
  blockedRes = await call('list_domains', {});
  await settle();
  await call('list_domains', {});
  await call('get_node', { domain: DOM, slug: 'alpha' });
  await settle();
} finally {
  console.error = realErr;
}
ok(!blockedRes.isError && /zz-usage/.test(blockedRes.content[0].text),
  'the tool call still returns its real result with the log unwritable');
eq(stderrLines.length, 1,
  `exactly ONE stderr line across three failing appends (got ${stderrLines.length})`);
ok(/usage log/i.test(stderrLines[0] || ''), 'the one line says what could not be written');
ok(statSync(LOG).isDirectory(), 'nothing clobbered the blocking directory');
rmSync(LOG, { recursive: true, force: true });
usage.__resetUsageWarning();

// ═══════════════════════════════════════════════════════════════════════════
section('§4  ROTATION — bounded at one previous generation');
// ═══════════════════════════════════════════════════════════════════════════
clearLog();
// A synthetic over-cap file whose FIRST line is the oldest record in the store.
const oldest = '2026-01-01T00:00:00.000Z';
const filler = [];
filler.push(JSON.stringify({ ts: oldest, tool: 'get_index', domain: DOM, ok: true, refused: false, ms: 1 }));
while (Buffer.byteLength(filler.join('\n'), 'utf8') < usage.MAX_LOG_BYTES) {
  filler.push(JSON.stringify({ ts: '2026-02-01T00:00:00.000Z', tool: 'get_index', domain: DOM, ok: true, refused: false, ms: 1 }));
}
writeFileSync(LOG, `${filler.join('\n')}\n`, 'utf8');
const preRotateSize = statSync(LOG).size;
ok(preRotateSize >= usage.MAX_LOG_BYTES, `seeded ${preRotateSize} bytes (over the ${usage.MAX_LOG_BYTES} cap)`);

await call('list_domains', {});
await settle(120);
const rotatedExists = existsSync(LOG_PREV);
ok(rotatedExists, 'the over-cap file was rotated to .1');
// Guarded: a missing .1 must FAIL this assertion, not throw ENOENT and abort
// the run before §5–§7 (a mutation that crashes the suite is indistinguishable
// from one the suite cannot see).
eq(rotatedExists ? statSync(LOG_PREV).size : null, preRotateSize,
  'the rotated file is the previous one, byte for byte');
eq(readLines(LOG).length, 1, 'the live log now holds only the new line');
eq(JSON.parse(readLines(LOG)[0]).tool, 'list_domains', '…and it is the call that triggered the rotation');

// One previous generation, never two.
writeFileSync(LOG, `${filler.join('\n')}\n`, 'utf8');
await call('list_domains', {});
await settle(120);
ok(!existsSync(`${LOG}.2`), 'no .2 is ever created — the log is bounded at two files');

usage.__clearUsageCache();
const rotated = await usage.readUsage({ noCache: true });
eq(rotated.logStartedAt, oldest,
  'logStartedAt comes from the first line of the OLDEST file — the reading "not used since this log began" depends on it');
ok(rotated.logBytes > usage.MAX_LOG_BYTES, 'logBytes counts both files');

// ═══════════════════════════════════════════════════════════════════════════
section('§5  readUsage AGGREGATES + the route envelope');
// ═══════════════════════════════════════════════════════════════════════════
clearLog();
const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const seeded = [
  { ts: ago(30 * DAY), tool: 'get_working_state', domain: DOM, ok: true, refused: false, ms: 4 },
  { ts: ago(20 * DAY), tool: 'search_wiki', domain: DOM, ok: true, refused: false, ms: 9 },
  { ts: ago(3 * DAY), tool: 'search_wiki', domain: DOM, ok: true, refused: false, ms: 11 },
  { ts: ago(2 * DAY), tool: 'search_wiki', domain: null, ok: false, refused: true, ms: 1 },
  { ts: ago(1 * DAY), tool: 'get_project_context', domain: DOM, ok: true, refused: false, ms: 20 },
  { ts: ago(60 * 1000), tool: 'save_working_state', domain: DOM, ok: true, refused: false, ms: 33 },
  { ts: 'not-a-date', tool: 'search_wiki' },                       // malformed
  { ts: ago(30 * 1000), tool: 'search_wiki', domain: DOM, ok: false, refused: true, ms: 2 },
];
writeFileSync(LOG, `${seeded.map(o => JSON.stringify(o)).join('\n')}\nnot json at all\n`, 'utf8');
usage.__clearUsageCache();
const agg = await usage.readUsage({ now: NOW, noCache: true });
eq(agg.present, true, 'present is true when the log exists');
eq(agg.logStartedAt, ago(30 * DAY), 'logStartedAt is the first record');
eq(agg.malformedLines, 2, 'both unparseable lines are counted, not thrown on');
const sw = agg.byTool.search_wiki;
eq(sw.countTotal, 4, 'countTotal counts every call of that tool');
eq(sw.count7d, 3, 'count7d counts only the last 7 days (the 20-day-old call is excluded)');
eq(sw.refusedTotal, 2, 'refusedTotal counts the refusals');
eq(sw.lastUsedAt, ago(30 * 1000), 'lastUsedAt is the newest line, not the last parsed');
eq(sw.lastOk, false, 'lastOk is the newest call’s outcome');
eq(agg.sessions.lastBootstrapAt, ago(1 * DAY),
  'lastBootstrapAt takes the newest of get_project_context / get_working_state');
eq(agg.sessions.lastSaveAt, ago(60 * 1000), 'lastSaveAt comes from save_working_state');
eq(agg.byTool.get_node, undefined, 'a tool with no lines has no aggregate at all');

// The cache is keyed on mtime+size of both files: a changed file must be re-read.
const cached = await usage.readUsage({ now: NOW });
eq(cached.lineCount, agg.lineCount, 'a cached read returns the same line count');
writeFileSync(LOG, `${seeded.map(o => JSON.stringify(o)).join('\n')}\n`
  + `${JSON.stringify({ ts: ago(10 * 1000), tool: 'get_tags', domain: DOM, ok: true, refused: false, ms: 5 })}\n`, 'utf8');
const afterChange = await usage.readUsage({ now: NOW });
ok(!!afterChange.byTool.get_tags,
  'appending a line invalidates the cache (a size change is a key change)');

// The route.
const routes = await import(path.join(ROOT, 'src/routes/mcp.js'));
let body = null;
await routes.usageHandler({}, { json: (o) => { body = o; } });
ok(body && Array.isArray(body.tools), 'GET /api/mcp/usage returns a tools array');
eq(body.tools.length, registry.length, `the envelope lists ALL ${registry.length} tools, used or not`);
eq(body.present, true, 'present is forwarded');
eq(body.logStartedAt, ago(30 * DAY), 'logStartedAt is forwarded');
ok(body.logBytes > 0, 'logBytes is forwarded');
eq(body.sessions.lastSaveAt, ago(60 * 1000), 'the two session readings are forwarded');
// `?? {}` on purpose: a tool MISSING from the envelope must red the assertions
// below, not throw a TypeError and take §6 and §7 down with it.
const rowFor = (n) => body.tools.find(t => t.name === n) ?? {};
eq(JSON.stringify(Object.keys(rowFor('search_wiki')).sort()),
  JSON.stringify(['count7d', 'count7dAgent', 'countTotal', 'group', 'lastOk', 'lastUsedAt', 'lastVia',
    'mutates', 'name', 'purpose', 'refusedTotal', 'selfTestTotal'].sort()),
  'every row carries exactly the twelve contracted fields (v3.61.0 added lastVia + selfTestTotal, v3.66.0 count7dAgent)');
eq(rowFor('search_wiki').countTotal, 4, 'a used tool carries its counts');
eq(rowFor('get_node').lastUsedAt, null, 'an unused tool reports lastUsedAt: null…');
eq(rowFor('get_node').countTotal, 0, '…with zero counts — never omitted from the map');
eq(rowFor('save_foundation').mutates, true, 'the mutator flag reaches the envelope');
// The "never say never" rule lives HERE: the UI can only say "not used since
// this log began" if the envelope hands it the log's start.
ok(body.logStartedAt !== null && rowFor('get_node').lastUsedAt === null,
  'an unused tool ships alongside a non-null logStartedAt (the "never say never" rule is expressible)');

// An absent log is an empty map, not an error.
clearLog();
body = null;
await routes.usageHandler({}, { json: (o) => { body = o; } });
eq(body.present, false, 'with no log at all, present is false');
eq(body.logStartedAt, null, '…logStartedAt is null');
eq(body.tools.length, registry.length, '…and every tool is still listed');

// ═══════════════════════════════════════════════════════════════════════════
section('§6  THE CATALOGUE — names in order, mutators by executed census');
// ═══════════════════════════════════════════════════════════════════════════
eq(TOOL_CATALOGUE.map(t => t.name).join(','), registry.map(t => t.definition.name).join(','),
  'catalogue.js lists the SAME tools as the `tools` array, in the SAME order');

// The census. For each registered tool, find its handler's own function body in
// mcp/tools/*.js and look for the refuseIfReadonly call INSIDE it — per
// handler, not per file, so scan_wiki_health and fix_wiki_issue (both in
// health.js) are told apart.
const toolSources = new Map();
for (const f of ['domains.js', 'index-tool.js', 'search.js', 'nodes.js', 'connected.js',
  'summary.js', 'cross.js', 'overview.js', 'tags.js', 'backlinks.js', 'raw-source.js',
  'compile.js', 'health.js', 'dismissed.js', 'working-state.js']) {
  toolSources.set(f, readFileSync(path.join(ROOT, 'mcp/tools', f), 'utf8'));
}
const census = new Map();
const unlocated = [];
for (const t of registry) {
  const decl = `export async function ${t.handler.name}(`;
  let found = false;
  for (const [, src] of toolSources) {
    const i = src.indexOf(decl);
    if (i < 0) continue;
    found = true;
    const rest = src.slice(i);
    const end = rest.search(/\n\}/);            // a top-level closing brace
    const body = end > 0 ? rest.slice(0, end) : rest;
    census.set(t.definition.name, /refuseIfReadonly\s*\(/.test(body));
    break;
  }
  if (!found) unlocated.push(t.handler.name);
}
eq(unlocated.length, 0,
  unlocated.length ? `every handler was located in source (missing: ${unlocated.join(', ')})` : 'every handler was located in source');
// Anti-vacuity: the census must DISCRIMINATE inside one file, or it is
// measuring the file rather than the handler.
ok(census.get('fix_wiki_issue') === true && census.get('scan_wiki_health') === false,
  'the census tells two handlers in health.js apart (fix mutates, scan does not)');
const censusMutators = [...census.entries()].filter(([, m]) => m).map(([n]) => n);
eq(censusMutators.length, 7, `the refuseIfReadonly census finds 7 mutators (got ${censusMutators.length}: ${censusMutators.join(', ')})`);
for (const row of TOOL_CATALOGUE) {
  ok(row.mutates === census.get(row.name),
    `${row.name}: catalogue mutates=${row.mutates} matches the census`);
}
// group is the CAPABILITY split, and must never disagree with mutates.
for (const row of TOOL_CATALOGUE) {
  ok((row.group === 'write') === row.mutates, `${row.name}: group '${row.group}' agrees with mutates`);
}
eq(TOOL_CATALOGUE.filter(t => t.group === 'read').length, 17, '17 tools that read (the capability split the UI shows)');
eq(TOOL_CATALOGUE.filter(t => t.group === 'write').length, 7, '7 tools that write');
for (const row of TOOL_CATALOGUE) {
  const words = row.purpose.trim().split(/\s+/).length;
  ok(words > 0 && words <= 12, `${row.name}: purpose is ${words} words (≤ 12)`);
}
ok(new Set(TOOL_CATALOGUE.map(t => t.purpose)).size === TOOL_CATALOGUE.length,
  'no two tools share a purpose line (a copy-paste row would be invisible otherwise)');
// Pure data: importing catalogue.js must not drag the MCP tool graph into the
// web server, which is the whole reason it exists as a separate file.
ok(!/^\s*import\s/m.test(readFileSync(path.join(ROOT, 'mcp/tools/catalogue.js'), 'utf8')),
  'catalogue.js imports nothing');

// ═══════════════════════════════════════════════════════════════════════════
section('§7  OVER REAL STDIO — the line is written, and stdout stays pure JSON');
// ═══════════════════════════════════════════════════════════════════════════
clearLog();
const CHILD_USER_DATA = path.join(TMP, 'child-userdata');
mkdirSync(CHILD_USER_DATA, { recursive: true });
const CHILD_LOG = path.join(CHILD_USER_DATA, '.mcp-usage.jsonl');

const env = { ...process.env };
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL']) delete env[k];
env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
env.CURATOR_TEST_USER_DATA_DIR = CHILD_USER_DATA;

const child = spawn(process.execPath, [MCP_SERVER, '--domains-path', DOMAINS], { stdio: ['pipe', 'pipe', 'pipe'], env });
const CHILD_PID = child.pid;
let stdoutBuf = '';
let stderrText = '';
const rawStdoutLines = [];
const pending = new Map();
child.stderr.on('data', d => { stderrText += d; });
child.stdout.on('data', (d) => {
  stdoutBuf += d;
  let i;
  while ((i = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, i);
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (!line.trim()) continue;
    rawStdoutLines.push(line);
    let frame = null;
    try { frame = JSON.parse(line); } catch { /* §7 reports it */ }
    if (frame && pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id); }
  }
});
let nextId = 1;
const rpc = (method, params, timeoutMs = 20000) => {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ __timeout: true }); }, timeoutMs);
    pending.set(id, (f) => { clearTimeout(timer); resolve(f); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
};

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'curator-usage', version: '1' } });
ok(!!init?.result?.serverInfo, 'the child initialises');
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const listed = await rpc('tools/list');
eq((listed?.result?.tools || []).length, registry.length, `the wire still carries ${registry.length} tools`);
// v3.64.0: the SESSION line is written at startup, so the log exists before
// any tool has run. What `tools/list` must still not write is a TOOL line —
// listing is not a call, and a tile lit by a client's own catalogue refresh
// would be a false reading. Asserted on the tool lines, which is the claim
// this line has always been about.
{
  // RACE FIX: the session line is appended fire-and-forget from
  // `server.oninitialized`, so an immediate read here can land before the
  // append does on a slow/loaded runner (GitHub Actions run 35503086338).
  // Poll for at least one line instead of reading once; both assertions are
  // unchanged.
  const earlyRaw = await waitForLog(CHILD_LOG, (lines) => lines.length > 0);
  const early = earlyRaw.map((l) => JSON.parse(l));
  ok(early.every((r) => r.ev === 'session'), 'listing tools is not a tool CALL and writes no tool line');
  ok(early.length > 0, '…while the startup session line IS there (v3.64.0 — a bridge that is opened has begun)');
}

const wireOk = await rpc('tools/call', { name: 'list_domains', arguments: {} });
ok(/zz-usage/.test(wireOk?.result?.content?.[0]?.text || ''), 'list_domains answers over the wire');
const wireRefused = await rpc('tools/call', { name: 'get_raw_source', arguments: { domain: DOM, slug: 'x'.repeat(4096) } });
ok(/"ok": false/.test(wireRefused?.result?.content?.[0]?.text || ''), 'the oversized slug is refused over the wire');

// RACE FIX: same as above — the RPC reply for each `tools/call` arrives on
// stdout before that call's log append lands on disk, because the append is
// fire-and-forget. Poll for the three lines the assertions below expect
// (the startup session line + these two tool calls) instead of a fixed
// sleep before a single read; the assertions themselves are unchanged.
const childAll = await waitForLog(CHILD_LOG, (lines) => lines.length >= 3);
// STILL THREE, and still ONE session line — but v3.64.0 moved WHEN it is
// written (from the first tool call to `notifications/initialized`), so its
// POSITION moved: it is now the first line in the file rather than the first
// of a pair. See §13 for the measurement that bought the move.
eq(childAll.length, 3, `the child wrote its session line plus one per tool call (got ${childAll.length})`);
const childSession = childAll.map((l) => JSON.parse(l)).filter((r) => r.ev === 'session');
eq(childSession.length, 1, 'exactly ONE session line from the child — one bridge process is one session');
eq(JSON.parse(childAll[0]).ev, 'session',
  '…and it is the FIRST line in the file, written when the client identified itself');
const childLines = childAll.filter((l) => JSON.parse(l).ev !== 'session');
const childRecs = childLines.map(l => JSON.parse(l));
eq(childRecs[0].tool, 'list_domains', 'the first line is the first call');
eq(childRecs[1].refused, true, 'the refusal is recorded as such from the child too');
// The sid is a real PROCESS fact: minted in the child, identical on all three
// of its lines, and not this process's — the property the grouping rests on.
eq(childSession[0].sid, childRecs[0].sid, 'the session line and the tool lines share one sid');
eq(childRecs[0].sid, childRecs[1].sid, '…and both tool lines carry it');
ok(usage.SID_RE.test(childRecs[0].sid), 'it is 12 lowercase hex');
ok(childRecs[0].sid !== usage.getSessionId(),
  "and it is NOT this test process's sid — the id is minted per PROCESS");
// The self-test client above sent clientInfo.name "curator-usage", which is in
// no allow-list row, so it is recorded as `other` — never the caller's string.
eq(childSession[0].client, 'other', 'an unrecognised clientInfo.name is recorded as "other"');
ok(!childAll.some((l) => l.includes('curator-usage')),
  'the client-supplied name itself is NOWHERE in the file');
ok(childAll.every(l => Buffer.byteLength(l, 'utf8') < usage.MAX_LINE_BYTES), 'every child line is under the ceiling');
ok(!childAll.some(l => l.includes('xxxx')), 'no argument text reached the child’s log');
ok(!existsSync(path.join(DOMAINS, '.mcp-usage.jsonl'))
   && !existsSync(path.join(DOMAINS, DOM, '.mcp-usage.jsonl')),
  'nothing was written into the domains tree');

child.stdin.end();
child.kill();
// NOT a candidate for waitForLog: the claims below are negative ("stderr
// stayed empty", "nothing non-JSON showed up on stdout"). There is no
// predicate that distinguishes "settled" from "about to grow" for an absence
// — polling would just stop at the first successful check and could still
// race a straggling write. This settle only needs to be long enough to let
// any already-in-flight data event from the just-killed child drain; it is
// not waiting on the usage-log append the rest of this section polls for.
await settle(200);
const poison = rawStdoutLines.filter(l => { try { JSON.parse(l); return false; } catch { return true; } });
ok(rawStdoutLines.length > 0, `the child spoke on stdout (${rawStdoutLines.length} lines)`);
ok(poison.length === 0,
  poison.length === 0
    ? `all ${rawStdoutLines.length} stdout lines parse as JSON-RPC`
    : `NON-JSON ON STDOUT — src/brain/mcp-usage.js is now on the MCP import graph; a console.log there reaches Claude Desktop as "Unexpected token …". First: ${JSON.stringify(poison[0].slice(0, 160))}`);
eq(Buffer.byteLength(stderrText, 'utf8'), 0,
  stderrText ? `stderr carried: ${JSON.stringify(stderrText.slice(0, 200))}` : 'stderr is empty — a healthy log says nothing');


// ═══════════════════════════════════════════════════════════════════════════
section('§8  `via` — the one optional key, the literal, and the session gate');
// ═══════════════════════════════════════════════════════════════════════════
// v3.61.0. The app's "Test all N tools" run marks every line it causes, so a
// tile lit by the button is never read as agent use. Two things can go wrong
// and both are silent:
//
//   1. A STRING FROM AN ENVIRONMENT VARIABLE REACHING THE FILE. `via` arrives
//      as `CURATOR_MCP_VIA` on the child, and an env var is a string somebody
//      supplied. The only value this module may ever write is the exact
//      literal — everything else leaves the field absent.
//   2. A SELF-TEST MOVING THE SESSION STRIP. The run CALLS
//      get_project_context and save_working_state. If those lines counted,
//      "Last session start · 2 min" would be true of a button on the Settings
//      screen — a false reading on the one strip the memory layer exists for.

// ── 8a  THE LINE: absent by default, the literal or nothing ───────────────
{
  eq(usage.LINE_KEYS.join(','), 'ts,tool,domain,ok,refused,ms,sid,project,via',
    'LINE_KEYS names the two optional keys last, `via` last of all');
  eq(usage.LINE_KEYS_ALWAYS.join(','), 'ts,tool,domain,ok,refused,ms,sid',
    'LINE_KEYS_ALWAYS is the seven every tool line carries');
  eq(usage.LINE_KEYS_OPTIONAL.join(','), 'project,via', 'and the two optional ones are named apart');
  eq(usage.SESSION_LINE_KEYS.join(','), 'ts,ev,sid,client,via', 'a session line has its own five');
  eq(usage.VIA_SELF_TEST, 'self-test', 'the literal is "self-test"');
  eq(usage.VIA_ENV_VAR, 'CURATOR_MCP_VIA', 'the environment variable is CURATOR_MCP_VIA');

  const plain = JSON.parse(usage.buildUsageLine({ tool: 'get_node', ms: 3 }, 'T'));
  ok(!('via' in plain), 'no `via` argument → the key is ABSENT, not null');
  eq(Object.keys(plain).join(','), usage.LINE_KEYS_ALWAYS.join(','),
    '…so an ordinary line is the seven always-keys and nothing else');
  eq(JSON.parse(usage.buildUsageLine({ tool: 'get_node', ms: 3, via: 'self-test' }, 'T')).via,
    'self-test', 'the literal is recorded');
  eq(Object.keys(JSON.parse(usage.buildUsageLine({ tool: 'get_node', ms: 3, via: 'self-test' }, 'T'))).join(','),
    usage.LINE_KEYS.filter((k) => k !== 'project').join(','),
    '…last — after the seven, and after `project` when there is one');
  // NOT A PATTERN. Every one of these is a string somebody could put in an
  // environment variable, and none of them may reach the file.
  for (const junk of ['agent', 'Self-Test', 'SELF-TEST', 'self-test ', ' self-test',
    'self-test; rm -rf /', 'x'.repeat(10 * 1024), true, 1, {}, [], null, undefined]) {
    const line = usage.buildUsageLine({ tool: 'get_node', ms: 1, via: junk }, 'T');
    ok(!('via' in JSON.parse(line)),
      `via=${JSON.stringify(junk === undefined ? 'undefined' : junk).slice(0, 28)} is not the literal → absent`);
    ok(Buffer.byteLength(line, 'utf8') < usage.MAX_LINE_BYTES,
      `…and the line stays under the ${usage.MAX_LINE_BYTES}-byte ceiling`);
  }
  eq(usage.normaliseVia('self-test'), 'self-test', 'normaliseVia passes the literal');
  eq(usage.normaliseVia('agent'), null, '…and nulls everything else');
  // The env seam is read PER CALL, never snapshotted at import (the M1 rule).
  eq(usage.viaFromEnv({ CURATOR_MCP_VIA: 'self-test' }), 'self-test', 'viaFromEnv reads the variable');
  eq(usage.viaFromEnv({ CURATOR_MCP_VIA: 'anything-else' }), null, '…and refuses any other value');
  eq(usage.viaFromEnv({}), null, '…and an absent variable is null');
}

// ── 8b  THE ENVIRONMENT DRIVES IT, THROUGH THE REAL DISPATCH ─────────────
// The dispatch handler passes no `via` — it knows which tool ran, and only the
// process that SPAWNED this one knows why. So the value has to come off the
// environment inside appendUsage, and this drives the real handler to prove it.
{
  clearLog();
  const prev = process.env.CURATOR_MCP_VIA;
  process.env.CURATOR_MCP_VIA = 'self-test';
  try {
    await call('list_domains', {});
    await settle();
    const rec = JSON.parse(toolLines()[0]);
    eq(rec.via, 'self-test',
      'with CURATOR_MCP_VIA=self-test in the environment, the real dispatch handler\'s line carries it');
    // A junk value in the same variable must not reach the file.
    clearLog();
    process.env.CURATOR_MCP_VIA = 'pretend-i-am-an-agent';
    await call('list_domains', {});
    await settle();
    ok(!('via' in JSON.parse(toolLines()[0])),
      'CONTROL: a junk value in the SAME variable leaves the field absent');
    clearLog();
    delete process.env.CURATOR_MCP_VIA;
    await call('list_domains', {});
    await settle();
    ok(!('via' in JSON.parse(toolLines()[0])),
      'CONTROL: with the variable unset the field is absent — this is the ordinary MCP client');
  } finally {
    if (prev === undefined) delete process.env.CURATOR_MCP_VIA;
    else process.env.CURATOR_MCP_VIA = prev;
  }
}

// ── 8c  THE BOOTSTRAP EXCLUSION, AND ITS CONTROL ─────────────────────────
// Two logs whose lines are IDENTICAL but for `via`. The session readings must
// be opposite, or the exclusion is not doing anything.
{
  const NOW2 = Date.parse('2026-09-18T12:00:00.000Z');
  const at = (min) => new Date(NOW2 - min * 60_000).toISOString();
  const seed = (via) => [
    { ts: at(30), tool: 'get_project_context', domain: DOM, ok: true, refused: false, ms: 9, ...(via ? { via } : {}) },
    { ts: at(20), tool: 'get_working_state', domain: DOM, ok: true, refused: false, ms: 4, ...(via ? { via } : {}) },
    { ts: at(10), tool: 'save_working_state', domain: DOM, ok: true, refused: false, ms: 12, ...(via ? { via } : {}) },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';

  clearLog();
  writeFileSync(LOG, seed(null), 'utf8');
  usage.__clearUsageCache();
  const plainAgg = await usage.readUsage({ now: NOW2, noCache: true });
  eq(plainAgg.sessions.lastBootstrapAt, at(20),
    'CONTROL (unmarked): lastBootstrapAt is the newest of the two bootstrap tools');
  eq(plainAgg.sessions.lastSaveAt, at(10), 'CONTROL (unmarked): lastSaveAt is the save');
  eq(plainAgg.byTool.get_project_context.lastVia, null, 'CONTROL: lastVia is null');
  eq(plainAgg.byTool.get_project_context.selfTestTotal, 0, 'CONTROL: selfTestTotal is zero');

  clearLog();
  writeFileSync(LOG, seed('self-test'), 'utf8');
  usage.__clearUsageCache();
  const viaAgg = await usage.readUsage({ now: NOW2, noCache: true });
  eq(viaAgg.sessions.lastBootstrapAt, null,
    'THE GATE: the SAME three calls marked self-test leave lastBootstrapAt null');
  eq(viaAgg.sessions.lastSaveAt, null, '…and lastSaveAt null');
  // …while everything the tile shows is still counted, because the calls did
  // happen. The gate is about the SESSION strip only.
  eq(viaAgg.byTool.get_project_context.countTotal, 1, 'the call is still counted per tool');
  eq(viaAgg.byTool.get_project_context.lastUsedAt, at(30), '…with its real timestamp');
  eq(viaAgg.byTool.get_project_context.lastVia, 'self-test', '…and marked on the tile');
  eq(viaAgg.byTool.save_working_state.selfTestTotal, 1, '…and counted as a self-test');
  eq(viaAgg.lineCount, 3, 'no line was dropped from the log by the gate');

  // ── A MIXED LOG is the ordinary state of a machine whose owner presses the
  // button: the AGENT's older calls must still drive the strip.
  clearLog();
  writeFileSync(LOG,
    JSON.stringify({ ts: at(120), tool: 'get_project_context', domain: DOM, ok: true, refused: false, ms: 9 }) + '\n' +
    JSON.stringify({ ts: at(110), tool: 'save_working_state', domain: DOM, ok: true, refused: false, ms: 9 }) + '\n' +
    seed('self-test'), 'utf8');
  usage.__clearUsageCache();
  const mixed = await usage.readUsage({ now: NOW2, noCache: true });
  eq(mixed.sessions.lastBootstrapAt, at(120),
    'a mixed log reports the AGENT\'s two-hour-old bootstrap, not the run\'s ten-minute-old one');
  eq(mixed.sessions.lastSaveAt, at(110), '…and the agent\'s save');
  eq(mixed.byTool.get_project_context.lastVia, 'self-test',
    '…while the TILE shows self-test, because the newest call really was one');
  eq(mixed.byTool.get_project_context.countTotal, 2, '…and both calls are counted');
  eq(mixed.byTool.get_project_context.selfTestTotal, 1, '…one of them as a self-test');

  // A via value that is NOT the literal on disk (a hand edit, a future
  // version) is normalised on READ, so it cannot silently suppress a session.
  clearLog();
  writeFileSync(LOG,
    JSON.stringify({ ts: at(5), tool: 'get_project_context', domain: DOM, ok: true, refused: false, ms: 9, via: 'agent' }) + '\n',
    'utf8');
  usage.__clearUsageCache();
  const junkVia = await usage.readUsage({ now: NOW2, noCache: true });
  eq(junkVia.sessions.lastBootstrapAt, at(5),
    'a line whose `via` is not the literal still counts as a session start — the gate keys on the literal, on read as well as write');
  eq(junkVia.byTool.get_project_context.lastVia, null, '…and the tile shows no marker for it');
}

// ── 8d  THE ROUTE FORWARDS BOTH NEW FIELDS ───────────────────────────────
{
  clearLog();
  const NOW3 = Date.parse('2026-09-18T12:00:00.000Z');
  writeFileSync(LOG, [
    { ts: new Date(NOW3 - 600_000).toISOString(), tool: 'search_wiki', domain: DOM, ok: true, refused: false, ms: 5 },
    { ts: new Date(NOW3 - 60_000).toISOString(), tool: 'search_wiki', domain: DOM, ok: true, refused: false, ms: 5, via: 'self-test' },
    { ts: new Date(NOW3 - 30_000).toISOString(), tool: 'get_tags', domain: DOM, ok: true, refused: false, ms: 5 },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  usage.__clearUsageCache();
  const routes2 = await import(path.join(ROOT, 'src/routes/mcp.js'));
  let body2 = null;
  await routes2.usageHandler({}, { json: (o) => { body2 = o; } });
  const r = (n) => body2.tools.find((t) => t.name === n) || {};
  eq(r('search_wiki').lastVia, 'self-test',
    'a tool whose newest call was a self-test reaches the view marked');
  eq(r('search_wiki').selfTestTotal, 1, '…with one of its two calls attributed to the run');
  eq(r('search_wiki').countTotal, 2, '…and both still counted');
  eq(r('get_tags').lastVia, null, 'a tool an agent called last reaches the view unmarked');
  eq(r('get_tags').selfTestTotal, 0, '…with a zero self-test count');
  eq(r('get_node').lastVia, null, 'an unused tool reports lastVia: null');
  eq(r('get_node').selfTestTotal, 0, '…and selfTestTotal: 0 — never omitted');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  `sid` — one bridge process is one session');
// ═══════════════════════════════════════════════════════════════════════════
// v3.63.0. The meter's ONE grouping key. Three things can go wrong, and each
// produces a plausible-looking number that is wrong:
//
//   1. THE ID MOVES INSIDE ONE PROCESS. Every call would be its own session,
//      so a session that read and saved reads as two, one of which "did not
//      save" — the exact false reading the strip exists to avoid.
//   2. TWO PROCESSES SHARE AN ID. Two sessions merge into one that read and
//      saved when in fact each did half. Invisible. This is why it is not a
//      pid: the OS recycles those.
//   3. A CALLER SUPPLIES ONE. `sid` is the key the whole reading groups on,
//      so a forged value merges or splits sessions at the caller's choosing.
{
  eq(usage.SID_RE.source, '^[0-9a-f]{12}$', 'the shape is 12 lowercase hex');
  const mine = usage.getSessionId();
  ok(usage.SID_RE.test(mine), `this process's sid matches it (${mine})`);
  eq(usage.getSessionId(), mine, 'and it is STABLE — read twice, same value');

  // ── 9a  IDENTICAL ACROSS ONE PROCESS'S LINES, THROUGH THE REAL DISPATCH ──
  clearLog();
  usage.__resetSessionLine();
  await call('list_domains', {});
  await call('get_node', { domain: DOM, slug: 'alpha' });
  await call('get_index', { domain: DOM });
  await settle();
  const all9 = readLines().map((l) => JSON.parse(l));
  const tools9 = all9.filter((r) => r.ev !== 'session');
  const sess9 = all9.filter((r) => r.ev === 'session');
  eq(tools9.length, 3, 'three calls, three tool lines');
  eq(sess9.length, 1, '…and exactly ONE session line, however many calls follow it');
  eq(new Set(tools9.map((r) => r.sid)).size, 1, 'all three tool lines carry ONE sid');
  eq(tools9[0].sid, mine, '…and it is this process’s minted id');
  eq(sess9[0].sid, mine, '…which the session line names too');
  eq(all9[0].ev, 'session', 'the session line is first in the file');

  // A SECOND burst in the same process adds NO second session line: the
  // process is the session, and a lazily-written line is written once.
  await call('list_domains', {});
  await settle();
  eq(readLines().filter((l) => JSON.parse(l).ev === 'session').length, 1,
    'a later call in the SAME process adds no second session line');

  // ── 9b  TWO PROCESSES DIFFER ────────────────────────────────────────────
  // Measured by actually starting node twice. A mutation that replaced the
  // random draw with a constant reds here and nowhere else.
  const readSid = async () => {
    const { execFileSync } = await import('node:child_process');
    return execFileSync(process.execPath, ['-e',
      `import('${path.join(ROOT, 'src/brain/mcp-usage.js')}').then(m => process.stdout.write(m.getSessionId()))`,
    ], { encoding: 'utf8' }).trim();
  };
  const sidA = await readSid();
  const sidB = await readSid();
  ok(usage.SID_RE.test(sidA) && usage.SID_RE.test(sidB), `two fresh processes minted ${sidA} and ${sidB}`);
  ok(sidA !== sidB, 'TWO PROCESSES GET DIFFERENT IDS — not a pid, not a constant, not a clock');
  ok(sidA !== mine && sidB !== mine, '…and neither is this process’s');

  // ── 9c  A CALLER'S `sid` IS NOT A sid ───────────────────────────────────
  for (const junk of ['0123456789AB', '0123456789a', '0123456789abc', 'zzzzzzzzzzzz',
    '', '../../etc', 'x'.repeat(10 * 1024), 42, null, {}]) {
    const rec9 = JSON.parse(usage.buildUsageLine({ tool: 'get_node', ms: 1, sid: junk }, 'T'));
    eq(rec9.sid, mine,
      `sid=${JSON.stringify(junk === undefined ? 'undefined' : junk).slice(0, 22)} is refused; the process’s own id is written`);
  }
  eq(JSON.parse(usage.buildUsageLine({ tool: 'get_node', ms: 1, sid: 'abcdef012345' }, 'T')).sid, 'abcdef012345',
    'CONTROL: a well-shaped sid IS honoured — this is the seam the suites drive, not a dead branch');

  // ── 9d  A LINE WITH NO sid IS LEGACY, NOT MALFORMED ─────────────────────
  clearLog();
  writeFileSync(LOG, `${JSON.stringify({ ts: '2026-09-01T00:00:00.000Z', tool: 'get_node', domain: DOM, ok: true, refused: false, ms: 3 })}\n`, 'utf8');
  usage.__clearUsageCache();
  const legacyAgg = await usage.readUsage({ noCache: true });
  eq(legacyAgg.malformedLines, 0, 'a v3.60.0 line is NOT malformed — the log reads across the upgrade');
  eq(legacyAgg.lineCount, 1, '…and is counted as a call');
  eq(legacyAgg.byTool.get_node.countTotal, 1, '…and lights its tile');

  // ── 9e  SESSION LINES ARE NOT CALLS ─────────────────────────────────────
  // If one reached byTool it would invent a tile called `unknown` and inflate
  // the count the app shows as "calls recorded".
  clearLog();
  writeFileSync(LOG, [
    JSON.stringify({ ts: '2026-09-01T00:00:00.000Z', ev: 'session', sid: 'aaaaaaaaaaaa', client: 'codex' }),
    JSON.stringify({ ts: '2026-09-01T00:00:01.000Z', tool: 'get_node', domain: DOM, ok: true, refused: false, ms: 3, sid: 'aaaaaaaaaaaa' }),
  ].join('\n') + '\n', 'utf8');
  usage.__clearUsageCache();
  const mixAgg = await usage.readUsage({ noCache: true });
  eq(mixAgg.lineCount, 1, 'lineCount counts CALLS only — the session line is not one');
  eq(mixAgg.sessionLineCount, 1, '…and the session line is reported separately');
  eq(Object.keys(mixAgg.byTool).join(','), 'get_node', 'byTool has exactly one tile — no `unknown` was invented');
  eq(mixAgg.malformedLines, 0, '…and nothing was called malformed');
  eq(mixAgg.logStartedAt, '2026-09-01T00:00:00.000Z',
    'logStartedAt still comes from the first line of EITHER kind — it answers "when did this file begin"');
  // A session line with no usable sid can be joined to nothing, so it is
  // dropped as malformed rather than kept as a session about nobody.
  clearLog();
  writeFileSync(LOG, `${JSON.stringify({ ts: '2026-09-01T00:00:00.000Z', ev: 'session', client: 'codex' })}\n`, 'utf8');
  usage.__clearUsageCache();
  eq((await usage.readUsage({ noCache: true })).malformedLines, 1,
    'a session line with no sid is dropped — nothing could ever join to it');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9f  `project` — the resolved slug, through the REAL dispatch');
// ═══════════════════════════════════════════════════════════════════════════
// The widening this release took deliberately, and the field the capture
// meter's per-project reading is impossible without. It must come from the
// RESOLVED envelope, not the argument: a bare project name can be resolved
// across domains, and an absent one filled from the configured default — the
// resolved slug is the one the store actually wrote to.
{
  clearLog();
  await call('get_working_state', { domain: DOM });
  await call('list_projects', { domain: DOM });
  await call('get_project_context', { domain: DOM });
  await settle();
  const recs = toolLines().map((l) => JSON.parse(l));
  eq(recs.length, 3, 'three calls, three lines');
  eq(recs[0].project, DOM,
    'get_working_state resolved the domain’s own project and the line names it');
  ok(!('project' in recs[1]),
    'list_projects resolves NO project, so the key is ABSENT — not null, not the domain');
  eq(recs[2].project, DOM, 'get_project_context names it too');
  ok(recs.every((r) => Buffer.byteLength(JSON.stringify(r), 'utf8') < usage.MAX_LINE_BYTES),
    'all three lines are under the ceiling');
  // And it is a SLUG, not content: nothing else from those three envelopes —
  // which carry the standing brief, a handoff and a project list — is here.
  ok(!toolLines().some((l) => /content_is_data|headline|resolved_by/.test(l)),
    'none of the envelopes’ prose reached the log');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10  `client` — two protocol eras, an allow-list, and no branch');
// ═══════════════════════════════════════════════════════════════════════════
// MCP revision 2026-07-28 REMOVED the `initialize` handshake: `clientInfo` is
// now an optional, PER-REQUEST, self-reported `_meta` entry, and the spec says
// a server SHOULD NOT change behaviour on it. The installed SDK (1.29.0) is
// still the OLD era. So the value must be read from BOTH, and the app's own
// self-test only ever exercises the OLD one — which is exactly why each arm is
// driven ALONE here, each with a control proving the other is unreachable.
{
  const clients = await import(path.join(ROOT, 'src/brain/mcp-clients.js'));

  // ── 10a  THE MAP IS MANY-TO-ONE, AND THAT IS THE POINT ──────────────────
  eq(clients.labelForClient('codex-mcp-client'), 'codex', 'a source-verified value maps to its id');
  eq(clients.labelForClient('gemini-cli-mcp-client'), 'gemini-cli', '…and the second one');
  // ONE PRODUCT, TWO VALUES, SIMULTANEOUSLY (Cline: VS Code vs the SDK).
  eq(clients.labelForClient('Cline'), 'cline', 'Cline from VS Code');
  eq(clients.labelForClient('@cline/core'), 'cline', '…and @cline/core from the SDK — ONE harness, two current values');
  // ONE PRODUCT, TWO VALUES, SEQUENTIALLY (Copilot CLI renamed itself).
  eq(clients.labelForClient('github-copilot-developer'), 'copilot', 'Copilot CLI before its rename');
  eq(clients.labelForClient('copilot-cli'), 'copilot', '…and after it — a log spanning six months carries both');
  ok(clients.KNOWN_CLIENTS.size > new Set([...clients.KNOWN_CLIENTS.values()]).size,
    'the map really is MANY-to-one — more raw values than canonical ids');

  // Case and punctuation are normalised before the lookup, never after.
  eq(clients.labelForClient('ZED'), 'zed', 'the lookup is case-insensitive');
  eq(clients.labelForClient('  Windsurf  '), 'windsurf', '…and whitespace is stripped, not escaped');

  // ── 10b  UNKNOWN IS `other`, NEVER THE CALLER'S STRING ──────────────────
  for (const junk of ['not-a-real-client', '', '   ', 'x'.repeat(10 * 1024),
    '"); DROP TABLE', '\n\n', null, undefined, 42, {}, []]) {
    eq(clients.labelForClient(junk), 'other',
      `client=${JSON.stringify(junk === undefined ? 'undefined' : junk).slice(0, 24)} → "other"`);
  }
  // The 10 KB case, end to end: a client name that size must leave the SESSION
  // line under the ceiling, exactly as a 10 KB argument does for a tool line.
  const bigSession = usage.buildSessionLine({ sid: '0123456789ab', client: 'x'.repeat(10 * 1024) }, 'T');
  eq(JSON.parse(bigSession).client, 'other', 'a 10 KB clientInfo.name is recorded as "other"');
  ok(Buffer.byteLength(bigSession, 'utf8') < usage.MAX_LINE_BYTES,
    `…on a ${Buffer.byteLength(bigSession, 'utf8')}-byte line, under the ${usage.MAX_LINE_BYTES}-byte ceiling`);
  ok(!bigSession.includes('xxxxx'), '…and not one byte of it reached the file');

  // ── 10b2  THE ROUND TRIP: WRITE A LABEL, READ IT BACK, SAME HARNESS ────
  // A DEFECT THIS ASSERTION FOUND. What lands on a session line is already a
  // canonical ID, and most ids are NOT also raw names in the map — `codex` is
  // the id, `codex-mcp-client` is the key. Putting a stored line back through
  // the WRITE-side `labelForClient` therefore re-labelled a correctly recorded
  // harness as `other`, silently, for six of the eleven harnesses. Read-side
  // normalisation is its own function for exactly that reason.
  for (const [raw, id] of [['codex-mcp-client', 'codex'], ['gemini-cli-mcp-client', 'gemini-cli'],
    ['@cline/core', 'cline'], ['github-copilot-developer', 'copilot'],
    ['goose-desktop', 'goose'], ['dsh-mcp-client', 'dsh'], ['claude-ai', 'claude-desktop'],
    ['Zed', 'zed'], ['nonsense', 'other']]) {
    const line = usage.buildSessionLine({ sid: '0123456789ab', client: raw }, 'T');
    eq(JSON.parse(line).client, id, `${raw} is written as "${id}"`);
    eq(clients.normaliseStoredClient(JSON.parse(line).client), id,
      `…and reading that line back gives "${id}" again, not "other"`);
  }
  ok(clients.CLIENT_IDS.filter((id) => !clients.KNOWN_CLIENTS.has(id)).length >= 5,
    'PRECONDITION: most canonical ids are NOT raw keys — which is why the two functions differ');
  eq(clients.normaliseStoredClient('made-up-by-hand'), 'other',
    'a hand-edited line still gets the allow-list on read');
  eq(clients.normaliseStoredClient('other'), 'other', '…and the literal "other" survives it');

  // …AND THROUGH THE PARSER, not only through the helper. `readUsageLines`
  // is the path package U's capture route takes, and it has its own copy of
  // the read-side decision — which is where the defect above actually lived.
  // (Found green: the helper was asserted, the parser was not.)
  clearLog();
  writeFileSync(LOG, [
    JSON.stringify({ ts: '2026-09-18T10:00:00.000Z', ev: 'session', sid: 'cccccccccccc', client: 'codex' }),
    JSON.stringify({ ts: '2026-09-18T10:00:01.000Z', ev: 'session', sid: 'dddddddddddd', client: 'hand-edited-nonsense' }),
    JSON.stringify({ ts: '2026-09-18T10:00:02.000Z', tool: 'get_node', domain: DOM, ok: true, refused: false, ms: 1, sid: 'cccccccccccc' }),
  ].join('\n') + '\n', 'utf8');
  usage.__clearUsageCache();
  const parsed10 = await usage.readUsageLines({ noCache: true });
  const sess10 = parsed10.records.filter((r) => r.ev === 'session');
  eq(sess10.length, 2, 'the parser returns both session lines');
  eq(sess10[0].client, 'codex',
    'THE PARSER keeps a stored canonical id — `codex` is an id, not a raw name, and must not be re-labelled `other`');
  eq(sess10[1].client, 'other', '…while a hand-edited value IS reduced to "other" on read');

  // ── 10c  THE TWO COMMUNITY-REPORTED ROWS ARE MARKED AS SUCH ─────────────
  // The record wanted them withheld until measured. They ship, because an
  // `other` row teaches a reader nothing — but `verified: false` is DATA, so a
  // measurement pass can find them and a wrong label costs only a word.
  const unverified = clients.CLIENT_ROWS.filter((r) => !r.verified).map((r) => r.raw).sort();
  const community = clients.CLIENT_ROWS.filter((r) => r.evidence === 'community').map((r) => r.raw).sort();
  // DERIVED, NOT A HARDCODED LIST (v3.64.0). The set moves the moment a row is
  // MEASURED — package M has just moved `claude-code` from `community` to
  // `observed` — and a typed list would red the day the campaign succeeds,
  // which is the wrong incentive to put on a measurement. The equality is
  // also STRICTLY STRONGER than the implication below it: that one only says
  // unverified ⊆ community, so a community row quietly marked `verified: true`
  // would pass it and fails here.
  eq(unverified.join(','), community.join(','),
    `the unverified rows are EXACTLY the community-reported ones (${unverified.length} of ${clients.CLIENT_ROWS.length})`);
  ok(clients.CLIENT_ROWS.every((r) => r.verified === true || r.evidence === 'community'),
    'and `verified: false` implies `evidence: community` — no row is unverified for a second reason');
  // The two that are community-reported in EVERY build to date, named so the
  // set can never quietly empty out.
  for (const raw of ['claude-ai', 'cursor-vscode']) {
    const row = clients.CLIENT_ROWS.find((r) => r.raw === raw);
    ok(row && row.evidence === 'community' && row.verified === false,
      `\`${raw}\` is community-reported and marked unverified`);
  }
  // `claude-ai` IS CLAUDE DESKTOP. Conflating it with Claude Code would put
  // desktop-chat sessions in a coding harness's row.
  eq(clients.labelForClient('claude-ai'), 'claude-desktop', 'claude-ai is Claude DESKTOP');
  eq(clients.labelForClient('claude-code'), 'claude-code', '…and claude-code is Claude Code');
  ok(clients.labelForClient('claude-ai') !== clients.labelForClient('claude-code'),
    'THE TWO ARE NEVER COLLAPSED — they are different surfaces on different lifecycles');
  ok(clients.CLIENT_IDS.every((id) => id.length <= clients.CLIENT_LABEL_MAX),
    `every canonical id fits the ${clients.CLIENT_LABEL_MAX}-character bound the ceiling is derived from`);

  // ── 10d  ARM 1: THE 2026-07-28 PER-REQUEST `_meta`, ALONE ───────────────
  // The fake server exposes NO getClientVersion, so only `_meta` can answer.
  const metaOnlyServer = { setRequestHandler: () => {} };
  eq(clients.readClientName(
    { params: { name: 'x', _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'codex-mcp-client' } } } },
    metaOnlyServer), 'codex-mcp-client',
    'ARM 1: the per-request _meta is read when the server exposes no legacy accessor');
  eq(clients.readClientName({ params: { name: 'x' } }, metaOnlyServer), null,
    'CONTROL: with neither source, the answer is null — so arm 1 above was NOT vacuous');
  eq(clients.CLIENT_META_KEY, 'io.modelcontextprotocol/clientInfo', 'the _meta key is the specification’s');

  // ── 10e  ARM 2: THE DEPRECATED initialize-ERA ACCESSOR, ALONE ───────────
  const legacyServer = { getClientVersion: () => ({ name: 'gemini-cli-mcp-client', version: '1' }) };
  eq(clients.readClientName({ params: { name: 'x' } }, legacyServer), 'gemini-cli-mcp-client',
    'ARM 2: getClientVersion() is read when the request carries no _meta');
  eq(clients.readClientName({ params: { name: 'x' } }, { }), null,
    'CONTROL: a server without the accessor answers null — so arm 2 was NOT vacuous either');

  // ── 10f  NEWEST ERA WINS WHEN BOTH ARE PRESENT ──────────────────────────
  eq(clients.readClientName(
    { params: { name: 'x', _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'copilot-cli' } } } },
    legacyServer), 'copilot-cli',
    'with BOTH present the per-request value wins — the era that is current');
  // A hostile `_meta` is not an error: it falls through to the legacy arm.
  eq(clients.readClientName({ params: { name: 'x', _meta: { 'io.modelcontextprotocol/clientInfo': 'not-an-object' } } }, legacyServer),
    'gemini-cli-mcp-client', 'a malformed _meta falls through rather than throwing');
  eq(clients.readClientName({ params: { name: 'x' } }, { getClientVersion: () => { throw new Error('boom'); } }), null,
    'an SDK accessor that THROWS is not an error either — it is just no name');

  // ── 10g  THE REAL DISPATCH, DRIVEN BY EACH ERA IN TURN ──────────────────
  // The zod schema keeps `_meta` (RequestMetaSchema is a looseObject), so this
  // is the shape a real 2026-07-28 client produces.
  const dispatchWithServer = (srv) => {
    const handlers = new Map();
    registerTools({ setRequestHandler: (schema, fn) => handlers.set(schema, fn), ...srv }, storage);
    const fn = handlers.get(CallToolRequestSchema);
    return (name, args, meta) => fn({ params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });
  };
  clearLog();
  usage.__resetSessionLine();
  const callMeta = dispatchWithServer({});
  await callMeta('list_domains', {}, { 'io.modelcontextprotocol/clientInfo': { name: 'Cline' } });
  await settle();
  eq(JSON.parse(sessionLines()[0]).client, 'cline',
    'THE REAL DISPATCH reads the per-request _meta and writes the allow-listed label');

  clearLog();
  usage.__resetSessionLine();
  const callLegacy = dispatchWithServer({ getClientVersion: () => ({ name: 'goose-desktop' }) });
  await callLegacy('list_domains', {});
  await settle();
  eq(JSON.parse(sessionLines()[0]).client, 'goose',
    '…and with no _meta it reads the deprecated initialize-era accessor');

  clearLog();
  usage.__resetSessionLine();
  await call('list_domains', {});
  await settle();
  eq(JSON.parse(sessionLines()[0]).client, 'other',
    '…and with NEITHER it writes "other" — never an error, never a refusal');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11  NOTHING BRANCHES ON `client` — Decision I, as a source guard');
// ═══════════════════════════════════════════════════════════════════════════
// The specification says a server SHOULD NOT change behaviour or security
// decisions on a self-reported client name, and the observed values are
// unstable enough that any branch would be wrong within months. The bridge is
// the place a branch would be written, so `mcp/**` is swept for a READ of the
// field outside the one line that hands it to the logger — with a planted
// violation proving the sweep is not vacuous.
{
  const { readdirSync } = await import('node:fs');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(full);
    return d.name.endsWith('.js') ? [full] : [];
  });
  const mcpFiles = walk(path.join(ROOT, 'mcp'));
  ok(mcpFiles.length >= 15, `PRECONDITION: the sweep sees ${mcpFiles.length} files under mcp/`);

  // A READ is any of: `.client`, `['client']`, `client ===`, `client !==`,
  // `client ==`, a switch on it, or destructuring it out of an object.
  const READ_RE = /\.client\b|\[\s*['"]client['"]\s*\]|\bclient\s*(===|!==|==(?!=)|!=(?!=))|\bcase\s+['"]client|\{[^}\n]*\bclient\b[^}\n]*\}\s*=/;
  const scan = (files) => {
    const hits = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        const bare = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (!READ_RE.test(bare)) return;
        // THE ONE ALLOWED SITE: the dispatch hands the raw value to the
        // logger. It is a WRITE of a property, not a read of the field.
        if (/client,\s*$|client\s*\}\)/.test(bare) && f.endsWith(path.join('tools', 'index.js'))) return;
        hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${bare.trim().slice(0, 90)}`);
      });
    }
    return hits;
  };
  const hits = scan(mcpFiles);
  eq(hits.length, 0, hits.length
    ? `mcp/** reads the client field outside the logger:\n        ${hits.join('\n        ')}`
    : 'nothing under mcp/ reads `client` except the one hand-off to the logger');

  // THE PLANTED VIOLATION — the control. Without it a broken regex would
  // report a clean sweep forever, which is the v3.1.0 lesson in this repo.
  const planted = path.join(TMP, 'planted-violation.js');
  writeFileSync(planted, 'function h(req) {\n  if (req.client === "codex") return "special";\n  return "normal";\n}\n', 'utf8');
  const plantedHits = scan([planted]);
  ok(plantedHits.length === 1, `CONTROL: a planted \`req.client === "codex"\` IS caught (${plantedHits.length} hit)`);
  const planted2 = path.join(TMP, 'planted-violation-2.js');
  writeFileSync(planted2, 'const { client } = args;\nconsole.error(client);\n', 'utf8');
  ok(scan([planted2]).length === 1, 'CONTROL: destructuring it out of an object is caught too');
  rmSync(planted, { force: true });
  rmSync(planted2, { force: true });

  // And the label never reaches the tool map's envelope, which is the other
  // place it could quietly become a behaviour.
  clearLog();
  writeFileSync(LOG, [
    JSON.stringify({ ts: '2026-09-18T11:00:00.000Z', ev: 'session', sid: 'bbbbbbbbbbbb', client: 'codex' }),
    JSON.stringify({ ts: '2026-09-18T11:00:01.000Z', tool: 'get_tags', domain: DOM, ok: true, refused: false, ms: 2, sid: 'bbbbbbbbbbbb' }),
  ].join('\n') + '\n', 'utf8');
  usage.__clearUsageCache();
  const routes11 = await import(path.join(ROOT, 'src/routes/mcp.js'));
  let body11 = null;
  await routes11.usageHandler({}, { json: (o) => { body11 = o; } });
  ok(!JSON.stringify(body11).includes('codex'),
    'GET /api/mcp/usage does not carry the client label — the Tool map is per TOOL, not per harness');
  eq(body11.tools.find((t) => t.name === 'get_tags').countTotal, 1,
    'CONTROL: the tool line underneath it DID reach the envelope');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§12  summariseSessions — the honesty meter, as a pure function');
// ═══════════════════════════════════════════════════════════════════════════
// The reading package U's capture route serves. Built over a HAND-WRITTEN log
// so every case is exact: a session that read and saved, one that read and did
// not, one that neither, a REFUSED save, a self-test run, legacy lines with no
// sid, a second project, and a sid whose session line is missing.
{
  const T = (min) => new Date(Date.parse('2026-09-18T12:00:00.000Z') - min * 60_000).toISOString();
  const L = (o) => JSON.stringify(o);
  const P = 'curator';
  const rows = [
    // S1 — read then saved. The good session.
    { ts: T(300), ev: 'session', sid: '111111111111', client: 'claude-code' },
    { ts: T(299), tool: 'get_project_context', domain: DOM, ok: true, refused: false, ms: 9, sid: '111111111111', project: P },
    { ts: T(250), tool: 'search_wiki', domain: DOM, ok: true, refused: false, ms: 4, sid: '111111111111', project: P },
    { ts: T(240), tool: 'save_working_state', domain: DOM, ok: true, refused: false, ms: 12, sid: '111111111111', project: P },
    // S2 — read, never saved. THE READING THAT MATTERS.
    { ts: T(200), ev: 'session', sid: '222222222222', client: 'codex' },
    { ts: T(199), tool: 'get_working_state', domain: DOM, ok: true, refused: false, ms: 5, sid: '222222222222', project: P },
    { ts: T(180), tool: 'get_node', domain: DOM, ok: true, refused: false, ms: 2, sid: '222222222222', project: P },
    // S3 — worked without bootstrapping, and its save was REFUSED.
    { ts: T(150), ev: 'session', sid: '333333333333', client: 'cursor' },
    { ts: T(149), tool: 'search_wiki', domain: DOM, ok: true, refused: false, ms: 3, sid: '333333333333', project: P },
    { ts: T(148), tool: 'save_working_state', domain: DOM, ok: false, refused: true, ms: 1, sid: '333333333333', project: P },
    // S4 — bootstrapped only AFTER saving: not a session that read first.
    { ts: T(120), ev: 'session', sid: '444444444444', client: 'goose' },
    { ts: T(119), tool: 'save_working_state', domain: DOM, ok: true, refused: false, ms: 8, sid: '444444444444', project: P },
    { ts: T(118), tool: 'get_project_context', domain: DOM, ok: true, refused: false, ms: 8, sid: '444444444444', project: P },
    // S5 — ANOTHER PROJECT. Must not leak into P's reading.
    { ts: T(100), ev: 'session', sid: '555555555555', client: 'zed' },
    { ts: T(99), tool: 'get_project_context', domain: DOM, ok: true, refused: false, ms: 6, sid: '555555555555', project: 'other-project' },
    { ts: T(98), tool: 'save_working_state', domain: DOM, ok: true, refused: false, ms: 6, sid: '555555555555', project: 'other-project' },
    // S6 — a SELF-TEST run. It calls both tools and must count for nothing.
    { ts: T(60), ev: 'session', sid: '666666666666', client: 'other', via: 'self-test' },
    { ts: T(59), tool: 'get_project_context', domain: DOM, ok: true, refused: false, ms: 4, sid: '666666666666', project: P, via: 'self-test' },
    { ts: T(58), tool: 'save_working_state', domain: DOM, ok: true, refused: false, ms: 4, sid: '666666666666', project: P, via: 'self-test' },
    // S7 — tool lines with NO session line (rotated away, or the append was
    // in flight when the child was killed). A real session; unknown client.
    { ts: T(40), tool: 'get_working_state', domain: DOM, ok: true, refused: false, ms: 5, sid: '777777777777', project: P },
    { ts: T(39), tool: 'save_working_state', domain: DOM, ok: true, refused: false, ms: 7, sid: '777777777777', project: P },
    // LEGACY — written before v3.63.0. No sid, so no session.
    { ts: T(500), tool: 'get_project_context', domain: DOM, ok: true, refused: false, ms: 9 },
    { ts: T(499), tool: 'save_working_state', domain: DOM, ok: true, refused: false, ms: 9 },
  ];
  clearLog();
  writeFileSync(LOG, rows.map(L).join('\n') + '\n', 'utf8');
  usage.__clearUsageCache();

  const read12 = await usage.readUsageLines({ noCache: true });
  eq(read12.present, true, 'readUsageLines sees the log');
  eq(read12.records.length, rows.length, `it hands back all ${rows.length} records, both kinds`);
  eq(read12.malformedLines, 0, '…with none malformed');

  const m = usage.summariseSessions(read12.records, { project: P });
  eq(m.totals.sessions, 5, 'five sessions touched this project (S1-S4 and S7; S5 is another project, S6 is a self-test)');
  eq(m.totals.sessionsRead, 3, 'three of them bootstrapped BEFORE their first save (S1, S2, S7)');
  eq(m.totals.sessionsSaved, 3, 'three saved successfully (S1, S4, S7)');
  eq(m.totals.sessionsReadNotSaved, 1, 'ONE read and did not save — the reading that matters (S2)');
  eq(m.totals.legacyLines, 2, 'the two pre-v3.63.0 lines are counted as legacy, never as a session');
  eq(m.totals.selfTestLines, 3, '…and the self-test run’s three lines are counted apart');

  const by = Object.fromEntries(m.sessions.map((x) => [x.sid, x]));
  eq(Object.keys(by).length, 5, 'one row per session');
  ok(!by['666666666666'], 'the SELF-TEST session is not in the list at all');
  ok(!by['555555555555'], '…and neither is the other project’s');
  eq(by['111111111111'].read, true, 'S1 read…');
  eq(by['111111111111'].saved, true, '…and saved');
  eq(by['111111111111'].client, 'claude-code', '…under the client its session line named');
  eq(by['111111111111'].calls, 3, '…across three calls');
  eq(by['111111111111'].project, P, '…about this project');
  eq(by['222222222222'].read, true, 'S2 read…');
  eq(by['222222222222'].saved, false, '…and did NOT save');
  eq(by['333333333333'].read, false, 'S3 never bootstrapped…');
  eq(by['333333333333'].saved, false, '…and its REFUSED save is not a save — ok:true is required');
  eq(by['444444444444'].saved, true, 'S4 saved…');
  eq(by['444444444444'].read, false,
    '…but bootstrapped only afterwards, so it did not READ first — the definition is "before the first save"');
  eq(by['777777777777'].saved, true, 'S7 saved…');
  eq(by['777777777777'].client, null,
    '…and its client is NULL, not "other": "no session line for this id" is a different fact from "a name we did not recognise"');

  // "read" is AT ANY POINT before the first save, not AS the first call — the
  // continuity skill's own ritual calls list_projects first.
  const ritual = usage.summariseSessions([
    { ts: T(30), tool: 'list_projects', ok: true, sid: '888888888888', project: P },
    { ts: T(29), tool: 'get_project_context', ok: true, sid: '888888888888', project: P },
    { ts: T(28), tool: 'save_working_state', ok: true, sid: '888888888888', project: P },
  ], { project: P });
  eq(ritual.totals.sessionsRead, 1,
    'a session that called list_projects FIRST and bootstrapped second still counts as having read');

  // Ordering, timestamps and the domain-wide reading.
  eq(m.sessions[0].sid, '777777777777', 'the list is newest-first — the view shows the last N sessions');
  eq(m.sessions[m.sessions.length - 1].sid, '111111111111', '…and oldest last');
  eq(by['111111111111'].startedAt, T(299), 'startedAt is the session’s first CALL, not its session line');
  eq(by['111111111111'].endedAt, T(240), 'endedAt is its last line — nothing writes an end marker');

  const allProjects = usage.summariseSessions(read12.records, {});
  eq(allProjects.totals.sessions, 6, 'with no project filter the other project’s session joins the six');
  eq(allProjects.totals.legacyLines, 2, '…and the legacy count is the same: it is about the LOG, not one project');

  // THE THREE STATES A CALLER MUST TELL APART.
  const none = usage.summariseSessions([], { project: P });
  eq(none.totals.sessions, 0, 'STATE 1 — no bridge session ran at all: zero sessions, not an error');
  eq(none.sessions.length, 0, '…and an empty list');
  const onlyLegacy = usage.summariseSessions(
    [{ ts: T(10), tool: 'save_working_state', ok: true }], { project: P });
  eq(onlyLegacy.totals.sessions, 0, 'a log that is ENTIRELY pre-v3.63.0 reports no sessions…');
  eq(onlyLegacy.totals.legacyLines, 1,
    '…but says so through legacyLines, so a caller never reads "nobody saved" off lines it cannot group');

  // The window keeps a session WHOLE.
  const windowed = usage.summariseSessions(read12.records, { project: P, since: Date.parse(T(45)) });
  eq(windowed.totals.sessions, 1, 'a 45-minute window keeps only the session with a line inside it');
  eq(windowed.sessions[0].sid, '777777777777', '…which is S7');
  eq(windowed.sessions[0].read, true,
    '…read WHOLE: a session is judged on all its lines, never only the ones inside the window');

  // A SESSION THAT SPANS THE BOUNDARY is the case that tells "keep the
  // session whole" apart from "keep the lines inside the window" — without
  // it, dropping either reads the same. An agent that bootstrapped seven
  // hours ago and saved two minutes ago DID read; reporting it as "did not
  // read" would be a false reading produced by the instrument.
  const spanning = usage.summariseSessions([
    { ts: T(400), ev: 'session', sid: '999999999999', client: 'codex' },
    { ts: T(399), tool: 'get_project_context', ok: true, sid: '999999999999', project: P },
    { ts: T(398), tool: 'search_wiki', ok: true, sid: '999999999999', project: P },
    { ts: T(20), tool: 'save_working_state', ok: true, sid: '999999999999', project: P },
  ], { project: P, since: Date.parse(T(45)) });
  eq(spanning.totals.sessions, 1, 'a session with one line inside the window is kept');
  eq(spanning.totals.sessionsRead, 1,
    'and it READ — the bootstrap six hours before the boundary still counts, because a session is judged whole');
  eq(spanning.totals.sessionsSaved, 1, '…and saved');
  eq(spanning.sessions[0].calls, 3, 'all three of its calls are counted, not just the one inside the window');
  eq(spanning.sessions[0].startedAt, T(399), '…and startedAt is its real first call, outside the window');
  eq(spanning.sessions[0].client, 'codex', '…with the client from its session line, also outside the window');
  // CONTROL: move the boundary past its last line and the session goes.
  eq(usage.summariseSessions([
    { ts: T(400), ev: 'session', sid: '999999999999', client: 'codex' },
    { ts: T(399), tool: 'get_project_context', ok: true, sid: '999999999999', project: P },
  ], { project: P, since: Date.parse(T(45)) }).totals.sessions, 0,
    'CONTROL: a session with NO line inside the window is excluded — the filter is not a no-op');

  // Hostile input is data, not a crash.
  eq(usage.summariseSessions(null).totals.sessions, 0, 'null records → zero sessions, no throw');
  eq(usage.summariseSessions([null, 42, 'x', {}, { ts: 'nope', sid: '111111111111' }]).totals.sessions, 0,
    'junk records are skipped rather than counted');
  eq(usage.summariseSessions([{ ts: T(1), tool: 'get_node', ok: true, sid: 'NOTAHEXSID!!' }]).totals.legacyLines, 1,
    'a malformed sid is not a session id — the line is legacy, never a forged session');
  // The reading is PURE: it wrote nothing.
  eq(readLines().length, rows.length, 'summarising the log left it byte-for-byte unchanged');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§13  A bridge that is OPENED and never used is still a session');
// ═══════════════════════════════════════════════════════════════════════════
//
// MEASURED 2026-09-20, by the harness campaign: four real Claude Code sessions
// in arm B opened the bridge, read nothing and saved nothing — and left NO
// LINE AT ALL, because v3.63.0 wrote the session line lazily, in the same
// append as the process's first tool line. `scripts/measure-harness.js`
// therefore printed `not-measured` over four sessions that had demonstrably
// run, which reads as "nobody ran it". An ABSENT measurement and a MEASURED
// ZERO are the two things this whole log exists to keep apart, and the
// instrument was confusing them.
//
// Driven over REAL stdio, with `initialize` and `notifications/initialized`
// and NO `tools/call`, because that is the arm in question and nothing
// in-process can produce it.
{
  const SOLO_USER_DATA = path.join(TMP, 'solo-userdata');
  mkdirSync(SOLO_USER_DATA, { recursive: true });
  const SOLO_LOG = path.join(SOLO_USER_DATA, '.mcp-usage.jsonl');
  const soloEnv = { ...env, CURATOR_TEST_USER_DATA_DIR: SOLO_USER_DATA };
  const solo = spawn(process.execPath, [MCP_SERVER, '--domains-path', DOMAINS], { stdio: ['pipe', 'pipe', 'pipe'], env: soloEnv });
  let soloOut = '';
  solo.stdout.on('data', (d) => { soloOut += d; });
  solo.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } })}\n`);
  await new Promise((r) => setTimeout(r, 400));
  solo.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  await new Promise((r) => setTimeout(r, 600));
  try { solo.kill('SIGKILL'); } catch { /* gone */ }
  await new Promise((r) => setTimeout(r, 150));

  let soloLines = [];
  try { soloLines = readFileSync(SOLO_LOG, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); }
  catch { soloLines = []; }

  eq(soloLines.length, 1, `a bridge that answered only initialize still wrote ${soloLines.length} line(s)`);
  eq(soloLines[0].ev, usage.SESSION_EV,
    'and it is a session line — no tool ran, so no tool line exists');
  ok(usage.SID_RE.test(soloLines[0].sid), 'carrying a well-formed sid');
  // WHY `notifications/initialized` AND NOT `connect()`: a line with no client
  // cannot be attributed to a harness, and attribution is the whole point of
  // the measurement. The SDK populates `getClientVersion()` in `_oninitialize`,
  // so this is the first instant the name exists.
  eq(soloLines[0].client, 'claude-code',
    '…and the CLIENT, which is what makes the session attributable to a harness at all');
  ok(soloOut.trim().split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }),
    'and stdout is still pure JSON-RPC — the v2.5.3 rule, re-checked on the new write');

  // THE READING. Four such sessions must summarise as four sessions that read
  // nothing and saved nothing — a measured zero.
  const at = (min) => new Date(Date.parse('2026-09-18T12:00:00.000Z') - min * 60_000).toISOString();
  const four = [];
  for (const sid of ['a1a1a1a1a1a1', 'b2b2b2b2b2b2', 'c3c3c3c3c3c3', 'd4d4d4d4d4d4']) {
    four.push({ ts: at(1), ev: usage.SESSION_EV, sid, client: 'claude-code' });
  }
  const sum = usage.summariseSessions(four);
  eq(sum.totals.sessions, 4, 'four bridge-only sessions summarise as FOUR sessions');
  eq(sum.totals.sessionsRead, 0, '…none of which read');
  eq(sum.totals.sessionsSaved, 0, '…and none of which saved');
  eq(sum.totals.legacyLines, 0, '…and none of which is counted as a legacy line');
  eq(sum.sessions.length, 4, '…four rows, not an empty list a vacuous `every` would pass over');
  ok(sum.sessions.every((x) => x.calls === 0 && x.client === 'claude-code'),
    '…each with zero calls and the harness label off its session line');

  // The client is taken from ANY line of the sid, not the first: first-one
  // -wins would pin every session to null and lose the label entirely.
  const reversed = usage.summariseSessions([
    { ts: at(1), ev: usage.SESSION_EV, sid: 'e5e5e5e5e5e5', client: 'codex' },
    { ts: at(2), ev: usage.SESSION_EV, sid: 'e5e5e5e5e5e5' },
  ]);
  eq(reversed.sessions[0].client, 'codex', 'a clientless line NEVER overwrites a client already seen');

  // A PROJECT-FILTERED reading cannot claim them: a zero-call session names no
  // project, and counting it under every project would inflate each
  // denominator with the same session. Disclosed instead.
  const filtered = usage.summariseSessions(four, { project: 'lumina' });
  eq(filtered.totals.sessions, 0, 'a per-PROJECT reading claims none of them');
  eq(filtered.unattributedSessions, 4, '…and discloses all four as unattributed');
  eq(sum.unattributedSessions, 0, '…while an unfiltered reading has none to disclose');

  // AND THE INSTRUMENT ITSELF. `scripts/measure-harness.js` keeps its own
  // parser (it must run against a log written by a build older than itself),
  // so the fix is only real if ITS verdict moves too. Driven over the log the
  // REAL bridge just wrote, three lines above — not a hand-built one.
  const mh = await import(path.join(ROOT, 'scripts/measure-harness.js'));
  const bucketed = mh.bucketLines(readFileSync(SOLO_LOG, 'utf8').split('\n'), 0);
  const row = mh.buildHarnessRow(bucketed, 'claude-code', { minSessions: 4 });
  eq(row.sessions, 1, 'measure-harness counts the real bridge-only session as ONE session');
  eq(row.verdict, mh.VERDICTS.NO,
    'its verdict is `measured-no` — a measured zero, NOT `not-measured`, which would read as "nobody ran it"');
  const fourRow = mh.buildHarnessRow(
    mh.bucketLines(four.map((l) => JSON.stringify(l)), 0), 'claude-code', { minSessions: 4 });
  eq(fourRow.sessions, 4, '…and four such sessions are four');
  eq(fourRow.verdict, mh.VERDICTS.NO, '…still `measured-no`, which is the reading arm B actually earned');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§14  v3.66.0 — count7dAgent, summariseSessionsByProject, the union reader');
// ═══════════════════════════════════════════════════════════════════════════
{
  // The real credential files, fingerprinted (sha256 + size + existence only —
  // an mtime guard false-alarms on the maintainer's live app, v3.0.16).
  const { createHash } = await import('node:crypto');
  const REAL = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
    .map((f) => path.join(ROOT, f));
  const fp = () => REAL.map((f) => (existsSync(f)
    ? `${f}:${statSync(f).size}:${createHash('sha256').update(readFileSync(f)).digest('hex')}`
    : `${f}:absent`)).join('|');
  const fpBefore = fp();

  // ── (a) count7dAgent: the same window, self-test lines excluded ─────────
  // N anchors to the REAL clock, not a fixed date: this fixture is read both
  // by the pure `readUsage({ now: N })` call below AND by `r14.usageHandler`,
  // which has no clock seam and always computes its 7-day window off the
  // real `Date.now()` (src/routes/mcp.js's usageHandler → readUsage() with
  // no `now` option). A fixed 2026-09-18 anchor ages out of that window as
  // wall time moves past it — exactly what happened here.
  clearLog();
  const N = Date.now();
  const ago14 = (ms) => new Date(N - ms).toISOString();
  const D = 24 * 60 * 60 * 1000;
  const SID = 'a1a1a1a1a1a1';
  const lines = [
    { ts: ago14(10 * D), tool: 'search_wiki', domain: DOM, ok: true, refused: false, ms: 1, sid: SID },           // outside 7 d
    { ts: ago14(2 * D), tool: 'search_wiki', domain: DOM, ok: true, refused: false, ms: 1, sid: SID },            // agent
    { ts: ago14(1 * D), tool: 'search_wiki', domain: DOM, ok: false, refused: true, ms: 1, sid: SID },            // agent, refused
    { ts: ago14(60e3), tool: 'search_wiki', domain: DOM, ok: true, refused: false, ms: 1, sid: 'b2b2b2b2b2b2', via: 'self-test' },
    { ts: ago14(50e3), tool: 'get_node', domain: DOM, ok: true, refused: false, ms: 1, sid: 'b2b2b2b2b2b2', via: 'self-test' },
  ];
  writeFileSync(LOG, `${lines.map((o) => JSON.stringify(o)).join('\n')}\n`, 'utf8');
  usage.__clearUsageCache();
  const a = await usage.readUsage({ now: N, noCache: true });
  eq(a.byTool.search_wiki.count7d, 3, 'count7d is UNCHANGED — it still counts the self-test line in the window');
  eq(a.byTool.search_wiki.count7dAgent, 2,
    'count7dAgent counts the two agent calls in the window (the refusal included), not the self-test one, not the 10-day-old one');
  eq(a.byTool.get_node.count7d, 1, 'a tool touched ONLY by a self-test run still shows count7d 1…');
  eq(a.byTool.get_node.count7dAgent, 0, '…and count7dAgent 0 — one "Test all tools" press does not make it busy');
  const r14 = await import(path.join(ROOT, 'src/routes/mcp.js'));
  let b14 = null;
  await r14.usageHandler({ query: {} }, { json: (o) => { b14 = o; } });
  const sw14 = b14.tools.find((t) => t.name === 'search_wiki') ?? {};
  eq(sw14.count7dAgent, 2, 'the route forwards count7dAgent per tool');
  eq(sw14.count7d, 3, '…beside count7d, which keeps its shipped value');
  eq((b14.tools.find((t) => t.name === 'get_tags') ?? {}).count7dAgent, 0, 'an unused tool reads count7dAgent 0 (a present log, a measured zero)');
  ok(!('byProject' in b14) && !('savePulse' in b14) && !('byProjectWindow' in b14),
    'WITHOUT ?include=projects the envelope gains no project fields (the 30 s poll and onboarding stay cheap)');
  let b14x = null;
  await r14.usageHandler({ query: { include: 'nonsense' } }, { json: (o) => { b14x = o; } });
  ok(!('byProject' in b14x), 'an unrecognised include value is ignored, not honoured');

  // ── (b) summariseSessionsByProject IS summariseSessions, per project ─────
  const S1 = 'c1c1c1c1c1c1', S2 = 'c2c2c2c2c2c2', S3 = 'c3c3c3c3c3c3', S4 = 'c4c4c4c4c4c4';
  const since = N - 30 * D;
  const recs = [
    // S1 bootstraps BEFORE the window and saves inside it: read AND saved.
    { ts: ago14(40 * D), tool: 'get_project_context', domain: 'projects', project: 'alpha', ok: true, sid: S1 },
    { ts: ago14(1 * D), tool: 'save_working_state', domain: 'projects', project: 'alpha', ok: true, sid: S1 },
    // S2 touches alpha AND beta: saved alpha, read beta.
    { ts: ago14(2 * D), tool: 'get_working_state', domain: 'projects', project: 'alpha', ok: true, sid: S2 },
    { ts: ago14(2 * D - 1000), tool: 'save_working_state', domain: 'projects', project: 'alpha', ok: true, sid: S2 },
    { ts: ago14(2 * D - 2000), tool: 'get_working_state', domain: 'other', project: 'beta', ok: true, sid: S2 },
    // S3: beta, a REFUSED save is not a save.
    { ts: ago14(3 * D), tool: 'save_working_state', domain: 'other', project: 'beta', ok: false, refused: true, sid: S3 },
    // A self-test save on alpha must count nowhere.
    { ts: ago14(1000), tool: 'save_working_state', domain: 'projects', project: 'alpha', ok: true, sid: S4, via: 'self-test' },
    // A legacy line (no sid) is never a session.
    { ts: ago14(1000), tool: 'save_working_state', domain: 'projects', project: 'alpha', ok: true },
    // gamma, entirely outside the window: no row.
    { ts: ago14(45 * D), tool: 'save_working_state', domain: 'projects', project: 'gamma', ok: true, sid: 'c5c5c5c5c5c5' },
    // A session line (no project) must not create a row.
    { ts: ago14(1 * D), ev: 'session', sid: S1, client: 'codex' },
  ];
  const by = usage.summariseSessionsByProject(recs, { since });
  const rowOf = (p) => by.projects.find((r) => r.project === p);
  for (const p of ['alpha', 'beta']) {
    const ref = usage.summariseSessions(recs, { project: p, since }).totals;
    const r = rowOf(p) ?? {};
    ok(r.sessions === ref.sessions && r.sessionsRead === ref.sessionsRead && r.sessionsSaved === ref.sessionsSaved,
      `the ${p} row equals summariseSessions(records, {project: '${p}'}) — the capture meter's own reading `
      + `(${r.sessions}/${r.sessionsRead}/${r.sessionsSaved} vs ${ref.sessions}/${ref.sessionsRead}/${ref.sessionsSaved})`);
  }
  eq(rowOf('alpha')?.sessions, 2, 'alpha: two sessions (S1 and S2), the self-test and legacy lines excluded');
  eq(rowOf('alpha')?.sessionsSaved, 2, 'alpha: both saved');
  eq(rowOf('alpha')?.sessionsRead, 2, 'alpha: S1 read before the window and still counts as read (whole-session reading)');
  eq(rowOf('beta')?.sessions, 2, 'beta: S2 and S3');
  eq(rowOf('beta')?.sessionsSaved, 0, 'beta: a REFUSED save is not a save');
  eq(rowOf('gamma'), undefined, 'a project with no line in the window has NO row (absent, not a fabricated zero)');
  eq(by.projects.map((r) => r.project).join(','), 'alpha,beta', 'rows are ordered by sessions-that-saved, busiest first');
  eq(JSON.stringify(rowOf('alpha')?.domains), '["projects"]', 'each row names the domains its lines carried');
  eq(by.totals.sessions, 3, 'totals count DISTINCT sessions — S2 touched two projects and is one session');
  eq(by.totals.sessionsSaved, 2, 'totals.sessionsSaved: S1 and S2');
  eq(by.totals.selfTestLines, 1, 'the self-test line is counted as excluded');
  eq(by.totals.legacyLines, 1, 'the legacy line is counted as excluded');
  eq(JSON.stringify(Object.keys(rowOf('alpha') ?? {}).sort()),
    JSON.stringify(['domains', 'lastSessionAt', 'project', 'sessions', 'sessionsRead', 'sessionsSaved']),
    'a row carries exactly its six fields — no sid, no client, no content');
  eq(rowOf('alpha')?.lastSessionAt, ago14(1 * D), 'lastSessionAt is the newest session’s last line');
  eq(usage.summariseSessionsByProject([], {}).projects.length, 0, 'an empty log answers no rows and does not throw');

  // ── (c) the union reader: both logs, when the machine keeps two ──────────
  clearLog();
  writeFileSync(LOG, `${JSON.stringify({ ts: ago14(D), tool: 'save_working_state', domain: DOM, project: 'alpha', ok: true, refused: false, ms: 1, sid: 'd1d1d1d1d1d1' })}\n`, 'utf8');
  const BUNDLE = path.join(TMP, 'bundle-log');
  mkdirSync(BUNDLE, { recursive: true });
  const BLOG = path.join(BUNDLE, path.basename(LOG));
  writeFileSync(BLOG, `${JSON.stringify({ ts: ago14(D), tool: 'save_working_state', domain: DOM, project: 'alpha', ok: true, refused: false, ms: 1, sid: 'd2d2d2d2d2d2' })}\n`, 'utf8');
  const one = await usage.readUsageLinesUnion({ noCache: true });
  eq(one.files, 1, 'isolated, with no seam: ONE file (the suite never reaches a real bundle log)');
  process.env.CURATOR_TEST_BUNDLE_LOG_DIR = BUNDLE;
  try {
    const both = await usage.readUsageLinesUnion({ noCache: true });
    eq(both.files, 2, 'with a second log on the machine the union reads BOTH files');
    eq(both.records.length, 2, '…and both files’ lines');
    const single = await usage.readUsageLines({ noCache: true });
    eq(single.records.length, 1, '(control) the single-file reader sees only its own — the union is what differs');
    const sum2 = usage.summariseSessionsByProject(both.records, {});
    eq(sum2.projects[0]?.sessionsSaved, 2, 'a project saved through both Curators counts both sessions');
    // Cache keyed on EVERY file: growing the second must be seen.
    writeFileSync(BLOG, `${readFileSync(BLOG, 'utf8')}${JSON.stringify({ ts: ago14(D / 2), tool: 'get_node', domain: DOM, ok: true, refused: false, ms: 1, sid: 'd2d2d2d2d2d2' })}\n`, 'utf8');
    const grown = await usage.readUsageLinesUnion();
    eq(grown.records.length, 3, 'the union cache is keyed on the SECOND file too — its growth is re-read');
    // THE CAPTURE ROUTE READS THE SAME UNION (routes/memory.js) — pinned there;
    // here: reading never writes. Both files are byte-identical after the reads.
    const sizes = [statSync(LOG).size, statSync(BLOG).size];
    await usage.readUsageLinesUnion({ noCache: true });
    ok(statSync(LOG).size === sizes[0] && statSync(BLOG).size === sizes[1], 'the union reader writes nothing to either log');
  } finally {
    delete process.env.CURATOR_TEST_BUNDLE_LOG_DIR;
    usage.__clearUsageCache();
  }

  // ── (d) the route's ?include=projects half ──────────────────────────────
  // The fixture domain gets a standing brief, so the store lists its own project.
  mkdirSync(path.join(DOMAINS, DOM, 'state'), { recursive: true });
  writeFileSync(path.join(DOMAINS, DOM, 'state', 'project.md'), '# Brief\n\nFixture.\n');
  mkdirSync(path.join(DOMAINS, DOM, 'state', 'quiet'), { recursive: true });
  writeFileSync(path.join(DOMAINS, DOM, 'state', 'quiet', 'project.md'), '# Quiet\n\nFixture.\n');
  clearLog();
  let noLog = null;
  await r14.usageHandler({ query: { include: 'projects' } }, { json: (o) => { noLog = o; } });
  ok(Array.isArray(noLog.byProject), 'with ?include=projects the envelope carries byProject[]');
  eq(noLog.byProjectWindow?.logPresent, false, 'no usage log: logPresent false');
  eq(noLog.byProjectWindow?.busiestSaved, null, '…the bars’ denominator is null, not 0');
  ok(noLog.byProject.every((r) => r.sessions === null && r.sessionsSaved === null),
    '…and every store project reads sessions null — NOT MEASURED, never a fabricated 0');
  ok(noLog.byProject.some((r) => r.project === DOM && r.inStore === true),
    'the store’s projects are listed even with no log (the domain’s own project here)');
  writeFileSync(LOG, [
    { ts: new Date(Date.now() - D).toISOString(), tool: 'save_working_state', domain: DOM, project: DOM, ok: true, refused: false, ms: 1, sid: 'e1e1e1e1e1e1' },
    { ts: new Date(Date.now() - D).toISOString(), tool: 'save_working_state', domain: 'gone', project: 'retired', ok: true, refused: false, ms: 1, sid: 'e2e2e2e2e2e2' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  usage.__clearUsageCache();
  let withLog = null;
  await r14.usageHandler({ query: { include: 'projects' } }, { json: (o) => { withLog = o; } });
  const own = withLog.byProject.find((r) => r.project === DOM) ?? {};
  eq(own.sessionsSaved, 1, 'a store project with a saving session in the log reads sessionsSaved 1');
  eq(own.inStore, true, '…and it is the STORE’s row, joined — not a log-only one');
  const quiet = withLog.byProject.find((r) => r.project === 'quiet') ?? {};
  ok(quiet.inStore === true && quiet.sessions === 0 && quiet.sessionsSaved === 0,
    'a store project the PRESENT log never names reads a MEASURED 0 (not null)', JSON.stringify(quiet));
  const gone = withLog.byProject.find((r) => r.project === 'retired') ?? {};
  eq(gone.inStore, false, 'a project the log names and the store does not hold is KEPT, marked inStore:false');
  eq(gone.domain, 'gone', '…with the domain its lines named');
  eq(withLog.byProjectWindow?.busiestSaved, 1, 'busiestSaved is the named denominator (max sessionsSaved)');
  eq(withLog.byProjectWindow?.windowDays, 30, 'the window is 30 days, the capture meter’s own default');
  ok(withLog.savePulse === null || Number.isInteger(withLog.savePulse.events),
    'savePulse is the store pulse’s event count, or null when no journal exists');
  ok(withLog.tools.length === registry.length, 'the tool rows are still all there beside the project half');

  eq(fp(), fpBefore, 'real credential files unchanged (sha256 + size + existence)');
}

// ── Cleanup ────────────────────────────────────────────────────────────────
try { if (CHILD_PID && !child.killed) process.kill(CHILD_PID, 'SIGKILL'); } catch { /* gone */ }
paths.__setUserDataDirOverride(null);
config.__setDomainsDirOverride(null);
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${'─'.repeat(56)}`);
console.log(`Passed: ${passed}   Failed: ${failed}   (${Date.now() - t0}ms)`);
process.exit(failed ? 1 : 0);
