#!/usr/bin/env node
/**
 * My Curator — Local MCP Server
 *
 * Exposes the user's private Curator wiki to MCP-compatible LLM clients
 * (Claude Desktop, etc.) via stdio transport.
 *
 * This server is spawned as a child process by the MCP client — it does NOT
 * require the main Curator web app to be running. It only reads markdown files
 * from the domains folder and responds to tool calls.
 *
 * Usage:
 *   node mcp/server.js [--domains-path /path/to/domains]
 *
 * The generated Claude Desktop config always passes --domains-path explicitly,
 * so behaviour is deterministic regardless of cwd.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createStorageAdapter } from './storage/local.js';
import { registerTools } from './tools/index.js';
import { setCliDomainsDir } from '../src/brain/config.js';

const args = process.argv.slice(2);
const domainsPathIdx = args.indexOf('--domains-path');
const domainsPath = domainsPathIdx !== -1 ? args[domainsPathIdx + 1] : null;

// ── ONE SOURCE FOR READS AND WRITES — DO NOT MOVE THIS BELOW THE ADAPTER ─────
//
// MCP READS resolve through createStorageAdapter below, which honours
// `--domains-path` directly. MCP WRITES do not touch that adapter at all: the
// write tools import writePage/scanWiki/fixIssue from src/brain, and those
// resolve through getDomainsDir() in src/brain/config.js — which, until this
// line existed, had no rung for the arg and therefore silently resolved a
// DIFFERENT folder. compile_to_wiki reported `ok: true` with a summary_path,
// wrote the page into one tree, the audit log into another, and a follow-up
// get_node on the path it had just returned said NOT FOUND.
//
// Installing the arg into config.js makes the two resolvers agree by
// construction rather than by comment. It must happen BEFORE the adapter is
// built (the adapter snapshots its base at construction) and before any tool
// can run. Nothing else in the tree calls this setter, so the web server is
// untouched: `getDomainsDir()` there still short-circuits on a null override.
//
// A missing/blank value is a no-op — launching without the arg is legitimate
// (the app's own self-test and manual runs do it), and in that case both sides
// fall through to the stored setting exactly as they always have.
setCliDomainsDir(domainsPath);

const storage = createStorageAdapter({ domainsPath });

// `title` is the human-readable display name added in MCP spec 2025-06-18.
// We lead it with the brain glyph in case the host (Claude Desktop) derives
// the avatar's first character from `title` instead of `name` — a free-cost
// experiment. If the host doesn't honour it for the icon, the title still
// renders nicer than the bare slug. The MCP protocol has no icon/image
// field, so a real icon override is not currently possible.
const server = new Server(
  {
    name: 'my-curator',
    title: '🧠 My Curator',
    version: '1.0.0',
  },
  {
    capabilities: { tools: {} },
  },
);

// ── THIS BRIDGE LIVES IN TWO PROTOCOL ERAS AT ONCE (v3.63.0) ────────────────
//
// MCP specification revision `2026-07-28` REMOVED the `initialize` handshake.
// `clientInfo` is no longer a fact negotiated once per connection; it is an
// OPTIONAL, PER-REQUEST `_meta` entry (`io.modelcontextprotocol/clientInfo`),
// self-reported by the client, and the specification says a server SHOULD NOT
// change behaviour or security decisions on it.
//
// The installed SDK is `@modelcontextprotocol/sdk@1.29.0`, which is still the
// OLD era: its `server.getClientVersion()` returns what `initialize` carried
// (`dist/esm/server/index.js:273, 291`). That accessor is DEPRECATED in
// `@modelcontextprotocol/server` 2.0.0 in favour of the per-request envelope.
//
// So the dispatch handler in `tools/index.js` reads the name from BOTH,
// newest era first, through `src/brain/mcp-clients.js`'s `readClientName` —
// and the ONLY thing done with it is writing an allow-listed LABEL on one
// session line of the usage log. Nothing here branches on it, and nothing
// should: a `server/discover`-first client (GitHub Copilot CLI already sends
// one) reads as `other`, which must stay a harmless label rather than a
// refusal. The server object is passed to `registerTools` for this and for
// nothing else new.
//
// NOTE FOR ANYONE MEASURING THE TWO ARMS: the app's own self-test
// (`src/brain/mcp-exercise.js`, behind `POST /api/mcp/exercise`) drives this
// bridge over stdio and SENDS `initialize` — it is an initialize-era client,
// so it exercises the deprecated arm and never the `_meta` one.
registerTools(server, storage);

const transport = new StdioServerTransport();
await server.connect(transport);

// stdio keeps the process alive — exits when the client disconnects.
