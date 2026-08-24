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
  // ── Write tools (v2.5.2+) ───────────────────────────────────────────────────
  { definition: compileToWikiDefinition,          handler: compileToWikiHandler },
  { definition: scanWikiHealthDefinition,         handler: scanWikiHealthHandler },
  { definition: fixWikiIssueDefinition,           handler: fixWikiIssueHandler },
  { definition: scanSemanticDuplicatesDefinition, handler: scanSemanticDuplicatesHandler },
  { definition: getHealthDismissedDefinition,     handler: getHealthDismissedHandler },
  { definition: dismissWikiIssueDefinition,       handler: dismissWikiIssueHandler },
  { definition: undismissWikiIssueDefinition,     handler: undismissWikiIssueHandler },
];

// Response size cap. 1 MB of JSON is ~250 000 tokens — alone it would saturate
// Opus's 200 k context window, leaving no room for subsequent tool calls or the
// model's reasoning. We cap at 400 KB (~100 k tokens) so multiple tool calls
// can coexist in one conversation without exhausting context.
const MAX_RESPONSE_BYTES = 400 * 1024;

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
    return truncated + '\n\n…[response truncated — exceeded MCP 1 MB limit; use a more specific query]';
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
  ];
  const trimmed = { ...result };
  const trimmedFields = [];

  for (const field of trimmable) {
    if (!Array.isArray(trimmed[field])) continue;
    const original = trimmed[field].length;
    // Halve this array, then re-measure
    while (
      Array.isArray(trimmed[field]) &&
      trimmed[field].length > 10 &&
      Buffer.byteLength(JSON.stringify(trimmed, null, 2), 'utf8') > MAX_RESPONSE_BYTES
    ) {
      trimmed[field] = trimmed[field].slice(0, Math.floor(trimmed[field].length / 2));
    }
    if (trimmed[field].length < original) {
      trimmedFields.push(`${field}: ${original} → ${trimmed[field].length}`);
    }
    if (Buffer.byteLength(JSON.stringify(trimmed, null, 2), 'utf8') <= MAX_RESPONSE_BYTES) break;
  }

  if (trimmedFields.length) {
    trimmed._truncated = `Response exceeded MCP 1 MB limit and was trimmed: ${trimmedFields.join(', ')}. ` +
      `Narrow your query (filter, min_connections, max_results, domain-scoped call) for complete results.`;
  }

  text = JSON.stringify(trimmed, null, 2);
  // Final safety: hard-cap at the byte limit
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    return JSON.stringify(
      {
        _truncated: `Response from ${toolName} exceeded the 1 MB MCP response limit even after trimming. ` +
          `Please call this tool with more specific filters.`,
      },
      null,
      2,
    );
  }
  return text;
}

export function registerTools(server, storage) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => t.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find(t => t.definition.name === name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(args || {}, storage);
      const text = enforceSizeLimit(name, result);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error running ${name}: ${err.message}` }],
        isError: true,
      };
    }
  });
}
