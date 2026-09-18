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
/** The append is fire-and-forget; give the microtask + fs write a moment. */
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

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
eq(lines.length, 1, 'one call wrote exactly one line');
let rec = JSON.parse(lines[0]);
eq(Object.keys(rec).join(','), usage.LINE_KEYS_ALWAYS.join(','),
  'the line carries EXACTLY ts,tool,domain,ok,refused,ms — in that order');
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
lines = readLines();
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
rec = JSON.parse(readLines()[0]);
eq(rec.refused, false, 'KNOWN LIMIT: a string-shaped refusal is logged refused:false…');
eq(rec.ok, true, '…and ok:true — the log cannot see it without reading the message');

// (c) An oversized DOMAIN argument is dropped, not truncated and not written.
clearLog();
await call('get_node', { domain: BIG, slug: 'alpha' });
await settle();
rec = JSON.parse(readLines()[0]);
eq(rec.domain, null, 'a 10 KB `domain` argument is recorded as null, never truncated into the line');
ok(Buffer.byteLength(readLines()[0], 'utf8') < usage.MAX_LINE_BYTES, 'that line is under the ceiling too');

// (d) An unknown tool name is a CLIENT string — logged as "unknown".
clearLog();
const unknownRes = await call(`zz_${BIG}`, {});
ok(unknownRes.isError, 'an unknown tool still returns its error response');
await settle();
rec = JSON.parse(readLines()[0]);
eq(rec.tool, 'unknown', 'an unknown tool name is logged as "unknown", never as the client string');
ok(!readLines()[0].includes('zz_x'), 'the client-supplied name is nowhere in the line');
// The 10 KB name above is ALSO caught by buildUsageLine's shape check, so on
// its own it cannot tell the dispatch's `'unknown'` apart from that second
// guard. A SHORT, well-shaped name that is simply not a registered tool can:
// only the dispatch knows the difference between a real tool and a plausible
// invention, and an invented name is still a string the client chose.
clearLog();
await call('zz_not_a_tool', {});
await settle();
eq(JSON.parse(readLines()[0]).tool, 'unknown',
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
rec = JSON.parse(readLines()[0]);
eq(rec.ok, false, 'a throw records ok:false');
eq(rec.refused, false, '…and refused:false — a throw is not a refusal');
ok(!readLines()[0].includes('secret-detail'), 'the error message is NOT in the log');

// (f) buildUsageLine directly — the size proof at the caps, not just in practice.
// The WORST line the caps allow, and it must include `via` — which is why
// v3.61.0 narrowed TOOL_NAME_RE from 40 characters to 32: at 40 the worst line
// with `via` came to 201 bytes and the ⓘ's "under 200 bytes however large the
// call was" would have become false.
const maxLine = usage.buildUsageLine(
  { tool: 'a'.repeat(32), domain: 'b'.repeat(48), ok: false, refused: true, ms: 86_400_000, via: 'self-test' },
  '2026-09-18T12:34:56.789Z');
ok(Buffer.byteLength(maxLine, 'utf8') < usage.MAX_LINE_BYTES,
  `the WORST line the caps allow — with \`via\` — is ${Buffer.byteLength(maxLine, 'utf8')} bytes (< ${usage.MAX_LINE_BYTES})`);
eq(JSON.parse(maxLine).via, 'self-test', '…and that worst line really does carry via');
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
  JSON.stringify(['count7d', 'countTotal', 'group', 'lastOk', 'lastUsedAt', 'lastVia',
    'mutates', 'name', 'purpose', 'refusedTotal', 'selfTestTotal'].sort()),
  'every row carries exactly the eleven contracted fields (v3.61.0 added lastVia + selfTestTotal)');
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
ok(!existsSync(CHILD_LOG), 'listing tools is not a tool CALL and writes nothing');

