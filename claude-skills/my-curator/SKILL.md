---
name: my-curator
description: Use when interacting with the user's My Curator second brain via the my-curator MCP. Activates for READ ("what does my wiki say about X", "deep research my second brain", "find every source that mentions Y", "what does our cohort wiki say"), WRITE ("save to my wiki", "compile our findings", "put this in my projects domain"), Shared Brain contribution ("save to our shared brain", "contribute to the cohort wiki"), and maintenance ("check my wiki", "find broken links", "scan for duplicate pages"). Enforces atomic decomposition (entities, concepts, summaries), grounds every wikilink in an existing slug before writing, refuses speculative links on fresh domains, respects per-domain siloing, and handles Shared Brain mirrors correctly (read-only locally; contributions go through the user's personal opted-in domain + Sync-tab Push). Always calls list_domains and get_index before composing any write.
allowed-tools: mcp__my-curator__list_domains mcp__my-curator__get_index mcp__my-curator__get_graph_overview mcp__my-curator__get_tags mcp__my-curator__search_wiki mcp__my-curator__search_cross_domain mcp__my-curator__get_node mcp__my-curator__get_connected_nodes mcp__my-curator__get_backlinks mcp__my-curator__get_summary mcp__my-curator__get_raw_source mcp__my-curator__get_working_state mcp__my-curator__compile_to_wiki mcp__my-curator__scan_wiki_health mcp__my-curator__fix_wiki_issue mcp__my-curator__scan_semantic_duplicates mcp__my-curator__get_health_dismissed mcp__my-curator__dismiss_wiki_issue mcp__my-curator__undismiss_wiki_issue mcp__my-curator__save_working_state
---

# My Curator — second brain playbook

This skill is the canonical playbook for working with the user's **My Curator** second brain through the **my-curator MCP**. The MCP exposes 20 tools — 12 for reading (the wiki graph plus your own prior working state), and 8 in the health/authoring group, of which 5 actually mutate something (`compile_to_wiki`, `fix_wiki_issue`, `dismiss_wiki_issue`, `undismiss_wiki_issue`, `save_working_state`). This playbook tells you how to use them well, in the order that produces the best results.

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

Slugs may also contain **interior dots** and underscores — `entities/claude-sonnet-3.5.md` → `[[claude-sonnet-3.5]]`, `entities/express.js.md` → `[[express.js]]`. Version numbers and hostnames are ordinary page names; do not strip or rewrite the dot when calling `get_node`, `get_backlinks`, `get_summary` or `get_raw_source`, and do not silently retarget one version to another. (A leading dot, a trailing dot, `..`, spaces and accented characters are refused — if a slug from `search_wiki` comes back as "Invalid slug", that is why, and the answer is to tell the user, not to guess a nearby slug.)

`[[wikilinks]]` use **bare slugs** (no folder prefix) for entities and concepts. Summaries are the **one exception** — they keep their `summaries/` prefix because they live in a sibling folder Obsidian needs for routing. So: `[[openai]]` not `[[entities/openai]]`. But: `[[summaries/foo]]` not `[[foo]]` for summaries.

## §3 — Domain awareness

Before you do anything, know which domain you're working in.

1. **If the user named a domain** (`"add to my projects domain"`) → use it.
2. **If they said "my wiki" without naming one** → call `list_domains`. If exactly one domain exists, use it. If multiple exist, ask the user which one. Never guess.
3. **The user may have set a default domain** in the Curator app's Settings. If they did, MCP tools fall back to that automatically when you omit `domain`. But still confirm with the user when ambiguous.
4. **Domains are siloed.** Don't try to write a link from one domain to a page in another. If the user wants cross-domain synthesis, that's a `search_cross_domain` reading task — not a writing task.

### §3.1 — Shared Brain mirror domains (the read/write contract)

Some domains in `list_domains` may be **Shared Brain mirrors** — named like `shared-<slug>` (e.g. `shared-cohort`, `shared-team`). These are local read-only copies of a collective wiki the user contributes to as part of a cohort, team, or research group (see [`docs/shared-brain-user-guide.md`](../../docs/shared-brain-user-guide.md) for the user-facing model).

**Reading a mirror is unrestricted.** All twelve read tools work normally on `shared-*` domains — `get_node`, `get_index`, `search_wiki`, `search_cross_domain`, `get_graph_overview`, `get_connected_nodes`, `get_backlinks`, `get_tags`, `get_summary`, `get_raw_source`, `get_working_state`, `list_domains`. This is where the cohort use cases get powerful: you can be asked *"across our shared brain, which papers contradict each other on X?"* and you answer by traversing the collective wiki.

