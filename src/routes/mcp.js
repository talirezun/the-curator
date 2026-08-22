/**
 * MCP configuration endpoints — power the "My Curator" wizard in the Settings tab.
 *
 *   GET  /api/mcp/config              → status + resolved paths
 *   GET  /api/mcp/claude-config       → JSON snippet to paste into claude_desktop_config.json
 *   GET  /api/mcp/claude-full-config  → merged preview (current file + the curator entry)
 *   POST /api/mcp/self-test           → spawns mcp/server.js locally, runs list_domains, reports
 *   POST /api/mcp/reveal-config       → opens Claude Desktop's config file in Finder
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

function buildCuratorEntry(domainsDir) {
  return {
    command: process.execPath,
    args: [MCP_SERVER_PATH, '--domains-path', domainsDir],
  };
}

function readClaudeConfig() {
  if (!existsSync(CLAUDE_CONFIG_PATH)) return null;
  try { return JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, 'utf8')); }
  catch { return { __parseError: true }; }
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
  const domainsDir = getDomainsDir();
  const existing = readClaudeConfig();
  const entry = buildCuratorEntry(domainsDir);

  if (!existing || existing.__parseError) {
    // Show the ideal minimal config the user should create
    return res.json({
      was_empty: true,
      merged: { mcpServers: { [MCP_SERVER_NAME]: entry } },
    });
  }

  const merged = { ...existing, mcpServers: { ...(existing.mcpServers || {}), [MCP_SERVER_NAME]: entry } };
  res.json({ was_empty: false, merged });
});

router.post('/self-test', async (_req, res) => {
  const proc = spawn(process.execPath, [MCP_SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  proc.on('error', (err) => cleanup({ ok: false, error: err.message }));

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

    let domains = null;
    if (listDomains?.result?.content?.[0]?.text) {
      try {
        const parsed = JSON.parse(listDomains.result.content[0].text);
        domains = parsed.domains || null;
      } catch {
        // string-form response (e.g. "No domains found") — fine
      }
    }

    cleanup({
      ok: !!init?.result && !!toolsList?.result,
      server_info: init?.result?.serverInfo || null,
      tool_count: toolsList?.result?.tools?.length || 0,
      tool_names: toolsList?.result?.tools?.map(t => t.name) || [],
      domains,
      stderr: stderrBuf || null,
    });
  } catch (err) {
    cleanup({ ok: false, error: err.message, stderr: stderrBuf || null });
  }
});

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
