/**
 * test-next-mcp-wizard.js — OFFLINE suite for the /next MCP setup wizard
 * (src/public/next/views/mcp-wizard.js + views/mcp-wizard.css + the
 * views/settings.js seam).
 *
 * No network, no API key, no server. The wizard's decision logic is written
 * as pure functions with no DOM and no fetch precisely so it can be driven
 * here; they are extracted from the REAL source by brace-matching and
 * evaluated standalone with `new Function` — the pattern
 * scripts/test-raw-source-ui.js and scripts/test-chat-markdown.js already
 * use. Wiring, escaping discipline and the CSS/HTML seams are checked with
 * source-level guards against the real files.
 *
 * ── What this suite ACTUALLY covers, and what it does not ───────────────
 * COVERED, behaviourally (the function is executed, both directions):
 *   - interpretMcpConfig(): every backend field → normalised status,
 *     including the case a corrupt config produces (installed/stale both
 *     false, which must NOT read as "not connected").
 *   - wholeFilePayloadAvailability() and wholeFileUsable(): the two
 *     INDEPENDENT layers of the destructive-payload gate (may we request it;
 *     may we use what came back), each proven to refuse on its own.
 *   - classifyResponse(): the v2.3.3 SPA-fallthrough guard.
 *   - copyOutcome() + runCopyAndAdvance(): a failed clipboard write must
 *     not advance the step, and a successful one must.
 *   - describeSelfTest(): every failure shape the route can produce,
 *     including ok:false with `error` undefined.
 *   - blockerFor(): which blocked panel each blocker renders.
 *   - The tool-count constants, pinned against the REAL mcp/tools/index.js
 *     and the REAL refuseIfReadonly call sites.
 *
 * NOT COVERED here (stated rather than implied):
 *   - Rendering. Every render* function touches the DOM and is checked only
 *     by source-level guards below (that it uses textContent, that the
 *     whole-file fetch sits behind the gate). A rendering regression that
 *     keeps those shapes intact would pass this suite.
 *   - Focus trapping, Escape, and the pip/step transitions — browser-only.
 *   - Anything about the actual MCP bridge or Claude Desktop.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const WIZ_PATH = path.join(ROOT, 'src/public/next/views/mcp-wizard.js');
const wiz = readFileSync(WIZ_PATH, 'utf8');
const wizCss = readFileSync(path.join(ROOT, 'src/public/next/views/mcp-wizard.css'), 'utf8');
const nextIndex = readFileSync(path.join(ROOT, 'src/public/next/index.html'), 'utf8');
const settings = readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');

// ── Comment stripping for the source guards ─────────────────────────────
// The §9/§10 guards are ABSENCE and COUNT checks against real source, and
// this file's own subjects are heavily commented — including comments that
// deliberately quote the very strings being asserted absent (the old
// "seventeen tools" copy, "not var(--scrim, ...)", "no registerView"). Run
// against raw text, every one of those guards would be reading a comment
// instead of code, which is precisely the "the check stopped reaching what
// it protects" failure this repo has recorded more than once.
//
// Deliberately conservative: it removes /* … */ blocks and lines whose
// first non-whitespace characters are //. It does NOT try to strip
// end-of-line comments, because distinguishing those from a // inside a
// string needs a real lexer — and the safe direction for an ABSENCE check
// is to leave too much in (a false FAILURE the author must look at), never
// too little (a false pass). assertStrippedSane() below fails loudly if a
// strip ever removes something it shouldn't have.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}
function assertStrippedSane(stripped, label, mustContain) {
  for (const needle of mustContain) {
    if (!stripped.includes(needle)) {
      throw new Error(`stripComments over-reached on ${label}: "${needle}" is gone from the stripped code`);
    }
  }
  return stripped;
}

// Code-only views of the three sources the §9/§10 guards inspect.
const wizCode = assertStrippedSane(stripComments(wiz), 'mcp-wizard.js',
  ["async function getJson(url, init)", "export function openMcpWizard(opts)", "role=\"dialog\""]);
const settingsCode = assertStrippedSane(stripComments(settings), 'settings.js',
  ["function wireMcpListeners()", "id=\"btn-mcp-wizard\"", "twenty tools"]);
// The second canary was `rgba(5,5,10,0.68)` — the scrim darkness, inlined
// here because `--scrim` was an undefined name baselined at exactly one
// reference. All five /next overlays now read `--modal-scrim`, a real
// definition in shell.css, so that literal is gone from this file. The
// canary moves to the declaration that replaced it, which is what a
// canary is for: a string that must survive the strip, not a value this
// suite has an opinion about.
const wizCssCode = assertStrippedSane(stripComments(wizCss), 'mcp-wizard.css',
  [".mcpw-scrim {", "var(--modal-scrim)"]);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Extract the pure functions from the real source ──────────────────────
// Brace-matched so nested braces in a body can't truncate the extraction.
// If a name goes missing (renamed, deleted, or turned into an arrow const)
// this THROWS rather than silently testing nothing — the failure mode this
// repo has recorded more than once is a green suite that stopped reaching
// what it was written to protect.
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in mcp-wizard.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  // Skip the PARAMETER LIST before looking for the body brace. Caught while
  // writing this suite: runCopyAndAdvance takes a destructured argument
  // (`function runCopyAndAdvance({ copy, ... })`), so a naive
  // indexOf('{', start) latches onto the parameter pattern and the
  // brace-matcher then "ends" the function at the closing paren — yielding
  // a truncated, syntactically broken extraction. Match the paren pair
  // first, then take the next brace.
  let p = src.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i);
  // Tripwire: a truncated extraction must fail LOUDLY here, not later as a
  // confusing SyntaxError from new Function() (which is exactly what the
  // parameter-list bug above produced).
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

