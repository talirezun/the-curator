# My Curator — sample dialogues

Worked end-to-end examples showing how the playbook in [SKILL.md](SKILL.md) plays out. Six scenarios, covering deep research, fresh-domain compile (the strictest mode), compounding into an established domain, maintenance, Shared Brain contribution, and escalating from a summary to its original source.

---

## Example 1 — Deep research (read-only)

The user wants a synthesis that touches multiple domains. No writes.

> **User:** *"Across my `articles` and `business` domains, find every page that touches AI agents in enterprise software, group them by source, and identify the three biggest open questions."*

**Step 1 — Cross-domain query.**

```
search_cross_domain(query="AI agents enterprise software")
```

Returns ranked matches per domain. You see clusters in both `articles` (research papers, LLM deployment patterns) and `business` (case studies on enterprise pilots).

**Step 2 — Topology check on the larger domain.**

```
get_graph_overview(domain="articles")
```

Confirms `[[ai-agent-orchestration]]` and `[[agentic-workflows]]` are central hubs in `articles`. You decide those plus the top business cluster are worth pulling.

**Step 3 — Targeted retrieval.**

```
get_node(domain="articles", slug="ai-agent-orchestration")
get_node(domain="articles", slug="agentic-workflows")
get_backlinks(domain="articles", slug="ai-agent-orchestration")
get_node(domain="business", slug="enterprise-llm-pilots")
```

**Step 4 — Synthesise in the conversation.** Cite specific pages by slug. Identify the open questions from gaps you noticed during traversal (e.g. "no page yet on cost-control patterns at scale").

**Step 5 — Offer next steps.** *"If you'd like, I can compile this synthesis as a permanent summary. Which domain — `articles` or a new `research-notes` domain?"*

**Key moves**
- `search_cross_domain` for the initial sweep — read-only, no persistent cross-domain links created.
- `get_graph_overview` to orient before drilling.
- Targeted `get_node` and `get_backlinks` rather than enumerating everything.
- Synthesis cites slugs the user can cross-check.

---

## Example 2 — Fresh-domain compile (strict mode)

The user has been researching a new project and wants the conclusions saved into a fresh, mostly-empty domain.

> **User:** *"Based on our discussion of the Lumina Pro project, generate a detailed summary and save it to my second brain in the `projects` domain. Be careful with structure and avoid broken links."*

**Step 1 — Confirm the domain exists.**

```
list_domains()
```

Returns `["articles", "business", "projects", "research"]`. `projects` is named — proceed.

**Step 2 — Inventory the existing wiki.**

```
get_index(domain="projects")
```

Returns ~6 pages — fresh domain. Note them: `entities/lumina-ai.md`, `concepts/agentic-coding.md`, etc.

**Step 3 — Compose with grounded links.** As you draft the summary, every `[[wikilink]]` must reference (a) one of the 6 existing slugs, or (b) a slug you'll create in `additional_pages`.

You decide the summary will introduce three new concepts (`[[multi-agent-orchestration]]`, `[[ai-tool-routing]]`, `[[enterprise-deployment-patterns]]`) and reference one new entity (`[[lumina-pro]]`). They go in `additional_pages`. Other concepts you mention are written as plain prose without brackets.

**Step 4 — Strict-mode call.** Fresh domain → use `'refuse'`:

```
compile_to_wiki({
  domain: "projects",
  title: "Lumina Pro — Project Research Summary",
  summary_content: "## Key Takeaways\n- ...\n## Concepts Introduced or Referenced\n- [[multi-agent-orchestration]] — ...\n- [[lumina-ai]] — already exists, references the umbrella project\n## Entities Mentioned\n- [[lumina-pro]] — ...",
  additional_pages: [
    { path: "entities/lumina-pro.md", content: "..." },
    { path: "concepts/multi-agent-orchestration.md", content: "..." },
    { path: "concepts/ai-tool-routing.md", content: "..." },
    { path: "concepts/enterprise-deployment-patterns.md", content: "..." },
  ],
  broken_link_policy: "refuse",
})
```

**Step 5 — Inspect the response.**

If `ok: true` — done. Show the change report to the user.

If `ok: false` with `error: "N broken wikilinks detected..."` — read the `broken` array and `valid_slugs_sample`. Two paths:

- **The broken slugs SHOULD have been new pages** → add them to `additional_pages` and retry.
- **The broken slugs are real typos** (you wrote `[[OpenAI]]` instead of `[[openai]]`) → fix the wikilinks in `summary_content` and retry.

The retry loop typically converges in 1–2 calls and produces a wiki with **zero broken links**.

> **You (after success):** *"Saved to your `projects` domain — created the Lumina Pro summary, plus 4 new concept/entity pages. Updated 2 existing pages (`[[lumina-ai]]` got a backlink, the index was refreshed). All 14 wikilinks resolved cleanly."*

