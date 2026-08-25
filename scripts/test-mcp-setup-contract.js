#!/usr/bin/env node
/**
 * MCP setup-endpoint contract tests — OFFLINE (no network, no API key, no paid call).
 *
 * Covers two defects fixed in src/routes/mcp.js:
 *
 *   D1  GET /claude-full-config reported a CORRUPT claude_desktop_config.json
 *       identically to an ABSENT one, and in the corrupt case returned a
 *       `merged` object containing ONLY the curator entry — rendered by the
 *       wizard as "your file after" beside a copy button. Pasting it deletes
 *       every other MCP server the user had configured.
 *
 *   D2  POST /self-test spawned the MCP server WITHOUT --domains-path, so the
 *       one thing the pasted config uniquely contributes was the one thing the
 *       self-test never exercised. It also collapsed "no domains" and "the
 *       domains folder does not exist" into the same cheerful green result.
 *
 * SAFETY — the real ~/Library/Application Support/Claude/claude_desktop_config.json
 * is NEVER read, written, moved or replaced by this suite. CLAUDE_CONFIG_PATH is a
 * module constant in the route with no override seam, so the config-merge logic is
 * tested through the exported PURE functions with hand-built inputs instead. The
 * only child process spawned is mcp/server.js itself, pointed at throwaway tempdirs.
 *
 * SCOPE — no HTTP layer is exercised and no server is started. Coverage is:
 *   §1-2, §5  the pure functions the routes delegate to, with hand-built inputs
 *   §3        source-level guards that the routes delegate to them and to
 *             nothing else — necessary, and provably NOT sufficient (see §3's
 *             own note: the shape guard was measured green against a one-token
 *             edit that reinstated D2 completely)
 *   §4        the CHILD honours --domains-path — says nothing about the route
 *   §6        BEHAVIOURAL: the exported route handler is invoked for real and
 *             the domains the spawned child returned are asserted, which is the
 *             only thing that proves the route passes the argument
 *   §7        source-structure guards that the honest result reaches the SCREEN;
 *             these are regex/structure guards, not a rendered-DOM test, so they
 *             pin where the misleading copy may live rather than what a browser
 *             ultimately paints
 */

import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { spawn } from 'child_process';

import {
  buildCuratorEntry,
  parseClaudeConfigText,
  buildFullConfigPayload,
  classifyDomainsResult,
  selfTestHandler,
} from '../src/routes/mcp.js';
import { __setDomainsDirOverride } from '../src/brain/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ROUTE_SRC_PATH = path.join(REPO_ROOT, 'src', 'routes', 'mcp.js');
const MCP_SERVER = path.join(REPO_ROOT, 'mcp', 'server.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond) {
  if (cond) { passed++; }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(label, actual, expected) {
  check(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected);
}
function section(name) { console.log(`\n${name}`); }

const routeSrc = readFileSync(ROUTE_SRC_PATH, 'utf8');
const DOMAINS = '/tmp/zz-fake-domains';

// ---------------------------------------------------------------------------
section('§1  D1 — absent vs corrupt vs readable are three DISTINCT outcomes');
// ---------------------------------------------------------------------------

const absent   = buildFullConfigPayload(null, DOMAINS);
const corrupt  = buildFullConfigPayload(parseClaudeConfigText('{ "mcpServers": { ,, }'), DOMAINS);

// The headline defect: these two used to be byte-identical.
check('absent and corrupt payloads are NOT identical', JSON.stringify(absent) !== JSON.stringify(corrupt));
check('absent and corrupt differ specifically in `merged`',
  JSON.stringify(absent.merged) !== JSON.stringify(corrupt.merged));

// --- corrupt: structurally cannot be presented as a safe merge --------------
eq('corrupt: merged is null', corrupt.merged, null);
eq('corrupt: parse_error true', corrupt.parse_error, true);
eq('corrupt: merge_available false', corrupt.merge_available, false);
check('corrupt: merge_error is a non-empty explanatory string',
  typeof corrupt.merge_error === 'string' && corrupt.merge_error.length > 40);
// A naive consumer must not be able to find ANY pasteable config in this payload
// except the one explicitly named `entry`.
const mcpServersBearingKeys = Object.entries(corrupt)
  .filter(([, v]) => v && typeof v === 'object' && 'mcpServers' in v)
  .map(([k]) => k);
check('corrupt: the ONLY mcpServers-bearing value is the clearly-named `entry`',
  mcpServersBearingKeys.length === 1 && mcpServersBearingKeys[0] === 'entry');
check('corrupt: entry snippet is still available to add by hand',
  !!corrupt.entry?.mcpServers?.['my-curator']?.command);

// --- absent: the pre-existing happy path still works -----------------------
eq('absent: parse_error false', absent.parse_error, false);
eq('absent: merge_available true', absent.merge_available, true);
eq('absent: was_empty true', absent.was_empty, true);
eq('absent: merge_error null', absent.merge_error, null);
check('absent: merged is a usable config with our entry',
  !!absent.merged?.mcpServers?.['my-curator']?.args?.includes('--domains-path'));
eq('absent: merged carries exactly one server', Object.keys(absent.merged.mcpServers).length, 1);

// --- readable: merge is genuinely non-destructive ---------------------------
const existing = {
  mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@x/fs'] },
    github:     { command: 'npx', args: ['-y', '@x/gh'] },
    'my-curator': { command: '/old/node', args: ['/old/server.js'] },
  },
  globalShortcut: 'Alt+Space',
};
const merged = buildFullConfigPayload(JSON.parse(JSON.stringify(existing)), DOMAINS);
eq('readable: was_empty false', merged.was_empty, false);
eq('readable: parse_error false', merged.parse_error, false);
eq('readable: merge_available true', merged.merge_available, true);
check('readable: every pre-existing top-level key survives',
  Object.keys(existing).every(k => k in merged.merged));
