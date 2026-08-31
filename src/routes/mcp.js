/**
 * MCP configuration endpoints — power the "My Curator" wizard in the Settings tab.
 *
 *   GET  /api/mcp/config              → status + resolved paths
 *   GET  /api/mcp/claude-config       → JSON snippet to paste into claude_desktop_config.json
 *   GET  /api/mcp/claude-full-config  → merged preview (current file + the curator entry)
 *   POST /api/mcp/write-config        → the wizard's "do it for me" step: writes ONLY
 *                                       mcpServers["my-curator"], keeps a .bak, refuses
 *                                       on a config it cannot parse
 *   POST /api/mcp/self-test           → spawns mcp/server.js locally, runs list_domains, reports
 *   POST /api/mcp/reveal-config       → opens Claude Desktop's config file in Finder
 *
 * TESTING NOTE — CLAUDE_CONFIG_PATH below is a module constant with no override
 * seam, and it points at the user's REAL Claude Desktop config. Nothing in this
 * file may be tested by writing to or replacing that file. The two functions
 * whose behaviour actually matters here (parseClaudeConfigText,
 * buildFullConfigPayload) are therefore exported as pure functions and are
 * exercised with hand-built inputs instead; see
 * scripts/test-mcp-setup-contract.js.
 */

import express from 'express';
import path from 'path';
import os from 'os';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { spawn, execFile } from 'child_process';
import { getDomainsDir } from '../brain/config.js';
import { appPath } from '../brain/paths.js';
import { getCapabilities } from '../brain/install-mode.js';
import { getMcpLauncherPath } from '../brain/mcp-launcher.js';
import { writeFileAtomicSync } from '../brain/atomic-write.js';

const router = express.Router();

// mcp/server.js is CODE — it ships inside the app, never in the user-data dir.
const MCP_SERVER_PATH = appPath('mcp', 'server.js');
const MCP_SERVER_NAME = 'my-curator';
const CLAUDE_CONFIG_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude_desktop_config.json',
);

/**
 * The single source of truth for HOW the MCP server is launched.
 *
 * Its output is (a) the snippet the wizard tells the user to paste into
 * claude_desktop_config.json, (b) what GET /config compares against to decide
 * `stale`, and (c) — since v3.6.1 — exactly what POST /self-test spawns. There
 * is deliberately no second copy of the command/args anywhere in this file: a
 * self-test that constructs its own launch line can drift from the prescribed
 * one, which is precisely the bug this consolidation fixes.
 *
 * ── TWO ARMS, forked on the CAPABILITY and never on the install form ────────
 *
 * `mcpLaunchStyle` shipped in v3.26.0 with no branch behind it. This is the
 * branch. It reads the capability, not `getInstallMode()`, per the rule
 * `scripts/test-install-mode.js` §4 enforces over every route file.
 *
 * REPO ARM ('node-script') — byte-identical to every version since v3.6.1.
 * `process.execPath` is the user's node, and mcp/server.js is a plain file.
 *
 * BUNDLE ARM ('launcher-script') — the command is a shell launcher this app
 * rewrites at every startup (see src/brain/mcp-launcher.js for why launch time
 * is the only correct moment), and it takes NO ARGUMENTS. Two reasons the
 * domains-path argument is dropped, and only in this arm:
 *
 *   1. It is a SNAPSHOT of getDomainsDir() taken when the wizard generated the
 *      snippet, and it sits at rung 2 of mcp/storage/local.js's ladder —
 *      ABOVE .curator-config.json at rung 3. So it OUTRANKS the user's live
 *      Settings choice: move your knowledge base and the MCP keeps reading the
 *      old one until you re-run the wizard. Omitting it lets the child resolve
 *      through config, which is what the app itself reads, so the two agree by
 *      construction and moving the folder needs no config edit at all.
 *   2. It is what makes the entry go STALE. With a stable launcher path and no
 *      arguments there is nothing left in the entry that a folder move can
 *      invalidate — see the `stale` computation in GET /config.
 *
 * The repo arm KEEPS it, deliberately. Dropping it there would make every
 * existing user's claude_desktop_config.json compare unequal against a freshly
 * generated entry and light up as `stale` overnight, for no benefit — and
 * v3.6.1 added it because a self-test that did not pass it gave a green pass
 * against a folder the user was not configured for.
 */