**Key moves**
- Strict `'refuse'` mode on a fresh domain prevents broken-link inflation.
- Every wikilink grounded against either the index or `additional_pages`.
- The retry loop is fast because the response includes `valid_slugs_sample`.

---

## Example 3 — Compound into an established domain

The user wants to add findings to a domain that already has hundreds of pages. The risk here isn't broken links — it's accidentally creating a duplicate of something that exists.

> **User:** *"Add a summary of our discussion about RAG vs fine-tuning to my `articles` second brain."*

**Step 1 — Domain confirmed in the request.**

**Step 2 — Inventory.**

```
get_index(domain="articles")
```

Returns 2000+ rows. You scan for relevant slugs — you already see `[[rag]]`, `[[fine-tuning]]`, `[[retrieval-augmented-generation]]`, `[[llm-customization]]`, etc.

**Step 3 — Disambiguate variant slugs.** You spot `[[rag]]` AND `[[retrieval-augmented-generation]]` in the index. They're probably semantic duplicates the user will eventually merge — but for now, pick the one that has more content. Quick `search_wiki(domain="articles", query="rag")` confirms `[[rag]]` is the established hub. Use that one.

**Step 4 — Compose with the existing slugs.** No new pages this time — every concept you mention already has a page. So `additional_pages` is empty; the summary just references existing slugs:

```
compile_to_wiki({
  domain: "articles",
  title: "RAG vs Fine-Tuning Discussion 2026-04-27",
  summary_content: "## Key Takeaways\n...\n## Concepts Introduced or Referenced\n- [[rag]]\n- [[fine-tuning]]\n- [[llm-customization]]\n...",
  // no additional_pages — every link references existing slugs
  broken_link_policy: "keep",  // default; populated domain
})
```

**Step 5 — Verify the response.**

`links: { total: 8, resolved: 7, normalized: 1, broken_count: 0 }` — clean. The `normalized: 1` means one slug variant got auto-fixed (e.g. you wrote `[[Rag]]`, it became `[[rag]]`). No broken links.

The change panel shows: 1 new page (the summary), 8 updated pages (each referenced entity/concept got a backlink to the new summary), 1 updated index.

> **You:** *"Compiled into `articles`. New summary created; 8 existing pages picked up backlinks. No broken links, no duplicates introduced. Want me to read the summary back?"*

**Key moves**
- `get_index` first to spot variant slugs (e.g. `[[rag]]` vs `[[retrieval-augmented-generation]]`).
- Use `search_wiki` for confidence on which variant is canonical.
- Empty `additional_pages` — no new pages because everything already exists.
- `'keep'` policy is fine on populated domains; the response confirms zero broken.

---

## Example 4 — Maintenance / cleanup

The user wants to clean up a domain that has accumulated cruft.

> **User:** *"Clean up my `articles` second brain. Auto-fix what's safe and ask me about the rest."*

**Step 1 — Scan.**

```
scan_wiki_health(domain="articles")
```

Returns counts:
- 12 `folderPrefixLinks` (auto-fixable)
- 8 `hyphenVariants` (auto-fixable)
- 3 `crossFolderDupes` (auto-fixable)
- 5 `missingBacklinks` (auto-fixable)
- 14 `brokenLinks` with `suggestedTarget` (auto-fixable)
- 23 `brokenLinks` without target (review-only)
- 47 `orphans` (review-only)

**Step 2 — Auto-fix the safe ones.** Loop over the auto-fixable categories:

The `type` argument is the **scan category name** — the key the issue arrived under in the
`scan_wiki_health` response. Individual issue objects do **not** carry it: a `folderPrefixLinks`
issue is `{sourceFile, linkText}`, and an `orphans` issue's own `type` field is the *page kind*
(`"entity"` / `"concept"`), not the issue category. Passing `issue.type` therefore sends
`undefined` (or an unfixable value) and every call is rejected. Iterate over the categories:

```
for category in ("folderPrefixLinks", "hyphenVariants", "crossFolderDupes", "missingBacklinks"):
    for issue in scan[category]:
        fix_wiki_issue(domain="articles", type=category, issue=issue)

for issue in scan["brokenLinks"]:
    if issue.suggestedTarget:                      # only these are auto-fixable
        fix_wiki_issue(domain="articles", type="brokenLinks", issue=issue)
```

Count a call as a success **only when it comes back `fixed: 1`**. A `fixed: 0` response carries a
`reason`, and most reasons mean nothing was written and the issue is still there — only
`link-not-present` / `link-already-present` mean it had genuinely been resolved already. Reporting
refusals as fixes is how a "clean sweep" gets announced over an untouched wiki.

Then report to the user: *"Fixed 42 issues automatically across 38 files."*