eq('readable: unrelated top-level value preserved', merged.merged.globalShortcut, 'Alt+Space');
check('readable: every OTHER mcpServer survives the merge',
  ['filesystem', 'github'].every(k => JSON.stringify(merged.merged.mcpServers[k]) === JSON.stringify(existing.mcpServers[k])));
check('readable: our own stale entry is REPLACED, not duplicated',
  merged.merged.mcpServers['my-curator'].command === process.execPath &&
  merged.merged.mcpServers['my-curator'].args.includes(DOMAINS));
eq('readable: server count is 3 (2 theirs + 1 ours)', Object.keys(merged.merged.mcpServers).length, 3);
check('readable: input object was not mutated in place',
  existing.mcpServers['my-curator'].command === '/old/node');

// A readable config with no mcpServers key at all.
const noServers = buildFullConfigPayload({ globalShortcut: 'X' }, DOMAINS);
eq('readable/no-mcpServers: was_empty false', noServers.was_empty, false);
eq('readable/no-mcpServers: unrelated key preserved', noServers.merged.globalShortcut, 'X');
eq('readable/no-mcpServers: our entry added', Object.keys(noServers.merged.mcpServers).length, 1);

// --- parseClaudeConfigText, both directions --------------------------------
eq('parse: valid JSON yields no sentinel', parseClaudeConfigText('{"a":1}').__parseError, undefined);
eq('parse: valid JSON yields the value', parseClaudeConfigText('{"a":1}').a, 1);
eq('parse: invalid JSON yields the sentinel', parseClaudeConfigText('{ ,, }').__parseError, true);
eq('parse: empty string yields the sentinel', parseClaudeConfigText('').__parseError, true);
eq('parse: truncated JSON yields the sentinel', parseClaudeConfigText('{"mcpServers":').__parseError, true);
// Documented edge: a file containing literal `null` is VALID JSON and is treated
// as "absent" downstream. Pinned so the behaviour is a decision, not a surprise.
eq('parse: literal null is valid JSON (not a parse error)', parseClaudeConfigText('null'), null);

// ---------------------------------------------------------------------------
section('§2  D1 — additive-only: no legacy field removed or renamed');
// ---------------------------------------------------------------------------