// Constants the extracted functions close over.
// Stops at the first `;` that ends a LINE — allowing an end-of-line comment
// after it. Caught while writing this suite: `const TOOL_READ = TOOL_TOTAL -
// TOOL_WRITE; // 14` has a trailing comment, so a plain `;\n` terminator
// walked straight past it and swallowed everything up to the next
// semicolon-at-end-of-line — silently producing an unbalanced sandbox. The
// tripwire below turns any future version of that into a named failure
// rather than a bare SyntaxError from new Function().
function extractConst(src, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} =[\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found in mcp-wizard.js`);
  const extracted = m[0].trim();
  if (/\bfunction\s/.test(extracted)) {
    throw new Error(`extractConst: "${name}" extraction swallowed a function — the terminator desynced`);
  }
  return extracted;
}

const PURE_FNS = [
  'interpretMcpConfig',
  'wholeFilePayloadAvailability',
  'wholeFileUsable',
  'writeConfigAvailability',
  'writeConfigOutcome',
  'classifyResponse',
  'copyOutcome',
  'runCopyAndAdvance',
  'describeSelfTest',
  'blockerFor',
  'joinCauses',
  // Reads the module-level `state` object, so the sandbox below declares one
  // and §2c drives it directly. Extracting it is what makes "the clipboard
  // cannot bypass the gate" a BEHAVIOURAL assertion rather than a source
  // regex — a mutation that removed the re-check stayed GREEN until this
  // was added.
  'currentPayload',
];
const PURE_CONSTS = ['STALE_ROUTES_MESSAGE', 'STALE_CAUSES', 'TOOL_TOTAL', 'TOOL_WRITE', 'TOOL_READ'];

const sandbox = new Function(
  'let state = {};\n' +
  PURE_CONSTS.map(c => extractConst(wiz, c)).join('\n') + '\n' +
  PURE_FNS.map(n => extractFunction(wiz, n)).join('\n\n') + '\n' +
  `return { ${PURE_FNS.join(', ')}, ${PURE_CONSTS.join(', ')}, __setState: (s) => { state = s; } };`
)();

const {
  interpretMcpConfig, wholeFilePayloadAvailability, wholeFileUsable, classifyResponse,
  writeConfigAvailability, writeConfigOutcome,
  copyOutcome, runCopyAndAdvance, describeSelfTest, blockerFor, joinCauses, currentPayload,
  STALE_CAUSES, TOOL_TOTAL, TOOL_WRITE, TOOL_READ, __setState,
} = sandbox;

// A healthy /api/mcp/config body, used as the base for every variation.
function healthyConfig(over) {
  return Object.assign({
    ok: true,
    mcp_server_path: '/Apps/Curator/mcp/server.js',
    mcp_server_exists: true,
    mcp_server_name: 'my-curator',
    domains_dir: '/Users/x/Knowledge',
    domains_dir_exists: true,
    node_binary: '/opt/homebrew/bin/node',
    claude_config_path: '/Users/x/Library/Application Support/Claude/claude_desktop_config.json',
    claude_config_exists: true,
    claude_config_parse_error: false,
    installed: false,
    stale: false,
  }, over || {});
}

// ═════════════════════════════════════════════════════════════════════════
section('1. interpretMcpConfig() — the ONE place a backend field is read');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = interpretMcpConfig(healthyConfig());
  ok(s.blocker === null, 'a healthy config produces no blocker');
  ok(s.connection === 'absent', 'no curator entry yet → connection "absent"');
  ok(s.serverName === 'my-curator', 'server name is carried through');
  ok(s.configPath.endsWith('claude_desktop_config.json'), 'config path is carried through');

  const inst = interpretMcpConfig(healthyConfig({ installed: true }));
  ok(inst.connection === 'connected', 'installed + not stale → "connected"');

  const stale = interpretMcpConfig(healthyConfig({ installed: true, stale: true }));
  ok(stale.connection === 'stale', 'installed + stale → "stale"');
  ok(stale.blocker === null, 'a stale entry is NOT a blocker — it is fixable in step 1');

  // The corrupt case. The route computes installed/stale inside its
  // !parseError branch, so both arrive false — which must not be reported
  // as a negative claim about the user's setup.
  const bad = interpretMcpConfig(healthyConfig({ claude_config_parse_error: true, installed: false, stale: false }));
  ok(bad.parseError === true, 'claude_config_parse_error is read at all (no frontend did before)');
  ok(bad.blocker === 'config-corrupt', 'a corrupt config is a BLOCKER');
  ok(bad.connection === 'unknown', 'corrupt config → "unknown", NOT "absent"');
  ok(bad.connection !== 'absent', 'and specifically never claims "not connected"');

  ok(interpretMcpConfig(healthyConfig({ domains_dir_exists: false })).blocker === 'domains-missing',
    'a missing knowledge folder blocks setup (defect 8)');
  ok(interpretMcpConfig(healthyConfig({ mcp_server_exists: false })).blocker === 'server-missing',
    'a missing bridge program blocks setup');

  // Severity ordering: a missing bridge outranks a corrupt config, because
  // fixing the JSON would not help.
  const both = interpretMcpConfig(healthyConfig({ mcp_server_exists: false, claude_config_parse_error: true }));
  ok(both.blocker === 'server-missing', 'missing bridge outranks corrupt config');

  // Defensive inputs — the wizard must not throw on a shape it did not expect.
  ok(interpretMcpConfig(null).blocker === 'server-missing', 'null payload → blocked, not a throw');
  ok(interpretMcpConfig('nope').blocker === 'server-missing', 'non-object payload → blocked, not a throw');
  ok(interpretMcpConfig({}).connection === 'absent', 'empty payload does not crash');

  // Additive-only backend contract: an unknown extra field changes nothing.
  const extra = interpretMcpConfig(healthyConfig({ some_future_field: 'x', another: 42 }));
  ok(extra.blocker === null && extra.connection === 'absent',
    'unknown extra response fields are ignored (the contract is additive-only)');

  // Truthiness must NOT be enough — the fields are strict booleans server-side.
  ok(interpretMcpConfig(healthyConfig({ claude_config_parse_error: 'false' })).parseError === false,
    'the string "false" is not treated as a parse error (strict === true)');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. wholeFilePayloadAvailability() — the destructive-payload gate');
// ═════════════════════════════════════════════════════════════════════════
{
  // BOTH directions. A gate that always refuses is as broken as one that
  // never does — the normal case must still get the convenient payload.
  const good = wholeFilePayloadAvailability(interpretMcpConfig(healthyConfig()));
  ok(good.offered === true, 'NORMAL case: the whole-file payload IS offered');
  ok(good.reason === null, 'and carries no refusal reason');

  const empty = wholeFilePayloadAvailability(interpretMcpConfig(healthyConfig({ claude_config_exists: false })));
  ok(empty.offered === true, 'no config file at all: still offered (creating one cannot lose anything)');

  const stale = wholeFilePayloadAvailability(interpretMcpConfig(healthyConfig({ installed: true, stale: true })));
  ok(stale.offered === true, 'a stale entry does not withhold the whole-file payload');

  const bad = wholeFilePayloadAvailability(interpretMcpConfig(healthyConfig({ claude_config_parse_error: true })));
  ok(bad.offered === false, 'CORRUPT case: the whole-file payload is REFUSED');
  ok(typeof bad.reason === 'string' && bad.reason.length > 20, 'and explains why in prose the user can act on');
  ok(/other MCP server/i.test(bad.reason), 'the reason names the actual harm — losing the other servers');

  ok(wholeFilePayloadAvailability(null).offered === false, 'no status → refused (fails closed)');
  ok(wholeFilePayloadAvailability(undefined).offered === false, 'undefined status → refused (fails closed)');
}

// ═════════════════════════════════════════════════════════════════════════
section('2b. wholeFileUsable() — the independent SECOND layer');
// ═════════════════════════════════════════════════════════════════════════
{
  // src/routes/mcp.js answers a corrupt file with merge_available:false /
  // merged:null / merge_error:"…". Layer 1 reasons from /config and decides
  // whether to REQUEST; this reasons from what /claude-full-config SENT and
  // decides whether to USE. Neither may depend on the other holding.
  const healthy = interpretMcpConfig(healthyConfig());
  const corruptStatus = interpretMcpConfig(healthyConfig({ claude_config_parse_error: true }));

  const goodPayload = { was_empty: false, parse_error: false, merge_available: true, merged: { mcpServers: {} }, merge_error: null };
  ok(wholeFileUsable(healthy, goodPayload).usable === true, 'NORMAL: a real merged payload is usable');
  ok(wholeFileUsable(healthy, goodPayload).wasEmpty === false, 'and was_empty is carried through');

  const emptyFilePayload = { was_empty: true, merge_available: true, merged: { mcpServers: {} } };
  ok(wholeFileUsable(healthy, emptyFilePayload).usable === true, 'a brand-new file is usable');
  ok(wholeFileUsable(healthy, emptyFilePayload).wasEmpty === true, 'and reported as "you don’t have one yet"');

  const refusedPayload = {
    was_empty: true, parse_error: true, merge_available: false, merged: null,
    merge_error: 'Your existing claude_desktop_config.json contains invalid JSON…',
  };
  ok(wholeFileUsable(healthy, refusedPayload).usable === false,
    'merge_available:false is refused EVEN IF layer 1 said the request was fine (independence)');
  ok(/invalid JSON/i.test(wholeFileUsable(healthy, refusedPayload).reason),
    'and the backend’s own merge_error is surfaced verbatim');

  ok(wholeFileUsable(corruptStatus, goodPayload).usable === false,
    'layer 1 alone still refuses even given a payload that looks fine (independence, other direction)');

  // Fail-closed shapes.
  ok(wholeFileUsable(healthy, null).usable === false, 'a missing payload is refused');
  ok(wholeFileUsable(healthy, {}).usable === false, 'a payload with no merged object is refused');
  ok(wholeFileUsable(healthy, { merge_available: true, merged: null }).usable === false,
    'merge_available:true with merged:null still fails closed');
  ok(wholeFileUsable(healthy, { merged: { a: 1 } }).usable === true,
    'a pre-v3.6.1 payload with no merge_available field still works (back-compat)');

  // UNMASKED: the case above (merge_available:false + merged:null) is also
  // caught by the merged-is-null guard, so disabling the flag check alone
  // left it GREEN — found by mutation, not by reading. This one can ONLY be
  // caught by the flag, so the flag is now independently load-bearing.
  const flagOnlyRefusal = { merge_available: false, merged: { mcpServers: { 'my-curator': {} } }, merge_error: 'nope' };
  ok(wholeFileUsable(healthy, flagOnlyRefusal).usable === false,
    'merge_available:false is honoured EVEN WHEN merged is a real object (the flag alone is load-bearing)');
}

// ═════════════════════════════════════════════════════════════════════════
section('2c. currentPayload() — the clipboard cannot bypass the gate');
// ═════════════════════════════════════════════════════════════════════════
{
  // state.payloadChoice comes from a DOM radio, and that radio's visibility
  // is a RENDER concern. If currentPayload trusted the choice, a stale
  // 'whole' selection would put a destructive payload on the clipboard even
  // though the gate had since refused it. Driven here against the real
  // function with a fabricated module state.
  const healthy = interpretMcpConfig(healthyConfig());
  const corrupt = interpretMcpConfig(healthyConfig({ claude_config_parse_error: true }));
  const snippet = { mcpServers: { 'my-curator': { command: '/n', args: [] } } };
  const merged = { mcpServers: { 'my-curator': {}, other: {} } };

  __setState({ payloadChoice: 'entry', status: healthy, snippet, wholeFile: { merge_available: true, merged } });
  ok(currentPayload().kind === 'entry', 'choice "entry" yields the entry payload');
  ok(currentPayload().json === snippet, 'and it is the snippet object');

  __setState({ payloadChoice: 'whole', status: healthy, snippet, wholeFile: { merge_available: true, merged } });
  ok(currentPayload().kind === 'whole', 'choice "whole" yields the whole-file payload when the gate allows it');
  ok(currentPayload().json === merged, 'and it is the merged object');

  // The bypass attempts. Each must fall back to the entry payload.
  __setState({ payloadChoice: 'whole', status: corrupt, snippet, wholeFile: { merge_available: true, merged } });
  ok(currentPayload().kind === 'entry',
    'a stale "whole" choice with a CORRUPT config falls back to the entry payload (layer 1)');

  __setState({ payloadChoice: 'whole', status: healthy, snippet, wholeFile: { merge_available: false, merged, merge_error: 'x' } });
  ok(currentPayload().kind === 'entry',
    'a stale "whole" choice with merge_available:false falls back to the entry payload (layer 2)');

  __setState({ payloadChoice: 'whole', status: healthy, snippet, wholeFile: null });
  ok(currentPayload().kind === 'entry', 'and with no whole-file payload at all');
}

// ═════════════════════════════════════════════════════════════════════════
section('2d. writeConfigAvailability() — the "Write it for me" gate');
// ═════════════════════════════════════════════════════════════════════════
{
  // POST /api/mcp/write-config shipped proven and UNWIRED. This is the gate
  // in front of its only caller. The state that matters most is the corrupt
  // one: rewriting a file we cannot parse means emitting a document holding
  // only our entry, which DELETES every other MCP server the user has.
  const absent = interpretMcpConfig(healthyConfig({ claude_config_exists: false, installed: false }));
  const stale = interpretMcpConfig(healthyConfig({ installed: true, stale: true }));
  const connected = interpretMcpConfig(healthyConfig({ installed: true, stale: false }));
  const corrupt = interpretMcpConfig(healthyConfig({ claude_config_parse_error: true }));

  ok(absent.connection === 'absent', 'fixture check: the absent fixture really is "absent"');
  ok(stale.connection === 'stale', 'fixture check: the stale fixture really is "stale"');
  ok(connected.connection === 'connected', 'fixture check: the connected fixture really is "connected"');
  ok(corrupt.connection === 'unknown', 'fixture check: a parse error reads as "unknown", never as a negative claim');

  ok(writeConfigAvailability(absent).offered === true, 'OFFERED when no config entry exists');
  ok(writeConfigAvailability(stale).offered === true, 'OFFERED when the entry is stale');
  ok(writeConfigAvailability(connected).offered === false,
    'NOT offered when already connected — a write there replaces the user’s file for no change');
  ok(writeConfigAvailability(connected).reason === null,
    'and that is not an error, so it carries no reason to show');

  ok(writeConfigAvailability(corrupt).offered === false, 'REFUSED on a parse error');
  ok(/valid JSON/i.test(writeConfigAvailability(corrupt).reason || ''),
    'and says why, in terms of the file rather than of an HTTP code');
  ok(/other MCP server/i.test(writeConfigAvailability(corrupt).reason || ''),
    'naming the ACTUAL harm — the other servers that would be dropped');

  ok(writeConfigAvailability(null).offered === false, 'a missing status is refused, not treated as absent');
  ok(writeConfigAvailability(undefined).offered === false, 'and so is undefined');
  ok(writeConfigAvailability('nope').offered === false, 'and a non-object');
  ok(writeConfigAvailability({}).offered === false,
    'an object with NO connection field is refused — the gate opens on a positive match, never by default');

  // CONTROL: the gate must be able to say yes, or every assertion above is
  // satisfied by a function that returns false unconditionally.
  ok([absent, stale].every(s => writeConfigAvailability(s).offered),
    'CONTROL: the gate DOES open on both states it is meant to open on');
}

// ═════════════════════════════════════════════════════════════════════════
section('2e. writeConfigOutcome() — what the user is told after a write');
// ═════════════════════════════════════════════════════════════════════════
{
  const created = writeConfigOutcome({ ok: true, written: true, created: true, backup_path: null, preserved_servers: [] });
  ok(created.tone === 'ok', 'a successful create reports tone ok');
  ok(/Created the config file/.test(created.message), 'and says it CREATED the file');
  ok(!/\.bak/.test(created.message), 'and does NOT mention a backup, because there was nothing to back up');

  const updated = writeConfigOutcome({
    ok: true, written: true, created: false,
    backup_path: '/Users/x/Library/Application Support/Claude/claude_desktop_config.json.bak',
    preserved_servers: ['a', 'b', 'c'],
  });
  ok(/Updated the config file/.test(updated.message), 'an update says UPDATED, not created');
  ok(/3 other MCP servers were left untouched/.test(updated.message),
    'and REPORTS the other servers rather than asking the user to take it on trust');
  ok(/\.bak/.test(updated.message), 'and names the backup of the original bytes');

  const one = writeConfigOutcome({ created: false, backup_path: '/x.bak', preserved_servers: ['solo'] });
  ok(/1 other MCP server was/.test(one.message), 'one server is singular');
  ok(!/1 other MCP servers/.test(one.message), 'and not "1 other MCP servers"');

  // A malformed or partial response must still produce a sentence rather than
  // "undefined" — the route is proven, but a stale server answering this route
  // is exactly the case classifyResponse exists for and it can reach here.
  const bare = writeConfigOutcome({});
  ok(typeof bare.message === 'string' && bare.message.length > 0, 'a bare payload still yields a message');
  ok(!/undefined|NaN|\[object/.test(bare.message), 'with no undefined/NaN/[object Object] leaking into it');
  ok(!/other MCP server/.test(bare.message), 'and claims nothing about servers it was not told about');
  ok(/restart Claude Desktop/i.test(bare.message), 'while still naming the next step, which is always true');
  const nullish = writeConfigOutcome(null);
  ok(typeof nullish.message === 'string' && nullish.message.length > 0, 'and null does not throw');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. classifyResponse() — the v2.3.3 SPA-fallthrough guard');
// ═════════════════════════════════════════════════════════════════════════
{
  // TRIGGERS: server.js's app.get('*') answers 200 with index.html, and a
  // stale server answers an unknown POST with Express's HTML 404.
  ok(classifyResponse(200, 'text/html; charset=utf-8') === 'html',
    'HTTP 200 + text/html → "html" (the SPA fallback — restart needed)');
  ok(classifyResponse(404, 'text/html; charset=utf-8') === 'html',
    'HTTP 404 + text/html → "html" (Express 404 for a POST route that does not exist yet)');
  ok(classifyResponse(200, 'TEXT/HTML') === 'html', 'content-type match is case-insensitive');

  // DOES NOT TRIGGER — the half people forget.
  ok(classifyResponse(200, 'application/json; charset=utf-8') === 'json',
    'HTTP 200 + JSON → "json" (the normal path is NOT mislabelled)');
  ok(classifyResponse(204, 'application/json') === 'json', 'any 2xx with JSON is fine');
  ok(classifyResponse(500, 'application/json; charset=utf-8') === 'http-error',
    'a genuine JSON 500 is "http-error", NOT "html" — it must not be reported as "restart the app"');
  ok(classifyResponse(500, 'application/json') !== 'html',
    'and specifically never classifies a real server error as a stale-routes case');
  ok(classifyResponse(403, 'application/json') === 'http-error', 'a JSON 403 is a real error');
  ok(classifyResponse(200, null) === 'json', 'a missing content-type on a 2xx is treated as JSON, not html');
  ok(classifyResponse(500, null) === 'http-error', 'a missing content-type on a 500 is still an error');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. copyOutcome() / runCopyAndAdvance() — a failed copy never advances');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(copyOutcome(true).advance === true, 'a successful copy advances');
  ok(copyOutcome(false).advance === false, 'a FAILED copy does not advance');
  ok(copyOutcome(false).tone === 'error', 'and is reported as an error, not silently');
  ok(/NOT been moved on/i.test(copyOutcome(false).message),
    'the failure message says explicitly that the user was not moved on');
  ok(/by hand|⌘C/i.test(copyOutcome(false).message), 'and offers the manual route');

  // Behavioural, with injected fakes — no DOM.
  const run = async (copyImpl) => {
    const seen = { advanced: 0, marked: 0, statuses: [] };
    const outcome = await runCopyAndAdvance({
      copy: copyImpl,
      showStatus: (o) => seen.statuses.push(o),
      onCopied: () => { seen.marked++; },
      advance: () => { seen.advanced++; },
    });
    return { seen, outcome };
  };

  const okRun = await run(async () => true);
  ok(okRun.seen.advanced === 1, 'copy resolves true → advance() called exactly once');
  ok(okRun.seen.marked === 1, 'and the copied payload is recorded exactly once');

  const failRun = await run(async () => false);
  ok(failRun.seen.advanced === 0, 'copy resolves false → advance() NEVER called');
  ok(failRun.seen.marked === 0, 'and no payload is recorded as copied');
  ok(failRun.seen.statuses.length === 1 && failRun.seen.statuses[0].tone === 'error',
    'the user is told, exactly once');

  const throwRun = await run(async () => { throw new Error('NotAllowedError'); });
  ok(throwRun.seen.advanced === 0, 'copy REJECTS → advance() never called (the shipping bug: it advanced anyway)');
  ok(throwRun.outcome.advance === false, 'and the returned outcome says so');

  const undefRun = await run(async () => undefined);
  ok(undefRun.seen.advanced === 0, 'a copy resolving undefined is not treated as success');

  // navigator.clipboard.writeText resolves undefined on success, so a naive
  // implementation could read that as failure. copyText() therefore returns
  // an explicit boolean; this pins that runCopyAndAdvance requires === true.
  const truthyRun = await run(async () => 'yes');
  ok(truthyRun.seen.advanced === 0, 'a merely-truthy copy result is not accepted either (strict === true)');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. describeSelfTest() — every branch has a next step');
// ═════════════════════════════════════════════════════════════════════════
{
  const okR = describeSelfTest({ ok: true, tool_count: 18, tool_names: ['list_domains'], domains: ['articles'], stderr: null });
  ok(okR.tone === 'ok', 'a working bridge reports ok');
  ok(/18 tools/.test(okR.detail), 'and names the tool count it actually got back');
  ok(/1 domain\b/.test(okR.detail), 'and the domain count, singular');

  const okNoDomains = describeSelfTest({ ok: true, tool_count: 18, domains: null });
  ok(okNoDomains.tone === 'ok', 'no domains yet is still a pass');
  ok(/expected on a brand-new install/i.test(okNoDomains.detail), 'and says so rather than looking like a fault');

  const zero = describeSelfTest({ ok: true, tool_count: 0 });
  ok(zero.tone === 'warn', 'ok:true with zero tools is a WARNING, not a pass');
  ok(zero.steps.length > 0, 'and carries next steps');

  // THE most likely failure: ok:false with `error` UNDEFINED. This is the
  // branch the shipping UI rendered as "Unknown error".
  const silent = describeSelfTest({ ok: false });
  ok(silent.tone === 'error', 'ok:false with no error field is an error');
  ok(!/unknown error/i.test(silent.headline + ' ' + silent.detail),
    'and NEVER renders as "Unknown error"');
  ok(silent.steps.length >= 2, 'it has concrete next steps');
  ok(/quit .*curator/i.test(silent.steps.join(' ')), 'including the restart that actually fixes it');

  const spawn = describeSelfTest({ ok: false, error: 'spawn ENOENT /nope/node' });
  ok(spawn.tone === 'error' && /Node could not start/i.test(spawn.headline),
    'a spawn/ENOENT error is identified as an install problem');
  ok(spawn.detail.includes('ENOENT'), 'and the raw error is still shown');
  ok(spawn.steps.some(s => /Updates/i.test(s)), 'with an actionable step');

  const stderrCase = describeSelfTest({ ok: false, stderr: 'SyntaxError: Unexpected token\n  at graph.js:12' });
  ok(/started and then failed/i.test(stderrCase.headline), 'output on stderr is classified as a startup failure');
  ok(stderrCase.stderr.includes('SyntaxError'), 'and the stderr is carried through for display');
  ok(stderrCase.steps.length > 0, 'with next steps');

  ok(describeSelfTest(null).tone === 'error', 'a null body does not throw');
  ok(describeSelfTest(null).steps.length > 0, 'and still offers a next step');
  ok(describeSelfTest('garbage').tone === 'error', 'a non-object body does not throw');

  // stderr is child-process output. It must never be blank-string-truthy.
  ok(describeSelfTest({ ok: false, stderr: '   ' }).stderr === null,
    'whitespace-only stderr is treated as absent, not as an error detail');
  ok(!/started and then failed/i.test(describeSelfTest({ ok: false, stderr: '  ' }).headline),
    'and does not trigger the stderr branch');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. blockerFor() — the blocked panels, especially the corrupt one');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(blockerFor(interpretMcpConfig(healthyConfig())) === null, 'no blocker → no panel');

  const corrupt = blockerFor(interpretMcpConfig(healthyConfig({ claude_config_parse_error: true })));
  ok(corrupt.kind === 'config-corrupt', 'the corrupt-config panel is selected');
  const corruptText = corrupt.title + ' ' + corrupt.body.join(' ') + ' ' + corrupt.steps.join(' ');
  ok(/not valid JSON/i.test(corruptText), 'it names the actual problem');
  ok(/wipe out|lost|other MCP server/i.test(corruptText), 'it explains the risk it is protecting against');
  ok(/fix the JSON|fix the json syntax/i.test(corruptText), 'it tells the user to fix the JSON first');
  ok(corrupt.showReveal === true, 'and offers to reveal the file');
  ok(corrupt.pathValue.endsWith('claude_desktop_config.json'), 'and shows the path');

  const domains = blockerFor(interpretMcpConfig(healthyConfig({ domains_dir_exists: false })));
  ok(domains.kind === 'domains-missing' && domains.steps.length > 0, 'the missing-folder panel has steps');
  ok(/Knowledge base/i.test(domains.steps.join(' ')), 'and points at the setting that fixes it');

  const server = blockerFor(interpretMcpConfig(healthyConfig({ mcp_server_exists: false })));
  ok(server.kind === 'server-missing' && server.showReveal === false,
    'the missing-bridge panel does not offer a Finder reveal (there is nothing to reveal)');
}

// ═════════════════════════════════════════════════════════════════════════
section('7. The stale message covers all four causes (defect 4)');
// ═════════════════════════════════════════════════════════════════════════
{
  const joined = STALE_CAUSES.join(' | ').toLowerCase();
  ok(STALE_CAUSES.length === 4, 'four causes are listed');
  ok(/knowledge folder/.test(joined), 'cause 1: the knowledge folder moved');
  ok(/curator itself was moved|reinstall/.test(joined), 'cause 2: the app directory moved');
  ok(/node/.test(joined) && /(nvm|homebrew)/.test(joined), 'cause 3: the Node binary path changed');
  ok(/by hand/.test(joined), 'cause 4: the entry was edited by hand');

  // The shipping copy said only the first, as a definite statement.
  ok(joinCauses(STALE_CAUSES).endsWith('or the entry was edited by hand'),
    'the four causes read as a finished list ("…, or …"), not a bare comma join');
  ok(joinCauses(['a']) === 'a' && joinCauses(['a', 'b']) === 'a or b' && joinCauses([]) === '',
    'joinCauses handles 0/1/2 items without producing a dangling "or"');

  ok(!/knowledge base folder has moved/i.test(wizCode),
    'the wizard does not carry the shipping app’s single-cause claim ("Your knowledge base folder has moved")');
}

// ═════════════════════════════════════════════════════════════════════════
section('8. Tool counts pinned against the REAL mcp/tools/index.js (defect 7)');
// ═════════════════════════════════════════════════════════════════════════
{
  const { tools } = await import(path.join(ROOT, 'mcp/tools/index.js'));
  const realTotal = tools.length;

  // Write tools = the ones guarded by refuseIfReadonly (Decision 7 — the
  // read/write boundary the MCP itself enforces). Counted from the real
  // tool modules, with comment lines excluded so a mention in prose cannot
  // inflate it.
  // ENUMERATED FROM DISK, never a hardcoded list. A literal list is the v3.14.0
  // FN_NAMES shape: a NEW tool module is simply absent from it, so the count comes
  // back LOW and the assertion keeps PASSING — the guard goes blind instead of red.
  // That is exactly what happened when working-state.js landed: the true mutator
  // count was 5 while this still read 4 and stayed green. The number it protects is
  // user-facing copy that CLAUDE.md records has already been wrong twice.
  const toolFiles = readdirSync(path.join(ROOT, 'mcp/tools'))
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .sort();
  ok(toolFiles.length >= 15,
    `refuseIfReadonly sweep enumerates the tool dir from disk (found ${toolFiles.length} modules)`);
  let realWrite = 0;
  for (const f of toolFiles) {
    const src = readFileSync(path.join(ROOT, 'mcp/tools', f), 'utf8');
    for (const line of src.split('\n')) {
      const code = line.replace(/\/\/.*$/, '').trim();
      if (/(?:^|[^.\w])refuseIfReadonly\s*\(/.test(code) && !code.startsWith('import')) realWrite++;
    }
  }

  ok(realTotal === 20, `sanity: mcp/tools/index.js registers 20 tools (got ${realTotal})`);
  ok(realWrite === 5, `sanity: 5 tools call refuseIfReadonly (got ${realWrite})`);

  ok(TOOL_TOTAL === realTotal, `the wizard's TOOL_TOTAL (${TOOL_TOTAL}) matches the real table (${realTotal})`);
  ok(TOOL_WRITE === realWrite, `the wizard's TOOL_WRITE (${TOOL_WRITE}) matches the real guard count (${realWrite})`);
  ok(TOOL_READ === realTotal - realWrite, `TOOL_READ (${TOOL_READ}) is the remainder`);

  // The settings.js prose is spelled out in words, so it is checked in words.
  // The label is DERIVED from the pattern, never typed twice. Caught here: an
  // earlier edit changed the label to "twenty" while the regex still tested
  // "eighteen", so the assertion reported a number it was not checking — a
  // guard that lies about what it verified is worse than no guard.
  for (const phrase of ['twenty tools', 'fifteen that read', 'five that write']) {
    ok(new RegExp(phrase, 'i').test(settingsCode), `settings.js says "${phrase}"`);
  }
  ok(!/seventeen tools/i.test(settingsCode), 'the old, wrong "seventeen tools" claim is gone');

  // REMOVED in v3.41.0, on this block's own instruction. Three assertions
  // pinned the same tool count in src/public/index.html, which stated it
  // twice and had been wrong twice ("10 structured tools" against a real 18,
  // found in v3.8.0). Their comment said in as many words: "Delete these
  // three when cutover deletes src/public/index.html — not before." That
  // file is deleted, so the two stale copies of the count are gone with it
  // and settings.js below is the only place left that states it.
  ok(!/ten read and seven write/i.test(settingsCode), 'the old, wrong read/write split is gone');
  ok(/compiling a conversation into pages|fixing health issues/i.test(settingsCode),
    'settings.js now makes the WRITE capability discoverable, not just countable');
}

