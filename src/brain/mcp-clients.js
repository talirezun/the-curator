/**
 * MCP client names — a LABEL for a report, and nothing else (v3.63.0).
 *
 * The usage log records which MCP client made a call so the owner can read a
 * row in the capture meter that says "Claude Code · 6 sessions · 4 saved".
 * That is the whole job. Three independent reasons say the value may never do
 * anything else, and they converge on one rule:
 *
 *   1. THE SPECIFICATION SAYS SO. MCP revision `2026-07-28` REMOVED the
 *      `initialize` handshake. `clientInfo` is no longer negotiated once per
 *      connection; it is an OPTIONAL, PER-REQUEST `_meta` entry
 *      (`io.modelcontextprotocol/clientInfo`), SELF-REPORTED by the client,
 *      and the specification says a server SHOULD NOT change behaviour or
 *      security decisions on it.
 *   2. THE VALUES ARE DEMONSTRABLY UNSTABLE. GitHub Copilot CLI moved from
 *      `github-copilot-developer` to `copilot-cli` inside six months — one
 *      product, two values, sequentially. Cline reports `Cline` from VS Code
 *      and `@cline/core` from its SDK/CLI — one product, two values,
 *      SIMULTANEOUSLY. That is why the table below is MANY-TO-ONE: a
 *      one-value-per-harness table would have to be wrong about both.
 *   3. THE FILE IS CONTENT-FREE BY CONTRACT. `clientInfo.name` is a string the
 *      CLIENT chose, exactly as `CURATOR_MCP_VIA` is a string somebody put in
 *      an environment variable. `mcp-usage.js` answers that with an `===`
 *      against a literal; this module answers it with an allow-list. A value
 *      that is not in the table is written as `other` — never verbatim.
 *
 * So: normalise, look up, write the canonical id or `other`. NOTHING in the
 * app, the store or the bridge reads this field except a report the owner
 * looks at — `scripts/test-mcp-usage.js` §11 greps `mcp/**` for a read of it
 * outside the logger and reds if one appears, with a planted-violation
 * control so the grep cannot go vacuous.
 *
 * ── PURE DATA ───────────────────────────────────────────────────────────────
 *
 * This module imports nothing, on purpose: it sits on the MCP child's import
 * graph, where every added module is a module that could print to stdout and
 * poison the JSON-RPC stream (the v2.5.3 rule in CLAUDE.md).
 */

/** The `_meta` key the 2026-07-28 specification defines for the client name. */
export const CLIENT_META_KEY = 'io.modelcontextprotocol/clientInfo';

/** Anything not in the table. Never an error, never a refusal. */
export const CLIENT_OTHER = 'other';

/**
 * The longest label this module will ever write, and the bound that makes
 * `mcp-usage.js`'s line ceiling arithmetic rather than a measurement. The
 * longest id in the table is `claude-desktop` at 14; 32 leaves room for a
 * harness nobody has written yet without the ceiling having to move again.
 */
export const CLIENT_LABEL_MAX = 32;

/**
 * HOW CERTAIN EACH ROW IS. Carried as data rather than a comment so a
 * measurement pass can assert against it: a row's `verified` flag flips to
 * `true` in the same release its harness row in the matrix is MEASURED.
 *
 *   'source'    — read in that client's own source
 *   'documented'— stated by the client's own documentation, or stable enough
 *                 in its published config to record
 *   'observed'  — seen in a real handshake
 *   'community' — REPORTED ONLY, never measured here. `verified: false`.
 *
 * An unverified row costs, at worst, a wrong WORD on a report row — because
 * nothing branches on it. Removing one is a one-line change.
 */