for (const [name, p] of [['absent', absent], ['corrupt', corrupt], ['readable', merged]]) {
  check(`${name}: legacy field 'was_empty' still present`, 'was_empty' in p);
  check(`${name}: legacy field 'merged' still present`, 'merged' in p);
  eq(`${name}: was_empty is a boolean`, typeof p.was_empty, 'boolean');
}
// Legacy consumer compatibility: src/public/app.js dereferences `merged` on the
// was_empty===false branch. `merged` must never be null while was_empty is false.
for (const [name, p] of [['absent', absent], ['corrupt', corrupt], ['readable', merged]]) {
  check(`${name}: never (was_empty=false AND merged=null) — would crash the shipped wizard`,
    !(p.was_empty === false && p.merged === null));
}

// ---------------------------------------------------------------------------
section('§3  D2 — the self-test spawns EXACTLY the prescribed launch line');
// ---------------------------------------------------------------------------

const entry = buildCuratorEntry(DOMAINS);
eq('buildCuratorEntry: command is the running node binary', entry.command, process.execPath);
eq('buildCuratorEntry: args length is 3', entry.args.length, 3);
eq('buildCuratorEntry: args[1] is --domains-path', entry.args[1], '--domains-path');
eq('buildCuratorEntry: args[2] is the domains dir', entry.args[2], DOMAINS);
check('buildCuratorEntry: args[0] is mcp/server.js', entry.args[0].endsWith(path.join('mcp', 'server.js')));

// --- source guards: ONE source, no second copy that can drift ---------------
check('source: the old arg-less spawn literal is gone',
  !/spawn\(\s*process\.execPath\s*,\s*\[\s*MCP_SERVER_PATH\s*\]/.test(routeSrc));
// Anchored on the trailing comma DELIBERATELY, and this guard is NOT the real
// protection — see §6. The unanchored form `…selfTestEntry\.args/` was verified
// by mutation to stay GREEN against
//   spawn(selfTestEntry.command, selfTestEntry.args.slice(0, 1), …)
// which is defect D2 reinstated in full: the child spawned with no
// --domains-path. Every other source guard in this section (the arg-less
// literal, the "exactly ONE args array" count, the --domains-path occurrence
// count) stayed green against it too. Anchoring closes that one shape; §6
// closes the class, by asserting on the child the route ACTUALLY spawned.
check('source: self-test spawns from the buildCuratorEntry result, args UNMODIFIED',
  /spawn\(\s*selfTestEntry\.command\s*,\s*selfTestEntry\.args\s*,/.test(routeSrc));
check('source: selfTestEntry is assigned from buildCuratorEntry(',
  /const\s+selfTestEntry\s*=\s*buildCuratorEntry\(/.test(routeSrc));
// If a second copy of the args array ever appears, the two can drift again —
// which is the entire failure mode being fixed.
eq('source: exactly ONE literal construction of the args array',
  (routeSrc.match(/\[\s*MCP_SERVER_PATH\s*,\s*'--domains-path'/g) || []).length, 1);
check('source: --domains-path appears only inside buildCuratorEntry',
  (routeSrc.match(/'--domains-path'/g) || []).length === 1);

// --- legacy self-test response fields still emitted -------------------------
for (const f of ['ok:', 'server_info:', 'tool_count:', 'tool_names:', 'domains:', 'stderr:']) {
  check(`source: legacy self-test response field ${f.slice(0, -1)} still emitted`, routeSrc.includes(f));
}
// The pass/fail gate must not have been silently redefined.
// Anchored on the trailing comma DELIBERATELY: an unanchored prefix match still
// passes when a third conjunct is appended (`&& !!listDomains?.result`), which is
// precisely how a silent redefinition of the gate would arrive. Caught by
// mutation — the first version of this guard was green against exactly that.
check('source: the `ok` gate is still EXACTLY init.result && toolsList.result',
  /ok:\s*!!init\?\.result\s*&&\s*!!toolsList\?\.result\s*,\s*\n/.test(routeSrc));
check('classifyDomainsResult does not return an `ok` field (must not redefine the gate)',
  !('ok' in classifyDomainsResult(null, true)));

// ---------------------------------------------------------------------------
section('§4  D2 — end-to-end: the prescribed args ACTUALLY control the child');
// ---------------------------------------------------------------------------
//
// Two throwaway domains dirs with different domains. The CLI arg points at one;
// the env fallback (DOMAINS_PATH) points at the other. If --domains-path is
// dropped, the child resolves the fallback — so this discriminates. Both
// directions are asserted: passing the args must yield the explicit dir AND
// omitting them must yield the fallback, or the discriminator proves nothing.
//
// CURATOR_TEST_DOMAINS_DIR is deliberately NOT set: it outranks the CLI arg
// (mcp/storage/local.js rung 1) and would mask exactly what we are testing.

const tmpRoot     = mkdtempSync(path.join(os.tmpdir(), 'curator-mcp-contract-'));
const userDataDir = path.join(tmpRoot, 'userdata');
const explicitDir = path.join(tmpRoot, 'explicit');
const fallbackDir = path.join(tmpRoot, 'fallback');

function makeDomain(root, name) {
  mkdirSync(path.join(root, name, 'wiki'), { recursive: true });
  writeFileSync(path.join(root, name, 'CLAUDE.md'), `# ${name}\n`);
}
mkdirSync(userDataDir, { recursive: true });
makeDomain(explicitDir, 'zz-explicit-domain');
makeDomain(fallbackDir, 'zz-fallback-domain');

// `envOverride` lets §6 reuse this probe under ITS OWN tempdirs. Without it the
// probe would silently resolve §4's dirs, which §4 deletes on the way out — a
// "control" that measures a deleted directory proves nothing.
function runListDomains(args, envOverride) {
  return new Promise((resolve) => {
    const env = envOverride || { ...process.env, CURATOR_TEST_USER_DATA_DIR: userDataDir, DOMAINS_PATH: fallbackDir };
    delete env.CURATOR_TEST_DOMAINS_DIR;
    const proc = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let buf = '';
    let stderr = '';
    const frames = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      resolve({ frames, stderr });
    };
    const timer = setTimeout(finish, 8000);
    proc.on('error', finish);
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { frames.push(JSON.parse(line)); } catch {}
      }
      if (frames.some(f => f.id === 3)) finish();
    });
    const send = (o) => { try { proc.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract-test', version: '1' } } });
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_domains', arguments: {} } }), 120);
    }, 250);
  });
}

