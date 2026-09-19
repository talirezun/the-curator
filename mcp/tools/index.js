/**
 * Tool registration hub — wires every tool module into the MCP server.
 */
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { listDomainsDefinition,    listDomainsHandler }    from './domains.js';
import { getIndexDefinition,       getIndexHandler }       from './index-tool.js';
import { searchWikiDefinition,     searchWikiHandler }     from './search.js';
import { getNodeDefinition,        getNodeHandler }        from './nodes.js';
import { getConnectedDefinition,   getConnectedHandler }   from './connected.js';
import { getSummaryDefinition,     getSummaryHandler }     from './summary.js';
import { searchCrossDefinition,    searchCrossHandler }    from './cross.js';
import { getGraphOverviewDefinition, getGraphOverviewHandler } from './overview.js';
import { getTagsDefinition,        getTagsHandler }        from './tags.js';
import { getBacklinksDefinition,   getBacklinksHandler }   from './backlinks.js';
import { getRawSourceDefinition,   getRawSourceHandler }   from './raw-source.js';

// Write tools (v2.5.2+) — turn the MCP into a full read+write client.
import { compileToWikiDefinition,            compileToWikiHandler }            from './compile.js';
import { scanWikiHealthDefinition,           scanWikiHealthHandler }           from './health.js';
import { fixWikiIssueDefinition,             fixWikiIssueHandler }             from './health.js';
import { scanSemanticDuplicatesDefinition,   scanSemanticDuplicatesHandler }   from './health.js';
import { getHealthDismissedDefinition,       getHealthDismissedHandler }       from './dismissed.js';
import { dismissWikiIssueDefinition,         dismissWikiIssueHandler }         from './dismissed.js';
import { undismissWikiIssueDefinition,       undismissWikiIssueHandler }       from './dismissed.js';

// Track 7 — portable working state. Three reads, three writes (v3.48.0 added
// the project level: `list_projects` answers "which project",
// `save_project_brief` writes tier 1 and is instruction-only; v3.59.0 added
// tier 0: `get_project_context` is the one-call bootstrap, `save_foundation`
// writes a canonical document and is instruction-only too).
import { getWorkingStateDefinition,          getWorkingStateHandler }          from './working-state.js';
import { listProjectsDefinition,             listProjectsHandler }             from './working-state.js';
import { getProjectContextDefinition,        getProjectContextHandler }        from './working-state.js';
import { saveWorkingStateDefinition,         saveWorkingStateHandler }         from './working-state.js';
import { saveProjectBriefDefinition,         saveProjectBriefHandler }         from './working-state.js';
import { saveFoundationDefinition,           saveFoundationHandler }           from './working-state.js';

// v3.60.0 — the tool-usage log. Content-free (tool, domain, outcome, duration),
// local-only, best-effort: it never throws to a caller and is never awaited.
// v3.63.0 adds the session id, the resolved project slug, and — on ONE session
// line per process — the client's declared name, read from BOTH protocol eras
// by `readClientName` and reduced to an allow-listed label. NOTHING below
// branches on that label; it is written and never read again in this process.
import { appendUsage } from '../../src/brain/mcp-usage.js';
import { readClientName } from '../../src/brain/mcp-clients.js';