export function buildCuratorEntry(domainsDir) {
  if (getCapabilities().mcpLaunchStyle === 'launcher-script') {
    return {
      command: getMcpLauncherPath(),
      args: [],
    };
  }
  return {
    command: process.execPath,
    args: [MCP_SERVER_PATH, '--domains-path', domainsDir],
  };
}

/**
 * Parse the raw text of claude_desktop_config.json.
 *
 * Split out of readClaudeConfig() ONLY so the corrupt-file branch is reachable
 * from a test without going anywhere near the real config file (the path is a
 * module constant with no override seam — see the note on CLAUDE_CONFIG_PATH).
 * Returns the `{__parseError:true}` sentinel on invalid JSON.
 */
export function parseClaudeConfigText(text) {
  try { return JSON.parse(text); }
  catch { return { __parseError: true }; }
}

function readClaudeConfig() {
  if (!existsSync(CLAUDE_CONFIG_PATH)) return null;
  return parseClaudeConfigText(readFileSync(CLAUDE_CONFIG_PATH, 'utf8'));
}

/**
 * Build the GET /claude-full-config payload from an already-read config.
 *
 * COVERAGE — this is the ONLY producer of a merged Claude Desktop config
 * anywhere in src/ or mcp/ (verified mechanically: `readClaudeConfig` has
 * exactly two consumers, GET /config and GET /claude-full-config, and nothing
 * else in the tree spreads an existing config into a new one). GET /config was
 * never wrong about the corrupt case — it has reported
 * `claude_config_parse_error` since v2.3.0; it simply had no reader. This
 * function covers the consumer that WAS wrong. The two are now consistent.
 *
 * THREE input states, THREE distinct outputs:
 *   existing === null              → file absent    → merge available
 *   existing.__parseError === true → file corrupt   → merge NOT available
 *   otherwise                      → file readable  → merge available
 *
 * Why `merged: null` when the file is corrupt, rather than an entry-only
 * object: you cannot merge into a document you cannot read. The previous code
 * returned `{mcpServers:{'my-curator':…}}` here — a complete, valid-looking
 * Claude Desktop config containing ONLY our server — rendered by the wizard as
 * "your file after" beside a button labelled "Copy the merged JSON". A user
 * with three other MCP servers and one stray comma was shown a payload that,
 * if pasted, deletes them. The protection here is STRUCTURAL, not advisory:
 * `null` is not a config, so no consumer — however naive — can present it as a
 * safe merge or paste it into a silent loss. The new `parse_error` /
 * `merge_available` / `merge_error` fields explain WHY; they are not what makes
 * it safe, and nothing depends on a frontend reading them.
 *
 * Why `was_empty` stays `true` in the corrupt case rather than becoming an
 * accurate `false`: it is a pre-existing field and its only shipped consumer
 * (src/public/app.js, the "before" diff pane) takes a branch on `false` that
 * dereferences `merged` — with `merged: null` that branch throws and takes the
 * whole MCP section down. `was_empty` therefore remains ambiguous BY DESIGN
 * and is superseded: `parse_error` and `merge_available` are the fields that
 * distinguish "absent" from "corrupt". Do not "tidy" was_empty without first
 * re-reading that consumer.
 */
export function buildFullConfigPayload(existing, domainsDir) {
  const entry = buildCuratorEntry(domainsDir);
  const snippet = { mcpServers: { [MCP_SERVER_NAME]: entry } };
  const base = {
    claude_config_path: CLAUDE_CONFIG_PATH,
    // Always present: the entry-only snippet is valid in every state, and is
    // what a frontend should offer when no merge can be computed.
    entry: snippet,
  };

  if (existing && existing.__parseError === true) {
    return {
      ...base,
      // Legacy field, deliberately unchanged — see docblock.
      was_empty: true,
      parse_error: true,
      merge_available: false,
      merged: null,
      merge_error:
        'Your existing claude_desktop_config.json contains invalid JSON, so it could not be read. ' +
        'A merged preview cannot be shown: merging into a file we cannot parse would silently drop ' +
        'any other MCP servers configured in it. Fix the JSON syntax error in that file first, or ' +
        'add the my-curator entry by hand using the snippet.',
    };
  }

  if (!existing) {
    return {
      ...base,
      was_empty: true,
      parse_error: false,
      merge_available: true,
      merged: snippet,
      merge_error: null,
    };
  }

  return {
    ...base,
    was_empty: false,
    parse_error: false,
    merge_available: true,
    merged: { ...existing, mcpServers: { ...(existing.mcpServers || {}), [MCP_SERVER_NAME]: entry } },
    merge_error: null,
  };
}

