/**
 * src/brain/harness-names.js — one tool, one name (v3.74.0, design item D1).
 *
 * `harness` on a working-state save is FREE TEXT the agent typed. The
 * maintainer's own store carries eight spellings of what is, for seven of
 * them, one product: `Claude Code`, `Claude Code (desktop)`, `Claude Code
 * (desktop app)`, `Claude Code (worker agent)`, `claude-code`, … and
 * `Antigravity`. Compared as raw strings, that made the pulse say "2 tools"
 * over 199 + 1 saves by one tool, and it could raise a FALSE "Two agent tools
 * are writing …" collision (`journalFacts.harnessShared`) on a scope one tool
 * wrote under two spellings.
 *
 * `normaliseHarness(raw)` reduces a spelling to `{id, label, variant, raw}`:
 *
 *   id       lowercase, the thing to COMPARE. A known tool's canonical id;
 *            otherwise the trimmed base, lowercased, whitespace collapsed.
 *   label    what to SHOW. A known tool's canonical label; otherwise the
 *            trimmed base exactly as the agent typed it.
 *   variant  a trailing parenthetical (`desktop app, worker agent`), or null.
 *            It is a detail of HOW the tool ran, never a different tool.
 *   raw      the string as given (trimmed), for a tooltip. Nothing is lost.
 *
 * ── THREE RULES, EACH OF WHICH IS THE POINT ────────────────────────────────
 *
 * 1. NEVER MERGE DISTINCT PRODUCTS. `claude-desktop` is NOT `claude-code` —
 *    the same rule `mcp-clients.js` states for `claude-ai` (a different
 *    surface, lifecycle and hook set). The alias table is MANY-TO-ONE within a
 *    product and says nothing across products.
 * 2. UNKNOWN NAMES PASS THROUGH. A name not in the table is never matched by
 *    prefix, edit distance or substring to a known one: `Claude` is not
 *    `Claude Code`, `Antigravity IDE` is not `Antigravity`. Case and repeated
 *    whitespace are folded (so `Foo Bar` and `foo  bar` compare equal), and
 *    nothing else — hyphens and spaces stay distinct for an unknown name.
 * 3. PURE. No import, no I/O, no stdout: `working-state.js` imports this, and
 *    that module is on the MCP child's import graph, where a module that
 *    prints poisons the JSON-RPC stream.
 *
 * The seed is `harness-adapters.js`'s ids and labels (each asserted to
 * normalise to its own id by scripts/test-harness-names.js, so the two cannot
 * drift silently), `mcp-clients.js`'s raw client names for the same products,
 * plus `antigravity`, which has no adapter row yet (audit G5).
 */

/**
 * One row per PRODUCT. `aliases` are lookup keys (see `lookupKey`): lowercase,
 * with every run of whitespace, `_`, `/` or `-` folded to one `-`.
 */
const PRODUCTS = [
  { id: 'claude-code', label: 'Claude Code', aliases: ['claude-code', 'claudecode'] },
  // A DIFFERENT PRODUCT. See rule 1 — and mcp-clients.js, which maps the
  // desktop app's own client name `claude-ai` here, never to claude-code.
  { id: 'claude-desktop', label: 'Claude Desktop', aliases: ['claude-desktop', 'claude-ai'] },
  { id: 'codex', label: 'OpenAI Codex CLI', aliases: ['codex', 'codex-cli', 'openai-codex', 'openai-codex-cli', 'codex-mcp-client'] },
  { id: 'gemini-cli', label: 'Gemini CLI', aliases: ['gemini-cli', 'gemini-cli-mcp-client'] },
  { id: 'cursor', label: 'Cursor', aliases: ['cursor', 'cursor-vscode'] },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', aliases: ['copilot-cli', 'github-copilot-cli', 'copilot', 'github-copilot-developer'] },
  { id: 'cline', label: 'Cline', aliases: ['cline', '@cline-core'] },
  { id: 'opencode', label: 'OpenCode', aliases: ['opencode'] },
  { id: 'goose', label: 'goose', aliases: ['goose', 'goose-desktop'] },
  { id: 'kilo', label: 'Kilo', aliases: ['kilo'] },
  { id: 'dsh', label: 'DeepSeek Harness', aliases: ['dsh', 'deepseek-harness', 'dsh-mcp-client'] },
  { id: 'windsurf', label: 'Windsurf / Devin Desktop', aliases: ['windsurf', 'windsurf-devin-desktop'] },
  { id: 'zed', label: 'Zed', aliases: ['zed'] },
  { id: 'aider', label: 'Aider', aliases: ['aider'] },
  // No harness-adapters row exists for Antigravity yet (audit G5); the one
  // real Antigravity save on record spelled it `Antigravity`.
  { id: 'antigravity', label: 'Antigravity', aliases: ['antigravity', 'google-antigravity'] },
];

/** alias key → product row. Built once. */
const BY_ALIAS = new Map();
/**
 * An alias listed under TWO products — which would silently resolve to
 * whichever row came last, i.e. merge two products by table order. Collected
 * rather than thrown: this module is on the MCP import graph, where a throw at
 * load takes the bridge down. The suite asserts it is empty.
 */
export const HARNESS_ALIAS_COLLISIONS = [];
for (const p of PRODUCTS) {
  for (const a of p.aliases) {
    const prior = BY_ALIAS.get(a);
    if (prior && prior !== p) HARNESS_ALIAS_COLLISIONS.push({ alias: a, ids: [prior.id, p.id] });
    else BY_ALIAS.set(a, p);
  }
}

/** Every canonical id this module knows, for a suite to iterate. */
export const KNOWN_HARNESS_IDS = PRODUCTS.map((p) => p.id);

/** The longest raw string considered. Matches working-state's MAX_META_CHARS. */
const MAX_RAW = 80;

/** Lowercase; every run of whitespace, `_`, `/` or `-` becomes one `-`. */
function lookupKey(base) {
  return base.toLowerCase().replace(/[\s_/-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Reduce one free-text harness label to `{id, label, variant, raw}`, or null
 * when there is nothing usable (not a string, or blank). TOTAL: never throws.
 */
export function normaliseHarness(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, MAX_RAW).trim();
  if (!trimmed) return null;
  // A TRAILING parenthetical only — `Claude Code (desktop app, worker agent)`.
  // One level, no nesting: a label with a parenthesis in the middle keeps it.
  let base = trimmed;
  let variant = null;
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(trimmed);
  if (m && m[1].trim()) {
    base = m[1].trim();
    variant = m[2].trim() || null;
  }
  const known = BY_ALIAS.get(lookupKey(base));
  if (known) return { id: known.id, label: known.label, variant, raw: trimmed };
  // UNKNOWN: passed through. Case and whitespace folded for the id, nothing
  // else; the label is the agent's own spelling.
  const label = base.replace(/\s+/g, ' ');
  return { id: label.toLowerCase(), label, variant, raw: trimmed };
}

/** The comparable id for a raw label, or null. */
export function harnessId(raw) {
  const n = normaliseHarness(raw);
  return n ? n.id : null;
}
