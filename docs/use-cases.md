# Use Cases

The Curator is domain-agnostic — it applies the same Atomic Decomposition and network-compounding
pattern to any field where knowledge accumulates over time. Below are detailed workflows for the
primary use cases.

---

## A. Content Creators (Writers, Podcasters, YouTubers)

**The Problem:** Creators consume hundreds of articles, books, and podcasts, but face a blank
page when it's time to create. They struggle to recall specific anecdotes and struggle to
synthesise across everything they've consumed.

**The Workflow:**
1. Ingest all research material into The Curator (articles, book summaries, podcast notes)
2. When outlining new content, open the Obsidian graph and identify the largest Concept nodes —
   these are the themes you naturally gravitate toward
3. Click any Entity node to see every source you've ingested that mentions it
4. Query the chat: *"Summarise everything I know about [topic]"* for a cited briefing

**The Result:** Passive consumption becomes a content assembly line. A fully cited script or
article outline in minutes rather than hours.

---

## B. Researchers & Academics

**The Problem:** Researchers drown in 50-page PDFs. Standard RAG systems lose the big picture
because they only retrieve isolated text chunks. Subtle synthesis questions require manually
re-reading across five documents.

**The Workflow:**
1. Batch-upload 20+ PDFs on a research topic
2. The Curator extracts all distinct methodologies (Concepts) and authors/institutions (Entities)
3. Use the Obsidian graph's visual "Idea Collisions" to identify intersections between concepts
   that no existing paper has addressed
4. Query: *"What methodologies are linked to [concept] but haven't been applied to [domain]?"*

**The Result:** A synthesised view across the entire literature corpus, with source citations.
Content gaps and new research hypotheses emerge visually from the graph.

---

## C. Executives & Strategists

**The Problem:** Executives need to track competitors, market trends, and meeting transcripts,
but this data is scattered across formats. Crucial insights get lost. Recency bias means
the most recent input dominates over older (often more reliable) signals.

**The Workflow:**
1. Upload quarterly reports, competitor analyses, meeting transcripts
2. Enable "Node Size → Linked Mentions" in Obsidian — the most-referenced concepts grow largest,
   creating a visual heat map of your intelligence
3. Query: *"Synthesise the main friction points from the last 20 customer interviews"*

**The Result:** An objective intelligence layer. The Curator weighs a transcript from yesterday
equally with one from six months ago, surfacing the true signal across the full dataset.

---

## D. Software Architects & Development Teams

**The Problem:** Technical documentation dies the moment it is written. Architecture Decision
Records, API specs, and post-mortems get lost in Jira, GitHub, or Confluence. New developers
take months to understand *why* the codebase is built the way it is.

**The Workflow:**
1. Ingest all ADRs, post-mortems, API specs, and README files
2. The Curator builds an Entity graph of microservices, databases, and tools — and a Concept
   graph of design patterns, security protocols, and failure modes
3. New hires query: *"Why did we choose Postgres over MongoDB for the auth service?"*

**The Result:** A conversational Senior Engineer that never leaves. Context and decisions from
years ago are instantly accessible with source citations.

---

## E. Medical & Scientific Researchers

**The Problem:** Scientific knowledge is siloed in dense PDFs. Researchers tracking a specific
disease or compound suffer from context fragmentation — the paper explaining *why* compound X
interacts with protein Y is buried in a folder that hasn't been opened in two years.
Traditional search only finds exact keywords, missing conceptual links.

**The Workflow:**
1. Ingest clinical trial PDFs and academic papers
2. The Curator extracts Entities (genes, proteins, drugs, compounds) and Concepts
   (pathways, methodologies, biomarkers)
3. Query: *"What compounds target BCR-ABL and have clinical results in leukemia?"*

**The Result:** A dynamic biological knowledge graph. The graph reveals hidden intersections —
a compound used in one domain showing efficacy in a completely different study — by visually
bridging entity nodes across the entire literature corpus.

---

## F. Entrepreneurs & Startup Founders

**The Problem:** Founders are bombarded with disparate information: customer interview
transcripts, competitor reports, legal documents, and strategic frameworks. Critical insights
get lost in the noise, leading to repeated mistakes or missed market opportunities.

**The Workflow:**
1. Feed the app customer interviews, investor updates, and market research
2. Look at the graph for Concept clusters forming around recurring themes (e.g. "Onboarding Friction")
3. Query: *"Synthesise the main friction points from the last 20 customer interviews"*

**The Result:** An external "Board of Advisors" built from your own collected intelligence.
Strategic decisions grounded in your full research history, not the last thing you read.

---

## G. Personal Growth & Self-Analysis

**The Problem:** People consume endless self-help content and write journal entries, but rarely
synthesise across it to notice their own behavioral loops. Everything is captured; nothing is
connected.

