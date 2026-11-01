/**
 * The tool-list signature (v3.88.0): 8 hex characters that change exactly when
 * the bridge's TOOL LIST changes.
 *
 * WHY IT EXISTS. Until v3.88.0 the app called an open bridge "stale" when it
 * had started before the files on disk last changed. A Mac-app update rewrites
 * every file in the bundle, so every release re-flagged every open bridge —
 * including a Windows-only release with no MCP change at all — and the page
 * told the user it "still offers the older tool list" when it did not
 * (measured 2026-11-01: `git diff v3.86.0 HEAD -- mcp/` was empty, and both of
 * Claude Desktop's bridges served the same 24 tools). The bridge now writes
 * this signature on its usage-log session line, and the app compares it with
 * the signature of the tools on disk. Same signature: same tools.
 *
 * WHAT IS IN IT: each tool's NAME and its INPUT SCHEMA, sorted by name, keys
 * sorted. A new tool, a removed tool, or a new/renamed/retyped argument moves
 * it. A DESCRIPTION edit does not, and on purpose: descriptions are reworded
 * often, and a reworded paragraph is not a reason to tell someone to quit
 * Claude Desktop (which also ends the Claude Code sessions in its Code tab).
 * Registration ORDER does not either — the same set of tools is the same list.
 *
 * Content-free by construction: names and schemas are the shipped code, never
 * anything a user wrote. Pure — no I/O, never writes to stdout (this module is
 * imported by the bridge, whose stdout is the JSON-RPC stream).
 */
import { createHash } from 'node:crypto';

/** The shape a signature has on disk and on the wire. */
export const TOOL_SIG_RE = /^[0-9a-f]{8}$/;

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * `definitions` is the `definition` of each entry in `mcp/tools/index.js`'s
 * `tools` array. Returns 8 lower-case hex characters, or null for an input
 * that is not a list of named definitions (never a guess).
 */
export function toolSignature(definitions) {
  if (!Array.isArray(definitions) || !definitions.length) return null;
  const rows = [];
  for (const d of definitions) {
    if (!d || typeof d.name !== 'string' || !d.name) return null;
    rows.push([d.name, d.inputSchema === undefined ? null : d.inputSchema]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(canonical(rows)).digest('hex').slice(0, 8);
}
