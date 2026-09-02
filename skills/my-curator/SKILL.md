---
name: my-curator
description: Use when interacting with the user's My Curator second brain via the my-curator MCP. Activates for READ ("what does my wiki say about X", "what do I know about X", "search my notes", "deep research my second brain", "find every source that mentions Y", "what does our cohort wiki say"), WRITE ("save to my wiki", "remember this", "add this to my second brain", "compile our findings", "put this in my projects domain"), Shared Brain contribution ("save to our shared brain", "contribute to the cohort wiki"), and maintenance ("check my wiki", "find broken links", "scan for duplicate pages"). Enforces atomic decomposition (entities, concepts, summaries), grounds every wikilink in an existing slug before writing, refuses speculative links on fresh domains, respects per-domain siloing, and treats Shared Brain mirrors as read-only, routing contributions through the user's own opted-in domain. Always calls list_domains and get_index before composing any write.
allowed-tools: mcp__my-curator__list_domains mcp__my-curator__get_index mcp__my-curator__get_graph_overview mcp__my-curator__get_tags mcp__my-curator__search_wiki mcp__my-curator__search_cross_domain mcp__my-curator__get_node mcp__my-curator__get_connected_nodes mcp__my-curator__get_backlinks mcp__my-curator__get_summary mcp__my-curator__get_raw_source mcp__my-curator__get_working_state mcp__my-curator__compile_to_wiki mcp__my-curator__scan_wiki_health mcp__my-curator__fix_wiki_issue mcp__my-curator__scan_semantic_duplicates mcp__my-curator__get_health_dismissed mcp__my-curator__dismiss_wiki_issue mcp__my-curator__undismiss_wiki_issue mcp__my-curator__save_working_state
---

# My Curator — second brain playbook

This skill is the canonical playbook for working with the user's **My Curator** second brain through the **my-curator MCP**. The MCP exposes 20 tools — 12 for reading (the wiki graph plus your own prior working state), and 8 in the health/authoring group, of which 5 actually mutate something (`compile_to_wiki`, `fix_wiki_issue`, `dismiss_wiki_issue`, `undismiss_wiki_issue`, `save_working_state`). This playbook tells you how to use them well, in the order that produces the best results.

**Read the tool list you were actually given, not this paragraph.** Older Curator builds register fewer tools — `get_raw_source` needs v3.5.0+, and the two working-state tools need v3.17.0+, below which the count is 18. A tool that is absent is simply unavailable; everything else here still applies.

**On-demand companions** — do not read them up front; open one when its case arises:

| File | Open it when |
|---|---|
| [shared-brain.md](shared-brain.md) | a `shared-*` domain is involved, or the user mentions a cohort / team wiki |
| [maintenance.md](maintenance.md) | you are actually making Health calls — the call shapes, the orphan recipe, the clean-up script |
| [examples.md](examples.md) | you want a worked end-to-end dialogue |

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

**Dots can be READ but cannot be CREATED, and the asymmetry is real.** Pages with interior dots exist in real wikis — `entities/claude-sonnet-3.5.md` → `[[claude-sonnet-3.5]]`, `entities/express.js.md` → `[[express.js]]` — usually created by ingest. Every read tool accepts them: do not strip or rewrite the dot when calling `get_node`, `get_backlinks`, `get_summary` or `get_raw_source`, and never silently retarget one version to another. But `compile_to_wiki` validates an `additional_pages` slug against `^[a-z0-9][a-z0-9-]*$` — **hyphens and alphanumerics only** — so a dotted path is refused at the tool boundary with *"slug … must be lowercase alphanumeric with hyphens"*. If you need a page for `express.js` and it does not exist, create `express-js` and say what you did, or ask the user. Do not keep retrying the dotted form. (A leading dot, a trailing dot, `..`, spaces and accented characters are refused on **read** as well — if a slug from `search_wiki` comes back as "Invalid slug", that is why, and the answer is to tell the user, not to guess a nearby slug.)

`[[wikilinks]]` use **bare slugs** (no folder prefix) for entities and concepts. Summaries are the **one exception** — they keep their `summaries/` prefix because they live in a sibling folder Obsidian needs for routing. So: `[[openai]]` not `[[entities/openai]]`. But: `[[summaries/foo]]` not `[[foo]]` for summaries.

## §3 — Domain awareness

Before you do anything, know which domain you're working in.

1. **If the user named a domain** (`"add to my projects domain"`) → use it.
2. **If they said "my wiki" without naming one** → call `list_domains`. If exactly one domain exists, use it. If multiple exist, ask the user which one. Never guess.
3. **The user may have set a default domain** in the Curator app's Settings. If they did, MCP tools fall back to that automatically when you omit `domain`. But still confirm with the user when ambiguous.
4. **Domains are siloed.** Don't try to write a link from one domain to a page in another. If the user wants cross-domain synthesis, that's a `search_cross_domain` reading task — not a writing task.