function domainsFrom(res) {
  const f = res.frames.find(x => x.id === 3);
  const text = f?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text).domains || null; } catch { return null; }
}

const withArgs = await runListDomains(buildCuratorEntry(explicitDir).args);
const withArgsDomains = domainsFrom(withArgs);
check('e2e: child responded to list_domains when spawned WITH --domains-path',
  Array.isArray(withArgsDomains));
check(`e2e: WITH args → the EXPLICIT dir is used (got ${JSON.stringify(withArgsDomains)})`,
  JSON.stringify(withArgsDomains) === JSON.stringify(['zz-explicit-domain']));

// Negative control — proves the discriminator can actually fail.
const withoutArgs = await runListDomains([MCP_SERVER]);
const withoutArgsDomains = domainsFrom(withoutArgs);
check('e2e: child responded to list_domains when spawned WITHOUT --domains-path',
  Array.isArray(withoutArgsDomains));
check(`e2e: WITHOUT args → the FALLBACK dir is used, i.e. the arg is load-bearing (got ${JSON.stringify(withoutArgsDomains)})`,
  JSON.stringify(withoutArgsDomains) === JSON.stringify(['zz-fallback-domain']));
check('e2e: the two spawns genuinely differ (the test can distinguish them)',
  JSON.stringify(withArgsDomains) !== JSON.stringify(withoutArgsDomains));

rmSync(tmpRoot, { recursive: true, force: true });

// ---------------------------------------------------------------------------
section('§5  D2 — list_domains outcome is reported HONESTLY (gate unchanged)');
// ---------------------------------------------------------------------------

const asText = (t, extra = {}) => ({ id: 3, result: { content: [{ type: 'text', text: t }], ...extra } });
const asJson = (o) => asText(JSON.stringify(o));

let r = classifyDomainsResult(asJson({ domains_path: '/x', count: 2, domains: ['a', 'b'] }), true);
eq('ok: status is ok', r.domains_status, 'ok');
check('ok: domains array preserved', JSON.stringify(r.domains) === JSON.stringify(['a', 'b']));
eq('ok: no error', r.domains_error, null);

