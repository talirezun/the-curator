# The Shared Brain: When Second Brains Start Thinking Together

**By Dr. Tali Režun & Dražen Kapusta**
[COTRUGLI Business School](https://cotrugli.eu/) · [COlab](https://cotrugli.eu/) · The Curator Research Series · May 2026

> A collective wiki that multiple people contribute to together — built on plain markdown, Git, and explicit human choice. Each contributor keeps their private brain private. Only the selected contribution becomes shared. This article is the fifth in the series, and the first to explore the [Shared Brain](../../docs/shared-brain.md) feature introduced in **The Curator v3.0.0-beta**.

> *From Lab to Life Series · The Curator: Article 5*

---

## Table of Contents

1. [The question every organisation avoids](#the-question-every-organisation-avoids)
2. [From personal second brain to shared intelligence](#from-personal-second-brain-to-shared-intelligence)
3. [What The Curator does](#what-the-curator-does)
4. [Why we needed a Shared Brain](#why-we-needed-a-shared-brain)
5. [What Shared Brain is](#what-shared-brain-is)
6. [How it works without the technical jargon](#how-it-works-without-the-technical-jargon)
7. [Why this matters for education](#why-this-matters-for-education)
8. [Why this matters for organisations](#why-this-matters-for-organisations)
9. [Why this matters for AI agents](#why-this-matters-for-ai-agents)
10. [The beauty of plain text](#the-beauty-of-plain-text)
11. [What is real now, and what comes next](#what-is-real-now-and-what-comes-next)
12. [What this opens](#what-this-opens)
13. [A practical invitation](#a-practical-invitation)
14. [About the Authors](#about-the-authors)
15. [Disclaimer](#disclaimer)
16. [Discussion & Comments](#discussion--comments)

---

## The question every organisation avoids

What happens to the real knowledge inside an organisation when the people who carry it leave?

Not the documents. Organisations have more documents than ever: Notion pages, Confluence wikis, shared drives, archived slide decks, final reports, and folders named some version of *Final_v3_REAL_FINAL_USE_THIS.pdf*.

We are talking about something deeper: the reasoning behind decisions, the pattern recognition built over years, the understanding of why something was tried, why it failed, what was learned, and what should never be repeated.

This is the invisible intelligence of an organisation.

In most companies, research labs, universities, and professional communities, that intelligence still lives primarily inside individual human minds. When people leave, retire, move on, burn out, or simply stop being available, a significant part of that intelligence disappears with them.

Not because people are selfish. Because we never had a practical infrastructure designed to capture, structure, attribute, and compound what they know.

This is the problem [**The Curator**](https://github.com/talirezun/the-curator) has been designed to address.

And with the release of [**The Curator v3.0.0-beta**](https://github.com/talirezun/the-curator/releases), we believe we have taken the most meaningful step so far.

The feature is called [**Shared Brain**](../../docs/shared-brain.md).

It turns individual second brains into a shared, attributed, AI-queryable knowledge graph — without forcing contributors to surrender privacy, ownership, or control.

For us, this is not just a product feature. It is the first practical step toward a broader vision we have been developing at [COTRUGLI Business School](https://cotrugli.eu/): how individuals, teams, cohorts, and organisations can build collective intelligence without flattening individual sovereignty.

At COTRUGLI, this will be tested in a very concrete setting: through the [Vanguard MBA](https://cotrugli.eu/) and COTRUGLI learning ecosystem, where students, executives, founders, and researchers are learning to work with AI not only as a tool, but as a cognitive partner.

The Shared Brain is one of the simplest ways to make that shift practical.

---

## From personal second brain to shared intelligence

The story of The Curator began with a powerful idea from [Andrej Karpathy](https://karpathy.ai), one of the most influential thinkers in artificial intelligence.

Karpathy described what he called the [**LLM Wiki pattern**](https://github.com/karpathy/LLM-wiki): instead of using AI only to search through documents, what if we used AI to continuously build and maintain a structured wiki?

Not a folder of files. Not a chat interface over PDFs. A living, interlinked knowledge base.

Every time a new article, paper, transcript, book highlight, or internal document is added, the AI does not merely index it. It reads it, extracts the key knowledge, updates existing pages, creates new links, detects contradictions, and integrates the new material into the structure that already exists.

The knowledge compounds.

Karpathy's architectural metaphor was elegant: [Obsidian](https://obsidian.md) is the IDE, the LLM is the programmer, and the wiki is the codebase.

That idea was beautiful. But for most people, the implementation was too technical.

That gap is where The Curator was born.

---

## What The Curator does

[The Curator](https://github.com/talirezun/the-curator) is a local, open-source application that automates the LLM Wiki pattern and makes it usable by people who are not engineers.

You install it on your computer. It runs locally. You drag in documents: PDFs, articles, papers, transcripts, notes, book highlights, and research material. The Curator reads them, extracts the key knowledge, and organises it into a structured wiki of plain markdown files.

The architecture is built around what we call [**Atomic Decomposition**](../../docs/architecture.md#design-decisions).

It produces three types of interconnected pages:

- **Entities are the nouns**: people, organisations, companies, tools, institutions, places, and named objects. Andrej Karpathy is an Entity. COTRUGLI Business School is an Entity. The Curator is an Entity.
- **Concepts are the ideas**: frameworks, principles, methods, theories, patterns, and recurring themes. Compounding knowledge is a Concept. Human-AI teaming is a Concept. Collective intelligence is a Concept.
- **Summaries are the narratives**: one per source, distilling the key ideas and linking them back to the Entities and Concepts they introduced.

Every page links to other pages using Obsidian's wiki-link syntax. Every new source deepens the graph. Over time, the structure becomes more than notes. It becomes a map of your thinking.

After a few months of use, you have a [second brain](./the-second-brain-that-grows-smarter.md). After years, you have something closer to an intellectual autobiography: a durable, searchable, machine-readable record of how your understanding evolved.

Until now, this was mostly personal.

The [Shared Brain](../../docs/shared-brain.md) changes that.

---

## Why we needed a Shared Brain

While building The Curator, we were also developing a broader thesis at COTRUGLI called **Beautiful Mind**.

The central idea is simple but important:

Individual intelligence is powerful. But collective intelligence, when it is properly structured, attributed, governed, and connected to AI systems, can become something of a different order.

The challenge is that most collective-intelligence systems force a bad trade-off.

Either people keep their knowledge private, and the organisation never learns properly.
Or they push everything into a shared platform, and individual ownership, context, nuance, and privacy disappear.

We wanted a third path.

A system where each person can maintain their own private second brain, on their own machine, under their own control — and then contribute only the specific [domains of knowledge](../../docs/domains.md) they choose to share.

Not everything. Not their journal. Not private notes. Not unfinished thinking. Not unrelated work.

Only the selected contribution.

This is the core principle of Shared Brain:

> **Private brains remain private. Shared intelligence is built only from explicit contributions.**

That one design choice changes everything.

---

## What Shared Brain is

A [**Shared Brain**](../../docs/shared-brain.md) is a collective Curator wiki that multiple people contribute to together.

It can be used by a student cohort, a research team, a company department, a consulting firm, a product team, an alumni community, or a group of independent thinkers working on a shared domain.

Each participant keeps their own personal Curator brain locally. They then choose one domain to contribute to the collective.

For example:

- A student may contribute their AI research domain.
- A consultant may contribute a sanitised client-insights domain.
- An engineer may contribute architectural decision records.
- A researcher may contribute notes from a specific literature stream.
- A founder may contribute strategic lessons from a market-building project.

The contributed knowledge is pushed to a shared Git repository. The Curator then synthesises contributions into a [collective wiki](../../docs/shared-brain.md#how-it-works).

This is not just file merging.

The synthesis process compares contributions, resolves broken links, enriches sparse pages, detects conflicting formulations, preserves attribution, and rebuilds the collective knowledge graph.

Each participant can then pull the synthesised Shared Brain back to their own machine as a separate, read-only domain. They can browse it in Obsidian, query it in The Curator, or use it through the [**My Curator MCP**](../../docs/mcp-user-guide.md) with frontier AI models.

The result is a living knowledge graph that no single person could have built alone.

---

## How it works without the technical jargon

Imagine a team of five researchers working on AI governance. Each researcher has The Curator installed locally. Each has a private second brain containing their reading, notes, sources, and personal thinking. They decide to create a Shared Brain around one domain: AI governance research.

The workflow is simple.

**First, each researcher works normally.** They ingest papers, articles, notes, and reports into their own Curator domain. The Curator extracts Entities, Concepts, and Summaries as usual. Nothing changes in their daily work.

**Second, when they are ready, they push selected contributions.** The Curator compresses the meaning of their recent work into structured contribution summaries. The raw private brain does not leave their machine.

**Third, the Shared Brain admin runs synthesis.** The Curator reads the contributions, integrates them, resolves conflicts where possible, preserves attribution, and produces a collective wiki. (See the [admin operations guide](../../docs/shared-brain-admin.md) for the operational details.)

**Fourth, everyone pulls the result.** A new shared domain appears locally on each participant's machine. It is readable, searchable, browsable, and AI-queryable.

The shared state can start on GitHub because GitHub is familiar, robust, and easy for teams to set up. But the deeper architectural point is not GitHub itself. The deeper point is that the knowledge lives in standard files, in a standard version-controlled structure, and can later move to self-hosted infrastructure if an organisation requires it.

There is no proprietary knowledge-management platform to trust. There is no database format that only one vendor can read. There is no cloud system that must exist forever for your knowledge to remain accessible.

At its core, the Shared Brain is built from plain markdown files, [Git](https://git-scm.com), local software, and explicit human choice.

The simplicity is not a compromise. It is the architecture.

---

## Why this matters for education

Our first serious use case is education.

At COTRUGLI, we are especially interested in what this means for executive education, MBA cohorts, doctoral research, and leadership development in the AI era.

The old model of education assumed that knowledge moved mainly from professor to student.

The new model is different.

In an AI-rich learning environment, every serious student can build a [second brain](./the-second-brain-that-grows-smarter.md). Every cohort can build a [Shared Brain](../../docs/shared-brain.md). Every course can leave behind not only assignments and grades, but a structured knowledge graph created by the cohort itself.

Imagine a professor leading a 20-student cohort over one semester.

Each student contributes their selected reading domain. Each week, the Shared Brain is synthesised. By the end of the semester, the cohort has a collective wiki containing hundreds of pages: papers, concepts, thinkers, cases, frameworks, contradictions, and open questions.

Every contribution is attributed.

Every student keeps their private notes private.

The cohort leaves with something more valuable than a folder of slides. It leaves with a living memory of what it learned together.

This is how we believe leadership education changes in the AI era: not by adding a chatbot to a course, but by teaching people how to build, maintain, and govern shared intelligence.

---

## Why this matters for organisations

The same principle applies inside companies.

Most enterprise knowledge-management systems fail because they treat knowledge as content storage. But the most valuable organisational knowledge is not content. It is *context*.

- Why did we choose this architecture?
- Why did this client relationship succeed?
- Why did this product launch fail?
- What did the senior engineer know that was never written down?
- What pattern did the sales team see across five markets?
- What did the leadership team learn during a crisis that should not be lost?

A Shared Brain gives organisations a practical way to preserve this context.

A 50-person software company could create a Shared Brain for architectural decision records, post-mortems, internal RFCs, and engineering lessons learned. A new engineer joining the company could ask: *"Why did we choose PostgreSQL over MongoDB for the authentication service?"* Instead of asking three senior people and hoping someone remembers, the AI can query the Shared Brain and return the answer with references to the relevant decision record, concepts, and contributors.

A consulting firm could create a sanitised client-insights brain where consultants contribute patterns without exposing confidential client information.

A product team could create a six-month Shared Brain across product, design, engineering, research, and customer success.

A research lab could build a living literature graph where contradictions between papers are not hidden, but surfaced.

This is not document management.

It is **institutional memory with attribution**.

(For the legal and operational dimensions — GDPR, IP, EU residency — see the [Shared Brain compliance reference](../../docs/shared-brain-compliance.md).)

---

## Why this matters for AI agents

The most important reason Shared Brain matters may be AI agents. Agents are becoming more capable, but they still fail in predictable ways. They lose context. They repeat old work. They rederive what the organisation already knows. They make decisions without enough memory. They act as if every conversation starts from zero.

That is not how serious work gets done.

Serious work depends on accumulated context. The [**My Curator MCP**](../../docs/mcp-user-guide.md) gives AI models structured access to a Curator wiki. This is not simple keyword search. It allows graph-native access: following links, reading backlinks, moving from Entities to Concepts to Summaries, and understanding the topology of knowledge.

When this is applied to a Shared Brain, an AI model can reason across the combined knowledge of a team.

It can ask:

- Which concepts are central to this group's thinking?
- Where do contributors disagree?
- Which assumptions appear repeatedly but were never tested?
- Which papers contradict each other?
- Which ideas are isolated and underdeveloped?
- Which past decisions are relevant to the problem we are facing now?

For AI agents, a Shared Brain becomes more than a knowledge base. It becomes a **memory layer** grounded in accumulated human understanding. That is why we see Shared Brain as part of a larger shift: from AI as a tool that answers prompts, toward AI as a cognitive partner operating inside structured, governed, and attributed knowledge environments. (We explored the broader memory landscape in [Article 4 of this series](./the-agent-memory-problem.md).)

---

## The beauty of plain text

One reason we are excited about this architecture is that it is technologically modest. The most durable knowledge format ever invented is still plain text. Not a proprietary database. Not a closed SaaS platform. Not an API-dependent service that may change pricing, disappear, or lock users into a format they cannot easily leave. Plain text is readable by humans and machines. It can be opened now, and it will almost certainly be openable decades from now.

The Curator stores its knowledge as markdown files in folders on your machine. [Obsidian](https://obsidian.md) can read them. [Claude](https://claude.ai) can read them. Any text editor can read them. A future system we have not yet invented will still be able to read them.

The Shared Brain builds on that same foundation.

It is powerful not because it hides complexity behind another platform, but because it makes collective intelligence possible using simple, inspectable, portable building blocks.

Markdown. Git. Local software. Explicit sharing. Attribution. AI-assisted synthesis.

That is enough to begin.

---

## What is real now, and what comes next

We want to be precise about where the product stands. [The Curator v3.0.0-beta](https://github.com/talirezun/the-curator/releases) is a beta release. The [Shared Brain](../../docs/shared-brain.md) feature is ready for teams, cohorts, labs, and organisations willing to work with the current setup process. Git-based storage is usable now. In a future version, [Cloudflare R2](https://www.cloudflare.com/developer-platform/r2/) will provide an additional storage option for organisations with specific data-residency or deployment requirements. The admin tools will improve. Contributor management will become smoother. Revocation workflows will mature. Synthesis will become smarter. Enterprise deployment will become easier.

But the core is already here.

A group of people can now contribute selected knowledge domains into a collective, attributed, AI-queryable wiki while keeping their private brains private.

That is a real step.

---

## What this opens

For universities, this opens the possibility of cohort-level learning memory. For research teams, it opens a way to build living literature maps that no individual could maintain alone. For companies, it opens a practical path toward preserving institutional memory. For consulting firms, it opens a way to compound expertise without exposing sensitive client material. For leadership programs, it opens a new type of learning infrastructure where human-AI collaboration is not discussed abstractly, but practiced every week.

For AI agents, it opens a memory layer grounded in human-created, attributed, structured knowledge.

And for us at COTRUGLI, it opens the first practical implementation of a larger idea: that the future of intelligence is not only artificial, but also individual.

It is shared, structured, governed, and compounded.

---

## A practical invitation

The best way to understand Shared Brain is not to debate it theoretically. Start small. One cohort. One team. One domain. One shared Git repository. One weekly synthesis cycle.

Ask each participant to contribute only the knowledge they explicitly choose to share. Keep everything else private. After a few weeks, observe what begins to happen.

The group starts seeing patterns it could not see before. New members can enter the conversation faster. AI models stop behaving like disconnected chatbots and start working inside accumulated context.

The organisation begins to remember. That is the promise of the Shared Brain. The second brain was always the beginning. The Shared Brain is where it becomes something we can build together.

---

The Curator v3.0.0-beta is available as an [**open-source**](https://github.com/talirezun/the-curator), local-first, privacy-first application. [Shared Brain](../../docs/shared-brain.md) is an opt-in beta feature for cohorts, research teams, organisations, and communities that want to build collective intelligence without giving up individual control.

To get started, follow the [Shared Brain User Guide](../../docs/shared-brain-user-guide.md) (step-by-step setup for contributors and admins), browse the [architecture deep dive](../../docs/shared-brain.md), or review the [compliance reference](../../docs/shared-brain-compliance.md) before deploying inside an organisation.

---

## About the Authors

**Dr. Tali Režun** is a Serial Entrepreneur, Business Developer, and Academic at the forefront of frontier technologies. As Vice Dean of Frontier Technologies at [COTRUGLI Business School](https://cotrugli.eu/), he leads AI innovation initiatives and shapes MBA curricula for the next generation of technology leaders. With over 30 years of entrepreneurial experience — founding and scaling ventures including The Curator, Lumina AI, Moj AI, Block Labs, CR Systems, 4thTech, Immu3, PollinationX, and Online Guerrilla — he bridges cutting-edge research in AI and Web3 with practical business transformation.

**Tali's Links:**
- [talirezun.com](https://talirezun.com/)
- [X (formerly Twitter)](https://x.com/talirezun)
- [LinkedIn](https://www.linkedin.com/in/talirezun)
- [ResearchGate](https://www.researchgate.net/profile/Tali-Rezun)
- [Substack](https://talirezun.substack.com/)
- [COTRUGLI Profile](https://cotrugli.org/talirezun/)

**Dražen Kapusta** is the Principal and Founder of [COTRUGLI Business School](https://cotrugli.eu/), Co-Founder and CEO of HashNET Technologies, and the architect of the Vanguard Leadership Framework (VLF). He advises UNIDO and EU bodies on AI and blockchain strategies, and is co-author of *The Great Reckoning: Vanguard Leadership in the Age of Intelligent Machines*, *The ØØT Manifesto*, and (with Dr. Tali Režun) *The Energy and Water Footprint of Generative AI*. His work on the Beautiful Mind vision and the operational frameworks of the COTRUGLI CO Lab forms the conceptual backbone of how Shared Brain is being applied across leadership education and collective-intelligence research.

**Dražen's Links:**
- [COTRUGLI Business School](https://cotrugli.eu/)
- [LinkedIn](https://www.linkedin.com/in/drazenkapusta/)

---

## Disclaimer

### Research and Educational Purpose

This article is published for research and educational purposes only. The content represents the authors' personal experiences, observations, and analysis based on extensive hands-on experimentation with The Curator, Shared Brain, and AI agent technologies.

### No Commercial Relationships

The authors have not been compensated, sponsored, or otherwise financially supported by any of the companies, platforms, or tools mentioned in this article. All opinions, assessments, and recommendations are their own and based solely on independent research and practical experience.

### Beta Software

The Curator v3.0.0-beta and the Shared Brain feature are pre-release software. Behaviour, file formats, configuration paths, and admin workflows may change between the beta and the general-availability release. Treat any cohort or organisational deployment as an experiment and keep independent backups of contributed knowledge until you are confident the system meets your operational requirements. Always read the [release notes](https://github.com/talirezun/the-curator/blob/main/CLAUDE.md) before updating.

### Individual Research Required

Readers are strongly encouraged to:

- Conduct their own independent research before adopting any AI or collective-intelligence technology
- Evaluate tools and platforms based on their specific use cases, requirements, and risk tolerance
- Test systems thoroughly in controlled environments before production deployment
- Consult with relevant technical, legal, and security professionals — especially around the [compliance and IP terms](../../docs/shared-brain-compliance.md) of a Shared Brain deployment
- Stay informed about evolving best practices, security considerations, and regulatory requirements

### No Guarantees or Warranties

While every effort has been made to ensure accuracy based on research and experience, the authors make no guarantees regarding the performance, reliability, security, or suitability of any technology described here for any particular purpose. Technology capabilities and limitations may vary significantly based on implementation details, use cases, and environmental factors.

### Evolving Landscape

The AI and collective-intelligence ecosystem is developing rapidly. Tools, platforms, protocols, and best practices referenced in this article may be superseded, deprecated, or fundamentally changed by the time you read this. Always verify current capabilities and recommendations with primary sources and official documentation.

### Your Responsibility

You are solely responsible for evaluating whether and how to implement AI technologies in your specific context. Consider your risk tolerance, regulatory requirements, security needs, and organisational capabilities before implementation.

---

## Discussion & Comments

Have thoughts on collective intelligence, the Shared Brain architecture, or how you are using your own knowledge graph inside a team, cohort, or organisation?

**We'd love to hear from you.** Please use the [Discussions](https://github.com/talirezun/the-curator/discussions) tab in the GitHub repository to share your ideas, ask questions, or discuss your own use cases.

You can also open an [Issue](https://github.com/talirezun/the-curator/issues) if you've found a bug or have a feature request.

---

**Dr. Tali Režun** & **Dražen Kapusta**
[COTRUGLI Business School](https://cotrugli.eu/) · COlab · The Curator Research Series

**Connect:**
- Tali — [LinkedIn](https://linkedin.com/in/talirezun) · [X (formerly Twitter)](https://x.com/talirezun) · [GitHub](https://github.com/talirezun/the-curator)
- Dražen — [LinkedIn](https://www.linkedin.com/in/drazenkapusta/) · [COTRUGLI Business School](https://cotrugli.eu/)

---

*Published: May 19, 2026*
*Part of: [The Curator Research Series](https://github.com/talirezun/the-curator/tree/main/research)*
*Previous in series: [The Second Brain That Grows Smarter and Lives on Your Computer](./the-second-brain-that-grows-smarter.md) · [Building Knowledge Immortality Through the Second Brain Architecture and The Curator App](./knowledge-immortality-second-brain.md) · [From Graph to Intelligence: The My Curator MCP and the Art of Querying Your Second Brain](./from-graph-to-intelligence-my-curator-mcp.md) · [The Agent Memory Problem — And Why Your Second Brain Might Be the Answer](./the-agent-memory-problem.md)*
*Open source | Local-first | Privacy-first*
