/**
 * MCP configuration endpoints — power the "My Curator" wizard in the Settings tab.
 *
 *   GET  /api/mcp/config              → status + resolved paths
 *   GET  /api/mcp/claude-config       → JSON snippet to paste into claude_desktop_config.json
 *   GET  /api/mcp/claude-full-config  → merged preview (current file + the curator entry)
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
import { existsSync, readFileSync } from 'fs';
import { spawn, execFile } from 'child_process';
import { getDomainsDir } from '../brain/config.js';
import { appPath } from '../brain/paths.js';

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
 */
export function buildCuratorEntry(domainsDir) {
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