**Writing to a mirror is refused.** All five *mutating* tools — `compile_to_wiki`, `fix_wiki_issue` (which is also where the `scan_semantic_duplicates` merge is applied, as `type=semanticDupe`), `dismiss_wiki_issue`, `undismiss_wiki_issue`, `save_working_state` — check the target domain's `CLAUDE.md` frontmatter for `readonly: true`. If true, they refuse with this exact error:

> *"Domain 'shared-cohort' is a read-only Shared Brain mirror. Direct writes here would not propagate to other contributors and would be overwritten on the next pull. To contribute, call this tool on your personal opted-in domain (e.g. 'work-ai'), then run 'Push contributions' from the Sync tab."*

`scan_wiki_health`, `scan_semantic_duplicates` and `get_health_dismissed` are **not** guarded, and that is correct — they only read. Scanning a mirror to answer *"is the collective wiki healthy?"* is supported; it is applying a fix that is refused.

### §3.2 — How to actually contribute to a Shared Brain via MCP

The user CAN add to a shared brain through this skill — just **indirectly**. Here's the full flow and where MCP fits in:

```
What you (Claude via MCP) do        Where it happens     What it does
─────────────────────────────       ──────────────       ────────────────────
1. compile_to_wiki                  MCP                  Saves pages to the
   target = PERSONAL                                     user's PERSONAL
   opted-in domain                                       opted-in domain (e.g.
   (NEVER shared-*)                                      'work-ai/'), not the
                                                         mirror.

2. Tell the user clearly:           Conversation         User now needs to
   "Pages are in <domain>.                               complete the loop in
   To push them to the                                   the Curator app.
   cohort wiki, click
   'Push contributions' in
   your Sync tab."

──────────────────────── steps below are NOT MCP-driven ────────────────────────

3. (User) opens Curator             Curator app          The local LLM
   Sync tab → clicks                                     pre-processes the
   "Push contributions"                                  changed pages into
                                                         DeltaSummaries and
                                                         uploads them to
                                                         shared storage.

4. (Admin) periodically runs        Curator app          Merge rules 1-5,
   "Run synthesis"                                       contradiction
                                                         resolution, Provenance
                                                         section, etc.
                                                         Rewrites the
                                                         collective wiki.

5. (Everyone) clicks                Curator app          The shared-<slug>/
   "Pull updates"                                        mirror domain on each
                                                         machine refreshes with
                                                         the new synthesised
                                                         pages.
```

**The MCP tools push/pull/synthesize are not exposed in v3.0.0-beta.1.** Steps 3-5 only happen via the Curator app's Sync tab. This is intentional: those operations consume LLM tokens (paid) and credentials (PAT); they should fire on explicit user action, not as a side-effect of "save this".

### §3.3 — Dialogue scripts for common user requests

When the user says one of these phrases, follow the matching script.

#### "Save this to our shared brain" / "Add to the cohort wiki"

1. **Identify the personal opted-in domain.** Call `list_domains` if you don't already know. Look for personal domains (NOT starting with `shared-`) — the user opted ONE of them into the shared brain. Typical names: `work-ai`, `work`, `cohort-contributions`, `research`. If multiple personal domains exist and it's unclear which feeds the shared brain, **ask the user**: *"You have personal domains `work-ai` and `research`. Which one feeds the shared brain you want me to contribute to?"*
2. **Compile to that personal domain** using the full §5 writing playbook (get_index → ground links → compile_to_wiki).
3. **Tell the user how the contribution reaches the cohort**: *"I've saved this to your `work-ai` domain. To make it appear in the shared brain for your cohort, open the Curator Sync tab and click **Push contributions**. The admin will then run synthesis (usually weekly) and everyone will see it on their next Pull."*

#### "What does our cohort wiki / shared brain say about X?"

This is a read on the mirror. Treat it like any other deep-research query on `shared-<slug>`:
- `get_graph_overview(domain="shared-cohort")` for orientation
- `search_wiki(domain="shared-cohort", query="X")` for retrieval
- `get_node(domain="shared-cohort", slug="...")` for full content
- All work normally. Cite specific slugs in your synthesis.

If the user wants to compare what the SHARED brain says vs what their PERSONAL brain says, use `search_cross_domain` — it'll query both at once.