router.get('/config', (_req, res) => {
  const domainsDir = getDomainsDir();
  const domainsDirExists = existsSync(domainsDir);
  const serverExists = existsSync(MCP_SERVER_PATH);
  const existingConfig = readClaudeConfig();
  const hasConfigFile = existingConfig !== null;
  const parseError = hasConfigFile && existingConfig.__parseError === true;
  const launchStyle = getCapabilities().mcpLaunchStyle;
  // Reported so the wizard can explain a launcher that could not be written
  // (a translocated or Downloads-resident app refuses — see mcp-launcher.js).
  // In repo mode there is no launcher, and both fields are null/false rather
  // than a misleading "missing".
  const launcherPath = launchStyle === 'launcher-script' ? getMcpLauncherPath() : null;
  const launcherExists = launcherPath ? existsSync(launcherPath) : false;

  // Check whether the existing config already contains a matching curator entry
  let installed = false;
  let stale = false;
  if (hasConfigFile && !parseError && existingConfig.mcpServers?.[MCP_SERVER_NAME]) {
    installed = true;
    const entry = existingConfig.mcpServers[MCP_SERVER_NAME];
    const expected = buildCuratorEntry(domainsDir);
    const sameCommand = entry.command === expected.command;
    const sameArgs = JSON.stringify(entry.args) === JSON.stringify(expected.args);
    stale = !(sameCommand && sameArgs);
  }

  res.json({
    ok: serverExists && domainsDirExists,
    mcp_server_path: MCP_SERVER_PATH,
    mcp_server_exists: serverExists,
    mcp_server_name: MCP_SERVER_NAME,
    domains_dir: domainsDir,
    domains_dir_exists: domainsDirExists,
    node_binary: process.execPath,
    claude_config_path: CLAUDE_CONFIG_PATH,
    claude_config_exists: hasConfigFile,
    claude_config_parse_error: parseError,
    installed,
    stale,
    // Additive since the launcher seam. Existing consumers ignore them.
    mcp_launch_style: launchStyle,
    launcher_path: launcherPath,
    launcher_exists: launcherExists,
  });
});

router.get('/claude-config', (_req, res) => {
  const domainsDir = getDomainsDir();
  res.json({
    mcpServers: {
      [MCP_SERVER_NAME]: buildCuratorEntry(domainsDir),
    },
  });
});

router.get('/claude-full-config', (_req, res) => {
  res.json(buildFullConfigPayload(readClaudeConfig(), getDomainsDir()));
});

/**
 * Decide what POST /write-config should do, WITHOUT touching the filesystem.
 *
 * Split out for the same reason parseClaudeConfigText is: CLAUDE_CONFIG_PATH
 * is a module constant with no override seam and points at the user's REAL
 * Claude Desktop config, so the decision has to be reachable from a suite
 * that never goes near that file.
 *
 * Returns `{ok:true, next}` or `{ok:false, status, refused, message}`.
 * `next` is the FULL document to write — never a fragment — so the caller
 * cannot assemble a merge of its own and get it wrong.
 *
 * THE THREE INPUT STATES, and the third is the one that matters:
 *
 *   absent   → create `{mcpServers:{'my-curator': entry}}`. Nothing to lose.
 *   readable → clone and set exactly ONE key. Every other top-level field and
 *              every other MCP server is carried through by reference.
 *   corrupt  → REFUSE, and write nothing.
 *
 * The refusal is not politeness. buildFullConfigPayload's docblock already
 * spells out the harm: a user with three other MCP servers and one stray
 * comma has a file we cannot read, and "merging" into it means emitting a
 * document containing only our entry — which deletes them. That analysis was
 * done when the PREVIEW was fixed; this is the same rule applied to the
 * WRITER, which is the surface where getting it wrong is unrecoverable.
 *
 * The launcher check is the second refusal, and it exists because this write
 * is the one place a missing shim becomes silently destructive: pointing
 * Claude Desktop at a launcher that was refused (translocation, Downloads)
 * replaces a working entry with a broken one.
 */