const ROWS = [
  // ── source-verified ──────────────────────────────────────────────────────
  { raw: 'codex-mcp-client', id: 'codex', evidence: 'source', verified: true },
  { raw: 'gemini-cli-mcp-client', id: 'gemini-cli', evidence: 'source', verified: true },

  // ── documented, or stable enough in the client's own config to record ────
  { raw: 'opencode', id: 'opencode', evidence: 'documented', verified: true },
  { raw: 'kilo', id: 'kilo', evidence: 'documented', verified: true },
  { raw: 'dsh-mcp-client', id: 'dsh', evidence: 'documented', verified: true },
  { raw: 'zed', id: 'zed', evidence: 'documented', verified: true },
  { raw: 'windsurf', id: 'windsurf', evidence: 'documented', verified: true },
  // ONE PRODUCT, TWO VALUES, SIMULTANEOUSLY — the VS Code extension and the
  // SDK/CLI name themselves differently and both are current.
  { raw: 'cline', id: 'cline', evidence: 'documented', verified: true },
  { raw: '@cline/core', id: 'cline', evidence: 'documented', verified: true },
  // ONE PRODUCT, TWO VALUES, SEQUENTIALLY — the rename happened inside six
  // months, and a log spanning it carries both.
  { raw: 'copilot-cli', id: 'copilot', evidence: 'documented', verified: true },
  { raw: 'github-copilot-developer', id: 'copilot', evidence: 'documented', verified: true },

  // ── observed in a real handshake ─────────────────────────────────────────
  { raw: 'goose-desktop', id: 'goose', evidence: 'observed', verified: true },
  // Moved from `community` 2026-09-20 (package M's measurement campaign): the
  // real usage log's session lines carried the literal `claude-code` on every
  // one of the 6 real bridge sessions the campaign produced, and no other
  // label ever appeared in the window. Flip only — see
  // MEASUREMENT-claude-code-2026-09-20.md for the campaign itself.
  { raw: 'claude-code', id: 'claude-code', evidence: 'observed', verified: true },

  // ── COMMUNITY-REPORTED ONLY — carried, and marked. ───────────────────────
  // These two have NOT been measured against a real client by this project.
  // They are here so a first run produces a readable row instead of two
  // `other`s; they are NOT evidence, and `verified: false` is the fact a
  // measurement pass asserts against.
  //
  // `claude-ai` IS NOT CLAUDE CODE. It is Claude Desktop — a DIFFERENT
  // surface, on a different lifecycle, with different hooks. Collapsing the
  // two would put desktop-chat sessions in a coding harness's capture row and
  // make the meter lie about which tool saved. They get separate ids.
  { raw: 'claude-ai', id: 'claude-desktop', evidence: 'community', verified: false },
  { raw: 'cursor-vscode', id: 'cursor', evidence: 'community', verified: false },
];

/** raw (already normalised) → canonical harness id. MANY-to-one. */
export const KNOWN_CLIENTS = new Map(ROWS.map((r) => [r.raw, r.id]));

/** raw (already normalised) → the whole row, for a measurement pass. */
export const CLIENT_ROWS = ROWS;

/** Every canonical id this module can write, `other` excluded. */
export const CLIENT_IDS = [...new Set(ROWS.map((r) => r.id))].sort();

/**
 * Reduce a client-supplied name to the lookup key, or null.
 *
 * Lowercase → keep only `[a-z0-9@/_-]` → truncate to CLIENT_LABEL_MAX. The
 * charset is the one the real values need (`@cline/core` carries both `@` and
 * `/`) and no more: a space, a quote, a newline or a control character is
 * dropped rather than escaped, because this value is destined for a JSON line
 * in a file the product calls content-free.
 *
 * Truncation happens BEFORE the lookup, so a 10 KB name cannot match a table
 * row by prefix — it is truncated to 32 characters and then almost certainly
 * misses, which is `other`. That is the intended outcome; a hit on a
 * 32-character prefix of a longer string is still only a label.
 */
export function normaliseClientName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.toLowerCase().replace(/[^a-z0-9@/_-]+/g, '').slice(0, CLIENT_LABEL_MAX);
  return s.length ? s : null;
}