// THE COUNT, for every place that quotes one at a user: 24 tools as of
// v3.59.0 (22 in v3.48.0), of which 7 call refuseIfReadonly and so MUTATE
// (compile_to_wiki, fix_wiki_issue, dismiss_wiki_issue, undismiss_wiki_issue,
// save_working_state, save_project_brief, save_foundation). Derive the
// mutator list from the refuseIfReadonly call sites, never from this comment.
//
// A tool added here must also get a row in ./catalogue.js (name, capability
// group, mutates, a ≤ 12-word purpose) — that file is what the app's tool map
// is labelled from, and scripts/test-mcp-usage.js §6 compares the two lists
// name by name IN ORDER, with the mutator column taken from an executed
// refuseIfReadonly census rather than from either comment.
export const tools = [
  // ── Read tools (v2.3.0+) ────────────────────────────────────────────────────
  { definition: listDomainsDefinition,      handler: listDomainsHandler },
  { definition: getIndexDefinition,         handler: getIndexHandler },
  { definition: getGraphOverviewDefinition, handler: getGraphOverviewHandler },
  { definition: getTagsDefinition,          handler: getTagsHandler },
  { definition: searchWikiDefinition,       handler: searchWikiHandler },
  { definition: searchCrossDefinition,      handler: searchCrossHandler },
  { definition: getNodeDefinition,          handler: getNodeHandler },
  { definition: getConnectedDefinition,     handler: getConnectedHandler },
  { definition: getBacklinksDefinition,     handler: getBacklinksHandler },
  { definition: getSummaryDefinition,       handler: getSummaryHandler },
  // Track 7 Part II — the original document behind a summary. Read-only.
  { definition: getRawSourceDefinition,     handler: getRawSourceHandler },
  // Track 7 — resume a previous session's work. Read-only; reads state/,
  // never the wiki graph, so it is unaffected by graph.js's file-count cache.
  { definition: getWorkingStateDefinition,  handler: getWorkingStateHandler },
  // v3.48.0 — "which project am I resuming?". Registered BEFORE the write
  // block for the same reason every read tool is: tool ordering nudges a model
  // to reach for a read first when the intent is exploration.
  { definition: listProjectsDefinition,     handler: listProjectsHandler },
  // v3.59.0 — the ONE-CALL BOOTSTRAP: brief + latest handoff + the project's
  // canonical documents (index always, bodies within a budget, deltas against
  // what the last handoff recorded). Read-only; registered before the write
  // block like every read tool. Its `foundations.documents` array is on the
  // size guard's trim list below.
  { definition: getProjectContextDefinition, handler: getProjectContextHandler },
  // ── Write tools (v2.5.2+) ───────────────────────────────────────────────────
  { definition: compileToWikiDefinition,          handler: compileToWikiHandler },
  { definition: scanWikiHealthDefinition,         handler: scanWikiHealthHandler },
  { definition: fixWikiIssueDefinition,           handler: fixWikiIssueHandler },
  { definition: scanSemanticDuplicatesDefinition, handler: scanSemanticDuplicatesHandler },
  { definition: getHealthDismissedDefinition,     handler: getHealthDismissedHandler },
  { definition: dismissWikiIssueDefinition,       handler: dismissWikiIssueHandler },
  { definition: undismissWikiIssueDefinition,     handler: undismissWikiIssueHandler },
  // Track 7 — writes domains/<project>/state/, not the wiki. Carries
  // refuseIfReadonly like every other mutator here.
  { definition: saveWorkingStateDefinition,       handler: saveWorkingStateHandler },
  // v3.48.0 — tier 1. Instruction-only: its description says in as many words
  // that it is called when the USER asks, never on the agent's own initiative,
  // and every write it makes is stamped as agent-authored in the file itself.
  { definition: saveProjectBriefDefinition,       handler: saveProjectBriefHandler },
  // v3.59.0 — tier 0's one writer for curator-owned canonical documents.
  // Instruction-only like save_project_brief (refused without
  // `commissioned_by_owner: true`), and mutator #7 by the refuseIfReadonly
  // census. It does NOT call invalidateGraph: state/ is outside the graph
  // cache, exactly as the other two state writers are.
  { definition: saveFoundationDefinition,         handler: saveFoundationHandler },
];

// Response size cap. 1 MB of JSON is ~250 000 tokens — alone it would saturate
// Opus's 200 k context window, leaving no room for subsequent tool calls or the
// model's reasoning. We cap at 400 KB (~100 k tokens) so multiple tool calls
// can coexist in one conversation without exhausting context.
const MAX_RESPONSE_BYTES = 400 * 1024;
// The same number in the words a MODEL reads. Derived, never typed twice: all
// three notices below used to say "1 MB limit" — a figure the guard has not
// enforced since v2.3.1 — so a model told to narrow its query was given a
// budget 2.6x larger than the one that had just trimmed its answer, and could
// reasonably retry a request the guard was always going to cut again.
const MAX_RESPONSE_LABEL = `${Math.round(MAX_RESPONSE_BYTES / 1024)} KB`;

/**
 * Ensure tool output fits within the MCP response limit.
 * If the JSON body is oversized, progressively trim heavy arrays (nodes, edges,
 * results, tags, backlinks) and finally fall back to a structured error message.
 */