**Step 3 — Review-only items: ask the user.**

> *"60 review-only issues remain: 23 broken links without good auto-fix targets, and 47 orphans. Want to walk through them, batch-dismiss obvious ones, or use AI suggestions where available?"*

The user replies. For broken links without targets, you can also try:

```
ai-suggest path  // (existing in-app feature; equivalent here is offering to call list_domains/search to find a likely target manually)
```

For orphans, the *batch* AI rescue is an in-app feature, not exposed over MCP. Tell the user honestly: *"For bulk orphan rescue, the app has a ✨ Rescue orphans action in a domain's Wiki health panel — it plans all 47 in one batch and previews the plan before writing. From here I can link them one at a time if you tell me where each belongs, dismiss the ones you want skipped, or note them for later."*

Linking one orphan by hand goes through `fix_wiki_issue` with **`type="orphanLink"`** — not `"orphans"`, which is a scan category and a dismissal type but not a fixable type. It is the one case where you compose the issue instead of forwarding the scan object, because the scanner emits `{path, type, slug}` and the fixer needs a target it cannot know:

```
# scan gave you: { path: "concepts/lonely.md", type: "concept", slug: "lonely" }
# you ask the user: "Should [[lonely]] be linked from [[knowledge-graphs]]?"  → they agree

fix_wiki_issue(domain="articles", type="orphanLink", issue={
    "orphanSlug":  "lonely",             # the scan entry's `slug`, verbatim
    "targetSlug":  "knowledge-graphs",   # an EXISTING entity/concept, never a summary
    "description": "a related idea",
})
```

Forwarding the scan object unchanged here returns `fixed: 0` with `reason: "orphan-fields-missing"` — a refusal, not a fix. Never batch this without asking: `targetSlug` is your judgement, and 47 unasked guesses is 47 wrong edges.

**Step 4 — Process user decisions.** For each:
- *"fix it"* → `fix_wiki_issue` — pass the scan object through for every type **except** an orphan, which needs the composed `orphanLink` shape above
- *"dismiss it"* → `dismiss_wiki_issue` (syncs across machines + the app's Wiki health panel) — here `type="orphans"` **is** correct, with the scan object unchanged
- *"leave for later"* → no action, will resurface on next scan

**Step 5 — Optional: semantic duplicates.**

> *"I noticed in the index `[[rag]]` and `[[retrieval-augmented-generation]]` likely describe the same concept. Want to run a semantic-duplicate scan? It costs ~$0.005–$0.03 per scan; I can show you the estimate first."*

Only run `scan_semantic_duplicates` after explicit user approval. Use `estimate_only: true` first to show the cost.

For each pair the scan returns: call `fix_wiki_issue` with `type='semanticDupe'`, `preview: true` first → show the diff plan to the user → only on confirmation call again with `preview: false`.

**Key moves**
- Auto-fix the unambiguous categories without asking.
- Confirm with the user before destructive or judgement-call fixes.
- Use `dismiss_wiki_issue` for "leave alone" — it persists across scans + machines.
- `semantic-duplicate` is opt-in, paid, and **always** preview-then-confirm.

---

## Example 5 — Contributing to a Shared Brain (Curator v3.0.0-beta.1+)

The user is a contributor in a cohort and wants Claude to save research findings to the cohort's shared wiki.

> **User:** *"This is great. Save what we just discussed about context engineering — and put it in our shared brain, not my personal notes."*

Claude has been chatting about context engineering with the user. There's a clear set of findings worth persisting. The user is asking for a contribution to a Shared Brain (signal: "our shared brain", "not my personal notes").

**Step 1 — Identify the personal opted-in domain.** Per §3.3, Claude needs to know which personal domain feeds the shared brain. Call `list_domains`:

```
list_domains()
```

Returns: `['personal', 'work-ai', 'journal', 'shared-cohort']`.

The `shared-cohort` is a mirror (read-only). The others are personal. Claude doesn't know which personal domain is opted in — that mapping lives in the user's `.sharedbrain-config.json`, not exposed via MCP. So Claude asks:

> **Claude:** *"You have three personal domains (`personal`, `work-ai`, `journal`) and one shared mirror (`shared-cohort`). Which personal domain is the one you opted into the cohort brain? Usually it's the one you were asked to contribute when you joined the cohort — for ML cohorts it's typically `work-ai`."*
>
> **User:** *"Yeah, `work-ai`."*

**Step 2 — Inventory `work-ai` before composing.** Apply the §5 writing playbook:

```
get_index(domain="work-ai")
```

Read the existing slugs. Claude sees `entities/anthropic.md` exists but `entities/context-engineering.md` doesn't, and `concepts/agentic-workflows.md` exists. So Claude will:
- Use `[[anthropic]]` (existing slug)
- Use `[[agentic-workflows]]` (existing slug)
- Create `[[context-engineering]]` as a new entity page via `additional_pages`

**Step 3 — Compile to the PERSONAL domain (NOT the mirror).**

```
compile_to_wiki(
  domain="work-ai",                              ← personal opted-in domain
  title="Context Engineering — March 2026 review",
  summary_content="...",                          ← grounded links throughout
  additional_pages=[
    {path: "entities/context-engineering.md", content: "..."}
  ],
  broken_link_policy="keep"                       ← established domain, 'keep' is fine
)
```

The response's `links` field shows `broken_count: 0` — all links grounded. ✓

**Step 4 — Tell the user precisely how the contribution reaches the cohort.**

> **Claude:** *"Saved to your `work-ai` domain: one summary + one new entity page (`context-engineering.md`). To make this appear in the cohort's shared brain:*
>
> *1. Open the Curator app → Sync tab*
> *2. In the Shared Brains section, on your cohort's connection card, click **Push contributions***
> *3. The admin will run synthesis (usually weekly) — your contribution will then show up in everyone's `shared-cohort` mirror on their next Pull*
>
> *I can't trigger the Push myself — that step lives in the Curator app, not MCP, in v3.0.0-beta.1. (It's a future roadmap item.) Anything else you want me to add to your `work-ai` domain before you push?"*