export function planConfigWrite(existing, domainsDir, launcherState = null) {
  if (existing && existing.__parseError === true) {
    return {
      ok: false,
      status: 409,
      refused: 'claude_config_parse_error',
      message:
        'Your claude_desktop_config.json contains invalid JSON, so The Curator cannot read it. ' +
        'It will not be overwritten: rewriting a file we cannot parse would silently delete any ' +
        'other MCP servers configured in it. Fix the syntax error in that file first, then run ' +
        'this again — or paste the snippet in by hand.',
    };
  }

  if (launcherState && launcherState.required && !launcherState.present) {
    return {
      ok: false,
      status: 409,
      refused: 'launcher_missing',
      message:
        (launcherState.message ||
          'The Curator could not create the launcher that Claude Desktop needs to start the bridge.') +
        ' Nothing was written to your Claude Desktop config.',
    };
  }

  const entry = buildCuratorEntry(domainsDir);
  const next = existing
    ? { ...existing, mcpServers: { ...(existing.mcpServers || {}), [MCP_SERVER_NAME]: entry } }
    : { mcpServers: { [MCP_SERVER_NAME]: entry } };

  return { ok: true, entry, next, created: !existing };
}

/**
 * POST /write-config — the wizard's "do it for me" step.
 *
 * This is NOT a background repair and must never become one. It writes ANOTHER
 * APPLICATION'S configuration file, which is a category of action this app has
 * never taken before, so it is reachable only from an explicit user action in
 * the MCP wizard and is never invoked on a poll, a page load or a status
 * refresh. `stale` (GET /config) is what tells the user to come here; it does
 * not bring them here on its own.
 *
 * Exported and registered by reference so the contract suite can drive the
 * real handler with an injected filesystem rather than asserting on a regex.
 *
 * A `.bak` is kept whenever a file was replaced. It is the ORIGINAL BYTES, not
 * a re-serialisation: comments-shaped whitespace, key order and formatting the
 * user cares about all survive, and a re-serialised "backup" of a document we
 * only half understood would be a worse copy than the one it replaced.
 */
export async function writeConfigHandler(_req, res, deps = {}) {
  const io = {
    exists: deps.exists || ((p) => existsSync(p)),
    read: deps.read || ((p) => readFileSync(p, 'utf8')),
    write: deps.write || ((p, c) => writeFileAtomicSync(p, c, { encoding: 'utf8', mode: 0o600 })),
    mkdir: deps.mkdir || ((p) => mkdirSync(p, { recursive: true })),
    configPath: deps.configPath || CLAUDE_CONFIG_PATH,
    launcherState: deps.launcherState || currentLauncherState(),
  };

  const domainsDir = getDomainsDir();
  let raw = null;
  let existing = null;
  try {
    if (io.exists(io.configPath)) {
      raw = io.read(io.configPath);
      existing = parseClaudeConfigText(raw);
    }
  } catch (err) {
    return res.status(500).json({
      ok: false,
      refused: 'read_failed',
      error: `Could not read ${io.configPath}: ${err.message}`,
      written: false,
    });
  }

  const plan = planConfigWrite(existing, domainsDir, io.launcherState);
  if (!plan.ok) {
    return res.status(plan.status).json({
      ok: false,
      refused: plan.refused,
      error: plan.message,
      written: false,
      claude_config_path: io.configPath,
    });
  }

  const backupPath = io.configPath + '.bak';
  try {
    io.mkdir(path.dirname(io.configPath));
    // Back up FIRST. If this throws, nothing has been replaced yet.
    if (raw !== null) io.write(backupPath, raw);
    io.write(io.configPath, JSON.stringify(plan.next, null, 2) + '\n');
  } catch (err) {
    return res.status(500).json({
      ok: false,
      refused: 'write_failed',
      error: `Could not write ${io.configPath}: ${err.message}`,
      written: false,
      claude_config_path: io.configPath,
    });
  }

  res.json({
    ok: true,
    written: true,
    created: plan.created,
    backup_path: raw !== null ? backupPath : null,
    claude_config_path: io.configPath,
    entry: plan.entry,
    // Every OTHER server that was in the file and still is. Reported so the
    // wizard can say "your 3 other servers are untouched" rather than asking
    // the user to take that on trust.
    preserved_servers: Object.keys(plan.next.mcpServers || {}).filter(k => k !== MCP_SERVER_NAME),
    restart_required: true,
  });
}