// ═════════════════════════════════════════════════════════════════════════
section('9. Source guards — the shapes the pure tests cannot reach');
// ═════════════════════════════════════════════════════════════════════════
{
  // Defect 1, structural half: the destructive payload is never even
  // FETCHED when the gate refuses. This is what makes the fix independent
  // of any render branch.
  // Counts REQUEST SITES, not mentions: stripComments deliberately leaves
  // end-of-line comments in place (see its own note), and one such comment
  // names this endpoint. Matching the call shape is what the guard is
  // actually about anyway.
  const fullCfgFetches = (wizCode.match(/getJson\('\/api\/mcp\/claude-full-config'\)/g) || []).length;
  ok(fullCfgFetches === 1, 'there is exactly ONE /claude-full-config request site');
  const gateIdx = wizCode.indexOf('wholeFilePayloadAvailability(status);');
  const fetchIdx = wizCode.indexOf("getJson('/api/mcp/claude-full-config')");
  ok(gateIdx !== -1 && fetchIdx !== -1 && gateIdx < fetchIdx,
    'the gate is evaluated BEFORE the whole-file request is issued');
  ok(/if \(avail\.offered\) \{[\s\S]{0,200}claude-full-config/.test(wizCode),
    'and that request sits inside `if (avail.offered)`');

  // Defect 6: every fetch goes through the guard.
  const rawFetches = (wizCode.match(/(?:^|[^.\w])fetch\(/g) || []).length;
  ok(rawFetches === 1, 'there is exactly ONE raw fetch() in the module (inside getJson)');
  ok(/async function getJson[\s\S]{0,400}classifyResponse\(/.test(wizCode),
    'getJson calls classifyResponse before parsing');
  ok(/classifyResponse\([\s\S]{0,200}=== 'html'/.test(wizCode), "and branches on the 'html' verdict");
  const jsonCalls = (wizCode.match(/\.json\(\)/g) || []).length;
  ok(jsonCalls === 2, 'the only .json() calls are the two inside getJson (success + error-body), not scattered');

  // Escaping discipline: nothing backend-, file-, or process-derived is
  // interpolated into HTML.
  ok(!/innerHTML\s*=\s*[^;]*\+/.test(wizCode),
    'no innerHTML assignment concatenates a runtime value');
  ok(/pre\.textContent = d\.stderr/.test(wizCode), 'stderr is written with textContent');
  ok(/pre\.textContent = text/.test(wizCode), 'the JSON payload preview is written with textContent');
  ok(/el\.textContent = message/.test(wizCode), 'status messages (which can carry backend errors) use textContent');
  ok(!/escapeHtml/.test(wizCode),
    'escapeHtml is not used in code — because there is no interpolation site to guard');

  // Wizard chrome discipline (house style, mirrored from shared-brain-wizard.js).
  ok(/^let wizardGen = 0;/m.test(wizCode), 'wizardGen is module-level, not part of the replaceable state');
  ok(!/state\.wizardGen/.test(wizCode), 'and never reachable through state');
  ok(/if \(root\) return;/.test(wizCode), 'open() has a single-instance guard');
  ok(/wizardGen \+= 1/.test(wiz.slice(wizCode.indexOf('export function openMcpWizard'))),
    'gen is bumped on open');
  ok(/function closeWizard\(opts\) \{[\s\S]{0,400}wizardGen \+= 1/.test(wizCode), 'and on close');
  ok(!/registerView/.test(wizCode), 'this is a wizard, not a view — no registerView');
  ok(!/setMain|setSidebar/.test(wizCode), 'and it never writes into the view mount points');
  ok(!/document\.getElementById/.test(wizCode), 'all lookups are scoped to the wizard root, never document');
  ok(/document\.body\.appendChild\(root\)/.test(wizCode), 'it owns a detached subtree appended to body');
  ok(/root\.remove\(\)/.test(wizCode), 'and removes it on close');

  // A11y (browser-verified separately; these pin the markup that makes it possible).
  ok(/role="dialog" aria-modal="true" aria-labelledby="mcpw-title"/.test(wizCode), 'the card is a labelled modal dialog');
  ok(/e\.key === 'Escape'/.test(wizCode), 'Escape is handled');
  ok(/e\.key !== 'Tab'/.test(wizCode) && /offsetParent !== null/.test(wizCode),
    'Tab is trapped over VISIBLE focusables only');
  ok(/aria-current', 'step'/.test(wizCode), 'the active pip carries aria-current="step"');
  ok((wizCode.match(/aria-live="polite"/g) || []).length >= 3, 'every status region is aria-live="polite"');
  ok(/function focusHeading[\s\S]{0,300}h\.focus\(/.test(wizCode), 'focus moves to the active panel heading');
  ok(/tabindex', '-1'/.test(wizCode), 'via a tabindex="-1" heading, so it is not a tab stop afterwards');
  ok(/prevFocus\.focus\(\)/.test(wizCode), 'and focus returns to the launching element on close');

  // Populate-on-entry (the bug the Shared Brain wizard actually shipped).
  ok(/function goToStep[\s\S]{0,700}if \(n === 2\) renderStep2\(\);/.test(wizCode),
    'step 2 is populated on ENTRY, inside goToStep');
  ok(/function goToStep[\s\S]{0,700}if \(n === 3\) renderStep3\(\);/.test(wizCode),
    'step 3 too');

  // ── "Write it for me": the wiring the pure tests above cannot reach ──────
  //
  // The endpoint shipped proven and with NO caller. These assert that it now
  // has exactly one, that the one is a user click, and that the gate sits in
  // front of it — the three things a green §2d does not say by itself.
  const writeCfgPosts = (wizCode.match(/getJson\('\/api\/mcp\/write-config', \{ method: 'POST' \}\)/g) || []).length;
  ok(writeCfgPosts === 1, 'there is exactly ONE /write-config request site');
  ok(/function onWriteConfig\(myGen\)[\s\S]{0,900}getJson\('\/api\/mcp\/write-config'/.test(wizCode),
    'and it lives inside onWriteConfig');
  ok(/id="mcpw-writecfg"[\s\S]{0,200}addEventListener|byId\('mcpw-writecfg'\)[\s\S]{0,120}addEventListener\('click', \(\) => onWriteConfig\(/.test(wizCode),
    'onWriteConfig is reached only from a click on the step-2 button');
  ok(!/setInterval[\s\S]{0,300}onWriteConfig|loadAll[\s\S]{0,2000}onWriteConfig\(/.test(wizCode),
    'and NEVER from a poll or from loadAll — this writes another application’s config file');
  // The gate is checked at CLICK time, not only at render time. A hidden
  // button is still in the DOM, and a status refresh between paint and click
  // could change the verdict.
  ok(/function onWriteConfig[\s\S]{0,400}writeConfigAvailability\(state\.status\)/.test(wizCode),
    'onWriteConfig re-evaluates the gate before issuing the request');
  const gateIdx2 = wizCode.indexOf('writeConfigAvailability(state.status)');
  const postIdx2 = wizCode.indexOf("getJson('/api/mcp/write-config'");
  ok(gateIdx2 !== -1 && postIdx2 !== -1 && gateIdx2 < postIdx2,
    'and the gate is evaluated BEFORE the request is issued');
  // Busy discipline, matching onReveal.
  ok(/function onWriteConfig[\s\S]{0,200}state\.writeCfgBusy\) return;/.test(wizCode),
    'a second click while one write is in flight is refused');
  ok(/function onWriteConfig[\s\S]{0,1400}finally \{[\s\S]{0,200}writeCfgBusy = false/.test(wizCode),
    'and the busy flag is cleared in a finally, so a failure does not wedge the button');
  ok(/writeCfgBusy: false/.test(wizCode), 'writeCfgBusy is part of freshState, so closing the wizard resets it');
  // Rendered always, hidden by class — the shape that stops markup and wiring
  // disagreeing about whether the element exists (bindStep2 binds once).
  ok(/id="mcpw-writecfg"[^>]*mcpw-hidden|mcpw-hidden[^>]*id="mcpw-writecfg"/.test(wizCode),
    'the button ships hidden in the static markup');
  ok(/function renderStep2\(\)[\s\S]{0,800}mcpw-writecfg[\s\S]{0,300}writeConfigAvailability/.test(wizCode),
    'and renderStep2 — which goToStep runs on ENTRY — decides its visibility');

  // Defect 3, wiring half: the copy handler routes through the shell that
  // the §4 tests actually drive, rather than open-coding a second copy path.
  ok((wizCode.match(/runCopyAndAdvance\(/g) || []).length === 2,
    'runCopyAndAdvance is defined once and called once — there is no second copy-and-advance path');
  ok(!/catch[\s\S]{0,120}goToStep\(2/.test(wizCode),
    'no catch block advances to step 2 (the exact shipping bug)');
}

// ═════════════════════════════════════════════════════════════════════════
section('10. Seams — settings.js, index.html, CSS');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(/import \{ openMcpWizard, closeMcpWizardIfOpen \} from '\.\/mcp-wizard\.js';/.test(settingsCode),
    'settings.js imports both wizard entry points');
  ok(/id="btn-mcp-wizard"/.test(settingsCode), 'renderMcp() emits the CTA button');
  ok(/getElementById\('btn-mcp-wizard'\)[\s\S]{0,400}openMcpWizard\(/.test(settingsCode),
    'wireMcpListeners() binds it');
  ok(/const token = myMountToken;/.test(settingsCode.slice(settingsCode.indexOf('function wireMcpListeners'))),
    'the mount token is captured synchronously at bind time');
  ok(/onDone[\s\S]{0,300}state\.mcp = null;[\s\S]{0,120}loadMcp\(token\)/.test(settingsCode),
    'onDone drops the cached state.mcp and refetches (a plain re-render would show stale data)');
  ok(/onDone[\s\S]{0,200}if \(!isCurrentMount\(token\)\) return;/.test(settingsCode),
    'and every state mutation in it is gated on isCurrentMount (settings.js reassigns state per mount)');
  ok(/closeMcpWizardIfOpen\(\);\s*\n\s*\};/.test(settingsCode),
    'the teardown returned by onEnter closes the wizard');
  ok(/closeMcpWizardIfOpen\(\)[\s\S]{0,200}closeWizard\(\{ notify: false \}\)/.test(wizCode),
    'and that path suppresses onDone — navigate() tears down BEFORE it bumps mountToken');
  ok(/if \(notify && onDone\)/.test(wizCode),
    'every OTHER dismissal notifies unconditionally (the Settings pill caches, so it must not be left asserting a stale state)');
  ok(!/const touched/.test(wizCode),
    'and there is no "did the user actually do something" heuristic deciding that');

  ok(/claude_config_parse_error/.test(settingsCode),
    'settings.js reads claude_config_parse_error too, so its pill cannot claim "Not connected" for an unreadable file');
  ok(/Config unreadable/.test(settingsCode), 'and has a distinct label for it');

  // Root-absolute since v3.6.1 (see scripts/test-next-asset-paths.js).
  ok(/<link rel="stylesheet" href="\/next\/views\/mcp-wizard\.css">/.test(nextIndex),
    'next/index.html links the wizard stylesheet (without it, test-css-tokens.js cannot see the file either)');

  // ── TWO ASSERTIONS INVERTED, NOT DELETED ───────────────────────────────
  // They read:
  //   'the wizard CSS does NOT reference var(--scrim)'
  //   'it inlines the same scrim literal views/shared.css uses'  [0.68]
  // under a header calling it "the --scrim trap: exactly one baselined
  // reference exists in /next, in shell.css. A second one anywhere fails
  // test-css-tokens.js." That was accurate, and it is precisely how one
  // value came to have five private copies across five files — which then
  // drifted in the LIGHT theme (0.42 in two of them, 0.5 in three).
  // `--scrim` never existed as a definition; `--modal-scrim` does, in
  // shell.css, for both themes. The first assertion survives unchanged in
  // spirit (the retired name stays retired) and the second flips.
  ok(!/var\(--scrim\b/.test(wizCssCode), 'the wizard CSS does NOT reference the retired var(--scrim)');
  ok(/background:\s*var\(--modal-scrim\)/.test(wizCssCode),
    'it reads the shared --modal-scrim token (was: asserted it INLINED the rgba literal, one of five copies)');
  ok(!/rgba\(5,5,10/.test(wizCssCode) && !/rgba\(20,20,31/.test(wizCssCode),
    'and no scrim rgba literal survives in this file');
  // Regression guard for a bug browser verification caught and no amount of
  // reading did: `.mcpw-hidden` had only per-block definitions, so any
  // element whose base class sets its own `display` — every `.btn`, which
  // shell.css makes inline-flex — ignored it. "I copied it by hand" was
  // permanently visible, and the blocked panel's Finder-reveal button showed
  // for blockers with nothing to reveal.
  ok(/\.mcpw-card \.mcpw-hidden \{ display: none; \}/.test(wizCssCode),
    'there is a GENERIC .mcpw-hidden rule, not only per-block ones (a .btn.mcpw-hidden must actually hide)');
  const hiddenBtns = (wizCode.match(/classList\.(?:toggle|add|remove)\('mcpw-hidden'/g) || []).length;
  ok(hiddenBtns >= 5, `the wizard relies on .mcpw-hidden in ${hiddenBtns} places, so the generic rule is load-bearing`);

  ok(!/prefers-color-scheme/.test(wizCssCode), 'theming is via [data-theme], never prefers-color-scheme');
  // INVERTED. It read 'and the light theme is handled explicitly', pinning
  // a `[data-theme="light"] .mcpw-scrim` override. The theme split moved UP
  // into the token: shell.css defines --modal-scrim per theme, so this file
  // must NOT carry its own override — a second one here would be the same
  // five-copies drift, one level down.
  ok(!/\[data-theme="light"\] \.mcpw-scrim/.test(wizCssCode),
    'the scrim carries NO per-file light override — the token is themed at its definition in shell.css (was: asserted the override existed here)');

  // Prefix ownership: `mcpw-` belongs to this pair of files only.
  //
  // COMMENTS STRIPPED, and this was a latent false positive found by
  // running it: the scan ran over RAW text, so a prose comment in another
  // stylesheet that merely NAMES `.mcpw-card` — views/shared.css has one,
  // pointing at the shared radius decision — reads as that file defining an
  // `.mcpw-` rule. Nothing was wrong with the CSS. Same shape as v3.24.2's
  // button scanner, where an unstripped comment hid three of five real bugs.
  const otherNextCssRaw = ['shell.css', 'views/shared.css', 'views/settings.css', 'views/chat.css',
    'views/domains.css', 'views/ingest.css', 'views/sync.css', 'views/memory.css']
    .map(f => readFileSync(path.join(ROOT, 'src/public/next', f), 'utf8')).join('\n');
  const otherNextCss = stripComments(otherNextCssRaw);
  ok(!/\.mcpw-/.test(otherNextCss), 'no other /next stylesheet defines an .mcpw- rule');
  // Positive control: the strip must be doing work here, or the assertion
  // above is passing for the wrong reason on a future edit.
  ok(/\.mcpw-/.test(otherNextCssRaw) && !/\.mcpw-/.test(otherNextCss),
    'control: the raw text DOES name .mcpw- (in a comment) and the strip is what removes it — an unstripped scan would false-positive here');
  ok(/\.cfd-scrim/.test(otherNextCss),
    'control: …and the strip leaves real selectors in those files intact');
  ok(!/mcpw-/.test(settingsCode.replace(/mcp-wizard/g, '')), 'settings.js does not reach into the wizard’s own class namespace');

  // No inline style="" with a var() — test-css-tokens.js §8 walks these.
  ok(!/style="[^"]*var\(/.test(wizCode), 'no built HTML string carries a var() inside an inline style attribute');
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