#### "Check our shared brain for problems" / "Find broken links in the cohort wiki"

This is a Health scan on the mirror. Scanning is allowed:
- `scan_wiki_health(domain="shared-cohort")` works fine — returns the report.

But **fixing is refused** (Health fix tools would write to the mirror). Tell the user:
> *"Here's the scan: 12 broken links, 3 orphans. Fixing these directly would not propagate — the shared brain is rebuilt by synthesis from contributors' personal domains. To fix a broken link in the shared brain: ask the contributor whose personal page references that broken slug to update it, then push + synthesise. Or, if it's your own contribution that introduced the broken link, I can fix it in your `work-ai` domain right now — want me to?"*

#### "Push my contributions" / "Run synthesis" / "Pull updates"

These are NOT MCP operations in v3.0.0-beta.1. Tell the user:
> *"Push, Pull, and Run synthesis live in the Curator app's Sync tab — they're not exposed via MCP yet (planned for v3.x). Open the app → Sync tab → click the appropriate button. I can prepare the contribution by compiling to your personal domain first — want me to do that?"*

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
| **Verbatim / exact figure** | `get_summary` or `get_node` first, `get_raw_source` only on escalation | "What's the exact quote?" / "Check the actual source for that number." See §4.1 — this is the one pattern where reaching for the tool too early is a mistake, not a shortcut. |

### §4.1 — Compiled first, verbatim only on escalation

The wiki is compiled knowledge, not a retrieval index — every summary already distilled what mattered from its source. **Default to the wiki for everything.** `get_raw_source` (the original document a summary was built from, text-extracted) is an **escalation**, reached for only when the compiled version genuinely isn't enough:

- The user needs an **exact quote** or the author's own wording.
- The user needs a **precise figure** they'll be held to (a statistic, a date, a dollar amount) — don't launder an approximate number from a summary as if it were exact.
- The summary is silent on something you have specific reason to believe the source covers.

Do NOT reach for `get_raw_source` as your first move on a research question, and do not call it for every citation "just to be safe" — that defeats the reason a compiled wiki exists in the first place (see §1) and floods your own context with verbatim text the wiki already distilled for you.

Three things to know about the tool itself:

- **It never returns binary.** PDFs are text-extracted server-side; you get plain text, capped in size, with the response telling you when it was truncated.
- **"The original isn't on this machine" is a normal, expected answer — not an error.** Raw source files never sync (only wiki pages do), so on any machine other than the one that ingested a document — including right after the user pulls via Sync, or on a Shared Brain mirror — you'll be told the filename, size, and ingest date instead of the text. Report that plainly; it does not mean anything is broken or lost.
- **A `source:` that is a URL is reported as text, never fetched.** Some summaries record a web page instead of a local file. Don't attempt to retrieve it yourself — just relay what the tool returns.

### Cross-domain reasoning

`search_cross_domain` queries every domain at once. Use this when the user asks something like *"What patterns appear across both my articles and my projects domains?"*. The tool returns matches scoped per-domain — synthesise them in the conversation. **You cannot create persistent cross-domain links** — that's a fundamental property of the wiki architecture (see §3).

### The opening move that usually works

For a deep-research request, this two-step is almost always the right start:

1. `get_graph_overview(domain)` — orient yourself on hubs, clusters, orphan sample.
2. Based on what you see, decide which entities/concepts are worth `get_node` calls, then synthesise.

You don't need to enumerate everything. The wiki is large; reasoning over hubs and surfacing connections is the value.

## §5 — Writing workflow (adding knowledge)

This is the rule that produces ZERO broken links and ZERO duplicate pages. **Follow it every single time** the user asks you to save, add, compile, or update.

### The playbook

**Step 0 — Check the target isn't a Shared Brain mirror.** If the domain starts with `shared-`, STOP. Apply the §3.3 "Save this to our shared brain" script instead — redirect the write to the user's personal opted-in domain. Trying to write directly to a `shared-*` mirror will be refused with a clear error, but earlier rejection saves a round trip.

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

### Step 6 — If you are UPDATING an existing page, read it first

A write to an existing page is **not** fully non-destructive, and this is the single easiest way to
lose the user's work.