**The Workflow:**
1. Ingest daily journal entries, book highlights, therapy notes, and podcast summaries
2. The Curator extracts Entities (people, situations, environments) and Concepts
   (anxiety triggers, flow states, core values)
3. Query: *"What recurring themes appear on days where I log high stress?"*

**The Result:** A mirror into your own psychology. The Curator connects dots across months of
journaling with the objectivity of a third party, revealing patterns invisible to the person
living them.

---

## H. Conversation Compounding (v2.5.0+)

Every use case above starts from a *document* — a PDF, an article, a paper. But knowledge also gets created in the act of thinking. The Chat tab is where you brainstorm with the AI, work through a problem, or process notes out loud. Until v2.5.0 those conversations stayed in the chat history and never made it into the wiki. Now they do.

The **Compile to Wiki** button on any chat conversation extracts what was learned — facts, conclusions, new concepts, connections to existing entities — and writes it as wiki pages: a summary plus any new entities/concepts that emerged. The same merge pipeline that handles ingest runs here, so existing entity pages get updated rather than duplicated.

### Concrete examples

- **Decision record after a brainstorm.** "Help me think through whether to switch from Postgres to DuckDB for analytics." Several turns of back-and-forth, then click Compile → a `summaries/postgres-vs-duckdb-decision-2026-04-25-<hash>.md` page captures the conclusion, with `[[postgres]]` and `[[duckdb]]` entity pages updated to reference the new comparison summary.
- **Meeting / dictation processing.** Paste raw meeting notes into the chat: "Here's what we discussed about the Q3 roadmap…" Ask the AI to structure it. Click Compile → a clean summary lands in the wiki, with the entities mentioned (people, projects, dates) cross-linked.
- **Research synthesis.** "Summarise everything I know about RAG and tell me which gaps are biggest in my notes." After the conversation, Compile → the synthesis becomes a permanent wiki page you can revisit instead of re-deriving every time.
- **Content drafting.** Talk through an article outline with the AI. Compile → the outline (and any new concepts you defined during the chat) join the wiki and seed your next writing session.

### How it differs from ingest

| Aspect | Ingest | Compile |
|---|---|---|
| Source | A document on disk | A live conversation |
| Trigger | Drop a file in the Ingest tab | "Compile to Wiki" button in the Chat tab |
| What gets written | Summary + entities + concepts | Same — uses the same write pipeline |
| Re-running | Re-ingests merge new info into existing pages | Refused if the conversation hasn't changed (prevents bullet inflation) |
| Cost | 1 LLM call for a short source (single-pass); 1 planning call + N batch calls for a long one (multi-phase, ~4 pages/call) | 1 LLM call normally; up to 3 if the AI's response is too large and the app retries with a more concise extraction |

### Tip

The conversation isn't deleted when you compile — it stays in the Chat sidebar. So you can keep the brainstorm thread alive, send another message, and compile again later when you've made more progress. The new turn changes the conversation hash, so a fresh summary file is created alongside the previous one — both are kept.

---

## Shared Pattern Across All Use Cases

Every use case above shares the same underlying mechanics:

1. **Ingestion & Atomization** — large documents are decomposed into discrete Entity and Concept pages
2. **Node Generation** — discrete markdown files are created for every major Concept and Entity
3. **Edge Creation** — the AI automatically inserts bidirectional `[[links]]` between related pages
4. **Network Compounding** — subsequent ingests update existing pages rather than duplicating them;
   a second article mentioning Andrej Karpathy adds to his existing page, increasing its graph weight
5. **Contextual Provenance** — every chat answer cites the exact wiki page it came from,
   allowing you to trace any synthesised claim back to its source

The result is always the same: a private neural network of your knowledge domain that grows
smarter with every source you add.

---

# Cohort & Team Use Cases (Shared Brain, `v3.0.0-beta+`)

All the use cases above are for **individual** users. Below are use cases where multiple people contribute to a **shared collective wiki** — the Shared Brain feature.

Each contributor keeps their personal Curator private. Only opted-in domains push synthesised contributions to a shared GitHub repo. The collective wiki comes back as a separate read-only `shared-<slug>/` mirror on every contributor's machine.

> For step-by-step setup, see [`docs/shared-brain-user-guide.md`](shared-brain-user-guide.md). For the architecture and security model, see [`docs/shared-brain.md`](shared-brain.md). For compliance, see [`docs/shared-brain-compliance.md`](shared-brain-compliance.md).

## I. Educational Cohorts (Universities, Bootcamps, Programmes)

A professor leads a 20-student ML reading cohort across one semester. Each student ingests 5-10 papers per week into their personal `work-ai` domain. They opt that one domain into the cohort's Shared Brain.