/**
 * The label to write. A table hit gives the canonical id; everything else,
 * including an absent name, gives `other`.
 *
 * TOTAL FUNCTION — it never throws and never returns the caller's string.
 */
export function labelForClient(raw) {
  const key = normaliseClientName(raw);
  if (!key) return CLIENT_OTHER;
  return KNOWN_CLIENTS.get(key) || CLIENT_OTHER;
}

/**
 * Pull the client's declared name out of a `tools/call` request and the
 * server object, NEWEST PROTOCOL ERA FIRST. Returns a raw string or null; the
 * caller passes it through `labelForClient`.
 *
 * 1. `request.params._meta["io.modelcontextprotocol/clientInfo"].name` — the
 *    2026-07-28 era. Optional, per-request, self-reported. VERIFIED against
 *    the installed SDK: `RequestMetaSchema` is a zod `looseObject`, so an
 *    unknown `_meta` key survives parsing and reaches the handler intact.
 *
 * 2. `server.getClientVersion()?.name` — the INITIALIZE ERA. The installed
 *    `@modelcontextprotocol/sdk@1.29.0` sets `_clientVersion` from
 *    `request.params.clientInfo` while handling the `initialize` REQUEST
 *    (`dist/esm/server/index.js:273`) and returns it from `getClientVersion()`
 *    (`:291`), strictly before any `tools/call` can arrive.
 *
 *    ** THIS PATH IS DEPRECATED. ** `@modelcontextprotocol/server` 2.0.0
 *    removes it in favour of the per-request envelope (`ctx.mcpReq.envelope`),
 *    which is arm 1 above under a different accessor. It is kept because every
 *    client that predates the handshake's removal is the only source of a name
 *    at all — and because THE APP'S OWN SELF-TEST IS AN INITIALIZE-ERA CLIENT:
 *    `src/brain/mcp-exercise.js` drives the bridge over stdio and sends
 *    `initialize`, so `POST /api/mcp/exercise` exercises arm 2 and never arm 1.
 *    A suite that only ever drove the self-test would therefore be blind to
 *    arm 1 — which is why `scripts/test-mcp-usage.js` drives each arm alone,
 *    with a control proving the other is genuinely unreachable in that case.
 *
 * 3. Neither → null → `other`. Never an error, never a refusal (Decision I).
 */
export function readClientName(request, server) {
  try {
    const meta = request?.params?._meta;
    const fromMeta = meta && meta[CLIENT_META_KEY] && meta[CLIENT_META_KEY].name;
    if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  } catch { /* a hostile _meta is not an error; fall through */ }
  try {
    const v = typeof server?.getClientVersion === 'function' ? server.getClientVersion() : null;
    if (v && typeof v.name === 'string' && v.name) return v.name;
  } catch { /* an SDK that does not expose it is not an error */ }
  return null;
}

/**
 * Normalise a client label READ BACK OFF DISK.
 *
 * NOT the same function as `labelForClient`, and the difference is a real
 * defect this project's own suite caught before release. What is on a session
 * line is already a CANONICAL ID — `labelForClient` ran before it was written.
 * Most ids are not also raw keys (`codex` is the id, `codex-mcp-client` is the
 * key; likewise `gemini-cli`, `copilot`, `cline`, `dsh`, `goose`,
 * `claude-desktop`), so putting a stored line back through `labelForClient`
 * turns a correctly-recorded harness into `other` — silently, and only for the
 * harnesses whose id and raw name differ, which is most of them.
 *
 * So: an already-canonical id (or the literal `other`) passes through; anything
 * else — a hand-edited line, a line from a future version — goes through the
 * allow-list, which is what keeps an arbitrary string from reaching a reader.
 */
export function normaliseStoredClient(value) {
  if (typeof value === 'string') {
    if (value === CLIENT_OTHER || CLIENT_IDS.includes(value)) return value;
  }
  return labelForClient(value);
}