/** What the launcher looks like right now — null-shaped in repo mode. */
function currentLauncherState() {
  const required = getCapabilities().mcpLaunchStyle === 'launcher-script';
  if (!required) return { required: false, present: true, path: null, message: null };
  const p = getMcpLauncherPath();
  const present = existsSync(p);
  return {
    required: true,
    present,
    path: p,
    message: present
      ? null
      : `The Claude Desktop launcher is missing at ${p}. If The Curator is running from your ` +
        `Downloads folder or from a temporary copy, move it to /Applications and reopen it.`,
  };
}

router.post('/write-config', (req, res) => writeConfigHandler(req, res));

/**
 * Classify the outcome of the self-test's list_domains call.
 *
 * SCOPE — this makes the RESULT honest; it deliberately does NOT change the
 * pass/fail gate (see the `ok` comment at the call site). `domains` keeps its
 * exact previous meaning and type (array, or null when no list could be read)
 * so existing consumers are untouched.
 *
 * `list_domains` (mcp/tools/domains.js) returns a JSON object on success, but a
 * plain SENTENCE in two very different situations: "No domains found in …"
 * (folder is there, genuinely empty) and "Curator domains folder not found at …"
 * (the configured folder does not exist at all). Both used to collapse to
 * `domains: null`, so a broken install rendered as a cheerful "no domains yet".
 *
 * The missing-folder case is decided by the PARENT's own filesystem check, not
 * by matching the child's wording — and that check is only trustworthy because
 * the self-test now spawns the child with the same --domains-path the parent
 * resolved, so the two provably agree about which folder they mean.
 */
export function classifyDomainsResult(listDomainsResponse, domainsDirExists) {
  const truncate = (s) => (typeof s === 'string' && s.length > 500 ? s.slice(0, 500) + '…' : s);

  if (!listDomainsResponse) {
    return { domains: null, domains_status: 'no_response', domains_message: null, domains_error: null };
  }
  if (listDomainsResponse.error) {
    const msg = listDomainsResponse.error.message || 'list_domains returned a JSON-RPC error';
    return { domains: null, domains_status: 'error', domains_message: null, domains_error: truncate(msg) };
  }

  const result = listDomainsResponse.result;
  const text = result?.content?.[0]?.text;

  if (result?.isError === true) {
    return {
      domains: null,
      domains_status: 'error',
      domains_message: null,
      domains_error: truncate(typeof text === 'string' ? text : 'list_domains reported a tool error'),
    };
  }
  if (typeof text !== 'string') {
    return {
      domains: null,
      domains_status: 'unreadable',
      domains_message: null,
      domains_error: 'list_domains returned no readable text content',
    };
  }

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* sentence-form response — handled below */ }

  if (parsed && Array.isArray(parsed.domains)) {
    return {
      domains: parsed.domains.length ? parsed.domains : null,
      domains_status: parsed.domains.length ? 'ok' : 'empty',
      domains_message: null,
      domains_error: null,
    };
  }

  // Sentence-form (or otherwise unstructured) response.
  if (!domainsDirExists) {
    return { domains: null, domains_status: 'missing_folder', domains_message: truncate(text), domains_error: null };
  }
  if (/^\s*No domains found\b/i.test(text)) {
    return { domains: null, domains_status: 'empty', domains_message: truncate(text), domains_error: null };
  }
  return { domains: null, domains_status: 'unreadable', domains_message: truncate(text), domains_error: null };
}

/**
 * POST /self-test — spawn the bridge exactly as the wizard prescribes and report
 * what came back.
 *
 * Exported (and registered by reference below) so the contract suite can drive
 * the REAL handler end-to-end and assert on the child it actually spawned. A
 * source-regex guard alone is not enough here: `spawn(entry.command,
 * entry.args.slice(0, 1), …)` reintroduces the whole defect while still matching
 * any prefix-shaped regex, which was verified by mutation.
 */
