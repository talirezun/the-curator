# My Curator — Private MCP Bridge

> **Version 2.3.0+** · Local-only · macOS tested

**My Curator** is your private bridge between the Curator wiki and Claude Desktop (or any MCP-compatible LLM client). It lets frontier models — Opus, Sonnet — do deep research against your local second brain without uploading anything to the cloud.

This is a *personal* MCP: it reads only your local wiki folder, nothing more, and no one else can connect to it. Think of it as an extra window into the same knowledge that Obsidian renders as a graph — except the reader is a frontier LLM.

---

## Why this matters (the elevator pitch)

For most second-brain users, the loop is: ingest → admire the Obsidian graph → use the local Chat tab for everyday lookups. That's already useful. But the graph is something you *look at*. The synapses — the actual connections between thousands of knowledge nodes accumulated over years — are mostly invisible to you while you're inside the graph.

My Curator changes that. From the moment you connect Claude Desktop (with **Opus** or **Sonnet**) to your wiki via MCP, your second brain is **a prompt away** for a frontier model. Not as raw text. As a **graph** — with topology, tags, and bidirectional backlinks all exposed as first-class structured data.

This is what unlocks deep research:

- *"What ideas in my AI domain have I never explicitly connected to my business strategy domain?"* → the model traverses both graphs and surfaces the intersections.
- *"For my white paper on organisational resilience, pull every entity tagged `crisis-response` across all domains and build a citation skeleton."* → graph search + tag query + multi-page synthesis in one turn.
- *"Across my last six months of journal entries, identify recurring patterns I haven't named yet — citing the entries each pattern shows up in."* → the model finds patterns *you* missed, with sources.

Most "AI for personal knowledge" tools are RAG wrappers — they re-derive answers from raw files at query time and forget afterwards. Nothing compounds. Nothing traverses. My Curator inverts that: ingest builds a **persistent, graph-shaped** structure during writing, and MCP exposes that graph at read time so a frontier model can reason against it like an analyst querying a database.

That's the difference between *"I have a folder of notes"* and *"I have a queryable, compounding extension of my own thinking that any frontier model can reason against on demand."* Everything stays on your machine.

---

## What it does

My Curator exposes **twenty tools** to Claude Desktop — twelve read tools that explore your knowledge graph and your own prior working state, and eight health/authoring tools (v2.5.2+) that let Claude maintain and *update* the wiki on your behalf. Five of those eight actually change anything on disk (`compile_to_wiki`, `fix_wiki_issue`, `dismiss_wiki_issue`, `undismiss_wiki_issue`, `save_working_state`); the other three only scan and report.

### Read tools (since v2.3.0)

| Tool | Purpose |
|---|---|
| `list_domains` | Show available knowledge domains |
| `get_index` | Browse a domain's full page catalog |
| `get_graph_overview` | Compact topology snapshot: stats, top hubs, orphans, top tags |
| `get_tags` | Tag inventory (top 50 by default; filter for specifics) |
| `search_wiki` | Ranked search enriched with tags + link counts |
| `search_cross_domain` | Search across every domain at once |
| `get_node` | Fetch a page with frontmatter, outgoing links, backlinks |
| `get_connected_nodes` | Multi-hop graph traversal |
| `get_backlinks` | Find every page that links TO a given page |
| `get_summary` | Pull a source summary page |
| `get_raw_source` | Retrieve the *original* document a summary was built from — extracted text, never binary (v3.5.0) |
| `get_working_state` | Resume a previous session's handoff — brief, decisions, next steps, journal — possibly left by a different tool, model, or machine |

### Write tools (v2.5.2+)

| Tool | Purpose |
|---|---|
| `compile_to_wiki` | Save a research session, brainstorm, or set of findings as permanent wiki pages |
| `scan_wiki_health` | Find structural issues — broken links, orphans, duplicate entities, missing backlinks |
| `fix_wiki_issue` | Apply one Health repair (auto-fix safe ones, confirm destructive ones) |
| `scan_semantic_duplicates` | Opt-in, cost-gated AI scan that finds same-concept-different-slug pages |
| `get_health_dismissed` | List previously-skipped Health issues |
| `dismiss_wiki_issue` | Permanently silence an issue so it stops surfacing on future scans |
| `undismiss_wiki_issue` | Restore a dismissed issue |
| `save_working_state` | Write this session's handoff (Track 7) so the next session — possibly a different tool, model, or machine — can resume cold |

The key idea: a frontier model doesn't just *read* your wiki — it can *traverse* it AND *grow* it. Hubs, clusters, tags, and bidirectional links are exposed as first-class structured data, so the model can reason about your knowledge as a graph; and the write tools mean a research session in Claude Desktop can end with the conclusions saved permanently — no need to switch to The Curator app to commit them.

### Write tools on Shared Brain mirrors (`v3.0.0-beta+`)

When you join a Shared Brain (see [`docs/shared-brain.md`](shared-brain.md)), the collective wiki appears on your machine as a `shared-<slug>` domain. **The five mutating tools — `compile_to_wiki`, `fix_wiki_issue`, `dismiss_wiki_issue`, `undismiss_wiki_issue`, `save_working_state` — refuse on these mirrors** with a clear steer:

> *"Domain 'shared-cohort' is a read-only Shared Brain mirror. Direct writes here would not propagate to other contributors and would be overwritten on the next pull. To contribute, call this tool on your personal opted-in domain (e.g. 'work-ai'), then run 'Push contributions' from the Sync tab."*