r = classifyDomainsResult(asJson({ domains: [] }), true);
eq('empty-array: status is empty', r.domains_status, 'empty');
eq('empty-array: domains stays null (legacy type preserved)', r.domains, null);

// THE HONESTY FIX: a missing folder used to render as a cheerful "no domains".
r = classifyDomainsResult(asText('Curator domains folder not found at /gone. The Curator must be installed…'), false);
eq('missing folder: status is missing_folder, NOT empty', r.domains_status, 'missing_folder');
eq('missing folder: domains still null (legacy type preserved)', r.domains, null);
check('missing folder: the child\'s own sentence is surfaced', typeof r.domains_message === 'string' && r.domains_message.includes('not found'));

// The other direction: a genuinely empty but PRESENT folder is not scare-labelled.
r = classifyDomainsResult(asText('No domains found in /present. Open the Curator app and create a domain first.'), true);
eq('genuinely empty: status is empty', r.domains_status, 'empty');
eq('genuinely empty: no error raised', r.domains_error, null);

r = classifyDomainsResult(asText('some unexpected prose'), true);
eq('unrecognised text + folder present: status is unreadable', r.domains_status, 'unreadable');

r = classifyDomainsResult({ id: 3, error: { code: -32603, message: 'boom' } }, true);
eq('jsonrpc error: status is error', r.domains_status, 'error');
eq('jsonrpc error: message surfaced', r.domains_error, 'boom');
eq('jsonrpc error: domains null', r.domains, null);

r = classifyDomainsResult(asText('Error running list_domains: EACCES', { isError: true }), true);
eq('tool isError: status is error', r.domains_status, 'error');
check('tool isError: message surfaced', String(r.domains_error).includes('EACCES'));

r = classifyDomainsResult(undefined, true);
eq('no response: status is no_response', r.domains_status, 'no_response');
eq('no response: domains null', r.domains, null);

r = classifyDomainsResult({ id: 3, result: {} }, true);
eq('no text content: status is unreadable', r.domains_status, 'unreadable');

r = classifyDomainsResult(asText('x'.repeat(900)), true);
check('long text is truncated (no unbounded echo into the response)',
  r.domains_message.length <= 501 && r.domains_message.endsWith('…'));

// Legacy type contract: `domains` is ALWAYS an array or null, never undefined.
for (const input of [undefined, null, { id: 3, result: {} }, asText('x'), asJson({ domains: [] }), asJson({ domains: ['a'] })]) {
  const out = classifyDomainsResult(input, true);
  check('domains is always array-or-null, never undefined',
    out.domains === null || Array.isArray(out.domains));
}

// ---------------------------------------------------------------------------
section('§6  D2 — BEHAVIOURAL: the ROUTE itself passes --domains-path to the child');
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS, and why §3 and §4 together are not enough.
//
//   §3 asserts the SHAPE of the spawn call in the source. A regex is one clever
//      edit from useless: `selfTestEntry.args.slice(0, 1)` reinstates D2 exactly
//      and was measured green against every §3 guard.
//   §4 asserts that the CHILD honours --domains-path when it is given. Nothing
//      in it touches the route, so it stays green no matter what the route does.
//
// The untested seam is the join: does the ROUTE hand the child the dir the ROUTE
// resolved? That is the actual defect. This section drives the real exported
// handler and inspects the domains the spawned child came back with.
//
// The discriminator: the parent's dir is set via __setDomainsDirOverride, which
// is IN-PROCESS ONLY — the child cannot inherit it and can only learn that dir
// from the CLI argument. The child's own fallback (DOMAINS_PATH) is pointed at a
// different dir holding a differently-named domain. So a route that drops the
// argument reports the fallback's domain and this section goes red.
//
// CURATOR_TEST_DOMAINS_DIR must stay UNSET: it outranks the CLI arg in the child
// (mcp/storage/local.js rung 1) and would mask exactly what is being measured.
// CURATOR_TEST_USER_DATA_DIR IS set, so the child's config rung cannot find the
// developer's real domainsPath — which would both outrank DOMAINS_PATH and read
// their real wiki.

