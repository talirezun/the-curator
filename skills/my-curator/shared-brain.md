# Shared Brain — the indirect contribution model

Read this when the user mentions a cohort, a team wiki, a shared brain, or when
`list_domains` returns a domain named `shared-<slug>`. The one-paragraph contract that
governs every call is in [SKILL.md](SKILL.md) §3.1; this file is the detail.

## The read/write split, in full

A `shared-*` domain is a **local read-only mirror** of a collective wiki the user
contributes to as part of a cohort, team or research group (the user-facing model is in
`docs/shared-brain-user-guide.md`).

**Reading a mirror is unrestricted.** All twelve read tools work normally on `shared-*`
domains — `get_node`, `get_index`, `search_wiki`, `search_cross_domain`,
`get_graph_overview`, `get_connected_nodes`, `get_backlinks`, `get_tags`, `get_summary`,
`get_raw_source`, `get_working_state`, `list_domains`. This is where the cohort use cases
get powerful: you can be asked *"across our shared brain, which papers contradict each
other on X?"* and you answer by traversing the collective wiki.

**Writing to a mirror is refused.** All five *mutating* tools — `compile_to_wiki`,
`fix_wiki_issue` (which is also where the `scan_semantic_duplicates` merge is applied, as
`type=semanticDupe`), `dismiss_wiki_issue`, `undismiss_wiki_issue`, `save_working_state` —
check the target domain's `CLAUDE.md` frontmatter for `readonly: true`. If true, they
refuse with this error, quoted verbatim from the code:

> *"Domain 'shared-cohort' is a read-only Shared Brain mirror. Direct writes here would not
> propagate to other contributors and would be overwritten on the next pull. To contribute,
> call this tool on your personal opted-in domain (e.g. 'work-ai'), then run "Push
> contributions" from the Shared Brain view."*

`scan_wiki_health`, `scan_semantic_duplicates` and `get_health_dismissed` are **not**
guarded, and that is correct — they only read. Scanning a mirror to answer *"is the
collective wiki healthy?"* is supported; it is applying a fix that is refused.

## How a contribution actually reaches the cohort

The user CAN add to a shared brain through this skill — just **indirectly**. Here is the
full flow and where MCP fits in:

```
What you do over MCP                Where it happens     What it does
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
   the Shared Brain view."

──────────────────────── steps below are NOT MCP-driven ────────────────────────

3. (User) opens Curator             Curator app          The local LLM
   Shared Brain view →                                   pre-processes the
   clicks "Push contributions"                           changed pages into
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

**There are no push/pull/synthesize MCP tools — that has been true in every release so
far.** Steps 3-5 only happen in the Curator app's **Shared Brain** view. This is
intentional: those operations consume LLM tokens (paid) and credentials (a PAT); they
should fire on explicit user action, not as a side-effect of "save this".

## Dialogue scripts

When the user says one of these phrases, follow the matching script.

### "Save this to our shared brain" / "Add to the cohort wiki"

1. **Identify the personal opted-in domain.** Call `list_domains` if you do not already
   know. Look for personal domains (NOT starting with `shared-`) — the user opted ONE of
   them into the shared brain. Typical names: `work-ai`, `work`, `cohort-contributions`,
   `research`. If multiple personal domains exist and it is unclear which feeds the shared
   brain, **ask the user**: *"You have personal domains `work-ai` and `research`. Which one
   feeds the shared brain you want me to contribute to?"*
2. **Compile to that personal domain** using the full SKILL.md §5 writing playbook
   (`get_index` → ground links → `compile_to_wiki`).
3. **Tell the user how the contribution reaches the cohort**: *"I've saved this to your
   `work-ai` domain. To make it appear in the shared brain for your cohort, open the
   Curator app's **Shared Brain** view and click **Push contributions**. The admin will
   then run synthesis (usually weekly) and everyone will see it on their next Pull."*

### "What does our cohort wiki / shared brain say about X?"

This is a read on the mirror. Treat it like any other deep-research query on
`shared-<slug>`:

- `get_graph_overview(domain="shared-cohort")` for orientation
- `search_wiki(domain="shared-cohort", query="X")` for retrieval
- `get_node(domain="shared-cohort", slug="...")` for full content
- All work normally. Cite specific slugs in your synthesis.

If the user wants to compare what the SHARED brain says against what their PERSONAL brain
says, use `search_cross_domain` — it queries both at once.

### "Check our shared brain for problems" / "Find broken links in the cohort wiki"

This is a Health scan on the mirror. Scanning is allowed — `scan_wiki_health(domain="shared-cohort")`
works fine and returns the report. But **fixing is refused**, because fixes would not
propagate and would be overwritten on the next Pull. Tell the user:

> *"Here's the scan: 12 broken links, 3 orphans. Fixing these directly would not propagate
> — the shared brain is rebuilt by synthesis from contributors' personal domains. To fix a
> broken link in the shared brain: ask the contributor whose personal page references that
> broken slug to update it, then push + synthesise. Or, if it's your own contribution that
> introduced the broken link, I can fix it in your `work-ai` domain right now — want me
> to?"*

### "Push my contributions" / "Run synthesis" / "Pull updates"

These are not MCP operations, in any release. Tell the user:

> *"Push, Pull, and Run synthesis live in the Curator app's **Shared Brain** view — they're
> not exposed via MCP. Open the app → Shared Brain → click the appropriate button. I can
> prepare the contribution by compiling to your personal domain first — want me to do
> that?"*

## The two rules that are easiest to break

- **Don't compile to a `shared-*` mirror.** Always redirect to the user's personal opted-in
  domain. The mirror's writes do not propagate and would be overwritten on the next Pull.
- **Don't promise the user "I've added this to the shared brain"** when you have actually
  compiled to their personal domain. Be precise: *"Saved to your `work-ai` domain — it'll
  appear in the shared brain after you click **Push contributions** in the Shared Brain
  view and the admin runs synthesis."* The Push and synthesise steps are not yours to do.

A worked end-to-end contribution dialogue is Example 5 in [examples.md](examples.md).