> That refusal message is quoted verbatim from the code, and its last few words are now out of date: since the v3.9.0 cutover, **Push contributions** lives in the **Shared Brain** rail view, not in Sync. The refusal itself is correct — only the signpost at the end of it is stale.

Read tools (`get_node`, `search_wiki`, `get_index`, etc.) work normally on mirror domains — Claude can freely research across them. So do the three read-only members of the health/authoring group (`scan_wiki_health`, `scan_semantic_duplicates`, `get_health_dismissed`): scanning a mirror to answer *"is the collective wiki healthy?"* is supported, and it is only *applying* a fix that is refused. The MCP skill at `claude-skills/my-curator/SKILL.md` documents this in §3.1.

### Write tools while the Curator app is running an ingest (`v3.0.1-beta.8+`)

When the Curator desktop app has an ingest, compile, or bulk-Health-fix mid-flight on a domain, `compile_to_wiki` and `fix_wiki_issue` refuse with a clear message and `conflict: 'file_lock'`. Coordination is via a tiny lock file at `<domain>/.write-lock` (JSON containing the PID + start time + operation name), which the Curator app and the MCP server both check. If the lock seems stuck for more than 30 minutes (the auto-clear TTL on stale locks), check whether the Curator app is actually running an ingest — and if not, you can manually delete `<domains>/<domain>/.write-lock` to recover. The lock auto-clears on the next acquire attempt if the holder's PID is dead.

Read tools are unaffected — Claude can keep searching and exploring even while an ingest is running.

## How it scales

MCP tool responses feed into the model's context window as tokens — so the practical limit isn't just the 1 MB MCP cap, it's also the model's context. My Curator caps every tool response at **~400 KB (≈100 000 tokens)** so multi-turn conversations can sustain several tool calls without exhausting Opus's 200 000-token window.

- **`get_graph_overview`** returns a compact summary by default (≈4 KB at any scale): node/edge/tag counts, type breakdown, top 20 hubs, orphan sample, top 10 tags. Ask for `include_nodes: true` to enumerate every page, or `include_edges: true` for the full edge list — both are size-guarded: if the response would exceed the limit, it auto-trims heavy arrays and flags what was dropped.
- **`get_tags`** defaults to the top 50 tags with 50-page samples each. Use `filter` to zoom in on a single tag and `max_pages_per_tag: 0` for the full page list.
- **`get_connected_nodes`** caps at `max_nodes: 60` by default, ranked by hop distance then by degree. Max depth is 2. On hub entities the neighbourhood can be hundreds of nodes — raise `max_nodes` explicitly if you need more.
- **`search_wiki`** and **`search_cross_domain`** are ranked, so `max_results` keeps responses small.

Practical guidance:

| Wiki size | Default behaviour |
|---|---|
| Up to ~100 source documents | Everything works without filters |
| 100–500 documents | Prefer `get_graph_overview` (compact), use `include_nodes: true` with `min_connections: 2` to focus on the meaningful graph |
| 500+ documents | Compact `get_graph_overview` still fits; use `get_connected_nodes` for neighborhoods instead of enumerating everything |

A frontier model can always get the full picture — it just has to ask in pieces. The hints returned in `_hints` fields guide the model toward the right follow-up calls.

---

## Setup (under 2 minutes)

1. Open The Curator → **Settings** (rail footer) → **MCP bridge**. (At `/old` the section is in the Settings tab and headed *My Curator — Private MCP Bridge*.)
2. Click **Copy snippet** — a JSON block is now in your clipboard.
3. Click **Reveal in Finder** — Finder opens the folder containing `claude_desktop_config.json`.
4. Open that file in any text editor (TextEdit, VS Code). If it doesn't exist, create one containing just `{}`.
5. Paste the snippet inside the `mcpServers` key (the wizard shows you exactly what "before" and "after" look like).
6. Save, then **fully quit and reopen Claude Desktop** (⌘Q).
7. Back in the Curator, click **Run self-test** to confirm the bridge responds. Then in Claude Desktop:

    > *Use `list_domains` to show my available knowledge domains, then use `get_graph_overview` on the most interesting one to see how everything is connected.*

**If your `claude_desktop_config.json` already exists but contains a JSON syntax error**, the wizard
will **not** show you an "After" preview and the copy button on that pane disappears. That is
deliberate: a file that cannot be parsed cannot be merged into, and the only payload the Curator
could invent would contain *only* the my-curator entry — pasting it would delete every other MCP
server you have configured. Fix the syntax error in that file first, then reopen the wizard. The
entry-only **Copy snippet** in step 2 is unaffected and remains safe to paste by hand.

**What the self-test actually checks** (v3.6.1+): it launches `mcp/server.js` with **the same
`--domains-path` the snippet tells Claude Desktop to use**, so a wrong Knowledge Base Location can
no longer produce a green pass. It reports two things separately — whether the bridge speaks MCP
(that is what pass/fail means), and what happened when it asked for your domains. A brand-new
install with no domains yet passes, and says so, rather than being reported as broken. It never
reads or validates `claude_desktop_config.json` — see Troubleshooting below.

---

## The My Curator Claude skill — best results out of the box (v2.5.7+)