const routeRoot     = mkdtempSync(path.join(os.tmpdir(), 'curator-mcp-route-'));
const routeUserData = path.join(routeRoot, 'userdata');
const routeExplicit = path.join(routeRoot, 'explicit');
const routeOther    = path.join(routeRoot, 'other');
const routeFallback = path.join(routeRoot, 'fallback');

mkdirSync(routeUserData, { recursive: true });
makeDomain(routeExplicit, 'zz-route-explicit');
makeDomain(routeOther,    'zz-route-other');
makeDomain(routeFallback, 'zz-route-fallback');

const savedEnv = {
  DOMAINS_PATH: process.env.DOMAINS_PATH,
  CURATOR_TEST_USER_DATA_DIR: process.env.CURATOR_TEST_USER_DATA_DIR,
  CURATOR_TEST_DOMAINS_DIR: process.env.CURATOR_TEST_DOMAINS_DIR,
};
// The handler spawns with no `env` option, so the child inherits process.env.
process.env.DOMAINS_PATH = routeFallback;
process.env.CURATOR_TEST_USER_DATA_DIR = routeUserData;
delete process.env.CURATOR_TEST_DOMAINS_DIR;

/** Drive the REAL route handler with the parent resolving `dir`. */
async function callSelfTest(dir) {
  __setDomainsDirOverride(dir);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ __timeout: true }); } }, 20000);
    const res = {
      json(body) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(body);
      },
    };
    Promise.resolve(selfTestHandler({}, res)).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ __threw: String(err && err.message) });
    });
  });
}

const asNames = (b) => JSON.stringify(Array.isArray(b.domains) ? b.domains : b.domains);

const routeA = await callSelfTest(routeExplicit);
check('route: handler produced a response (not a timeout/throw)',
  !routeA.__timeout && !routeA.__threw && routeA.ok === true);
eq('route: the dir the route resolved is reported back', routeA.domains_dir, routeExplicit);
check(`route: the CHILD read the dir the ROUTE resolved — not its own fallback (got ${asNames(routeA)})`,
  asNames(routeA) === JSON.stringify(['zz-route-explicit']));
eq('route: a readable, populated folder classifies as ok', routeA.domains_status, 'ok');
// Reported-vs-actual: spawn_args is derived from the same entry, so it can agree
// with the prescription while the spawn disagrees. Asserted as a contract on the
// reported field only — the load-bearing proof is the domain name above.
check('route: spawn_args carries --domains-path <resolved dir>',
  Array.isArray(routeA.spawn_args)
  && routeA.spawn_args[routeA.spawn_args.length - 2] === '--domains-path'
  && routeA.spawn_args[routeA.spawn_args.length - 1] === routeExplicit);

// Second run at a DIFFERENT dir, same fallback. Doubles the red surface: if the
// argument were dropped, BOTH runs would return zz-route-fallback.
const routeB = await callSelfTest(routeOther);
check(`route: re-resolving the parent's dir re-points the child (got ${asNames(routeB)})`,
  asNames(routeB) === JSON.stringify(['zz-route-other']));
check('route: the two runs genuinely differ (this section can distinguish them)',
  asNames(routeA) !== asNames(routeB));
check('route: neither run fell through to the child\'s own DOMAINS_PATH fallback',
  asNames(routeA) !== JSON.stringify(['zz-route-fallback'])
  && asNames(routeB) !== JSON.stringify(['zz-route-fallback']));

// Negative control — the fallback dir IS reachable, so the two assertions above
// are discriminating rather than vacuously true.
const fallbackProbe = domainsFrom(await runListDomains([MCP_SERVER], { ...process.env }));
check(`control: a child spawned WITHOUT the arg does reach zz-route-fallback (got ${JSON.stringify(fallbackProbe)})`,
  JSON.stringify(fallbackProbe) === JSON.stringify(['zz-route-fallback']));

// A route pointed at a folder that does not exist must NOT report a cheerful
// "no domains yet" — that is the user-visible half of D2.
const routeMissing = await callSelfTest(path.join(routeRoot, 'does-not-exist'));
eq('route: a missing knowledge folder classifies as missing_folder, NOT empty',
  routeMissing.domains_status, 'missing_folder');
eq('route: missing folder does not fail the bridge gate', routeMissing.ok, true);