function enforceSizeLimit(toolName, result) {
  let text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  if (Buffer.byteLength(text, 'utf8') <= MAX_RESPONSE_BYTES) return text;

  // String result — just truncate with a notice
  if (typeof result === 'string') {
    const truncated = text.slice(0, MAX_RESPONSE_BYTES - 2000);
    return truncated + `\n\n…[response truncated — exceeded the MCP ${MAX_RESPONSE_LABEL} response limit; use a more specific query]`;
  }

  // Object result — progressively trim known heavy arrays
  const trimmable = [
    'edges', 'nodes', 'results', 'tags',
    'backlinks', 'outgoing_links', 'connected',
    'outgoing_from_start', 'backlinks_to_start',
    // v2.5.2+ — health scan result fields can grow unbounded on large
    // domains (the user's articles wiki currently has 645 broken links).
    'brokenLinks', 'orphans', 'folderPrefixLinks',
    'crossFolderDupes', 'hyphenVariants', 'missingBacklinks', 'pairs',
    // v3.59.0 — get_project_context's document bodies, ONE level down. The
    // halving keeps the FIRST half, and the store put the documents in
    // reading order, so the last in reading order go first. Without this a
    // bootstrap over budget would collapse to the bare `{_truncated}`
    // fallback below, with `ok`, the brief and the handoff erased.
    'foundations.documents',
    // v3.62.0 — the documents a caller named with `slugs`. LISTED AFTER the
    // line above so the bootstrap's own selection is given up first: a named
    // document is an instruction, the selection is the store's guess.
    // `boundContextResponse` normally gets there first (and records the drop
    // by name); this is the same defence in depth the line above is.
    'foundations.requested',
  ];
  const trimmed = { ...result };
  const trimmedFields = [];

  // A dotted name addresses a nested array; the path's objects are copied on
  // write so the caller's object is never mutated. Top-level names behave
  // exactly as they always have.
  const getAt = (obj, p) => p.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  const setAt = (obj, p, v) => {
    const keys = p.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) { o[keys[i]] = { ...o[keys[i]] }; o = o[keys[i]]; }
    o[keys[keys.length - 1]] = v;
  };

  for (const field of trimmable) {
    if (!Array.isArray(getAt(trimmed, field))) continue;
    const original = getAt(trimmed, field).length;
    // Halve this array, then re-measure
    while (
      Array.isArray(getAt(trimmed, field)) &&
      getAt(trimmed, field).length > (field.includes('.') ? 0 : 10) &&
      Buffer.byteLength(JSON.stringify(trimmed, null, 2), 'utf8') > MAX_RESPONSE_BYTES
    ) {
      const cur = getAt(trimmed, field);
      setAt(trimmed, field, cur.slice(0, Math.floor(cur.length / 2)));
    }
    if (getAt(trimmed, field).length < original) {
      trimmedFields.push(`${field}: ${original} → ${getAt(trimmed, field).length}`);
    }
    if (Buffer.byteLength(JSON.stringify(trimmed, null, 2), 'utf8') <= MAX_RESPONSE_BYTES) break;
  }

  if (trimmedFields.length) {
    trimmed._truncated = `Response exceeded the MCP ${MAX_RESPONSE_LABEL} response limit and was trimmed: ${trimmedFields.join(', ')}. ` +
      `Narrow your query (filter, min_connections, max_results, domain-scoped call) for complete results.`;
  }

  text = JSON.stringify(trimmed, null, 2);
  // Final safety: hard-cap at the byte limit
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    return JSON.stringify(
      {
        _truncated: `Response from ${toolName} exceeded the MCP ${MAX_RESPONSE_LABEL} response limit even after trimming. ` +
          `Please call this tool with more specific filters.`,
      },
      null,
      2,
    );
  }
  return text;
}

/** TEST-ONLY seam (v3.59.0): lets a suite drive the guard's nested-path trim
 *  (`foundations.documents`) directly. The MCP handlers bound themselves
 *  before this guard is reached, so the nested arm is defence in depth and
 *  cannot be reached over the wire with the shipped constants — which is
 *  exactly why it needs a seam to be tested at all. Never called in production. */
export const __enforceSizeLimit = enforceSizeLimit;