| Section kind | What happens on merge |
|---|---|
| Bullet sections — Key Facts, Key Ideas, Key Points, Key Takeaways, Related, Entities Mentioned, Concepts Introduced or Referenced, Applications, Examples | Genuinely accumulate. Existing bullets are kept, yours are added, duplicates are removed. Safe. |
| Prose sections — Definition, Summary, Why It Matters, Overview, anything else | **Your version REPLACES the existing one.** The existing prose is preserved *only* if your page omits that heading entirely. |

So when a page in `additional_pages` already exists:

- **Adding facts?** Send only the bullet sections. Omit the prose headings and the existing prose
  survives untouched. This is the safe default.
- **Genuinely rewriting the prose?** Call `get_node(domain, slug)` first, read what is there, and
  carry forward anything still true. Do not ship a one-line `## Definition` over a rich one.
- **Not sure whether the page exists?** It was in the index from step 2 — check.

Use `dry_run: true` when you are unsure. It shows which pages are creates and which are updates.

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
| **Auto-fix without asking** | `folderPrefixLinks`, `missingBacklinks`, `brokenLinks` *carrying a scanner-supplied* `suggestedTarget` | These have one clear right answer and remove no page. Call `fix_wiki_issue` for each, no confirmation needed. |
| **Say what disappears, then fix** | `crossFolderDupes`, `hyphenVariants` | These are **not** cosmetic: they merge two pages and **DELETE one of them** (inbound links are repointed to the survivor). Name the page that will disappear before you call. You do not need a preview round-trip, but the user must not learn a page was deleted afterwards. |
| **Confirm with user first** | `brokenLinks` *without* a scanner target; orphans (via `orphanLink` — see below) | Show the user, accept "fix" / "dismiss" / "leave for later", then act. See both rules below before you consider supplying a target yourself. |
| **ALWAYS preview, then confirm** | `semanticDupe` (destructive — deletes a file, rewrites links) | Call `fix_wiki_issue` with `preview: true` to get the diff plan; show the user; only on explicit confirmation call again with `preview: false`. |

**`orphans` is NOT a `fix_wiki_issue` type.** It is a scan category and a `dismiss_wiki_issue` type, and those are the only two places the word is accepted. `fix_wiki_issue` takes exactly seven types — `brokenLinks`, `folderPrefixLinks`, `crossFolderDupes`, `hyphenVariants`, `missingBacklinks`, `orphanLink`, `semanticDupe` — and passing `"orphans"` is rejected outright.

`orphanLink` is the one fixable type whose issue you must **compose rather than pass through**, and it is worth knowing exactly why: the scanner emits an orphan as `{path, type, slug}`, but the fixer needs `{orphanSlug, targetSlug, description}`. Forwarding the scan object unchanged is refused, because the scanner cannot know which page *ought* to link to the orphan — only you and the user can.

```
scan gives you:   { path: "concepts/lonely.md", type: "concept", slug: "lonely" }
the fixer needs:  { orphanSlug: "lonely", targetSlug: "<an existing page>", description: "<one clause>" }

fix_wiki_issue(domain, type="orphanLink", issue={
  orphanSlug:  "lonely",              # the scan entry's `slug`, verbatim
  targetSlug:  "knowledge-graphs",    # an EXISTING entity or concept — never a summary, never itself
  description: "a related idea",      # short prose for the bullet
})
```

Because `targetSlug` is your judgement and not the scanner's, treat it exactly like an invented `suggestedTarget`: **propose it to the user and get agreement before calling.** It writes `- [[orphanSlug]] — description` into the target's Related section. If no existing page is a genuine home, say so and leave the orphan alone — the app's bulk **✨ Rescue orphans** flow (Domains → the domain → Wiki health → Quick maintenance) plans them in one batch and previews before writing.

**Never invent a `suggestedTarget`.** Pass back the issue object `scan_wiki_health` gave you, unchanged. The scanner's `suggestedTarget` comes from deterministic slug normalisation; a target you reason your way to is a guess, and a wrong retarget writes a factually wrong link into **every** page that referenced it. Two traps that look convincing and are not:

- **Version numbers.** `[[claude-sonnet-4.5]]` is not `claude-sonnet-3.5`. `[[q1-2025-results]]` is not `q1-2024-results`. These read as near-identical and are different things.
- **Negations and opposites.** `[[data-retained]]` is not `data-not-retained`. `[[sync-write]]` is not `async-write`.

A `suggestedTarget` you compose is rejected outright unless it names a page that exists — and even then it is your guess, not the scanner's. For a broken link with no scanner target, the right move is to say so and leave the link alone, or tell the user about the app's bulk **✨ Fix broken links** flow (Domains → the domain → Wiki health → Quick maintenance), which plans the whole domain, previews it, and applies its own version/polarity safety gate before writing.

