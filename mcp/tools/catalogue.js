/**
 * The tool catalogue — one row per MCP tool, for anything that has to DESCRIBE
 * the bridge rather than run it (v3.60.0: the Settings tool map).
 *
 * PURE DATA, NO IMPORTS, ON PURPOSE. The app's route reads this file to label
 * a map of tool names; importing it must not drag `mcp/tools/*.js` — and with
 * them `src/brain/files.js`, `health.js` and the graph parser — into the web
 * server's process just to render some captions.
 *
 * It is therefore a SECOND list of the same 24 tools, and a second list is a
 * thing that drifts. `scripts/test-mcp-usage.js` §6 is what stops it:
 *
 *   - `name`, compared to the real `tools` array in index.js IN ORDER, so a
 *     tool added, removed or reordered there reds this file.
 *   - `mutates`, compared to an EXECUTED `refuseIfReadonly` census over
 *     `mcp/tools/**` — the call is what makes a tool a mutator, and CLAUDE.md
 *     has recorded twice that the prose count goes stale while the code does
 *     not. The census reads each handler's own body, so two tools in one file
 *     (scan_wiki_health and fix_wiki_issue both live in health.js) are told
 *     apart rather than tarred together.
 *   - `purpose`, ≤ 12 words. These are read by a PERSON in a grid of tiles,
 *     not by a model — the model reads `definition.description`, which is a
 *     paragraph. Do not paste one into the other.
 *
 * ── `group` IS BY CAPABILITY, NOT BY WHERE THE TOOL SITS IN index.js ────────
 *
 * There are two honest splits of these 24 and they disagree, so this file
 * names which one it means. index.js registers 14 read tools and then a block
 * of 10 "write tools", three of which only inspect (scan_wiki_health,
 * scan_semantic_duplicates, get_health_dismissed). By CAPABILITY — the split
 * that matters to someone deciding what to let an agent do — it is 17 that
 * read and 7 that write. `group` is the capability split, so `group === 'write'`
 * if and only if `mutates` is true, and the guard asserts exactly that. The
 * source grouping is not represented here; read index.js for it.
 */

export const TOOL_CATALOGUE = [
  // ── Read ──────────────────────────────────────────────────────────────────
  { name: 'list_domains',             group: 'read',  mutates: false, purpose: 'List every knowledge domain in this wiki.' },
  { name: 'get_index',                group: 'read',  mutates: false, purpose: "The domain's full page catalogue, slug by slug." },
  { name: 'get_graph_overview',       group: 'read',  mutates: false, purpose: 'Orientation snapshot: stats, hub pages, orphans, top tags.' },
  { name: 'get_tags',                 group: 'read',  mutates: false, purpose: 'The tag inventory, ranked by how many pages carry each.' },
  { name: 'search_wiki',              group: 'read',  mutates: false, purpose: "Full-text search across one domain's pages." },
  { name: 'search_cross_domain',      group: 'read',  mutates: false, purpose: 'Search every domain at once, results tagged by domain.' },
  { name: 'get_node',                 group: 'read',  mutates: false, purpose: 'One page in full, with its links and tags.' },
  { name: 'get_connected_nodes',      group: 'read',  mutates: false, purpose: 'Walk the link graph outward from one page.' },
  { name: 'get_backlinks',            group: 'read',  mutates: false, purpose: 'Every page that links to this one.' },
  { name: 'get_summary',              group: 'read',  mutates: false, purpose: 'The summary page written for one ingested source.' },
  { name: 'get_raw_source',           group: 'read',  mutates: false, purpose: 'The original document a summary was built from.' },
  { name: 'get_working_state',        group: 'read',  mutates: false, purpose: 'The last handoff: what an earlier session left unfinished.' },
  { name: 'list_projects',            group: 'read',  mutates: false, purpose: 'Which projects have working state, newest first.' },
  { name: 'get_project_context',      group: 'read',  mutates: false, purpose: 'One-call bootstrap: brief, handoff and canonical documents.' },
  // ── Write block in index.js — three of these only inspect ──────────────────
  { name: 'compile_to_wiki',          group: 'write', mutates: true,  purpose: "Write this conversation's findings into the wiki." },
  { name: 'scan_wiki_health',         group: 'read',  mutates: false, purpose: 'Scan for broken links, orphan pages and duplicates.' },
  { name: 'fix_wiki_issue',           group: 'write', mutates: true,  purpose: 'Apply one health fix; some of them delete files.' },
  { name: 'scan_semantic_duplicates', group: 'read',  mutates: false, purpose: 'Find pages describing one thing under different slugs.' },
  { name: 'get_health_dismissed',     group: 'read',  mutates: false, purpose: 'The health issues you chose to leave alone.' },
  { name: 'dismiss_wiki_issue',       group: 'write', mutates: true,  purpose: 'Stop a health issue surfacing on future scans.' },
  { name: 'undismiss_wiki_issue',     group: 'write', mutates: true,  purpose: 'Bring a dismissed health issue back into scans.' },
  { name: 'save_working_state',       group: 'write', mutates: true,  purpose: "Save this session's handoff so the next one resumes." },
  { name: 'save_project_brief',       group: 'write', mutates: true,  purpose: 'Write the standing brief, only when you ask.' },
  { name: 'save_foundation',          group: 'write', mutates: true,  purpose: 'Write one canonical project document, only when commissioned.' },
];

/** Catalogue row by tool name, or null. */
export function catalogueEntry(name) {
  return TOOL_CATALOGUE.find(t => t.name === name) || null;
}