const wireOk = await rpc('tools/call', { name: 'list_domains', arguments: {} });
ok(/zz-usage/.test(wireOk?.result?.content?.[0]?.text || ''), 'list_domains answers over the wire');
const wireRefused = await rpc('tools/call', { name: 'get_raw_source', arguments: { domain: DOM, slug: 'x'.repeat(4096) } });
ok(/"ok": false/.test(wireRefused?.result?.content?.[0]?.text || ''), 'the oversized slug is refused over the wire');
await settle(500);

const childLines = existsSync(CHILD_LOG) ? readFileSync(CHILD_LOG, 'utf8').split('\n').filter(l => l.trim()) : [];
eq(childLines.length, 2, `the child wrote one line per tool call (got ${childLines.length})`);
const childRecs = childLines.map(l => JSON.parse(l));
eq(childRecs[0].tool, 'list_domains', 'the first line is the first call');
eq(childRecs[1].refused, true, 'the refusal is recorded as such from the child too');
ok(childLines.every(l => Buffer.byteLength(l, 'utf8') < usage.MAX_LINE_BYTES), 'both child lines are under the ceiling');
ok(!childLines.some(l => l.includes('xxxx')), 'no argument text reached the child’s log');
ok(!existsSync(path.join(DOMAINS, '.mcp-usage.jsonl'))
   && !existsSync(path.join(DOMAINS, DOM, '.mcp-usage.jsonl')),
  'nothing was written into the domains tree');

child.stdin.end();
child.kill();
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
  eq(usage.LINE_KEYS.join(','), 'ts,tool,domain,ok,refused,ms,via',
    'LINE_KEYS names `via` last — the optional key is emitted after the six');
  eq(usage.LINE_KEYS_ALWAYS.join(','), 'ts,tool,domain,ok,refused,ms',
    'LINE_KEYS_ALWAYS is the six every line carries');
  eq(usage.VIA_SELF_TEST, 'self-test', 'the literal is "self-test"');
  eq(usage.VIA_ENV_VAR, 'CURATOR_MCP_VIA', 'the environment variable is CURATOR_MCP_VIA');

  const plain = JSON.parse(usage.buildUsageLine({ tool: 'get_node', ms: 3 }, 'T'));
  ok(!('via' in plain), 'no `via` argument → the key is ABSENT, not null');
  eq(Object.keys(plain).join(','), usage.LINE_KEYS_ALWAYS.join(','),
    '…so the line is byte-comparable with every line v3.60.0 wrote');
  eq(JSON.parse(usage.buildUsageLine({ tool: 'get_node', ms: 3, via: 'self-test' }, 'T')).via,
    'self-test', 'the literal is recorded');
  eq(Object.keys(JSON.parse(usage.buildUsageLine({ tool: 'get_node', ms: 3, via: 'self-test' }, 'T'))).join(','),
    usage.LINE_KEYS.join(','), '…last, after the six');
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
    const rec = JSON.parse(readLines()[0]);
    eq(rec.via, 'self-test',
      'with CURATOR_MCP_VIA=self-test in the environment, the real dispatch handler\'s line carries it');
    // A junk value in the same variable must not reach the file.
    clearLog();
    process.env.CURATOR_MCP_VIA = 'pretend-i-am-an-agent';
    await call('list_domains', {});
    await settle();
    ok(!('via' in JSON.parse(readLines()[0])),
      'CONTROL: a junk value in the SAME variable leaves the field absent');
    clearLog();
    delete process.env.CURATOR_MCP_VIA;
    await call('list_domains', {});
    await settle();
    ok(!('via' in JSON.parse(readLines()[0])),
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

// ── Cleanup ────────────────────────────────────────────────────────────────
try { if (CHILD_PID && !child.killed) process.kill(CHILD_PID, 'SIGKILL'); } catch { /* gone */ }
paths.__setUserDataDirOverride(null);
config.__setDomainsDirOverride(null);
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${'─'.repeat(56)}`);
console.log(`Passed: ${passed}   Failed: ${failed}   (${Date.now() - t0}ms)`);
process.exit(failed ? 1 : 0);