### The standard "clean up" dialogue

```
1. scan_wiki_health(domain)
2. Loop the auto-fixable ones via fix_wiki_issue
   — count a call as a success ONLY when it returns fixed: 1
3. List the review-only ones; ask the user one by one (or in batch)
4. For each user-approved fix → fix_wiki_issue
   — brokenLinks / folderPrefixLinks / crossFolderDupes / hyphenVariants /
     missingBacklinks: pass the scan object through unchanged
   — an ORPHAN: type="orphanLink" with a composed
     {orphanSlug, targetSlug, description}, target agreed with the user
5. For each user dismissal → dismiss_wiki_issue (persists across scans + machines)
   — this IS where type="orphans" is the correct value
```

**`type` is the scan CATEGORY, not a field on the issue.** `scan_wiki_health` returns issues grouped
under `brokenLinks`, `orphans`, `folderPrefixLinks`, `crossFolderDupes`, `hyphenVariants`,
`missingBacklinks` — and the individual objects do **not** carry that name. (A `folderPrefixLinks`
issue is just `{sourceFile, linkText}`; an `orphans` issue *does* have a `type` field, but it holds
the page kind — `"entity"` / `"concept"` — which is not a fixable issue type.) Pass the key you
found the issue under, and pass the issue object through unchanged:
`fix_wiki_issue(domain, type="folderPrefixLinks", issue=<the object>)`.

**The one exception is orphans**, per the block above: the scan category `orphans` is not a fixable
type, and the fixable type `orphanLink` takes a different object. Every other category is
pass-through.

**Never read `fixed: 0` as "already fine".** It has several causes and the response tells you which
one in a `reason` field, with the prose in `report`. Only `link-not-present` and
`link-already-present` mean the issue really had already been resolved. Everything else —
`target-not-found`, `orphan-fields-missing`, `no-suggested-target`, `orphan-not-found`, `self-link`,
`slug-shape-invalid`, `source-file-not-found` — means **nothing was written and the issue is still
there**; the `report` names the next action. Do not count such a call as a success, and do not
report a clean sweep to the user on the strength of it.

Persistent dismissals: `dismiss_wiki_issue` writes to a file synced across the user's machines. Items dismissed in a Claude Desktop conversation also disappear from the app's Wiki health panel; same store. Use `get_health_dismissed` to list previously skipped issues if the user asks.

### Semantic-duplicate scanning is paid

`scan_semantic_duplicates` calls the LLM with a small per-scan cost (~$0.005–$0.03). **Only run it when the user explicitly asks** — and use `estimate_only: true` first to show the cost before committing.

### Health on Shared Brain mirror domains

`scan_wiki_health` works fine on `shared-*` mirrors — you can show the user the report. But `fix_wiki_issue` is **refused** on mirrors: fixes wouldn't propagate to other contributors and would be overwritten on the next Pull. To resolve a Health issue in the shared brain, the contributor who introduced it must fix it in their personal opted-in domain, then Push + run synthesis. Tell the user this explicitly when their scan request targets a `shared-*` domain.

## §7 — Tool reference