export async function selfTestHandler(_req, res) {
  // Spawn EXACTLY what the wizard tells the user to paste. Before v3.6.1 this
  // spawned `[MCP_SERVER_PATH]` with no --domains-path, so the one thing the
  // pasted config uniquely contributes — the path argument — was the one thing
  // the self-test never exercised, and the child silently fell back to
  // config/env/default. A user whose configured folder was wrong got a green
  // pass, and the UI then told them the fault must be inside their config file.
  const domainsDir = getDomainsDir();
  const domainsDirExists = existsSync(domainsDir);
  const selfTestEntry = buildCuratorEntry(domainsDir);
  const proc = spawn(selfTestEntry.command, selfTestEntry.args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdoutBuf = '';
  let stderrBuf = '';
  const responses = [];
  let resolved = false;

  const cleanup = (body) => {
    if (resolved) return;
    resolved = true;
    try { proc.kill(); } catch {}
    res.json(body);
  };

  proc.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try { responses.push(JSON.parse(line)); } catch {}
    }
  });
  proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  // Uniform shape on the failure paths too, so a consumer never has to
  // distinguish "field absent" from "field null".
  const failureExtras = () => ({
    domains: null,
    domains_status: 'no_response',
    domains_message: null,
    domains_error: null,
    domains_dir: domainsDir,
    domains_dir_exists: domainsDirExists,
    spawn_command: selfTestEntry.command,
    spawn_args: selfTestEntry.args,
  });
  proc.on('error', (err) => cleanup({ ok: false, error: err.message, ...failureExtras() }));

  const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'curator-self-test', version: '1' } } });
    await sleep(200);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sleep(100);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await sleep(200);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_domains', arguments: {} } });
    await sleep(500);

    const init = responses.find(r => r.id === 1);
    const toolsList = responses.find(r => r.id === 2);
    const listDomains = responses.find(r => r.id === 3);

    const domainsOutcome = classifyDomainsResult(listDomains, domainsDirExists);

    cleanup({
      // GATE UNCHANGED, DELIBERATELY. `ok` means "the bridge speaks MCP"
      // (initialize + tools/list), which is what this endpoint is named for and
      // what every existing caller gates its "connected" messaging on. Folding
      // list_domains into it would turn a brand-new user with zero domains — a
      // legitimate, healthy install — into a hard FAIL, and a false red is as
      // harmful as the false green being fixed. The list_domains outcome is
      // instead reported honestly alongside it (domains_status), so a caller
      // can surface "bridge works, but your knowledge folder is missing"
      // without this endpoint redefining what a passing bridge is.
      ok: !!init?.result && !!toolsList?.result,
      server_info: init?.result?.serverInfo || null,
      tool_count: toolsList?.result?.tools?.length || 0,
      tool_names: toolsList?.result?.tools?.map(t => t.name) || [],
      domains: domainsOutcome.domains,
      domains_status: domainsOutcome.domains_status,
      domains_message: domainsOutcome.domains_message,
      domains_error: domainsOutcome.domains_error,
      domains_dir: domainsDir,
      domains_dir_exists: domainsDirExists,
      spawn_command: selfTestEntry.command,
      spawn_args: selfTestEntry.args,
      stderr: stderrBuf || null,
    });
  } catch (err) {
    cleanup({ ok: false, error: err.message, stderr: stderrBuf || null, ...failureExtras() });
  }
}

router.post('/self-test', selfTestHandler);

router.post('/reveal-config', (_req, res) => {
  // Use execFile (no shell) so the target path is never interpreted by the shell.
  // If the file doesn't exist yet, reveal the parent directory instead.
  const fileExists = existsSync(CLAUDE_CONFIG_PATH);
  const args = fileExists
    ? ['-R', CLAUDE_CONFIG_PATH]                    // reveal file in Finder
    : [path.dirname(CLAUDE_CONFIG_PATH)];           // open parent directory
  execFile('open', args, (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, revealed: fileExists ? CLAUDE_CONFIG_PATH : path.dirname(CLAUDE_CONFIG_PATH) });
  });
});

export default router;