After each Push, every other student's machine eventually shows the synthesised collective wiki via Pull. The professor (acting as admin) runs synthesis weekly. The cohort ends the semester with a 500-page collective wiki that no single student could have built alone — every paper is in the entity graph, every important concept is cross-referenced.

Privacy: each student's other domains (`personal`, `coursework`, `journal`) never leave their machine. Only the one opted-in `work-ai` domain participates.

**Why Shared Brain wins here**: per-fellow provenance means every student gets credit for their contributions; the LLM-mediated synthesis resolves contradictions between students' interpretations; GDPR Article 17 revocation handles students who drop the course.

## J. Research Teams & Lab Groups

A four-person AI safety research team shares a Slack and a Google Doc but their actual reading is scattered across each person's laptop. They set up a Shared Brain. Each researcher opts their `papers` domain into the brain. Throughout the week, each person ingests papers they're reading; nightly Pull brings everyone's notes into everyone else's `shared-safety/` mirror.

Friday morning: someone opens Claude Desktop with the My Curator MCP. Asks Claude: *"Across our shared brain, which mechanistic-interpretability papers contradict each other on the role of induction heads?"* Claude reads the collective wiki, surfaces three direct contradictions with the source papers cited. The team has a focused 30-minute meeting instead of a vague 2-hour one.

**Why Shared Brain wins here**: 4 researchers × 20 papers/week × 50 weeks = 4000 papers/year. No single person could read all of them. The collective wiki + cross-domain MCP search makes the corpus searchable from a single conversation. Synthesis resolves contradictions automatically.

## K. Consulting Firms — Shared Client Intelligence

A boutique strategy consulting firm has 15 partners + senior associates. Each works on multiple client engagements. The firm's most valuable asset is its *accumulated insight*: which approaches worked for similar problems in past clients, which competitive analyses still hold, which industry expert opinions are most reliable.

They set up a `firm-knowledge` Shared Brain. Each consultant opts in a specific `client-insights` domain (sanitised — no specific client names, just patterns and approaches). The collective wiki becomes the firm's institutional memory. New hires onboard by chatting with it. Senior partners use it to spot patterns across engagements.

**IP mode matters**: the firm picks `organisational` data handling terms at brain setup — employment contracts include IP assignment. The consent text at contributor join time reflects this explicitly.

**Why Shared Brain wins here**: institutional knowledge that survives partner departures. New hires productive faster. Cross-engagement pattern recognition. And the `organisational` IP mode is built-in legal clarity.

## L. Enterprise Knowledge Management (Mid-size SaaS / Tech Companies)

A 50-person SaaS company has hundreds of internal Notion pages, Confluence wikis, Slack archives, support tickets, and PRDs. Most of it is fragmented and stale. The new VP of Engineering pilots a Shared Brain.

Engineers opt one `engineering-knowledge` domain into the brain. They ingest their architectural decision records, post-mortems, internal RFCs, customer support escalations. The synthesised collective wiki becomes the engineering team's reasoning layer — *why* did we choose Postgres, *what* did we learn from the 2025-Q3 outage, *which* customer requests recur in support.

New engineers query Claude: *"Why did we pick PostgreSQL over MongoDB for the auth service?"* Claude reads the collective via MCP, returns the answer with a citation to a 2023 ADR. Onboarding time drops from weeks to days.

**Why Shared Brain wins here**: replaces stale wikis with a compounding, queryable knowledge graph. Per-engineer attribution makes it traceable. The `shared-engineering/` mirror is read-only for direct edits — engineers can't accidentally overwrite the collective; changes always originate in their personal opted-in domain and propagate via Push.

## M. Cross-functional Product Teams

A product team (PM + 3 designers + 4 engineers + 1 researcher) is building a new feature over 6 months. They generate enormous artifacts: research notes, user interviews, design rationales, technical specs, prototype evaluations.

They set up a Shared Brain. Each role opts in one focused domain (`product-research`, `design-rationale`, `eng-decisions`, `user-interviews`). The collective wiki becomes the project's shared memory. Six months later, the team's retrospective is informed by an actually queryable corpus, not just whoever happened to keep good notes.

**Why Shared Brain wins here**: the four professional disciplines have different vocabularies. LLM synthesis resolves terminology differences automatically. Provenance preserves who contributed what insight, useful in retrospectives.

## Pattern across Shared Brain use cases

All cohort & team cases share these properties:

1. **Multiple knowledge workers** producing knowledge in parallel, each with their own focus
2. **Common interest** that benefits from a shared collective view (a domain, a project, a research area)
3. **Asymmetric contribution** — most contributors only need to push what they're reading; one designated admin runs synthesis periodically
4. **Privacy boundary** — contributors keep their other work private; only the explicitly opted-in domain participates
5. **LLM-mediated quality** — synthesis isn't just file merge; it resolves contradictions, unifies formulations, attributes provenance, rebuilds the collective index

