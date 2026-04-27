---
name: my-curator
description: Use whenever the user wants to interact with their My Curator second brain — a markdown knowledge graph managed by The Curator app and accessed via the my-curator MCP. Activates for both READ requests ("what does my wiki say about X", "deep research my second brain", "find every source that mentions Y", "show me topology of the AI domain") and WRITE requests ("add to my second brain", "save to my wiki", "update my Curator", "compile our findings", "store these notes", "put this in my projects domain"). Also activates for maintenance ("check my wiki", "find broken links", "clean up orphans", "scan for duplicate pages"). Enforces the second-brain structure (entities, concepts, summaries), grounds every wikilink in an existing slug before writing, refuses speculative links on fresh domains, compounds knowledge into existing pages instead of creating duplicates, and respects the per-domain siloing model (no cross-domain links). Always orients on the wiki via list_domains and get_index BEFORE composing any write.
allowed-tools: mcp__my-curator__list_domains mcp__my-curator__get_index mcp__my-curator__get_graph_overview mcp__my-curator__get_tags mcp__my-curator__search_wiki mcp__my-curator__search_cross_domain mcp__my-curator__get_node mcp__my-curator__get_connected_nodes mcp__my-curator__get_backlinks mcp__my-curator__get_summary mcp__my-curator__compile_to_wiki mcp__my-curator__scan_wiki_health mcp__my-curator__fix_wiki_issue mcp__my-curator__scan_semantic_duplicates mcp__my-curator__get_health_dismissed mcp__my-curator__dismiss_wiki_issue mcp__my-curator__undismiss_wiki_issue
---

# My Curator — second brain playbook

This skill is the canonical playbook for working with the user's **My Curator** second brain through the **my-curator MCP**. The MCP exposes 17 tools — 10 for reading the wiki and 7 for writing to it. This playbook tells you how to use them well, in the order that produces the best results.

## §1 — What the second brain is

The user's "second brain" is a Curator-managed wiki: plain markdown files organised into a knowledge graph the user has built up over time. It lives on disk under `domains/<name>/wiki/` and is browsed visually in Obsidian, queried in the Curator app, and accessed by you via the my-curator MCP.

A wiki is divided into independent **domains** (e.g. `articles`, `business`, `projects`). Each domain is its own knowledge graph with its own pages, schema, and conversations. **Domains are siloed** — there are no automatic links between them and there is no shared inventory. A `[[wikilink]]` in `articles` resolves only against pages in `articles`. Cross-domain *reasoning* is possible (via `search_cross_domain`); cross-domain *linking* is not.

Within a domain, every wiki has three folders:

```
domains/<name>/wiki/
├── entities/       — the nouns
├── concepts/       — the verbs / ideas
└── summaries/      — the glue
```

## §2 — The atomic decomposition rule

This is the most important rule. When the user asks you to save something to the wiki, you must atomise it into the three folder types correctly.