The user clicks Push themselves. A week later when the admin synthesises, the contribution lands in every cohort member's `shared-cohort` mirror as a synthesised collective page with Claude attributed in the Provenance section (under the user's UUID or display name, per the cohort's attribution settings).

**Key moves**
- Never compile to a `shared-*` mirror — those writes are refused at the tool level AND would be overwritten on next Pull.
- `list_domains` distinguishes personal (no `shared-` prefix) from mirror (`shared-` prefix). Ask the user which personal domain feeds the shared brain when ambiguous.
- After compiling, be PRECISE in the wrap-up: *"saved to your personal domain"* — not *"saved to the shared brain"*. Mention the manual Sync-tab Push step. Don't promise something MCP can't do.
- For "what does our cohort brain say about X?" requests (the read direction), all read tools work directly on the `shared-cohort` mirror — no detour through personal domain needed.

---

## Example 6 — Escalating to the original source (Curator v3.5.0+)

The user is citing a figure from the wiki and wants to be sure it's exact before it goes in front of someone else.

> **User:** *"What does my `articles` wiki say about the water usage of a single ChatGPT query? I need the exact number for a slide, not a rounded one."*

**Step 1 — Answer from the wiki first, as always.**

```
search_wiki(domain="articles", query="ChatGPT water usage per query")
get_node(domain="articles", slug="the-energy-and-water-footprint-of-generative-ai")
```

The summary states a figure, attributed to a specific paper.

**Step 2 — This is the escalation case, not the default case.** The user explicitly said "exact number, not rounded" — for a slide, a number they'll be held to. Per SKILL.md §4.1, that's exactly when `get_raw_source` is the right call, not routine.

```
get_raw_source(domain="articles", slug="the-energy-and-water-footprint-of-generative-ai")
```

Two possible outcomes:

- **Found.** The response returns extracted text (never binary). Locate the exact sentence with the figure and quote it precisely, citing that it's from the original paper rather than the wiki's summary.
- **Not found on this machine.** Perfectly normal — raw sources never sync. The response still tells you the original filename and when it was ingested. Say so plainly: *"The wiki's summary gives [the figure], sourced from `[filename]` (ingested [date]) — but the original file isn't on this machine (raw sources don't sync across computers), so I can't quote it verbatim. The summary's number is the most precise figure I have access to right now."*

**Key moves**
- Don't call `get_raw_source` on the first pass of an ordinary question — only because the user specifically needs verbatim accuracy.
- Never treat "not found" as a dead end or an error — report what IS known (filename, date) and move on.
- If the tool returns a `truncation_notice`, don't assume the rest of the document lacks what you're looking for — say you only saw the first part.

---

## Quick decision tree

When the user makes a request, ask:

```
"What does my wiki say about X?"          → §4 reading workflow (Example 1)
"I need the exact quote/figure, not a summary" → §4.1 escalation to get_raw_source (Example 6)
"Save this to my <fresh> domain"          → §5 writing workflow, refuse mode (Example 2)
"Save this to my <established> domain"    → §5 writing workflow, keep mode (Example 3)
"Check / clean up / find problems in my wiki" → §6 maintenance workflow (Example 4)
"Save this to our shared brain"           → §3.2/§3.3 indirect-write model (Example 5)
```

If the request mixes patterns (e.g. *"Research X and save the conclusions"*), do them in order — research first, then ask the user to confirm before the write phase.