If you're a solo user, Personal Sync handles your single-machine-to-single-machine sync. If you're a group, Shared Brain handles many-to-collective. The two features compose: many users can each run Personal Sync (for their own personal brain backup) AND contribute one opted-in domain to a Shared Brain.

---

# Monetizing a Shared Brain — sell access to your expertise

The cohort/team patterns above assume contributors share the brain freely. But Shared Brain's architecture also supports **paid access** — domain experts can charge for access to a brain they curate. This works **today**, with zero code changes, using payment platforms you already know.

## N. Independent Experts Selling Recurring Brain Access

An AI safety researcher has built a personal `ai-safety-reading` domain with 4 years of paper reading — 300+ entities, 800+ concepts, 200+ summaries with synthesis. They turn it into a Shared Brain and offer access at **€15/month** via Gumroad. Buyers pay; the researcher manually adds each as a GitHub collaborator and sends the invite token by email. Each week the researcher continues reading, ingests papers into their personal opted-in domain, runs Push + synthesize → buyers Pull at their leisure.

Buyers get to: read the synthesised wiki locally in Obsidian; chat with it in the Curator's chat tab; query it via Claude Desktop with the My Curator MCP for deep research like *"across this brain, which papers contradict each other on mechanistic interpretability?"* The brain compounds — buyers who joined month 1 see the brain grow with every weekly synthesis.

**Comparable pricing reference**: Substack newsletters (€5-15/mo), Stratechery-style premium analyst subscriptions (€15/mo), Patreon tiers (€3-50/mo). A compounding queryable brain sits at the higher end of this range because the value keeps growing.

**Why Shared Brain wins here**: the brain compounds. Unlike a Notion template (bought once, frozen) or a newsletter (single read, then archived), the brain gets richer every synthesis run and remains searchable via Claude forever.

## O. Artists, Educators, Writers Selling Curated Knowledge

A graphic designer's `visual-references` domain with 10 years of curated inspiration + commentary. A university professor's `cognitive-science` domain with 15 years of paper reading + lecture notes. A novelist's `worldbuilding-research` with historical sources, character archetypes, geographic detail. All these are valuable IP that audiences will pay to access.

**Pattern**: one-time purchase (€20-50) for "lifetime access to the brain in its current state" OR monthly subscription (€8-15/mo) for "ongoing access as it grows".

**Why Shared Brain wins here**: artists and writers spend years building reference libraries. The Curator turns that library into an *interrogable* asset, not just a folder of bookmarks. Buyers can ask Claude *"what visual references did this designer save about brutalism?"* and get a real answer with sources.

## P. Consulting Firms Selling Sanitised Insights to Clients

A boutique strategy firm packages 5 years of pattern recognition across past engagements (anonymised, no client names) as a `firm-patterns` Shared Brain offered to current clients for €2000/month, bundled into engagement fees. Clients get access to the firm's accumulated insight, queryable via Claude.

**Why Shared Brain wins here**: the firm's competitive moat is patterns across engagements that any individual consultant might forget. The brain remembers. Selling access is selling the moat.

## Q. SaaS Companies Selling Domain Expertise to Enterprise Customers

A cybersecurity SaaS has deep internal knowledge about threat actors and CVEs. They package the `threat-intelligence` Shared Brain as a paid add-on for enterprise customers at €10000/year. Customers get queryable access to expertise that informs their security posture — knowledge that no individual analyst could carry.

**Why Shared Brain wins here**: enterprise customers pay for the company's deep expertise as a recurring asset, not just for the software product. This is "expertise as a service".

## Pattern across monetization use cases

All four shapes share these architectural properties (the "gates" — see the [Monetization Guide](shared-brain-monetization.md#2--the-architecture-knowing-the-gates) for the diagram):

1. **GitHub collaborator status** is the actual gate — pay → admin adds → access granted; cancel → admin removes → access revoked
2. **PAT scope** (Read-only vs Read AND Write) lets you offer two tiers without code changes
3. **Invite token** is metadata-only and safe to share via any channel
4. **The Curator app** is free, open source, installs in 5 minutes — buyers self-onboard from your sales-page link

The result: **a no-code or low-code monetization path** that domain experts can launch in a week, using tools they already know (Gumroad, Lemon Squeezy, Stripe).

> 📚 **Full step-by-step**: [`docs/shared-brain-monetization.md`](shared-brain-monetization.md) — pricing models, platform comparison (Gumroad vs Lemon Squeezy vs Stripe), legal/compliance, onboarding email templates, tiered access pattern, and answers to common questions like "can buyers share their access?" and "how do refunds work?"