| Folder | Contains | Examples |
|---|---|---|
| **entities/** | The nouns. Specific named things — people, companies, tools, datasets, products, organisations, places. Each has a proper name. | `entities/openai.md`, `entities/anthropic.md`, `entities/gpt-4.md`, `entities/andrej-karpathy.md`, `entities/lumina-pro.md` |
| **concepts/** | The verbs / ideas. Theories, techniques, frameworks, principles, methodologies. Ideas without a single owner. | `concepts/rag.md`, `concepts/agentic-workflows.md`, `concepts/context-engineering.md`, `concepts/llm-deployment-strategies.md` |
| **summaries/** | The glue. One summary page per ingested source or compiled conversation. The narrative that connects entities to concepts for that source. | `summaries/lumina-pro-research-notes-2026-04-27-...md` |

**Slug rules.** Filenames are lowercase, hyphenated, and become the slug used in `[[wikilinks]]`:

```
entities/openai.md            →  [[openai]]
concepts/agentic-workflows.md →  [[agentic-workflows]]
summaries/<title>-<hash>.md   →  [[summaries/<title>-<hash>]]
```

`[[wikilinks]]` use **bare slugs** (no folder prefix) for entities and concepts. Summaries are the **one exception** — they keep their `summaries/` prefix because they live in a sibling folder Obsidian needs for routing. So: `[[openai]]` not `[[entities/openai]]`. But: `[[summaries/foo]]` not `[[foo]]` for summaries.

## §3 — Domain awareness

Before you do anything, know which domain you're working in.

1. **If the user named a domain** (`"add to my projects domain"`) → use it.
2. **If they said "my wiki" without naming one** → call `list_domains`. If exactly one domain exists, use it. If multiple exist, ask the user which one. Never guess.
3. **The user may have set a default domain** in the Curator app's Settings. If they did, MCP tools fall back to that automatically when you omit `domain`. But still confirm with the user when ambiguous.
4. **Domains are siloed.** Don't try to write a link from one domain to a page in another. If the user wants cross-domain synthesis, that's a `search_cross_domain` reading task — not a writing task.

## §4 — Reading workflow (deep research)

When the user asks a question of their wiki, your job is to traverse the graph efficiently and synthesise — not just keyword-search.

### The five reading patterns

| Pattern | Tools | When |
|---|---|---|
| **Topology orientation** | `get_graph_overview` | "Show me the shape of my <domain> knowledge". Returns hubs, orphan sample, top tags. Always cheap; safe first move on a new domain. |
| **Targeted retrieval** | `search_wiki` → `get_node` | "What does my wiki know about X?". Search ranks results; fetch the top 1–3 with get_node for full content. |
| **Bidirectional tracing** | `get_node` + `get_backlinks` | "Every source that mentions Y". Pull the entity page; then list every page that links to it. |
| **Multi-hop traversal** | `get_connected_nodes` | "How is X connected to the rest?". Returns the neighborhood up to 2 hops, ranked by hop+degree. |
| **Tag-driven clusters** | `get_tags` (with `filter`) → `get_node` | "Pages tagged ai-safety, then synthesise". Tag inventory then per-page fetch. |

### Cross-domain reasoning

`search_cross_domain` queries every domain at once. Use this when the user asks something like *"What patterns appear across both my articles and my projects domains?"*. The tool returns matches scoped per-domain — synthesise them in the conversation. **You cannot create persistent cross-domain links** — that's a fundamental property of the wiki architecture (see §3).

### The opening move that usually works

For a deep-research request, this two-step is almost always the right start:

1. `get_graph_overview(domain)` — orient yourself on hubs, clusters, orphan sample.
2. Based on what you see, decide which entities/concepts are worth `get_node` calls, then synthesise.

You don't need to enumerate everything. The wiki is large; reasoning over hubs and surfacing connections is the value.

## §5 — Writing workflow (adding knowledge)

This is the rule that produces ZERO broken links and ZERO duplicate pages. **Follow it every single time** the user asks you to save, add, compile, or update.

### The five-step playbook

**Step 1 — Confirm the domain.** Per §3.

**Step 2 — Inventory the existing wiki.** Mandatory before composing.

```
get_index(domain)
```

This returns the master catalog. **Read it.** Note which entities and concepts already exist. For specific topics that might already have pages, also call `search_wiki` to find variant slugs you might miss in the index.

**Step 3 — Decide: what's new vs what already exists.** For every concept or entity you're about to mention:

- **Already in the index?** → use that EXACT slug in your `[[wikilinks]]`. Do not invent a variant. (`[[openai]]` matches `entities/openai.md`; `[[OpenAI]]` or `[[open-ai]]` would NOT.)
- **Not in the index, but you want to introduce it?** → add it to `additional_pages` so it gets created in this same call.
- **Not in the index, and you don't want to create a page for it?** → write the term as plain prose without `[[brackets]]`.

**Step 4 — Compose with grounded links.** Every `[[wikilink]]` you write must reference one of:
- A slug already in the index (from step 2)
- A slug you're creating in this same `additional_pages` array

Anything else is a broken link the user will have to fix later. Do not invent slugs.

**Step 5 — Choose the right `broken_link_policy`** when calling `compile_to_wiki`:

- **Fresh / mostly-empty domains (< ~20 pages)** → use `broken_link_policy: 'refuse'`. The call will abort if any link is broken, returning the broken list + a sample of valid slugs. Retry with corrections — typically converges in 1–2 iterations.
- **Established / populated domains** → `broken_link_policy: 'keep'` (default) is fine. The response's `links` field still tells you what's broken.
- **When unsure, prefer 'refuse'.** It's strict but produces clean wikis.

After the call, inspect the `links` field in the response:

```json
"links": {
  "total": 12,
  "resolved": 10,        // exact match
  "normalized": 1,       // variant auto-fixed (e.g. [[Claude]] → [[claude]])
  "broken": [...],       // these are the problem
  "broken_count": 1
}
```

If `broken_count > 0` and you used `'keep'`, decide: retry with corrections, or accept the broken link as a known TODO?

### Idempotency

`compile_to_wiki` refuses re-compiles when the title + content + date hash to the same slug. If the user asks to compile the same thing twice, the second call is refused with a clear message. To extend a previous compile, the user should add new content to their conversation first.

### Don'ts

- **Don't write to `summaries/` paths via `additional_pages`.** Summary slugs are deterministically generated by the system. You only provide `summary_content`; the tool produces the path.
- **Don't compile twice with identical content.** The idempotency guard will refuse — that's correct behaviour, not a bug.
- **Don't try to link across domains.** `[[business:openai]]` is not supported syntax.

## §6 — Maintenance workflow (Wiki Health)

When the user asks to "check my wiki" or "clean up", use the Health tools. There's a three-tier mental model:

| Tier | Issue types | Action |
|---|---|---|
| **Auto-fix without asking** | `folderPrefixLinks`, `crossFolderDupes`, `hyphenVariants`, `missingBacklinks`, `brokenLinks` *with* `suggestedTarget` | These have one clear right answer. Call `fix_wiki_issue` for each, no confirmation needed. |
| **Confirm with user first** | `orphans`, `brokenLinks` *without* a target | Show the user, accept "fix" / "dismiss" / "leave for later", then act. |
| **ALWAYS preview, then confirm** | `semanticDupe` (destructive — deletes a file, rewrites links) | Call `fix_wiki_issue` with `preview: true` to get the diff plan; show the user; only on explicit confirmation call again with `preview: false`. |

### The standard "clean up" dialogue

```
1. scan_wiki_health(domain)
2. Loop the auto-fixable ones via fix_wiki_issue (count successes)
3. List the review-only ones; ask the user one by one (or in batch)
4. For each user-approved fix → fix_wiki_issue
5. For each user dismissal → dismiss_wiki_issue (persists across scans + machines)
```

Persistent dismissals: `dismiss_wiki_issue` writes to a file synced across the user's machines. Items dismissed in a Claude Desktop conversation also disappear from the in-app Health tab; same store. Use `get_health_dismissed` to list previously skipped issues if the user asks.

### Semantic-duplicate scanning is paid

`scan_semantic_duplicates` calls the LLM with a small per-scan cost (~$0.005–$0.03). **Only run it when the user explicitly asks** — and use `estimate_only: true` first to show the cost before committing.

## §7 — Tool reference

| Tool | Purpose | When |
|---|---|---|
| `list_domains` | List domains | Always when domain is unclear |
| `get_index` | Master page catalog | Always before any write |
| `get_graph_overview` | Topology snapshot | First move on a research task |
| `get_tags` | Tag inventory | Tag-driven cluster work |
| `search_wiki` | Ranked search in one domain | Specific topic lookup |
| `search_cross_domain` | Search across all domains | Cross-domain synthesis only (read) |
| `get_node` | Full page with frontmatter | Detail pull on a known slug |
| `get_connected_nodes` | Neighborhood traversal | "How is X connected" |
| `get_backlinks` | Incoming-link list | "Every source that mentions X" |
| `get_summary` | Pull a summary page | When user references a specific source |
| `compile_to_wiki` | Save findings as wiki pages | THE write tool — follow §5 |
| `scan_wiki_health` | Find structural issues | "Check my wiki" |
| `fix_wiki_issue` | Apply ONE Health fix | After scan, per issue |
| `scan_semantic_duplicates` | AI duplicate detection | Opt-in, paid, user-initiated only |
| `get_health_dismissed` | List previously dismissed | "What have I skipped?" |
| `dismiss_wiki_issue` | Permanently skip an issue | When user says "leave alone" |
| `undismiss_wiki_issue` | Restore a dismissal | When user changes their mind |

## §8 — Quality rules (the don'ts)

A compact reminder of what NOT to do:

1. **Don't invent wikilinks.** Every `[[X]]` must resolve. If you didn't verify it's in the index or in `additional_pages`, write the text without brackets.
2. **Don't create duplicate pages.** If `entities/openai.md` exists, your update goes to `[[openai]]` — never `[[OpenAI]]` or `[[open-ai]]`.
3. **Don't write summaries via `additional_pages`.** Only entities/ and concepts/.
4. **Don't compile identical content twice in a day.** Idempotency refusal is correct.
5. **Don't try to link across domains.** Domains are siloed.
6. **Don't use folder prefixes in wikilinks** for entities or concepts. `[[openai]]` not `[[entities/openai]]`. Summaries keep their prefix: `[[summaries/foo]]`.
7. **Don't run `scan_semantic_duplicates` without the user asking.** It costs money.
8. **Don't fix `semanticDupe` issues without `preview: true` first.** Destructive — deletes files.
9. **Don't skip `get_index` on writes.** That's the #1 cause of broken links.
10. **Don't compose first and check links after.** Ground links during composition by referring to the index.

## §9 — Quick reference

For any user request, ask yourself:

```
Is the user READING the wiki?
  → §4 reading workflow
  → Start with get_graph_overview or search_wiki

Is the user WRITING to the wiki?
  → §5 writing workflow
  → Steps: domain check → get_index → ground links → compile_to_wiki (refuse mode on fresh domains)

Is the user MAINTAINING the wiki?
  → §6 maintenance workflow
  → scan_wiki_health → loop fix_wiki_issue (auto-fix simple, confirm risky, preview destructive)
```

For sample dialogues that show end-to-end flows for each scenario, see [examples.md](examples.md).