The MCP exposes 20 tools. Used naively, Claude works — but used *well*, Claude grounds every wikilink in your existing slugs, refuses speculative writes on fresh domains, three-tier-tracks Health fixes, and treats domains as siloed. Doing that consistently means typing detailed instructions into every conversation.

The **My Curator skill** packages that playbook into a single markdown file you install once. After install, every Claude conversation that touches the my-curator MCP automatically follows the rules — no detailed prompting needed.

> 📥 **Download:** [`claude-skills/my-curator/SKILL.md`](../claude-skills/my-curator/SKILL.md) and [`claude-skills/my-curator/examples.md`](../claude-skills/my-curator/examples.md) — both files from the GitHub repository.

### What the skill enforces

- **Reading** — uses `get_graph_overview` for orientation, `search_wiki` for keyword queries, `get_node` + `get_backlinks` for tracing, `get_connected_nodes` for neighborhood traversal, `search_cross_domain` for cross-domain synthesis.
- **Writing** — calls `get_index` BEFORE composing every summary. Grounds every `[[wikilink]]` in either an existing slug or one being created in the same call. Uses `broken_link_policy: 'refuse'` on fresh / mostly-empty domains. Inspects the response's `links` field after every write.
- **Maintenance** — three-tier model: auto-fix safe types, confirm review-only types, always-preview destructive (`semanticDupe`) merges. Persists `dismiss_wiki_issue` decisions across machines.
- **Quality rules** — no invented slugs, no duplicate pages, no folder prefixes in entity/concept wikilinks, no cross-domain links, no idempotency-violating re-compiles.

### Install — Claude Code (recommended path)

If you use Claude Code, skills are first-class:

```bash
mkdir -p ~/.claude/skills/my-curator
curl -L https://raw.githubusercontent.com/talirezun/the-curator/main/claude-skills/my-curator/SKILL.md \
  -o ~/.claude/skills/my-curator/SKILL.md
curl -L https://raw.githubusercontent.com/talirezun/the-curator/main/claude-skills/my-curator/examples.md \
  -o ~/.claude/skills/my-curator/examples.md
```

The skill activates automatically on the trigger phrases described in its frontmatter (`description` field). Verify by asking Claude in a new session:

> *What skills are available?*

You should see `my-curator` in the list. Edits to the file take effect mid-session — no restart needed.

### Install — Claude Desktop

Claude Desktop doesn't have first-class "skills" yet, but you can use the same content via the **Project knowledge** mechanism in any Claude Desktop project:

1. In Claude Desktop, open the project where you do most of your second-brain work (or create one — *e.g.* `My Second Brain`).
2. Open **Project knowledge**.
3. Upload both files from `claude-skills/my-curator/` — `SKILL.md` and `examples.md`.

Claude reads project-knowledge files automatically as context for every conversation in that project. The behaviour matches having the skill loaded.

> Alternatively, copy the entire content of `SKILL.md` (minus the frontmatter) into the project's **Custom instructions** field. Same effect, no separate file upload.

### Updating to the latest skill version

The skill is a static markdown file. To get updates (new sections, refined trigger phrases, new tool coverage — e.g. when Shared Brain semantics or new MCP tools change), **re-install over the existing copy**.

**Claude Code users** — just re-run the two `curl` commands from the install section above. They overwrite the existing files in `~/.claude/skills/my-curator/`. No restart, no session interruption — Claude picks up the updated skill on its next read (typically next message).

```bash
# Same commands as install — they overwrite cleanly
curl -L https://raw.githubusercontent.com/talirezun/the-curator/main/claude-skills/my-curator/SKILL.md \
  -o ~/.claude/skills/my-curator/SKILL.md
curl -L https://raw.githubusercontent.com/talirezun/the-curator/main/claude-skills/my-curator/examples.md \
  -o ~/.claude/skills/my-curator/examples.md
```

**Claude Desktop users** — re-upload via Project knowledge:

1. Open the project where you uploaded the skill.
2. **Project knowledge** → delete the existing `SKILL.md` and `examples.md`.
3. Download the latest from GitHub: [SKILL.md](https://github.com/talirezun/the-curator/raw/main/claude-skills/my-curator/SKILL.md) · [examples.md](https://github.com/talirezun/the-curator/raw/main/claude-skills/my-curator/examples.md)
4. Upload the fresh copies.

Check the skill's `§10 Version compatibility` footer to confirm which Curator version your installed copy targets. If the footer doesn't match your installed Curator version, update.

### Trigger phrases

The skill activates on natural language — you don't need to invoke it explicitly. Phrases that reliably trigger it:

| You say | Skill activates because… |
|---|---|
| "What does my wiki know about X?" | matches "READ requests" trigger |
| "Save this to my second brain" / "Add to my Curator" | matches "WRITE requests" trigger |
| "Check my wiki for problems" / "Find broken links" | matches "maintenance" trigger |
| "Put this in my `<name>` domain" | named-domain phrase |
| "Compile our findings" / "Store these notes" | write-intent phrase |
| "Deep research my second brain on X" | combined research-then-synthesise |

If you ever want to bypass the skill (rare — usually you don't), explicitly tell Claude *"don't use the my-curator playbook for this one"*.

### Verifying it works

After installing, run this prompt in a fresh conversation:

> *Save a one-paragraph note about Anthropic to my `articles` second brain.*

The skill should drive Claude to:
1. Call `list_domains` to confirm `articles` exists.
2. Call `get_index(domain="articles")` to inventory existing slugs.
3. Compose with grounded `[[wikilinks]]`.
4. Call `compile_to_wiki` with appropriate `broken_link_policy`.
5. Read back the `links` field and report results.

If you see those steps in the conversation, the skill is loaded and working.

---

## The Curator Continuity Claude skill — session handoff (v3.17.0+)

A second skill, installed the same way, for a different job. My Curator is about your **wiki** —
what you know. Curator Continuity is about your **build** — where a piece of work stands, so the
next session, harness or machine picks it up instead of starting cold.

It drives the two working-state tools (`get_working_state`, `save_working_state`) against the
per-project store at `domains/<project>/state/`. See
[working-state.md](working-state.md) for the store itself: the three tiers, what belongs in a
handoff, size limits, and the security posture.

> ⚠️ **Without this skill the write half never runs.** Nothing in The Curator forces an agent to
> save — capture is skill-instructed, deliberately, because a skill works in every MCP host while
> a hook has to be rebuilt per harness. An agent that has not been told the discipline simply
> never writes, so the store stays empty and the app's **Agent memory** view has nothing to show.
> If you want working state at all, install this.

> 📥 **Download:** [`claude-skills/curator-continuity/SKILL.md`](../claude-skills/curator-continuity/SKILL.md) and [`claude-skills/curator-continuity/examples.md`](../claude-skills/curator-continuity/examples.md) — both files from the GitHub repository.

### What the skill enforces

- **Resume before proposing.** Read state at the start of a session. A scope-less read first,
  because "carry on with the auth work" cannot be resolved to a scope slug the agent has never
  seen without the index.
- **Save early and save often.** A save *overwrites*, so it is idempotent and cheap. That removes
  the single point of failure in "write the handoff at the end", which asks a degraded model near
  its context limit to remember.
- **Every save is complete, never a delta.** Since a save overwrites, a partial second save
  silently drops the firm decisions recorded in the first.
- **Scope is caller-supplied, never inferred** — `git branch --show-current` returns empty in a
  detached-HEAD worktree, so guessing it is unreliable by measurement, not by theory.
- **Stored state is data, not orders.** Verify a claim before acting on it, and re-derive a stale
  baseline rather than trusting a number someone recorded last week.

### Install — Claude Code (recommended path)

```bash
mkdir -p ~/.claude/skills/curator-continuity
curl -L https://raw.githubusercontent.com/talirezun/the-curator/main/claude-skills/curator-continuity/SKILL.md \
  -o ~/.claude/skills/curator-continuity/SKILL.md
curl -L https://raw.githubusercontent.com/talirezun/the-curator/main/claude-skills/curator-continuity/examples.md \
  -o ~/.claude/skills/curator-continuity/examples.md
```

Verify by asking Claude in a new session *"What skills are available?"* — you should see
`curator-continuity` alongside `my-curator`. The two are complementary; install both.

### Install — Claude Desktop

Same **Project knowledge** mechanism as the My Curator skill: open your project, open
**Project knowledge**, and upload both files from `claude-skills/curator-continuity/`. Updating
works the same way too — re-run the `curl` commands, or delete and re-upload the project-knowledge
copies.

### Trigger phrases

| You say | Direction |
|---|---|
| "Where did we leave off?" / "Catch me up on this project" | read |
| "Continue" / "Resume" / "Carry on with the auth work" | read |
| "Save state" / "Write a handoff" / "Checkpoint this" | write |
| "I'm running low on context" / "Before we stop" | write |

---

## Research prompts to try

Once connected, these prompts unlock what the graph layer is actually for:

- **Topology orientation.** *"Use `get_graph_overview` on domain `<name>`. Identify the three most central hubs and tell me what they reveal about the shape of this knowledge."*
- **Tag-driven synthesis.** *"Use `get_tags` on `<name>` to find every page tagged `ai-safety`. Pull each one with `get_node` and write a synthesis."*
- **Backlink tracing.** *"Use `get_backlinks` on entity `<slug>`. For every source that mentions them, summarise how each source positions them."*
- **Cross-domain connection.** *"Use `search_cross_domain` for `organisational resilience`. Identify patterns that appear across more than one domain."*
- **Multi-hop traversal.** *"Use `get_connected_nodes` on `<slug>` with depth 2. Which second-hop nodes reveal non-obvious connections?"*

---

## How to prompt Claude Desktop

Natural language works — you almost never need to name tools explicitly. Claude reads each tool's description and picks the right one based on what you're asking. Here is the rule of thumb.

### Natural prompts (90% of the time)

Describe intent, not tool names. Claude maps what you want to the right tool.

| You say (natural) | Claude picks | Why |
|---|---|---|
| "What domains do I have?" | `list_domains` | "domains" matches the tool |
| "Show me everything about organisational resilience" | `search_wiki` → `get_node` | "about X" = search, then fetch top results |
| "What does my wiki know about Andrej Karpathy?" | `get_node` → `get_backlinks` | Named entity → direct fetch + see who references them |
| "How is my AI knowledge connected?" | `get_graph_overview` → `get_connected_nodes` | "connected / topology" signals graph tools |
| "Find themes tagged `ai-safety` and synthesise" | `get_tags` (with filter) → `get_node` | "tagged X" signals tag inventory |
| "Trace every source that mentions OpenAI" | `get_backlinks` on the `openai` entity | "every source that mentions" = incoming edges |
| "What connects AI research across my domains?" | `search_cross_domain` | Multi-domain query |

### When to name tools explicitly

Three situations where naming a tool pays off:

1. **You hit a size limit and want a different shape.** Give exact parameters so Claude doesn't guess:
   > *"Use `get_graph_overview` on `articles` with `include_nodes: true` and `min_connections: 3` so I can see every well-connected page."*

2. **You want a specific research protocol.** Dictate the order:
   > *"First use `get_graph_overview` to find the top 5 hubs. Then for each hub, use `get_backlinks` to see who references it. Then synthesise."*

3. **Claude picked the wrong tool.** Rare, but a nudge works:
   > *"Use `get_tags` with a filter instead — I want the tag inventory, not a keyword search."*

### The opening move that usually works

For any deep research session, a two-line natural prompt is often enough:

> *"Orient yourself first with `get_graph_overview` on my `articles` domain. Then based on what you see, decide which entities and concepts are worth pulling in detail to answer: **[your actual question]**."*

That gives Claude the research protocol — topology first, then targeted retrieval, then synthesis — and from there you can stay natural ("dig deeper on that", "what else connects", "contradictions?") and Claude will keep picking the right tools itself.

Every tool description also includes hints like *"Call this early in a research session to orient yourself"* and *"For a single page's neighborhood, prefer `get_connected_nodes`"* — so the model gets scaffolding for its own decisions without you having to memorise tool names.

**Bottom line:** describe the work, not the tool. Only name tools when you want tight control over the plan or a specific parameter (`min_connections`, `max_results`, `include_nodes`, `filter`).

---

## Writing to your wiki from Claude Desktop (v2.5.2+)

The biggest unlock of v2.5.2: a research session in Claude Desktop can *end* with the conclusions saved permanently to your wiki — no need to switch to The Curator app to commit them.

### When to use it

You're researching something with Claude — a thesis, a market analysis, a technical deep-dive. After several turns of back-and-forth you have insights worth keeping. Just ask:

> *"Summarise everything we've concluded about [topic] and save it to my second brain."*

Claude calls `compile_to_wiki`, writes a summary page plus any new entity/concept pages that emerged, and reports back what changed.

### Phrases that work

The tool descriptions are written in plain English with the natural phrases you actually use. All of these reliably trigger `compile_to_wiki`:

- *"Save what we discussed to my wiki."*
- *"Add this to my second brain."*
- *"Update my Curator with these findings."*
- *"Compile our conversation as a research note."*
- *"Store these notes in my `business` domain."*
- *"Put this in my markdown library."*

### Sample dialogue

> **You:** *"I want to research advanced AI usage in enterprise organisations. Help me explore my wiki and synthesise what we know."*
>
> **Claude:** [calls `get_graph_overview`, `search_wiki`, `get_node` on relevant pages] *"Based on your wiki, here are the patterns I see across `enterprise-ai`, `llm-deployment-strategies`, `agentic-workflows`…"* [continues with synthesis]
>
> **You:** *[after several turns]* *"Great. Now compile what we figured out and save it to my second brain in the `business` domain. Title it 'Enterprise AI Adoption — 2026 Q2 Research'."*
>
> **Claude:** [calls `compile_to_wiki` with `dry_run: true` first] *"Here's the plan: 1 new summary page, 2 new concept pages (`agentic-workflows-in-enterprise`, `llm-cost-controls`), and 4 updated entity pages. Ready to commit?"*
>
> **You:** *"Yes."*
>
> **Claude:** [calls `compile_to_wiki` with `dry_run: false`] *"Compiled to your business wiki. Created 3 new pages, updated 4 existing ones. Use `get_node` on any of them if you want to read back what was written."*

### What gets written

For every `compile_to_wiki` call:

- **One summary page** under `summaries/<slug>-<date>-<hash>.md` — the durable record of what was learned. The hash makes the slug deterministic, so re-compiling the same conversation never creates a duplicate.
- **Optional entity / concept pages** for any new people, tools, ideas, or frameworks that emerged. On an existing page the merge is **partly** additive: bullet sections (Key Facts, Related, Entities Mentioned, and the rest) genuinely accumulate and nothing is lost. **Prose sections behave differently** — a `## Definition` or `## Summary` in the incoming page *replaces* the existing one, and is only preserved when the incoming page omits that heading entirely. That is deliberate (it is how a full re-ingest rewrites a page with complete document context), but it means a thin update can overwrite richer existing prose. The tool description tells Claude to read the page first when updating; if you care about a hand-written Definition, say so in the conversation.
- **Cross-links** — every entity mentioned in the summary gets a backlink to it; the summary references all the entities and concepts.
- **Index update** — the new pages are added to `index.md` automatically.
- **Log entry** in `log.md` recording the compile.

The same write pipeline used by The Curator app's in-app Compile button runs here — typo-variant slugs are normalised, duplicates caught, folder-prefix link errors stripped, summary backlinks injected automatically. **The MCP and the app are equally-capable clients to the same wiki.**

### Safety features

- **Dry-run mode**: pass `dry_run: true` to preview what *would* be written without touching disk. Claude knows to use this for cautious confirmations before committing.
- **Hard caps**: 50 KB per page, max 10 pages per call. A confused or malicious model can't trash the wiki in one tool call.
- **Idempotency**: same conversation + same title + same date → same slug → second call is refused with a clear message ("Already compiled to X").
- **Default domain**: in The Curator's Settings, you can set a default domain for MCP writes. When you say "my wiki" without specifying which one, Claude uses that. Without a default, Claude must call `list_domains` first and confirm with you.
- **Audit log**: every MCP write is recorded to `domains/<d>/.mcp-write-log.jsonl` (local-only, never synced to GitHub) — your private record of what happened, when, and by which tool.
- **Link grounding (v2.5.5+)**: see below.

### Link grounding — preventing broken `[[wikilinks]]` (v2.5.5+)

When Claude composes wiki content, it has a habit of inventing wikilinks that look plausible but don't exist (`[[machine-learning-fundamentals]]`, `[[ai-research-2024]]`). On a fresh / empty domain this is the dominant source of broken links — early users reported dozens per compile.

**`compile_to_wiki` now runs a pre-write resolution pass on every link.** Each `[[wikilink]]` is resolved against:

- Slugs that already exist in the target domain
- Slugs being created in this same call's `additional_pages`
- Pass A / B / C variant normalisation (e.g. `[[Claude]]` → `[[claude]]`, `[[dr-tali-rezun]]` → `[[tali-rezun]]`)

The response includes a structured `links` field:

```json
"links": {
  "total": 12,
  "resolved": 8,            // exact slug match
  "normalized": 2,          // variant slug auto-fixed
  "broken": [               // no match anywhere
    { "in": "summaries/foo.md", "link": "machine-learning-fundamentals" }
  ],
  "broken_count": 1,
  "policy": "keep"
}
```

Claude reads this and can decide whether to retry with corrections.

### `broken_link_policy` — three modes for fresh domains

The optional `broken_link_policy` parameter on `compile_to_wiki` controls what happens when a link doesn't resolve:

| Policy | What it does | When to use |
|---|---|---|
| `'keep'` (default) | Writes broken links as-is, reports them in `links.broken`. | Most cases. Lets Claude decide on retry. Matches in-app ingest behaviour. |
| `'strip'` | Removes the `[[brackets]]` so the prose reads naturally and no broken link lands on disk. Lossy but clean. | When you want Claude's content saved cleanly even if some references can't be linked. |
| `'refuse'` | Aborts the whole compile if **any** link is broken. Response includes `valid_slugs_sample` of real slugs from the domain so Claude can retry quickly. | **Recommended for fresh / empty domains.** Forces Claude to ground its links before any write happens. |

### Sample dialogue for fresh domains

> **You:** *"Add a summary of our discussion about AI agents to my new `projects` domain. The wiki is empty so be strict — refuse if any link is broken."*
>
> **Claude:** [calls `compile_to_wiki` with `broken_link_policy: 'refuse'`] *"The compile was refused — 4 broken links: `agent-orchestration`, `tool-calling`, `model-router`, `prompt-chaining`. Want me to add those as new pages in the same call, or rewrite the summary without those links?"*
>
> **You:** *"Add them as new pages."*
>
> **Claude:** [calls `compile_to_wiki` again with `additional_pages: [...]` covering the four concepts] *"Compiled. 5 new pages in 'projects', all 12 links resolved cleanly."*

This loop typically converges in 1–2 retries and produces a wiki with **zero broken links** — instead of dozens that need cleanup later.

---

## Healing your wiki from Claude Desktop (v2.5.2+)

Health checks and repairs are also available through the MCP. Three tiers, encoded in the tool descriptions so Claude knows when to ask vs. when to act:

| Tier | Issue types | Behaviour |
|---|---|---|
| **Auto-fix** | folder-prefix violations, missing backlinks, and broken links that the *scanner* already matched to a target | Claude applies these without asking — they have one clear right answer, and no page is removed. |
| **Say what disappears first** | cross-folder duplicates, hyphen variants | These **merge two pages and delete one of them** (links pointing at the deleted page are repointed to the survivor). Since v3.9.1 the tool description tells Claude to name the page that disappears before calling. |
| **Confirm first** | orphans, broken links *without* a scanner target | Claude shows you the issue, you say fix / dismiss / leave, Claude calls the tool. |
| **Always preview** | semantic-duplicate merges (DESTRUCTIVE — deletes a file, rewrites links domain-wide) | Claude calls `fix_wiki_issue` with `preview: true` first to show the diff plan; only after your explicit yes can it call again with `preview: false` to commit. |

**A broken link Claude *thinks* it can place is not the same as one the scanner matched (v3.9.1).** `fix_wiki_issue` is for handing back the issue object `scan_wiki_health` gave you. The scanner's `suggestedTarget` comes from deterministic slug normalisation; a target Claude reasons its way to is a guess, and a wrong retarget writes a factually wrong link into every page that referenced it. The tool now refuses any `suggestedTarget` that does not name a page actually on disk, and its description tells Claude to leave an unmatched broken link alone rather than invent one — or to point you at the app's bulk AI broken-link fixer (Domains → the domain → Wiki health), which previews the whole plan and applies its own safety gate before writing anything.

### Sample dialogue

> **You:** *"Claude, clean up my `articles` second brain."*
>
> **Claude:** [calls `scan_wiki_health`] *"Found 14 issues. 6 are safe to fix outright — folder-prefix violations and missing backlinks. I'll do those now."* [calls `fix_wiki_issue` 6 times]. *"Done — 6 issues fixed across 12 files. Two more are hyphen variants: fixing those merges `dr-tali-rezun` into `tali-rezun` and deletes the first page, repointing its links. Want me to?"*
>
> **Claude:** *"Six remaining need your judgement: 4 broken links without good targets, 2 orphan pages. Want to review them?"*
>
> **You:** *"Yes, walk me through them."*
>
> **Claude:** *"First — `concepts/foo.md` has a broken link `[[bar]]`. No close match in the wiki. Fix, dismiss, or leave?"*
>
> **You:** *"Dismiss it. The link is intentional, I'll create the bar page later."*
>
> **Claude:** [calls `dismiss_wiki_issue`] *"Dismissed. Won't surface on future scans."* [continues through the rest]

### Phrases that work

- *"Check my wiki for problems"* → `scan_wiki_health`
- *"Find broken links"* / *"audit my second brain"* → `scan_wiki_health`
- *"Fix what's safe to fix"* → loop of `fix_wiki_issue` on auto-fixable types
- *"Find duplicate pages"* / *"scan for semantic duplicates"* → `scan_semantic_duplicates`
- *"Stop showing me this"* / *"dismiss this"* → `dismiss_wiki_issue`
- *"What have I dismissed?"* → `get_health_dismissed`

### Where dismissals live

The MCP and the app's Wiki health panel share the **same** dismissal store (`domains/<d>/wiki/.health-dismissed.jsonl`, git-tracked, syncs across machines via your existing GitHub sync). Skip a 70-pair semantic scan in Claude Desktop, sync, and the same false positives stay skipped on your other computers and in the app.

### Cost note

`scan_semantic_duplicates` is the only Health tool with a paid LLM call (typically $0.005–$0.03 per scan on Gemini Flash Lite). Use the `estimate_only: true` flag to get the cost estimate before committing — Claude knows to do this when you say *"how much would it cost to scan?"* or similar.

---

## Reading the original source from Claude Desktop (v3.5.0+)

A summary page is a *lossy* rendering of whatever you ingested — the AI kept what it judged important and left the rest behind. `get_raw_source` lets Claude go back to the actual document a summary was built from.

### Compiled first, verbatim only on escalation

**The wiki stays the default source for everything.** That's the whole point of a compiled second brain instead of a RAG pipeline: the wiki already did the work of extracting and connecting what matters, and reading it is cheap. `get_raw_source` is an **escalation**, not a first move — reach for it only when the summary genuinely isn't enough:

- You need an **exact quote** or the author's own wording.
- You need a **precise figure** you'll be held to (a statistic, a date, a dollar amount).
- The summary is silent on something you have reason to believe the source covers.

Composing every answer from raw source text instead of the compiled wiki would quietly turn The Curator into the retrieval-at-query-time pattern it was built to avoid (see [Why this matters](#why-this-matters-the-elevator-pitch) above). If you notice Claude reaching for `get_raw_source` by default rather than as a fallback, tell it to answer from the wiki first.

### What to expect

- **Text only, never binary.** PDFs are text-extracted before Claude ever sees them; the tool cannot return raw file bytes. Response size is capped well under the MCP's response budget, and the response says explicitly when it was truncated.
- **"The original isn't on this machine" is a normal answer, not an error.** Raw source files (`raw/`) are deliberately never synced — only your wiki pages are. On any machine other than the one you ingested a document on, `get_raw_source` reports the filename, size, and ingest date it still knows about, and says plainly that the file itself isn't here. This is expected after a Personal Sync pull or on a Shared Brain mirror, and nothing about your wiki page is affected.
- **A `source:` that's a URL is reported as-is, never fetched.** Some summaries record a web page rather than a local file (e.g. `medium.com/@author`). Claude sees that value as text; The Curator never turns it into an outbound request.

### Phrases that work

- *"Check the actual source for that figure."*
- *"What's the exact quote the summary is paraphrasing?"*
- *"Pull the original text of the document behind this summary."*

---

## Things to know

**If you move your domains folder, MCP stops working.** The config file has an absolute path baked in. When you change the Knowledge Base Location in **Settings → Knowledge base** (or move the Curator install), come back to **Settings → MCP bridge**, click **Regenerate**, paste the new snippet, and restart Claude Desktop. The wizard detects staleness and shows a warning banner when it happens.

**The MCP and the app now agree on `DOMAINS_PATH` vs Settings.** If you've set a `DOMAINS_PATH` environment variable (the developer-oriented `.env` fallback described in [user-guide.md](user-guide.md)) *and* a different Knowledge Base Location in Settings, the Settings value wins — in both the app and in Claude Desktop, identically. That particular disagreement can no longer happen.

The one way they can still drift apart is the one described just above: the `--domains-path` baked into `claude_desktop_config.json` is a **snapshot** taken the last time you ran the wizard. If you change the Knowledge Base Location in Settings afterward without regenerating that snippet, Claude Desktop's read tools keep looking at the OLD folder (that baked-in argument always wins for reads) while the browser shows the NEW one. Writes don't follow the same path, though: `compile_to_wiki` and the Health-fix tools save through the Curator's own current Knowledge Base Location, not the snippet's baked-in path — so in this exact stale state, asking Claude to save research writes into the NEW folder while every read tool is still showing you the OLD one, and the pages will look missing even though they saved successfully. The fix is exactly what's already described above — Settings → My Curator → **Regenerate** → paste the new snippet → restart Claude Desktop — and it's worth doing promptly, not just eventually, precisely because of that read/write split.

**The Curator server does not need to be running.** Claude Desktop spawns `mcp/server.js` as a child process on demand. It's a separate, read-only path into the same markdown files.

**Existing wiki? It just works.** My Curator reads the files that ingest already produces — no migration, no re-ingest. For the cleanest possible graph on day one, you can optionally run **Wiki Health → Apply All Fixes** once, but it's not required.

**Privacy.** Everything stays on your machine. There is no network component. No telemetry.

**Security.** Every tool validates its `domain` and `slug` arguments before touching disk, and the filesystem adapter refuses to resolve any path outside your domains folder — even if a prompt injection tries to steer the model toward `../../../etc/passwd`, the request returns "Invalid slug" without ever touching disk. The twelve read tools are strictly read-only, as are three of the eight health/authoring tools (`scan_wiki_health`, `scan_semantic_duplicates`, `get_health_dismissed`) — fifteen of the twenty never change anything on disk. Of the five that do (v2.5.2+, plus `save_working_state`), `compile_to_wiki` is hard-capped at 50 KB/page and 10 pages/call and is idempotent per conversation; all five refuse a read-only Shared Brain mirror outright, and every write is recorded locally in `.mcp-write-log.jsonl` — see "Safety features" below. `get_raw_source` (v3.5.0) is read-only and returns extracted text only; it never emits raw file bytes.

**What a slug is allowed to contain (widened in v3.9.1).** Lowercase letters, digits, hyphens, underscores, and **interior dots** — so `claude-sonnet-3.5`, `gemini-2.5-flash`, `industry-5.0`, `apache-2.0-license` and `express.js` are all addressable. Before v3.9.1 every dot was refused, and the effect was silently self-contradictory: `search_wiki` and `get_index` would happily *show* you those pages, and then `get_node`, `get_backlinks`, `get_connected_nodes`, `get_summary` and `get_raw_source` would all answer *"Invalid slug"* for the exact slug they had just advertised. Across the six real domains it was measured on, that made **73 of 4,751 pages discoverable but unreadable**, and `get_raw_source` unusable for every summary whose source file was actually present.

A dot still buys nothing towards a path: `..` anywhere, a leading dot (so a dotfile can never be named), a trailing dot, and every path separator remain refused, and the real containment check in the filesystem adapter is unchanged. Domain names stayed strict on purpose and were split into their own validator — a domain is the outer folder of every path, and the app cannot create a dotted one anyway, since it reduces a display name to letters, digits and hyphens before making the folder.

**Eight slugs are still unreachable, and this is stated rather than glossed.** Of the same 4,751, eight remain refused after the widening and none of them is dot-related: three carry non-ASCII accented characters (widening to non-ASCII raises its own normalisation and look-alike-character questions and was not decided here), three contain literal spaces, and two exceed the 200-character limit — both of those are runaway AI-generated page titles of around 230 characters, where the limit is doing its job.

---

## Troubleshooting

| Symptom | Most likely cause | Fix |
|---|---|---|
| Claude Desktop shows no `my-curator` tools | Snippet pasted incorrectly, or Claude Desktop not restarted | Double-check the "After" preview in the wizard, then ⌘Q and reopen Claude Desktop |
| "Stale config" banner in Settings | Knowledge Base Location changed since you last generated the snippet | Click **Regenerate**, paste the new snippet, restart Claude Desktop |
| Self-test reports the bridge is fine but says your knowledge folder is missing | Knowledge Base Location points somewhere that no longer exists | Set a valid path in **Settings → Knowledge base**, then **Regenerate** the snippet and re-paste it. Note the self-test deliberately still **passes** here: `ok` means "the bridge speaks MCP", and a working bridge with an empty or missing folder is a real, distinguishable state rather than a broken install. Since v3.6.1 it says which one — the folder being genuinely empty and the folder not existing at all no longer look the same |
| Tools show but return "no domains" | You haven't created any domains yet | Open the Curator, create a domain, ingest a source |
| Claude finds a page in search but gets "Invalid slug" when it tries to open it | The slug contains a character the MCP refused. Before v3.9.1 that was any dot (`claude-sonnet-3.5`) | Update to v3.9.1 or later. If it persists, the slug likely has an accented character or a space — rename the file to plain lowercase-and-hyphens, or open the page in the Curator app instead |
| Self-test passes but Claude Desktop still doesn't see the tool | Config file has a JSON syntax error | The self-test only checks the bridge, never your config file — a syntax error there cannot fail it. The wizard detects it separately: the Settings panel's status call (`GET /api/mcp/config`) returns `claude_config_parse_error: true`, and the merged "After" preview then shows **no merge at all** rather than a misleading one, because a file that can't be parsed can't be safely merged into. Fix the JSON syntax in `claude_desktop_config.json` first, then reopen Settings |

---

## What it is *not*

- Not a cloud service. Not hosted. Not shared.
- Not multi-user. My Curator = *my* Curator. Phase 3 will add an optional hosted/collective version with API keys — that's a separate thing.
- Not a replacement for the built-in Chat tab, Obsidian graph view, or the ingest pipeline. It's an *additional* access path: Obsidian gives you spatial exploration, Chat gives you a quick Q&A, and My Curator gives you frontier-model research.