__setDomainsDirOverride(null);
for (const [k, v] of Object.entries(savedEnv)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
rmSync(routeRoot, { recursive: true, force: true });

// ---------------------------------------------------------------------------
section('§7  D2 — the honest result actually REACHES the user (frontend consumes it)');
// ---------------------------------------------------------------------------
//
// domains_status is worthless as a field. It is only worth anything as a
// SENTENCE ON SCREEN. Shipping it with zero consumers left the reported defect
// fully intact behind a green suite: the wizard still answered a missing
// knowledge folder with "no domains yet … the issue is inside its config file",
// which is the exact harm D2 exists to remove.

const appSrc = readFileSync(path.join(REPO_ROOT, 'src', 'public', 'app.js'), 'utf8');

/** Slice a function body out of source by brace-matching from its signature. */
function functionBody(src, signature) {
  const at = src.indexOf(signature);
  if (at === -1) return null;
  const open = src.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

const selfTestFn = functionBody(appSrc, 'async function runSelfTestInto(');
check('frontend: runSelfTestInto located in app.js', typeof selfTestFn === 'string' && selfTestFn.length > 200);

if (selfTestFn) {
  check('frontend: runSelfTestInto reads data.domains_status', /data\.domains_status/.test(selfTestFn));
  check('frontend: it branches on the status (switch/case or equivalent)',
    /case\s*'(ok|empty|missing_folder)'/.test(selfTestFn));
  check('frontend: an unrecognised/degraded status still renders something honest (default arm present)',
    /\bdefault\s*:/.test(selfTestFn));
  for (const s of ['ok', 'empty', 'missing_folder']) {
    check(`frontend: status '${s}' has its own arm`,
      new RegExp(`case\\s*'${s}'`).test(selfTestFn));
  }

  // THE REGRESSION THAT MATTERS. This sentence is correct for a healthy bridge
  // and actively harmful for a missing/unreadable folder — it sends the user to
  // debug the one file that is fine. It must live ONLY in the 'ok' arm.
  const BLAME_CONFIG = "the issue is inside its config file";
  const arms = selfTestFn.split(/case\s*'|(?=\bdefault\s*:)/);
  const blamingArms = arms.filter(a => a.includes(BLAME_CONFIG));
  check(`frontend: the "blame the config file" sentence appears in exactly one arm (found ${blamingArms.length})`,
    blamingArms.length === 1);
  check('frontend: and that arm is the healthy \'ok\' one',
    blamingArms.length === 1 && blamingArms[0].startsWith("ok'"));
  check('frontend: the missing_folder arm explicitly tells the user NOT to blame the config file',
    /missing_folder'[\s\S]*?not a mistake in your Claude Desktop config file/.test(selfTestFn));

  // XSS boundary: every one of these is a spawned child's stdout or a path.
  for (const f of ['domains_dir', 'domains_error', 'domains_message']) {
    check(`frontend: data.${f} is never interpolated unescaped`,
      !new RegExp(`\\$\\{\\s*data\\.${f}\\s*\\}`).test(selfTestFn));
  }
  check('frontend: the domain NAMES from the child are escaped too',
    !/\$\{\s*data\.domains\.join/.test(selfTestFn) && /data\.domains\.map\(escapeHtml\)/.test(selfTestFn));
  check('frontend: stderr is still escaped on the failure path',
    /escapeHtml\(data\.stderr\)/.test(selfTestFn));
}

// D1 residue — the "Your file now" pane must not claim an unparseable file is empty.
const renderFn = functionBody(appSrc, "const diffBefore = document.getElementById('mcp-diff-before')");
check('frontend: the diff-before block was located', typeof renderFn === 'string');
if (renderFn) {
  const mergeAt = renderFn.indexOf('merge_available');
  const emptyAt = renderFn.indexOf('was_empty');
  check('frontend: diff-before checks merge_available at all', mergeAt !== -1);
  check('frontend: …and checks it BEFORE was_empty, so a corrupt file never renders as "{}"',
    mergeAt !== -1 && emptyAt !== -1 && mergeAt < emptyAt);
  check('frontend: the corrupt branch says the file is unreadable, not empty',
    /not valid JSON/.test(renderFn));
}

// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('All MCP setup-contract assertions passed.');
