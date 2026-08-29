# Domains

A **domain** is a focused wiki for one topic area. Each domain is a self-contained knowledge graph with its own AI schema, wiki pages, chat conversations, and Obsidian graph cluster. This guide is the single reference for everything domain-related: what they are, how to manage them, how their schema works, how they relate to each other, and how to customise templates for specialised topics.

> 📖 **Just looking for the basics?** The [User Guide § 10](user-guide.md#10-manage-your-domains) has a quick walkthrough. This page is the deep dive.

---

## 1. What is a domain?

The Curator's core insight, from researcher Andrej Karpathy and educator Nick Spisak, is that **one general-purpose second brain that covers everything ends up good at nothing**. Instead, you maintain *focused* wikis per domain — one for AI/Tech, one for Business, one for Personal Growth — each one a specialist. Each one compounds in value with every source you add.

Concretely, a domain is a folder under `domains/` containing:

```
domains/<slug>/
├── CLAUDE.md            ← the schema (system prompt for Claude in this domain)
├── raw/                 ← uploaded source files (gitignored)
├── conversations/       ← saved chat threads (JSON)
├── state/               ← working state (optional — see below)
└── wiki/
    ├── index.md         ← master page catalog
    ├── log.md           ← chronological ingest log
    ├── entities/        ← people, tools, companies, datasets
    ├── concepts/        ← ideas, techniques, frameworks
    └── summaries/       ← one page per ingested source / compiled conversation
```

Three built-in domains ship with the app — **AI / Tech**, **Business / Finance**, **Personal Growth** — but you can create as many as you like.

### `state/` — working state, not wiki content

Since v3.17.0 a domain may also carry a `state/` folder. It's a genuine **sibling** of `wiki/`, not a path inside it — a standing project brief plus per-machine session handoffs that an agent reads and writes over MCP (`get_working_state`, `save_working_state`), so a build session on one machine can hand its context to the next session on any machine, harness, or model. You can read it in the app: the **Agent memory** rail view shows the standing brief, the current handoff for a chosen scope and machine, and the journal tail. That view is **read-only, deliberately** — agents are the only writer, which is what keeps two machines from ever writing the same file, and a browser writer would also stamp your edit with the last agent's provenance. To change the standing brief by hand, open `state/project.md` in Obsidian; it is plain markdown in your own folder.

It deliberately sits **outside the wiki graph**: nothing in `state/` goes through `writePage`, so none of it carries frontmatter or `[[wikilinks]]`, none of it is scanned by Wiki Health, none of it is folded into `index.md`, and none of it counts toward a domain's page counts (those are all computed by walking `wiki/` only). Where the wiki's merge model *accumulates* — every ingest adds to a page's bullets and nothing is dropped — working state *supersedes*: each save overwrites the previous handoff, because yesterday's resolved blocker should not be resurrected by today's read.

Nothing needs to create the folder by hand — the first save makes `state/` and every path segment under it on demand. See [`working-state.md`](working-state.md) for the full layout, the two MCP tools, and how it's kept safe to read back into a conversation.

---

## 2. Managing domains (recommended path: the UI)

The easiest way to create, rename, or delete a domain is from within the app — no Finder or terminal needed. Open The Curator at `http://localhost:3333` and click the **Domains** tab.

### Creating a new domain

1. Click **+ New Domain**.
2. Enter a display name (e.g. `Health & Fitness`). The folder slug is generated automatically and shown as a live preview (e.g. `domains/health-and-fitness/`).
3. Optionally describe the scope in 1–2 sentences.
4. Pick a **template** that matches your topic:

   | Template | Best for | Entity types | Concept style |
   |----------|----------|-------------|---------------|
   | ⚙️ Tech / AI | Software, AI research, developer tools | person, tool, company, dataset | How It Works / Applications |
   | 📈 Business / Finance | Startups, investing, strategy | person, company, fund, institution | Why It Matters / Examples |
   | 🌱 Personal Growth | Books, habits, mental models | person, book, framework | Why It Matters / How to Apply It |
   | 📁 Generic | Any other topic | person, item, organization | Overview / Examples |

5. Click **Create Domain**.

The domain appears immediately in every dropdown (Ingest, Chat, Wiki) and in Obsidian's file explorer. No restart needed.

### Renaming a domain

Click the **pencil icon** on a domain card, type the new display name, and click **Rename**. All wiki pages, conversations, and chat history are preserved. Obsidian reflects the change instantly.

> **If sync is configured:** renaming appears to GitHub as a delete + add. Click **Sync now** soon after renaming so your other computers stay consistent.

### Deleting a domain

Click the **trash icon** on a domain card. The confirmation panel shows exactly how many wiki pages and conversations will be removed. Click **Yes, delete permanently** to commit.

> ⚠️ **Deletion is permanent — there is no undo.** If sync is configured, the domain is removed from GitHub on the next **Sync now**.

### Manual setup (advanced)

If you want a custom schema beyond what the templates offer, you can create a domain by hand:

```bash
SLUG="my-domain"
mkdir -p domains/$SLUG/{raw,conversations,wiki/{entities,concepts,summaries}}
printf '# Wiki Index — My Domain\n\n| Page | Type | Summary |\n|------|------|---------|\n' \
  > domains/$SLUG/wiki/index.md
printf '# Ingest Log — My Domain\n\n' > domains/$SLUG/wiki/log.md
# Then write the schema (see § 3)
```

The app discovers domains on every request — no restart needed. Open **Domains** and check that your new domain appears.

To delete or rename manually:

```bash
rm -rf domains/my-domain
mv domains/old-name domains/new-name   # remember to update the # Domain: header in CLAUDE.md
```

### Manual checklist

- [ ] `domains/<slug>/CLAUDE.md` — schema written (see § 3)
- [ ] `domains/<slug>/raw/` — directory exists (can be empty)
- [ ] `domains/<slug>/wiki/index.md` — initialised with header + empty table
- [ ] `domains/<slug>/wiki/log.md` — initialised with header
- [ ] `domains/<slug>/wiki/{entities,concepts,summaries}/` — three directories exist
- [ ] `domains/<slug>/conversations/` — directory exists

---

## 3. The schema (CLAUDE.md)

Every domain has a `CLAUDE.md` file at its root. This file is **the system prompt for the AI in that domain** — Claude reads it before every ingest and every query. It's the single most important configuration file in the system, controlling:

- What topics belong in this domain
- How pages are structured and named
- How cross-references are formatted
- What instructions the AI follows when processing sources

### Schema anatomy

A well-formed `CLAUDE.md` has six sections:

```markdown
# Domain: <Name>

[One-sentence description of the domain's scope]

## Scope
[What topics belong here. Be specific about inclusions and exclusions.]

## Wiki Conventions
[Page types, naming rules, markdown templates]

## Cross-Referencing Rules
[How to link between pages]

## index.md Format
[Template for the master catalog]

## log.md Format
[Template for the ingest log]

## Instructions for the AI
[Step-by-step instructions for ingest and query behaviour]
```

### Scope — be specific

The Scope section tells Claude what to include and what to ignore. Without it, Claude creates pages for tangentially related topics and dilutes the domain.

**Too vague:**
```markdown
## Scope
Technology topics.
```

**Well-defined:**
```markdown
## Scope
Artificial intelligence, machine learning, software engineering, developer
tools, programming languages, research papers, open-source projects, and
the people and companies behind them.

Out of scope: business strategy, investing, self-improvement (these have
their own domains).
```

The `Out of scope` note is especially valuable when adjacent domains exist — it prevents duplication.

### Wiki Conventions — three page types

Every domain should have at minimum:

| Type | Folder | One page per |
|------|--------|--------------|
| Summary | `summaries/` | Ingested source or compiled conversation |
| Entity | `entities/` | Person, tool, company, dataset, book |
| Concept | `concepts/` | Idea, technique, framework, principle |

Filenames are lowercase and hyphenated — they become the slug used in `[[wikilinks]]`:

```
entities/andrej-karpathy.md     → [[andrej-karpathy]]
concepts/chain-of-thought.md   → [[chain-of-thought]]
summaries/attention-paper.md   → [[summaries/attention-paper]]
```

### Page templates

Define a markdown template for each page type. Claude follows it consistently:

**Entity:**
```markdown
# [Entity Name]
Type: person | tool | company | dataset
Tags: [comma-separated]

## Summary
One-paragraph description.

## Key Facts
- Bullet facts

## Related
- [[concept-name]] — why related
- [[other-entity]] — why related
```

**Concept:**
```markdown
# [Concept Name]
Tags: [comma-separated]

## Definition
Clear, concise definition.

## How It Works
Explanation with examples.

## Applications
- Use case

## Related
- [[entity-or-concept]] — why related
```

**Summary:**
```markdown
# [Source Title]
Source: [filename]
Date Ingested: [YYYY-MM-DD]
Tags: [comma-separated]

## Key Takeaways
- Bullet list of main points

## Concepts Introduced or Referenced
- [[concept-name]]

## Entities Mentioned
- [[entity-name]]

## Notes
Additional commentary.
```

### Cross-Referencing Rules

Cross-references are what turn a wiki into a knowledge graph instead of a flat file dump. The schema tells Claude both the syntax and the obligation:

```markdown
## Cross-Referencing Rules
- Always use [[page-name]] syntax for internal links (without folder prefix).
- When you create or update a summary, update the corresponding entity and
  concept pages to reference it.
- Every entity or concept mentioned in a source gets either a new page or
  an update to an existing page.
```

The second and third rules ensure the graph grows bidirectionally — a summary links to its concepts/entities, and those pages link back.

### Instructions for the AI — the most critical section

This is what governs ingest output quality. State exactly what the AI should produce:

```markdown
## Instructions for the AI
When ingesting a source:
1. Write a summary page under summaries/.
2. Create or update entity pages for every person, tool, company, or
   dataset mentioned.
3. Create or update concept pages for every key idea or technique.
4. Add cross-references between all related pages.
5. Return the full list of pages to create/update as JSON.

When answering a query:
- Cite specific pages using [source: path/to/page.md] format.
- Synthesise across multiple pages rather than quoting verbatim.
```

### Schema iteration

As you ingest more sources, you'll spot gaps or inconsistencies. Update `CLAUDE.md` to fix them — the schema change takes effect on the next ingest. Common improvements:

- Add a `Status` or `Last updated` field to entity pages when facts change frequently
- Add a domain-specific tag taxonomy
- Add an `Out of scope` line if off-topic pages keep appearing
- Refine concept templates to capture domain-specific attributes (e.g. `Evidence Level` for health, `Time Complexity` for algorithms)

---

## 4. How domains relate to each other

This is the part that surprises most people once they have more than one domain, so it gets its own section. **Short answer: domains are siloed by default. The Curator never creates links between them.** The longer answer has four levels worth understanding.

### Level 1 — Inside a domain: full graph

A page in `articles` can link to any other page in `articles`. Backlinks resolve. Health scans validate links. Obsidian's graph view shows the network. This is the design centre.

### Level 2 — Across domains via The Curator's tools: no links

- **Ingest** only loads existing slugs from the *current* domain when prompting the LLM, so cross-domain slugs aren't visible to the AI during writes.
- **`compile_to_wiki`** (the MCP write tool) writes to **one domain per call**. It cannot create a link from `projects` to a page in `articles`.
- **Link grounding** (v2.5.5+) only resolves against the current domain's slug inventory; cross-domain hits are treated as broken.

In other words, every Curator-driven write stays within a single domain.

### Level 3 — Across domains via MCP read: yes, but read-only

The MCP tool **`search_cross_domain`** queries every domain at once. Claude can *reason* across all your knowledge for synthesis prompts like:

> *"What patterns appear in both my `articles` and `projects` domains?"*

This is a powerful research mode — but it's purely conceptual reasoning *in the conversation*. It doesn't create persistent cross-domain links on disk.

### Level 4 — Across domains via Obsidian: accidental edges

Here's the nuance. If your Obsidian vault root is set to the `domains/` folder (covering several domains at once), Obsidian's **own** link resolver sees all the markdown files together. If a `[[foo]]` link in `articles/wiki/.../something.md` happens to match a `foo.md` in `projects/wiki/.../foo.md`, Obsidian will draw an edge between them in the graph.

But:

- This connection is **accidental** — created by Obsidian's resolver matching identical slugs across folders, not by The Curator's intentional architecture.
- The Curator's Health scanner is per-domain; that same `[[foo]]` is flagged as **broken** during the `articles` scan because Health can't find `foo` inside `articles/`.
- If two domains both have an `entities/openai.md`, Obsidian shows them as the same node — useful (one canonical OpenAI page everywhere) or confusing (two different pages collapsed into one), depending on your intent.

### Practical guidance

| Want | Set Obsidian vault root to |
|------|---------------------------|
| **True silos.** Each domain its own graph, no cross-pollination. | `domains/<one-domain>/wiki/` per vault (one Obsidian vault per domain) |
| **Unified visual graph.** Surfaces accidental cross-domain matches — sometimes a feature, sometimes noise. | `domains/` (covers all domains in one vault) |

If you want **intentional** cross-domain linking — a person in `articles` explicitly linking to their company in `business`, with proper resolution and Health validation — that's not currently supported. It would require a syntax like `[[business:openai]]` and corresponding parser/scanner work. If this is a real need, file an issue and we'll scope it as a future feature; in practice almost everyone uses the siloed model successfully.

### TL;DR

| Question | Answer |
|---|---|
| Does The Curator create links between domains? | **No.** |
| Does `compile_to_wiki` write cross-domain links? | **No** — single domain per call. |
| Can Claude reason across domains via MCP? | **Yes** — via `search_cross_domain`, read-only. |
| Will Obsidian show accidental cross-domain edges? | **Yes**, if your vault root covers multiple domains AND slugs match. |
| Will Health flag those as broken in the source domain? | **Yes** — Health is per-domain. |

### Shared Brain mirror domains (`v3.0.0-beta+`)

When you join a Shared Brain (see [`docs/shared-brain.md`](shared-brain.md)), the collective wiki appears on your machine as an additional domain named `shared-<slug>`. These mirror domains behave like any other domain for **reading** (chat, MCP, Obsidian) but are **read-only for writes**:

- The CLAUDE.md frontmatter declares `readonly: true`.
- MCP write tools (`compile_to_wiki`, `fix_wiki_issue`, `dismiss_wiki_issue`, `undismiss_wiki_issue`) refuse with a clear steer to use your personal opted-in domain instead.
- The Curator's app UI keeps Ingest and Compile disabled for these domains, and the mutating Wiki Health endpoints refuse them. (Two exceptions: **dismissing** and **un-dismissing** a Health issue still work in-app on a mirror. That is a local-only note-to-self — it is not wiki content, it does not propagate to other contributors, and it is not pruned by a Pull.)

**Do not hand-edit a mirror.** Since v3.0.3 a Pull *replaces* each page rather than merging into it, and prunes local pages the collective no longer has — which is what makes deletions and GDPR erasure propagate. Any local edit to a `shared-<slug>` page is therefore overwritten on the next Pull.

To contribute to a Shared Brain, write to your **personal opted-in domain** (e.g. `work-ai/`), then click **Push contributions** in the Shared Brain view. The synthesised collective wiki comes back to `shared-<slug>/` on the next Pull.

---

## 5. Customising templates for specialised topics

Different subject areas call for different entity and concept hierarchies. The four built-in templates cover most cases, but here are starter examples for domains beyond the defaults — drop these snippets into `CLAUDE.md` to seed the schema, then iterate.

### History

```markdown
## Wiki Conventions
- entities/ — Historical figures, nations, empires, events, treaties
- concepts/ — Political systems, economic models, military strategies, ideologies
- summaries/ — One page per book, article, or documentary ingested

Entity page additions:
## Era
[Time period, e.g. "Ancient Rome, 27 BC – 476 AD"]

## Impact
[Why this entity matters historically]
```

### Health & Fitness

```markdown
## Wiki Conventions
- entities/ — Studies, researchers, protocols, supplements, equipment
- concepts/ — Training principles, nutrition frameworks, physiological mechanisms
- summaries/ — One page per study, book, or podcast episode ingested

Concept page additions:
## Evidence Level
[Strong / Moderate / Weak / Anecdotal]

## Practical Application
[How to actually apply this]
```

### Legal

```markdown
## Scope
Contract law, intellectual property, startup legal structures, employment
law. Out of scope: criminal law, family law.

## Wiki Conventions
- entities/ — Laws, regulations, court cases, jurisdictions, named legal concepts
- concepts/ — Legal principles, frameworks, doctrines
- summaries/ — One page per article, case study, or document ingested

Entity page additions:
## Jurisdiction
[Which legal system applies]

## Status
[Current / Superseded / Varies by jurisdiction]
```

---

## 6. Terminology

The Curator uses precise language for what it does. These terms appear in the app, in the docs,
and in the page structure described above.

| Term | Definition |
|------|-----------|
| **Atomic Decomposition** | Breaking a large document into three discrete network components: Entities, Concepts, and Summaries |
| **Entities (the nouns)** | Specific people, companies, tools, datasets — nodes with a proper name. Filed under `entities/` |
| **Concepts (the verbs / ideas)** | Broad theories, techniques, frameworks, principles — ideas without a single owner. Filed under `concepts/` |
| **Summaries (the glue)** | The narrative that connects specific entities to concepts for one source document. Filed under `summaries/`, one per ingested source |
| **Semantic Intelligence** | The system's ability to read raw text, comprehend context, and extract structured knowledge rather than storing chunks |
| **Hidden Relations** | Intersections between concepts that only become visible in the graph — what a search bar can never show you |
| **Contextual Provenance** | The ability to trace any synthesised idea back to its exact source page |
| **Network Compounding** | Each new source updates existing pages rather than duplicating them — knowledge builds on itself |

> Shared Brain has its own vocabulary — see
> [Shared Brain User Guide § 7](shared-brain-user-guide.md#7--terminology).

---

## See also

- **[User Guide § 10](user-guide.md#10-manage-your-domains)** — short walkthrough of the Domains view
- **[Sync Guide](sync.md)** — how domains travel between computers via GitHub
- **[MCP User Guide § Writing to your wiki](mcp-user-guide.md#writing-to-your-wiki-from-claude-desktop-v252)** — how `compile_to_wiki` chooses a domain and what defaultDomain does
- **[Architecture § Data flow: Ingest](architecture.md#data-flow-ingest)** — the technical pipeline that consumes the schema