export function registerTools(server, storage) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => t.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startedAt = Date.now();
    // READ HERE, AT THE DISPATCH, AND NOWHERE ELSE. Both protocol eras are
    // consulted (the per-request `_meta` of spec 2026-07-28 first, then the
    // SDK's deprecated initialize-era `getClientVersion()`), and the raw value
    // goes straight into `recordUsage` → `appendUsage`, which allow-lists it.
    // It is never compared, never branched on, and never stored anywhere a
    // second reader could find it — Decision I, and the specification's own
    // instruction that a server SHOULD NOT change behaviour on this value.
    const client = readClientName(request, server);
    const tool = tools.find(t => t.definition.name === name);
    if (!tool) {
      const response = {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
      // `name` here is a string the CLIENT chose and nothing has validated, so
      // it is never written to the log — see mcp-usage.js on why no user
      // string goes in that file. The call still happened, so it is recorded.
      recordUsage({ tool: 'unknown', args, result: null, threw: true, ms: Date.now() - startedAt, client });
      return response;
    }
    let result = null;
    let threw = false;
    let response;
    try {
      result = await tool.handler(args || {}, storage);
      const text = enforceSizeLimit(name, result);
      response = { content: [{ type: 'text', text }] };
    } catch (err) {
      threw = true;
      response = {
        content: [{ type: 'text', text: `Error running ${name}: ${err.message}` }],
        isError: true,
      };
    }
    // AFTER the response is fully built, and never awaited. The log must not
    // be able to delay a tool call, change its answer, or fail it.
    recordUsage({ tool: name, args, result, threw, ms: Date.now() - startedAt, client });
    return response;
  });
}

/**
 * The usage-log hook. One call per dispatch, fire-and-forget.
 *
 * HOW `ok` AND `refused` ARE DECIDED, measured against what the tools actually
 * return rather than assumed. A handler never sets `isError` — that is the
 * dispatch's word for "it threw". What handlers DO return on a refusal is
 * `{ok: false, error: '<sentence>'}`: `refuseIfReadonly` builds exactly that
 * shape (mcp/util.js), `resolveDomainArg`'s error is spread into the same
 * shape, and every argument validation in every tool module follows it. So:
 *
 *   ok: false, refused: true   → a structured refusal (read-only mirror, a bad
 *                                slug, a missing required argument, a guard)
 *   ok: false, refused: false  → the handler threw
 *   ok: true,  refused: false  → it answered
 *
 * That collapses "you may not" and "you asked wrongly" into one flag, which is
 * deliberate: the map shows a count of refusals per tool, and the distinction
 * between the two would need the error TEXT to make — which is precisely what
 * this log will not store.
 *
 * The domain is taken from the RESULT first (the resolved one, after
 * `resolveDomainArg` has applied the configured default) and only then from
 * the arguments, and is dropped unless it looks like a slug.
 *
 * THE PROJECT (v3.63.0) is taken the same way and for the same reason: the
 * working-state tools return the RESOLVED slug on their envelope
 * (`result.project`, a string), which is the one the store actually wrote to
 * — an argument may have been a bare name resolved across domains, or absent
 * entirely and filled from the configured default. A tool that names no
 * project leaves the field absent. `mcp-usage.js` bounds and shape-checks it;
 * nothing here trusts it.
 *
 * THE CLIENT is passed through UNVALIDATED on purpose — `appendUsage` is the
 * one place that allow-lists it, so there is exactly one gate rather than two
 * that could disagree. It reaches disk only on the session line.
 */
function recordUsage({ tool, args, result, threw, ms, client }) {
  try {
    const obj = result && typeof result === 'object' ? result : null;
    const refused = !threw && obj ? obj.ok === false : false;
    const domain = (obj && (obj.domain || obj.project?.domain)) || (args && args.domain) || null;
    const project = (obj && typeof obj.project === 'string' ? obj.project : null)
      || (args && typeof args.project === 'string' ? args.project : null)
      || null;
    // No await, and no .catch() needed: appendUsage's promise always resolves.
    appendUsage({
      tool,
      domain: typeof domain === 'string' ? domain : null,
      ok: !threw && !refused,
      refused,
      ms,
      project,
      client,
    });
  } catch { /* observability may never break a tool call */ }
}