### §3.1 — Shared Brain mirrors, in one paragraph

Some domains in `list_domains` are **Shared Brain mirrors** — named `shared-<slug>` (e.g. `shared-cohort`). They are local **read-only** copies of a collective wiki. **Reading one is unrestricted**: all twelve read tools work normally, and answering *"what does our cohort wiki say about X?"* by traversing a mirror is exactly what it is for. **Writing to one is refused**: all five mutating tools check the domain's `CLAUDE.md` for `readonly: true` and return an error telling you to call the tool on the user's personal opted-in domain instead, then run **Push contributions** from the app's **Shared Brain** view. The pure scans — `scan_wiki_health`, `scan_semantic_duplicates`, `get_health_dismissed` — are not guarded, correctly, because they only read. **Whenever a `shared-*` domain is in play, open [shared-brain.md](shared-brain.md)** for the contribution flow, the verbatim refusal text and the dialogue scripts.

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

**Step 0 — Check the target isn't a Shared Brain mirror.** If the domain starts with `shared-`, STOP and read [shared-brain.md](shared-brain.md) — redirect the write to the user's personal opted-in domain. A direct write to a `shared-*` mirror is refused with a clear error, but earlier rejection saves a round trip.

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
  "normalized": 1,       // variant auto-fixed (e.g. [[Curator]] → [[curator]])
  "broken": [...],       // these are the problem
  "broken_count": 1
}
```

If `broken_count > 0` and you used `'keep'`, decide: retry with corrections, or accept the broken link as a known TODO?

### The hard caps on one call, and the trap in splitting

`compile_to_wiki` validates before it writes anything, so an over-cap call costs you a round trip and produces nothing. **Every one of these is refused, not trimmed:**

| Limit | Value | What counts |
|---|---|---|
| Pages per call | **10 total, including the summary** — so at most **9** `additional_pages` | `additional_pages.length + 1 > 10` is refused |
| Bytes per page | **50 KB** | applies to `summary_content` and to each `additional_pages[].content`, measured as UTF-8 bytes |
| `summary_content` length | **60,000 characters** | a second, separate check from the byte cap |
| `title` length | **200 characters** | |
| Reserved paths | `index`, `log`, and the files `index.md`, `log.md`, `CLAUDE.md` | app-managed; refused |
| Folder | `entities/` or `concepts/` only, exactly `<folder>/<slug>.md` | `summaries/` is generated for you |

**The trap: splitting one source across two calls with the same title creates TWO summary pages.** The idempotency slug is `<slugified title>-<today>-<4 hex of a hash>`, and that hash is taken over the title **plus** `summary_content` **plus** every `additional_pages` path and content. So part 2 of a split hashes differently from part 1, produces a different slug, and lands as a second summary page for what the user thinks of as one source — permanently, and the re-compile guard will not catch it because nothing collided.

When a compile does not fit in ten pages, in order of preference:

1. **Cut to the nine pages that matter.** A wiki page for every noun mentioned is not the goal; the graph is worth more when its nodes are.
2. **Give each part a genuinely different title** — *"Q3 architecture review — part 1, storage"* / *"— part 2, transport"* — so the two summaries are honestly two summaries, and say so to the user.
3. **Never** send the same title twice expecting the pages to merge. They do not.

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

### The two refusals you will actually meet

- **Idempotency.** `compile_to_wiki` refuses a re-compile when title + content + date hash to the same slug: *"Already compiled to summaries/… Same content + title + date detected."* That is correct behaviour, not a bug. To extend a previous compile, add new content first — a changed corpus hashes to a new slug and proceeds normally.
- **`conflict: 'file_lock'`.** *"Another process is writing to <domain> right now"* means the Curator app is mid-ingest or mid-compile on that domain and holds the file lock; the MCP server is a separate process and shares the lock through a `.write-lock` file. **Nothing was written and nothing was lost.** Wait a moment and retry the **identical** call — it is safe to repeat, because a call that wrote nothing did not move the idempotency hash. Do not edit the payload to "get past" it, and do not tell the user their save failed; tell them the app is busy. Only if it persists for many minutes is the lock plausibly stale (it expires after 30 minutes), and then the fix is theirs, not yours.

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
| **Confirm with user first** | `brokenLinks` *without* a scanner target; orphans (via `orphanLink`) | Show the user, accept "fix" / "dismiss" / "leave for later", then act. |
| **ALWAYS preview, then confirm** | `semanticDupe` (destructive — deletes a file, rewrites links) | Call `fix_wiki_issue` with `preview: true` to get the diff plan; show the user; only on explicit confirmation call again with `preview: false`. |

Four rules that hold whatever you are fixing:

1. **Never invent a `suggestedTarget`.** Pass back the issue object `scan_wiki_health` gave you, unchanged. The scanner's `suggestedTarget` comes from deterministic slug normalisation; a target you reason your way to is a guess, and a wrong retarget writes a factually wrong link into **every** page that referenced it. Two traps that look convincing and are not — **version numbers** (`[[claude-sonnet-4.5]]` is not `claude-sonnet-3.5`; `[[q1-2025-results]]` is not `q1-2024-results`) and **negations** (`[[data-retained]]` is not `data-not-retained`; `[[sync-write]]` is not `async-write`).
2. **Never read `fixed: 0` as "already fine".** Only `link-not-present` and `link-already-present` mean the issue was already resolved; every other `reason` means nothing was written and the issue is still there. Do not report a clean sweep on the strength of one.
3. **`orphans` is a scan category and a dismissal type — it is not a `fix_wiki_issue` type.** `fix_wiki_issue` takes exactly seven types — `brokenLinks`, `folderPrefixLinks`, `crossFolderDupes`, `hyphenVariants`, `missingBacklinks`, `orphanLink`, `semanticDupe` — and passing `"orphans"` is rejected outright. Every one of those is **pass the scan object through unchanged** except `orphanLink`, which you must **compose**: the scanner emits `{path, type, slug}` and the fixer needs `{orphanSlug, targetSlug, description}`, where `targetSlug` is your judgement and therefore needs the user's agreement first.
4. **`scan_semantic_duplicates` costs money** (~$0.005–$0.03 per scan, it calls the LLM). Only run it when the user explicitly asks, and use `estimate_only: true` first to show the cost before committing.

**For the actual call shapes — the pass-through rule, the `orphanLink` recipe, the clean-up dialogue, dismissals, and Health on mirrors — open [maintenance.md](maintenance.md) before you start making Health calls.**

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
| `get_raw_source` | Pull the original document a summary was built from — verbatim text, never binary | Escalation only — exact quotes/figures. See §4.1 |
| `get_working_state` | Resume a previous session's handoff (brief, decisions, next steps, journal) | "carry on", "where did we leave off" — call first, before re-reading code |
| `compile_to_wiki` | Save findings as wiki pages | THE write tool — follow §5 |
| `scan_wiki_health` | Find structural issues | "Check my wiki" |
| `fix_wiki_issue` | Apply ONE Health fix | After scan, per issue |
| `scan_semantic_duplicates` | AI duplicate detection | Opt-in, paid, user-initiated only |
| `get_health_dismissed` | List previously dismissed | "What have I skipped?" |
| `dismiss_wiki_issue` | Permanently skip an issue | When user says "leave alone" |
| `undismiss_wiki_issue` | Restore a dismissal | When user changes their mind |
| `save_working_state` | Write this session's handoff for the next session to resume | Save early and often — after a decision settles, a trap is found, or a step completes |

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
5. **Don't split one source across two calls under the same title.** You get two summary pages, not one — cut to nine pages or give each part its own title (§5).
6. **Don't try to create a dotted slug.** Dots are readable, not creatable — use hyphens and say so (§2).
7. **Don't try to link across domains.** Domains are siloed.
8. **Don't use folder prefixes in wikilinks** for entities or concepts. `[[openai]]` not `[[entities/openai]]`. Summaries keep their prefix: `[[summaries/foo]]`.
9. **Don't run `scan_semantic_duplicates` without the user asking.** It costs money.
10. **Don't fix `semanticDupe` issues without `preview: true` first.** Destructive — deletes files.
11. **Don't skip `get_index` on writes.** That's the #1 cause of broken links.
12. **Don't compose first and check links after.** Ground links during composition by referring to the index.
13. **Don't compile to a `shared-*` mirror**, and **don't tell the user you added something to the shared brain** when you compiled to their personal domain. See [shared-brain.md](shared-brain.md).
14. **Don't treat `conflict: 'file_lock'` as a failure.** Nothing was written; wait and retry the identical call (§5).
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
  → 10 pages max INCLUDING the summary; one title = one summary page

Is the user MAINTAINING the wiki?
  → §6 maintenance workflow, then maintenance.md for the call shapes
  → scan_wiki_health → loop fix_wiki_issue (auto-fix simple, confirm risky, preview destructive)

Is a shared-* domain involved?
  → shared-brain.md — read freely, never write, redirect the contribution
```

For sample dialogues that show end-to-end flows for each scenario, see [examples.md](examples.md).