| Tool | Purpose | When | Works on `shared-*` mirror? |
|---|---|---|---|
| `list_domains` | List domains | Always when domain is unclear | Yes (lists mirrors too) |
| `get_index` | Master page catalog | Always before any write | Yes |
| `get_graph_overview` | Topology snapshot | First move on a research task | Yes |
| `get_tags` | Tag inventory | Tag-driven cluster work | Yes |
| `search_wiki` | Ranked search in one domain | Specific topic lookup | Yes |
| `search_cross_domain` | Search across all domains | Cross-domain synthesis only (read) | Yes (treats mirrors as just another domain) |
| `get_node` | Full page with frontmatter | Detail pull on a known slug | Yes |
| `get_connected_nodes` | Neighborhood traversal | "How is X connected" | Yes |
| `get_backlinks` | Incoming-link list | "Every source that mentions X" | Yes |
| `get_summary` | Pull a summary page | When user references a specific source | Yes |
| `get_raw_source` | Pull the original document a summary was built from — verbatim text, never binary | Escalation only — exact quotes/figures. See §4.1 | Yes (usually reports the file isn't on this machine, since raw sources never sync) |
| `get_working_state` | Resume a previous session's handoff (brief, decisions, next steps, journal) | "carry on", "where did we leave off" — call first, before re-reading code | Yes (read-only) |
| `compile_to_wiki` | Save findings as wiki pages | THE write tool — follow §5 | **No — refused.** Redirect to personal opted-in domain per §3.3 |
| `scan_wiki_health` | Find structural issues | "Check my wiki" | Yes (read-only scan) |
| `fix_wiki_issue` | Apply ONE Health fix | After scan, per issue | **No — refused.** Fixes don't propagate from mirrors |
| `scan_semantic_duplicates` | AI duplicate detection | Opt-in, paid, user-initiated only | Yes (scan) but the merge path that would delete files is refused on mirrors |
| `get_health_dismissed` | List previously dismissed | "What have I skipped?" | Yes (read-only) |
| `dismiss_wiki_issue` | Permanently skip an issue | When user says "leave alone" | **No — refused** on mirrors |
| `undismiss_wiki_issue` | Restore a dismissal | When user changes their mind | **No — refused** on mirrors |
| `save_working_state` | Write this session's handoff for the next session to resume | Save early and often — after a decision settles, a trap is found, or a step completes | **No — refused.** Writes `domains/<project>/state/`, not the wiki, but the same mirror guard applies |

> **The two working-state tools have their own playbook.** This skill covers the WIKI —
> what knowledge to write and how to ground it. Carrying build state between sessions is a
> different discipline (when to save, what a handoff must contain, the writing standard) and
> lives in the `curator-continuity` skill. Install both if you code with the Curator; this
> skill alone is enough to call the tools, but not to use them well.
>
> The boundary that matters: a failure whose value is the PATTERN across incidents is
> KNOWLEDGE — compile it to a wiki page here, where it compounds and is graphed. Only the
> recent, scope-local tail belongs in working state, where the next save overwrites it.

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
11. **Don't compile to a `shared-*` mirror.** Always redirect to the user's personal opted-in domain (§3.3). The mirror's writes don't propagate and would be overwritten on the next Pull.
12. **Don't promise the user "I've added this to the shared brain"** when you've actually compiled to their personal domain. Be precise: *"Saved to your `work-ai` domain — it'll appear in the shared brain after you click **Push contributions** in the Sync tab and the admin runs synthesis."* The Push and synthesise steps aren't yours to do.
13. **Don't try to call a "push" or "synthesize" MCP tool.** They don't exist in v3.0.0-beta.1. Those operations live in the Curator app's Sync tab. If the user asks you to push, tell them how to do it themselves.
14. **Don't suggest fixing Health issues on a `shared-*` mirror.** Suggest the upstream fix (in the contributor's personal domain) and a Push + synthesise cycle.
15. **Don't reach for `get_raw_source` as your default.** The wiki is compiled knowledge — answer from `get_node`/`get_summary` first, and escalate to the raw source only for verbatim quotes, exact figures, or a real gap in the summary (§4.1). Reaching for it by default turns a compiled second brain back into a retrieval-at-query-time system.
16. **Don't treat "the original isn't on this machine" as an error.** Raw sources never sync — report the filename/date the tool gives you and move on.

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

---

## §10 — Version compatibility

**This skill targets Curator v3.0.0-beta.1 and later.** If you're working with The Curator, the following features are covered by this version of the skill:

- The 20 MCP tools (12 read + 8 in the write group, of which 5 mutate — list in §7)
- `get_raw_source` and the compiled-first/verbatim-on-escalation rule (§4.1) — requires Curator v3.5.0 or later; on an earlier version this tool simply won't be in the list, and every other reading pattern in §4 still works
- Shared Brain mirror domains (`shared-*`) — §3.1 read/write contract, §3.2 indirect-write model, §3.3 dialogue scripts
- Health on mirrors — scan allowed, fix refused (§6)
- Two-primitives model — invite token (metadata) vs PAT (per-contributor identity)

**Earlier Curator versions** (pre-v3.0.0-beta.1) didn't have Shared Brain at all. The mirror-domain logic still works — there simply won't be any `shared-*` domains to dispatch on. The skill is backward-compatible.

**Updating to a newer skill version**: just re-run the install commands in `docs/mcp-user-guide.md` — they overwrite the existing files in `~/.claude/skills/my-curator/` (Claude Code) or replace the project knowledge upload (Claude Desktop). Re-installation doesn't restart any conversation — edits take effect mid-session.
