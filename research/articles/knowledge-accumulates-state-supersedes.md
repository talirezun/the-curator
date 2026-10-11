# Knowledge Accumulates, State Supersedes

## Structuring and Carrying Context for Multi-Session, Multi-Harness AI Agent Work — A Design Study of The Curator, an Open-Source Context Engine

**By Dr. Tali Režun**
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)

Research article · October 2026 · Software version described: The Curator v3.81.0

Software: [github.com/talirezun/the-curator](https://github.com/talirezun/the-curator) · Website: [mycurator.xyz](https://mycurator.xyz) · User guide: [docs/user-guide.md](../../docs/user-guide.md)

> The research paper behind the series. Three kinds of context, told apart by how each must behave when it is written to — knowledge that accumulates, working state that supersedes, canonical documents replaced whole — and an open, local-first implementation that carries them across sessions, agent harnesses, models and machines, with small, dated measurements of whether agents actually read and save them.
>
> *From Lab to Life Series · The Curator: Article 12 — research paper*

> **About this repository copy.** The paper is published on ResearchGate ([read it on ResearchGate](https://www.researchgate.net/publication/415028893_Knowledge_Accumulates_State_Supersedes_Structuring_and_Carrying_Context_for_Multi-Session_Multi-Harness_AI_Agent_Work_-A_Design_Study_of_The_Curator_an_Open-Source_Context_Engine)). It describes The Curator **v3.81.0** (30 September 2026); this copy was prepared on 11 October 2026 and checked against **v3.82.1**. The text, tables, figures and reference list are the paper's own. What this copy adds is links: where the paper names a part of the product, the name links to the section of the documentation that describes it. Every factual statement about the product was checked against the code and documentation at v3.82.1 — the 24 MCP tools, the store's limits, the seven reading-budget presets, the start states, the per-tool scope default, the measurements and their dates — and held. Two statements are narrower in the code than in a sentence, and each carries a bracketed *repository note* rather than an edit. The five figures are the paper's own diagrams, re-encoded without metadata; none shows personal data.

---

## Contents

- [Abstract](#abstract)
- [1. Introduction](#1-introduction)
- [2. Background and Related Work](#2-background-and-related-work)
- [3. Research Approach](#3-research-approach)
- [4. A Model of Context for Agent Work](#4-a-model-of-context-for-agent-work)
- [5. The Curator: Architecture](#5-the-curator-architecture)
- [6. Budgeting Context: The Right Context, Not All of It](#6-budgeting-context-the-right-context-not-all-of-it)
- [7. Portability Across Harnesses, Models and Machines](#7-portability-across-harnesses-models-and-machines)
- [8. Evidence](#8-evidence)
- [9. Discussion](#9-discussion)
- [10. Limitations and Threats to Validity](#10-limitations-and-threats-to-validity)
- [11. Open Questions and Future Work](#11-open-questions-and-future-work)
- [12. Conclusion](#12-conclusion)
- [Software, Documentation and Data Availability](#software-documentation-and-data-availability)
- [Glossary](#glossary) · [Acknowledgements](#acknowledgements) · [Declarations](#declarations) · [References](#references)
- [Appendix A. The Handoff's Sections and the Store's Limits](#appendix-a-the-handoffs-sections-and-the-stores-limits)
- [Appendix B. The Shape of a Standing Brief](#appendix-b-the-shape-of-a-standing-brief)

---

## Abstract

Large language model (LLM) agents now carry out work that outlasts a single session: building software, running literature reviews, writing books, producing campaigns. Every session, however, begins with an empty context window, and when the work moves to a different agent harness, a different model or a different computer, whatever the previous session knew is lost. This article argues that the binding constraint in such work is the session boundary rather than the size of the context window, and that the remedy is to treat context as owner-controlled infrastructure with an explicit structure. I propose a model of context for agent work that distinguishes three kinds by how they must behave when written to: compounded knowledge, which accumulates; volatile working state, which supersedes; and canonical documents, which are replaced whole and read verbatim. I then describe The Curator, an open-source, local-first application built in public over six months and more than 200 releases, which implements this model as plain markdown files in a folder the user owns, synchronised through the user's own private repository and read and written by any agent harness through the Model Context Protocol. The system spans three audiences — the individual's second brain, a team's shared brain, and the agents' working context — within one store. I report small, dated measurements: carrying working state moved an agent's identification of the correct next priority from 0 of 4 to 8 of 8 runs, and suppressed proposals the project had already ruled out; the reliability of saving depended far more on where an instruction was placed than on how it was worded; and a handoff cured ignorance but not disagreement. The article closes with limitations and open questions for a field in which context has become the principal determinant of output quality.

**Keywords:** context engineering; LLM agents; agent memory; working state; session continuity; agent harness; Model Context Protocol; personal knowledge management; second brain; organisational memory; local-first software

## 1. Introduction

### 1.1 The problem

An LLM reasons only over what is in its context window: the instructions it was given, the documents placed in front of it, the conversation so far and the results of the tools it has called. What is not in the window does not exist for the model. For a single question this is rarely a difficulty. For work that takes weeks — a production application, a research programme, a book — it is the central difficulty, because such work is carried out across many sessions, and every session starts empty.

The industry's most visible response has been to enlarge the window. Frontier models commonly offer around one million tokens today, where two hundred thousand was generous eighteen months ago. Larger windows help, but they do not address the problem this article is about, for two reasons. First, usable context is smaller than advertised context: model performance degrades as input grows, well before the nominal limit (Hong et al., 2025; Liu et al., 2024). Second, and more fundamentally, a session ends. The next one starts at zero whatever the size of the window, and if it starts in a different tool, on a different model or on a different machine, it starts at zero in a place that has never seen the first one.

**The context window is not the binding constraint in multi-session work. The session boundary is.**

### 1.2 Why it matters now

Two developments have made the session boundary more costly. The first is that agentic work has become long-horizon by default. Agent harnesses — the software that wraps a model with file access, tools, a terminal, permissions and a control loop, such as Claude Code, Codex, Cursor, Antigravity or opencode — now routinely carry out tasks that span dozens or hundreds of sessions.

The second is that serious practitioners increasingly use several harnesses and several models deliberately. Models are not interchangeable: some are stronger at construction, others at review, and a model is a weak auditor of its own output. Vendor harnesses are also economically distinct, since subscription plans bundled with a vendor's harness can, in the author's experience, provide considerably more usage than equivalent pay-per-token access (Section 7.1). The rational workflow is therefore a *mixed fleet* — building in one harness, auditing in another — and every crossing between them is a session boundary at which context is lost. Each harness keeps its own memory in its own place (CLAUDE.md, AGENTS.md, GEMINI.md, project settings, conversation history), so the cost of crossing is paid in the most expensive currency available: the practitioner's time, spent re-explaining the project.

### 1.3 Research questions

This article addresses five questions:

1. **RQ1.** Why does the loss of context across sessions and harnesses matter, and where does it bite?

2. **RQ2.** What kinds of context does agent work require, and how must each behave when it is written to?

3. **RQ3.** How can that context be made portable across sessions, harnesses, models and machines without being held by any single vendor?

4. **RQ4.** How much context should an agent receive at the start of a session, and how can that choice be made visible?

5. **RQ5.** Do agents actually read and save such context in practice, and what determines whether the discipline holds?

### 1.4 Contributions

The article makes four contributions:

- **A model of context for agent work** that separates three kinds of context by their write semantics — accumulate, supersede, replace whole — and relates them to three audiences: the individual, the team and the agents (Section 4).

- **An open, implemented architecture** — The Curator — that realises the model as plain files owned by the user, with a published on-disk format, a harness-neutral access protocol and a transport design for several tools and several computers (Sections 5–7).

- **A budgeting principle for session start**, "the right context, not all of it", with a visible instrument for applying it (Section 6).

- **Small, dated empirical findings** on whether carrying state changes agent behaviour and on what makes agents actually save it (Section 8), reported with their limits.

> **In plain terms.** Every AI agent is like a brilliant new colleague who forgets everything at the end of each day. This paper asks what to hand that colleague each morning, how that material should be organised, how much of it to hand over, and how to make sure it follows the work when it moves to a different tool or computer.

## 2. Background and Related Work

### 2.1 Context windows and their limits

Two lines of evidence establish that more context is not automatically better. Liu et al. (2024) showed that models use information at the beginning and end of long inputs more reliably than information in the middle. Hong, Troynikov and Huber (2025) evaluated a range of frontier models and found that performance degrades as input length grows, even on simple tasks — a phenomenon they called *context rot*. The practical implication, which Anthropic's engineering guidance on context engineering also draws (Anthropic, 2025), is that context is a finite resource to be spent deliberately: the aim is the smallest set of high-signal tokens that makes the desired outcome likely.

### 2.2 Memory for LLM agents

A substantial literature addresses memory for LLM agents. MemGPT treats the context window as main memory and pages information to and from external storage (Packer et al., 2023). Generative Agents maintain a memory stream with retrieval by recency, importance and relevance, and a reflection step that synthesises higher-level observations (Park et al., 2023). The Cognitive Architectures for Language Agents framework organises agent memory into working, episodic, semantic and procedural components (Sumers et al., 2024), a distinction borrowed from cognitive psychology (Tulving, 1972). Production systems such as Mem0 (Chhikara et al., 2025) and Zep with its temporal knowledge graph (Rasmussen et al., 2025) extract, consolidate and retrieve facts across conversations; tools such as claude-mem add persistent memory to specific coding harnesses (thedotmack, n.d.). Surveys summarise the space (Zhang et al., 2024).

These systems share two properties that distinguish them from the problem addressed here. They are mostly *automatic* — memory is extracted and retrieved by the system, usually through embeddings — and they are mostly *homogeneous*: a memory is a memory, stored and merged by one rule. Neither property is wrong, but together they leave a gap for work whose context includes things that must be carried verbatim, things that must be overwritten, and things that must accumulate, and whose owner needs to read, edit and move all of it.

### 2.3 Retrieval versus compiled knowledge

Retrieval-augmented generation (Lewis et al., 2020) re-derives relevant knowledge from source documents at query time; graph-based variants build an entity graph to support global questions (Edge et al., 2024). In April 2026 Karpathy (2026) proposed an alternative pattern for personal knowledge bases: rather than retrieving from raw documents on every question, an LLM incrementally builds and maintains a persistent, interlinked wiki of markdown files, so that knowledge is compiled once and kept current. The Curator began as an implementation of that pattern.

### 2.4 Personal and organisational memory

The idea of an external, associative store of one's reading reaches back to Bush's Memex (Bush, 1945) and to Luhmann's Zettelkasten, popularised for contemporary knowledge work as the "second brain" (Ahrens, 2017; Forte, 2022). At the group level, transactive memory theory describes how teams distribute knowledge across members and rely on knowing who knows what (Wegner, 1987), and the knowledge-creation literature emphasises the movement of knowledge between individual and collective (Nonaka & Takeuchi, 1995). The local-first software movement argues that users should own their data in files they control, with collaboration layered on top rather than mediated by a vendor's server (Kleppmann et al., 2019). The design described here draws on all three: a personal store, a collective layer, and ownership by the user.

### 2.5 Vendor memory and harness instruction files

Vendors are building memory into their products. In August 2026, for example, Anthropic unified Claude's memory across its chat and agent products and exposed what it retains for inspection and editing (Anthropic, 2026). Coding harnesses read standing instructions from project files — CLAUDE.md for Claude Code, and the open AGENTS.md format, now stewarded under the Linux Foundation and read by many harnesses (AGENTS.md, n.d.). These mechanisms are valuable within one product. By construction, however, a vendor's memory lives inside that vendor's product, and instruction files are read by some harnesses and not others, so neither carries a project across the boundaries this article is concerned with.

### 2.6 The Model Context Protocol

The Model Context Protocol (MCP), introduced by Anthropic in November 2024 and since adopted across the industry, defines how an AI client launches or connects to a server and calls its tools (Anthropic, 2024). Its significance here is structural: a context store exposed as an MCP server can be read and written by any harness that implements the protocol, without integration work per vendor.

### 2.7 The gap

To the author's knowledge, no existing system combines (a) an explicit distinction between context kinds by write semantics, (b) storage as plain, user-owned files with a published format, (c) harness-neutral access, (d) transport across the user's own machines without a third-party service, and (e) a single store serving the individual, the team and the agents. That combination is the design space this article explores.

> **In plain terms.** Many teams are building "memory" for AI. Most of it is automatic and lives inside one product. What was missing was a way to keep a project's context as ordinary files you own, organised by how each piece behaves, readable by any AI tool, and movable between your computers.

## 3. Research Approach

### 3.1 Design science as method

This work follows a design-science approach (Hevner et al., 2004): a problem is identified in practice, an artefact is designed and built to address it, and the artefact is evaluated against the problem, with each evaluation feeding the next design cycle. Here the artefact is an open-source application, and the design cycles are its public releases.

### 3.2 The practitioner baseline

I did not begin from theory. For roughly three years I ran a manual context-engineering protocol across several large codebases, each built across hundreds of agent sessions in several harnesses. The protocol had three phases. First, research and foundations: before any building, I used AI to produce foundational documents — architecture, feature blueprint, interface design, security, deployment — refined until correct. Second, the build: agents worked against those documents, and at roughly 80% of the context window I would stop and ask the agent to write a detailed handoff file stating what had been done, what had been decided and ruled out, and what came next, which the next session read first. Third, audit and deployment, ideally by a different model from the one that built the system.

The protocol worked. It produced, among others, Lumina, a production application of 2,314 commits; a real-time avatar platform built for a client (approximately 400 commits); and The Curator itself (approximately 1,400 commits), which was built by the manual protocol until its own context layer could carry its development. I have no controlled measurements from this period; what it provides is a baseline practice, a set of failure modes observed repeatedly, and the design requirements for automating it. Its most persistent weakness was structural: the handoff was written at 80% of the window, by a model that had already begun to lose the beginning of the session.

### 3.3 Building in public

The Curator has been developed openly since April 2026 under the MIT licence, with more than 200 versioned releases to v3.81.0 on 30 September 2026. On that date the repository had 97 stars and 15 forks. Every release carries a changelog entry recording what changed, why, what was measured and what remains unfixed. At v3.81.0 the project runs 275 offline test suites, and guards are proven by mutation: the relevant code is deliberately broken, the suite must fail for a behavioural reason, and the code is restored and verified by checksum. Documentation ships in the same release as the behaviour it describes, on the principle that several documents are read by models rather than people, so a false sentence changes what an agent does.

### 3.4 Evaluation

Three kinds of evidence are reported. **Controlled small-N measurements** run a fixed task in isolated stores, headless, typically four or eight runs per condition, with the model, harness version and date recorded. **Live tests** are observations of real handovers between harnesses and computers on my own projects. **Naturalistic readings** come from the store's own logs during daily use. None of these is a benchmark. They establish the shape and direction of effects, and they are reported as counts out of N rather than percentages, to avoid implying a precision they do not have.

### 3.5 Position of the researcher

I am the designer, developer and principal user of the system described. This creates obvious risks of bias, which I address by reporting measurements that were unfavourable to my own design (for example, an agent saving in 0 of 4 runs), by naming what has not been measured, and by publishing the code, format and measurement records so that others can check them.

## 4. A Model of Context for Agent Work

### 4.1 Context, defined operationally

For the purposes of this article, *context* is everything a model can observe when it produces an output. For long-horizon work the relevant question is which parts of that context must survive a session boundary, and how each part should be stored so that it remains correct.

### 4.2 Three kinds of context

Observation of the manual protocol suggested that the material carried across sessions was of three different kinds, and that they failed in different ways when treated alike.

**Compounded knowledge** is what one has learned about a domain: entities, concepts, sources and the relations between them. It is true indefinitely, and more of it is better. A new paper about a method should make the existing page about that method richer rather than produce a second page.

**Volatile working state** is where a piece of work stands now: what was done, what was decided, what is blocked, what was tried and failed, what comes next. It is true only at present. "Blocked on the login defect" ceases to be true when the defect is fixed; a store that merely *added* the fix would leave the blocker beside it, and the next agent would diligently repair a defect that no longer exists.

**Canonical documents** are the documents a project is built against: architecture, firm decisions, conventions, roadmap. They are true until their owner decides otherwise, and their exact wording matters. They should not be paraphrased, merged with other material or summarised by a model on the way in.

### 4.3 Write semantics

The central claim of the model is that these three kinds require three different write rules, and that using the wrong rule destroys the value of the store silently (in the repository: [the one rule that matters](../../docs/user-guide.md#the-one-rule-that-matters-state-versus-knowledge); the design decision as recorded for developers, [memory layer — "State SUPERSEDES, knowledge ACCUMULATES"](../../docs/dev/decisions-agents.md#memory-layer-working-state)):

- **Knowledge accumulates.** A write merges new material into what exists. Nothing is dropped.

- **State supersedes.** A write replaces the previous state entirely. History is kept separately, as an append-only log that is read as history, not as the present.

- **A canonical document is replaced whole.** A write replaces the document as a unit, and a reader receives the original text, never a retelling.

The failure modes are symmetric. Filed as state, a durable decision is deleted by the next save, without warning, because overwriting is precisely what that store is for. Filed as knowledge, a transient blocker becomes permanent. Mixed into either, a canonical document is paraphrased into something its author never wrote.

![Figure 1, the model of context. A box labelled A DOMAIN — one folder, one topic, owned by the user — branches into three: KNOWLEDGE (the wiki: entities, concepts, summaries, cross-linked), WORKING STATE (standing brief, handoff per scope and per machine, journal) and CANONICAL DOCUMENTS (architecture, decisions, conventions, roadmap). Each has a write rule beneath it: ACCUMULATES (a new source enriches existing pages; nothing is dropped), SUPERSEDES (each save replaces the last handoff; history kept in the append-only journal) and REPLACED WHOLE (kept and read verbatim; mirrored byte for byte; never summarised). Dashed boxes at the foot say who reads it: your brain plus your team's brain (Shared Brain) for knowledge; your agents' brain — the project's state and its canonical documents, returned together in one call at session start — for the other two.](../images/knowledge-accumulates-fig1-taxonomy.png)

**Figure 1.** The model of context. Three kinds of context, distinguished by their write semantics, held in one domain folder and serving three audiences: the individual (knowledge), the team (shared knowledge) and the agents (state plus canonical documents).

### 4.4 Three audiences

The same material serves three readers, which The Curator names *your brain*, *your team's brain* and *your agents' brain* ([the three layers](../../docs/user-guide.md#the-three-layers-and-the-one-rule-that-separates-them)). The individual's knowledge accumulates from what they read. A team's knowledge accumulates collectively, from what its members choose to contribute. The agents' context combines the volatile state of each piece of work with the project's canonical documents. Because all three live in one folder, they share one synchronisation mechanism, one backup, one editor and one access protocol.

### 4.5 A placement test

The model yields a practical test for where any item belongs (Table 1). It is simple to state and, in my teaching experience, harder to apply than it looks, because the boundary between a passing observation and a durable lesson is a judgement no system can make for its owner.

**Table 1.** Where an item of context belongs.

| Question about the item | Destination | Write rule |
|---|---|---|
| Will it still be true next month, in every thread of the work? (rules, firm decisions) | The standing brief | Rewritten deliberately, by the owner |
| Is it true only of this thread, now? (progress, blockers, next steps) | The handoff | Supersedes |
| Is it long, reference-grade and needed only for certain work? | A canonical document | Replaced whole |
| Is it something learned, which should connect to other things learned? | The wiki | Accumulates |
| Is its value the pattern across many incidents? | The wiki (compiled from sessions) | Accumulates |

> **In plain terms.** Some things you know stay true and should keep growing (a library). Some things are only true today and must be replaced when they change (a shift note). Some things are the rules of the house and must be kept word for word (a handbook). Store each one with the right rule, or the store quietly works against you.

## 5. The Curator: Architecture

### 5.1 Principles

The Curator is a local application (a macOS app, or a local server on Windows and Linux) that holds all three kinds of context as plain markdown and JSON-lines files in a folder the user chooses ([architecture](../../docs/architecture.md)). Its design follows five principles:

1. **Local-first ownership.** No account, no database and no service operated by the author. Synchronisation, when used, goes to the user's own private GitHub repository.

2. **Plain, published formats.** Everything is readable in any editor and in Obsidian. The on-disk format of the working-state layer is published as a specification ([`working-state/1`](../../docs/spec/working-state-v1.md); Režun, 2026b), and a test suite checks the specification against the live code so that the two cannot drift apart.

3. **Harness neutrality.** Agents reach the store through an MCP server that runs as a local child process, so any MCP-capable harness can read and write it, with or without the application running.

4. **Model neutrality.** The application's own AI tasks run on the user's choice of provider (Gemini, Anthropic, or OpenRouter, which aggregates many vendors), using the user's own key.

5. **Honest failure.** Where the system cannot guarantee something, it fails in the safe direction and says so. The clearest example is capture: a missed save yields the previous state — stale, never corrupted.

### 5.2 The knowledge layer: your brain

The user [adds sources](../../docs/user-guide.md#8-ingest-a-source) — PDF, markdown and text files — to a *domain*, a folder holding one topic's wiki. An ingestion pipeline sends each source through the configured model, which decomposes it into three page types: **entities** (people, tools, organisations, products), **concepts** (ideas, methods, frameworks) and a **summary** of the source that links them. Large documents are processed in several phases. Pages are cross-linked with wiki-style links, and a new source that mentions an existing entity enriches that entity's page rather than creating a duplicate. A [health subsystem](../../docs/user-guide.md#17-wiki-health) detects broken links, orphans, spelling variants and semantic near-duplicates, and every automatic redirect is reported rather than silent. *[Repository note, v3.82.1: true of the app's ingest and compile since v3.81.0; the MCP's `compile_to_wiki` does not yet surface redirect warnings — listed as known and unfixed in that release's changelog row.]*

The user can converse with a domain in the application, with answers built from and citing its pages; a conversation worth keeping can be [compiled back into pages](../../docs/user-guide.md#compiling-a-conversation-to-your-wiki-v250). Because every page is a markdown file, Obsidian renders the domain as a navigable graph. This layer accumulates, as the model requires.

### 5.3 The team layer: your team's brain

The [Shared Brain](../../docs/shared-brain-user-guide.md) extends the knowledge layer from one person to a group, such as a class cohort, a research team or a department. Each member keeps a private Curator and opts in one domain. Contributions leave the member's machine not as raw files but as change summaries produced by a model on the member's own machine; they are synthesised into a collective wiki in a shared private repository, and the collective returns to every member as a separate, read-only *mirror* domain. Nothing from a domain the member did not opt in ever leaves the machine. Members cannot edit the mirror directly; contributions always originate in their own domain.

In terms of the model, the Shared Brain is collective accumulation. It is also, in the vocabulary of Section 2.4, an implementation of transactive memory with a persistent substrate: the team does not merely know who knows what, it holds the union of what its members chose to share in a form both people and agents can read. A mirror domain can be attached to any project as a source of knowledge (Section 5.4), so a team's accumulated reading becomes available to every member's agents. The Shared Brain is currently released as a beta.

### 5.4 The agents' layer: working state

Within a domain, the agents' layer is organised as *projects*. A project is a thing being built against the domain's knowledge, and each has one standing brief and any number of *scopes* — named threads of work. Each scope holds, per machine, one handoff and one journal (Figure 2; [the three tiers](../../docs/working-state.md#the-three-tiers), [scopes](../../docs/working-state.md#scopes), and in the interface [Memory — the brief, Handoffs and the Journal](../../docs/user-guide.md#memory--the-brief-handoffs-and-the-journal)).

![Figure 2, the on-disk layout as a tree. domains/<domain>/ holds wiki/ (compounded knowledge — accumulates; entities/, concepts/, summaries/, one markdown page per subject, cross-linked), raw/ (original sources, kept on the ingesting machine only) and state/<project>/. Inside the project: project.md (the standing brief, one per project), foundations/ (canonical documents — replaced whole; manifest.json and <document>.md files, with sources, sha256 fingerprints and start states) and <scope>/<machine>/ (one thread of work on one computer) holding current.md (the handoff, overwritten on every save), journal.jsonl (the journal, one line per save, append-only) and an optional previous.md (another tool's replaced handoff, kept once).](../images/knowledge-accumulates-fig2-layout.png)

**Figure 2.** On-disk layout. Knowledge (the wiki) and a project's state share one domain folder. The brief sits above all scopes; each scope holds one handoff and one journal per machine; canonical documents are kept in a foundations folder with a manifest of sources and fingerprints.

**The standing brief** (project.md) holds what is true across all threads: the goal and what "done" means, how the owner wants the work carried out, firm decisions with their reasons, and a "Read before you…" list naming which canonical document suits which kind of work. It is the one tier nothing writes as a side effect: the owner writes it, or explicitly commissions an agent to, and the file records which occurred. Every read returns it, whatever scope is requested.

**The handoff** (current.md) is an agent's statement of where one thread stands. It has [defined sections](../../docs/working-state.md#the-sections-a-handoff-carries) — where things stand, next steps, decisions, timestamped observations, traps and dead ends, open questions, and which canonical documents were read (by fingerprint) — and each save replaces it entirely. The design inverts the manual protocol's weakest point: instead of one handoff written at 80% of the window, the agent is instructed to save after every significant step, so the handoff is always current and a defect fixed in the first hour is recorded as fixed in the first hour. Saves are idempotent, so the instruction is to save early and often.

**The journal** (journal.jsonl) receives one line per save — time, scope, machine, harness, model and a one-line headline. It is append-only, so the timeline survives even though each handoff does not, and it is presented to agents explicitly as history rather than as the present.

**The machine segment is load-bearing** ([why `<machine>` is in the path](../../docs/working-state.md#why-machine-is-in-the-path)). Synchronisation uses git, and during development a hazard was measured that shaped the layout. When two machines edited the same handoff, git's default three-way merge with a conflict preference did not merely keep one version: where one side re-sent a section unchanged, the other side's edit applied cleanly, and the result was a *spliced* document — well formed, internally coherent, attributed to one author, and containing a decision that author never made — with no conflict marker and a successful exit. Because a complete save re-sends unchanged sections verbatim, the capture discipline made this more likely rather than less. Giving each machine its own path means two machines never write the same file, so the hazard cannot arise. Cross-machine continuity is recovered on the reading side: a read that names no machine returns the newest handoff, ordered by the agent's own recorded save time rather than by file timestamps, which git rewrites on checkout.

**A single writer per file.** The application is read-only over handoffs and journals ([what the app writes, and what it does not](../../docs/working-state.md#6-what-the-app-writes-and-what-it-does-not)); agents write them through the MCP server or a command-line client. This keeps a handoff an honest record of what an agent observed, rather than a document two writers take turns on, and preserves the property on which synchronisation safety rests.

### 5.5 Canonical documents: foundations

A project's canonical documents — called *foundations* in the store ([the foundations tier](../../docs/working-state.md#the-foundations-tier--canonical-documents-that-travel)) and *Documents* in the interface ([Documents — the files that travel with a project](../../docs/user-guide.md#documents--the-files-that-travel-with-a-project)) — live in the project's state folder, so they travel with the project and are readable by an agent on a machine that has never checked out the project's repository. They enter in three ways: mirrored byte for byte from a local folder or a GitHub repository (up to eight sources per project), copied in once, or written in the application. A mirrored document's source remains authoritative; the store records a sha256 fingerprint for each, and a refresh copies over only what changed. Nothing is summarised by a model on the way in or out, and an agent may write or update a canonical document only when the owner has explicitly commissioned it — the tool refuses otherwise. Each document is capped at 512 KB and a project's documents at 200 KB in total, with an over-budget project accepted and disclosed rather than silently truncated.

### 5.6 The brief's authority, and its limits

A standing brief is only useful if its rules land. During development, a real failure demonstrated how they can fail to: an agent read a brief instructing it to orchestrate rather than build, encountered a conflicting instruction in its own harness, resolved the clash silently in the harness's favour, and spent an hour on the wrong mode of work. Nothing indicated that a decision had been made. Three behaviours ([making sure your standing rules actually land](../../docs/user-guide.md#making-sure-your-standing-rules-actually-land)) now travel with every brief, in the response the store returns rather than in any vendor-specific skill, so that every MCP client receives them:

1. **Read-back.** In its first reply the agent states, in one line, which standing rules it is adopting. A dropped rule becomes visible in the first minute; a reply naming no rules, against a brief that has some, shows that the brief did not arrive.

2. **Conflict protocol.** When the brief and the harness's own rules disagree, the agent names the clash and asks the owner. The protocol resolves to *ask*, never to *obey*.

3. **Capability fallback.** When a rule asks for something the harness cannot do, the agent says so and proposes an alternative, so that "cannot" is never mistaken for "will not".

A fourth rule ([what a standing directive may never do](../../docs/user-guide.md#what-a-standing-directive-may-never-do)) bounds the mechanism: **a standing directive may narrow behaviour or shape method; it may never widen authority.** A brief that attempted to authorise a deletion, a purchase or a push is treated exactly as the same instruction would be if it appeared in a web page. Where authorship cannot be established — a brief inside a shared mirror written by other people, or a file that appears forged or badly merged — the elevated framing is withheld and the brief is returned as ordinary untrusted material. Handoffs and journals are always returned as recorded data to be verified, never as instructions.

### 5.7 Access: bridge, client, skills, instructions and hooks

Agents reach the store through the **[My Curator MCP server](../../docs/mcp-user-guide.md)**, which exposes 24 tools covering the wiki and the working state and runs entirely on the user's machine. The key tool for continuity, get_project_context, returns in one call the brief, the latest handoff, recent journal lines, an index of canonical documents and the text of those marked to be read first. A **[command-line client](../../docs/user-guide.md#the-command-my-curator)** offers the same operations to harnesses that can run a shell command but do not speak MCP. Two **[agent skills](../../skills/README.md)** carry the procedures for working with the wiki and for continuity.

Because a skill is only effective if the harness activates it — which, as Section 8.4 shows, cannot be assumed — the application also provides a short **[instruction block](../../docs/user-guide.md#making-sure-your-agent-actually-does-it)**, with the project's name filled in, to be placed at the top of whichever instruction file each harness reads (CLAUDE.md, AGENTS.md and so on). Where a harness supports lifecycle **[hooks](../../docs/user-guide.md#hooks-what-they-can-do-on-your-harness-and-what-they-cannot)**, optional adapters inject the project's context at session start and ask for a save at the end. A hook may ask, inject or record; it may never compose a handoff, because a fabricated handoff is worse than a missing one. Figure 3 shows the resulting loop.

![Figure 3, the session loop as six boxes. THE STORE (plain markdown in the owner's folder, synced to the owner's private repository on request) leads by one call to SESSION START (get_project_context: brief, latest handoff, journal lines, document index, read-first text), then READ-BACK (the first reply names the brief's rules adopted; clashes go to the owner; the impossible is said aloud), then WORK (open documents by name when the task needs them; search the wiki when a question goes deeper), which repeats with SAVE (SUPERSEDES) (after every significant step a complete handoff replaces the previous one and one line is appended to the journal), then NEXT TURN (any harness, any model, any machine; on "continue" or after a pause, read again before acting) and back to the store. A footnote reads: a missed save leaves the previous handoff — stale, never corrupted; hooks may inject context or ask for a save, they never write one.](../images/knowledge-accumulates-fig3-session-loop.png)

**Figure 3.** The session loop. One call at session start (and again on "continue" or after a pause); a complete, superseding save after every significant step; history kept in the append-only journal. Any harness, model or machine can take the next turn.

> **In plain terms.** The Curator keeps three things in one folder: a growing library of what you have read (optionally shared with your team), the rules and handbook of each project, and a running note of where each piece of work stands that is replaced every time the work moves on. Any AI tool can read and update it through one standard connection, and a few simple rules make sure the AI says which of your rules it is following.

## 6. Budgeting Context: The Right Context, Not All of It

### 6.1 The operating envelope

If context is valuable, it is tempting to load all of it. The evidence in Section 2.1 and practical experience both argue against this. Every token spent at the start of a session is a token the work cannot use later, and material unrelated to the task at hand degrades the model's attention to what matters. The opposite error is equally real: an agent that starts with too little re-derives what it could have read, re-opens settled questions and guesses at what its briefing omitted.

The operating envelope I have used for three years, and which the system encodes as guidance, is that a session should **start near 10% of the window and hand off by about 80%**, leaving roughly 70% of the window for the work itself.

### 6.2 What a session start contains

The governing rule is stated in one sentence: *the right context, not all of it*. At session start an agent receives three things: its **foundations** (two or three canonical documents the owner has marked *read first*), the **last state** (the latest handoff and a few journal lines) and the **brief**. Everything else is available on demand. Each canonical document has one of [three start states](../../docs/user-guide.md#three-start-states-and-suggest-a-reading-plan-v3652--v3670):

- **Read first** — its text arrives in every session, within a reading budget.

- **On request** — it appears in an index (title, role, size, freshness) and the agent opens it by name when the work requires it.

- **Not at start** — it is kept and mirrored but omitted from the index; the brief's "Read before you…" list tells an agent when to open it.

The wiki is never loaded at session start. Compounded knowledge is *searched* when needed, so it can grow without limit at no cost to the start of a session. An index row without text is explicitly described to agents as a document awaiting a request, not a missing one.

### 6.3 The reading budget

The owner chooses a [reading budget](../../docs/user-guide.md#session-start-and-the-context-window) for each project from seven presets, named in tokens: Index only (0), Lean (≈8k), Standard (≈16k, recommended), Deep (≈33k), Large (≈66k), Extra large (≈131k) and Max (≈205k). The budget caps how much read-first text is sent. A planner lets the owner try start states and budgets together and see the effect before applying anything, and an optional suggestion step proposes a reading plan from the brief and each document's role and size, changing nothing until approved.

### 6.4 Delivery constraints

A practical constraint shaped delivery. At least one widely used harness displays an MCP reply of at most roughly 25,000 tokens and silently writes anything larger to a file, handing the agent a file reference instead of the text. A large bootstrap that appeared to fit a budget could therefore never actually enter the model's window. The store [delivers large bootstraps in pages](../../docs/working-state.md#paged-delivery-v3700) of at most about 20,000 tokens, whole documents only, in reading order, and instructs the agent to continue until no page remains.

### 6.5 Making the budget visible

Because none of this is useful if it cannot be seen, the application draws the session start as a meter: the model's whole context window to scale, the harness's own consumption as a hatched block (an estimate supplied by the user, since the application cannot measure it), and The Curator's contribution broken down by layer. All token figures are estimates at four bytes per token, always marked approximate; they read low for dense code and tables.

![Figure 4, two horizontal bars across a 1M-token axis, with dashed lines at 10% (target start) and 80% (hand off). The upper bar, the author's project on 30 September 2026 with nothing read first, shows a hatched block for the harness's own share and a thin dark block for The Curator, labelled about 130k in use (about 13% of the window), free about 870k. The lower bar, the same project with two documents of about 12k read first under the Standard budget (illustrative), reads about 142k in use (about 14%), free about 858k. The legend names the hatched block as the harness's own share — system prompt, tool lists, instruction files, skills, the owner's estimate, not measured — and the dark block as The Curator's session start: framing 3.2k, brief 4.5k, handoff 0.5k, journal 0.2k, index 1.1k.](../images/knowledge-accumulates-fig4-context-window.png)

**Figure 4.** Composition of a 1M-token context window at session start, for the author's own project on 30 September 2026 (upper bar) and for the same project with two canonical documents marked read first under the Standard budget (lower bar; illustrative). The harness's own share is the owner's estimate. In both cases the dominant consumer is the harness, not the project's context.

A worked example from my own project on 30 September 2026 illustrates the point (Figure 4). With a 1M-token window, my estimate of the harness's own consumption — its system prompt, tool definitions for several MCP servers, instruction files and skills — was about 120,000 tokens. The Curator's contribution was about 9,500 tokens (≈1% of the window): about 3,200 of framing instructions, 4,500 for a long brief, 500 for the handoff, 200 for journal lines and 1,100 for an index of nine documents, none marked read first. The total, about 13% of the window, sat at the upper edge of the envelope. The most instructive observation, repeated in teaching, is that **the largest consumer of starting context is frequently the harness itself, not the project**.

> **In plain terms.** Give the AI enough to start well, not so much that it starts tired: about a tenth of its working memory, not a third. Hand it the rules, the latest note and two or three essential documents; let it ask for the rest by name; and let it search the library rather than carry it.

## 7. Portability Across Harnesses, Models and Machines

### 7.1 Why a mixed fleet

The case for working across harnesses (Section 1.2) rests on model specialisation, independent review and the economics of vendor subscriptions. On the last point I offer a practitioner's observation rather than a measurement: in my own use, subscription plans bundled with vendor harnesses have provided substantially more work per unit of cost than the same models billed per token, but vendors adjust usage allowances frequently — including unscheduled mid-week resets — which makes the difference impractical to measure rigorously. What does not change is that each crossing between harnesses is a session boundary, and each harness keeps its own memory in its own format.

### 7.2 One scope per tool

When two harnesses work on one project on one computer, they would, if saving under the same scope, write the same file and overwrite each other's handoff — the per-machine path protects against two computers, not two programs on one computer. A live test on 25 September 2026 observed exactly this: a harness that had not been given the instruction block saved into a shared scope and replaced another harness's handoff. Two changes followed. Since v3.74.0, a save that [replaces another tool's handoff](../../docs/working-state.md#when-a-save-replaces-another-tools-handoff--warned-and-kept-once-v3740) says whose it replaced, when, and with what headline, and keeps the replaced text once as previous.md. Since v3.76.0, a save that names no scope is filed under a scope named for the tool that made it, so each harness keeps its own thread by default while the brief remains shared by all. *[Repository note, v3.82.1: the default applies when the save names its `harness`; a save that names neither scope nor harness still lands in `main`, and an explicit scope always wins — see [scopes](../../docs/working-state.md#scopes).]*

### 7.3 Three transport routes

Working across computers exposed a second problem, which I had not anticipated: users — including me — could not tell *how* each piece of a project reaches another machine, and most setup errors came from expecting one route to carry something that travels by another. The model that resolved this is that everything a project needs travels by exactly one of three routes, and the routes never mix (Figure 5, Table 2; [what travels between your computers, and how](../../docs/user-guide.md#what-travels-between-your-computers-and-how)).

![Figure 5, three routes between two computers. Computer A and Computer B each hold a Knowledge folder (brief, handoffs, journal, documents, wiki, conversations), a Project folder that is a git clone (code, CLAUDE.md, AGENTS.md, GEMINI.md, .curator-project) and a dashed box Set up on this computer (each tool's MCP entry, skills, hooks, API keys, settings). Between them, inside a dashed GITHUB box for the owner's accounts, Route 1 — the private knowledge repository — syncs the knowledge folders, and Route 2 — the project's own repository — carries the project folders by git. A dotted line between the set-up boxes is labelled Route 3 — nothing travels.](../images/knowledge-accumulates-fig5-transport-routes.png)

**Figure 5.** Three transport routes between two computers. Route 1, the application's own synchronisation to the user's private knowledge repository, carries the whole knowledge folder. Route 2, the project's own git repository, carries code and harness instruction files. Route 3 carries nothing: each computer's tool configuration is set up locally.

**Table 2.** What travels by which route.

| What | Where it lives | Route to the other computer |
|---|---|---|
| Brief, handoffs, journal, canonical documents | Knowledge folder | 1 — Personal Sync to the user's private repository |
| Wiki pages, conversations | Knowledge folder | 1 — Personal Sync |
| Original ingested files | Knowledge folder | Not synchronised; remain on the ingesting machine |
| Code; CLAUDE.md, AGENTS.md, GEMINI.md; project marker file | Project folder | 2 — the project's own git |
| Each harness's MCP configuration, skills, hooks | That harness's settings | 3 — none; set up on each computer |
| API keys, synchronisation credentials, application settings | Local application settings | 3 — none; set up on each computer |

The division has a rationale: the handoff belongs to the *work*, wherever it happens, so it follows the user; the instruction file belongs to the *code*, so it follows the repository. Every synchronisation is an explicit user action, performed before starting and after the last save; a forgotten synchronisation can make the next session read an older handoff, but it can never overwrite anything, because each machine writes its own files.

### 7.4 Making setup legible

Multi-tool, multi-computer work depends on a list of preconditions that are invisible when they fail: the MCP entry in each harness, current skills, the instruction block at the top of each instruction file the harness actually reads, a committed project marker, and synchronisation at both ends of a session. Releases v3.77.0 to v3.80.0 added a **[Setup check](../../docs/user-guide.md#13e-the-setup-check-in-the-app)** that reads these facts for one project on one computer and presents each problem in two lines — what is wrong, naming the file, computer or date; then why it matters and what to do — with an action for each. Each group of checks is labelled with the route by which its contents travel. The check reads configuration files for yes-or-no facts only, never their values, and never writes another tool's configuration. It deliberately shows no score: a "9/10" invites optimising the number rather than the conditions it stands for.

> **In plain terms.** Use different AI tools for what each does best, and let each keep its own note while sharing the same rules. Know that your notes travel through your private backup, your code and its instruction files travel through the code repository, and each tool's connection must be set up on each computer. The app checks the list for you.

## 8. Evidence

### 8.1 Overview

Table 3 summarises the measurements reported in this section. All were conducted on the author's projects or on seeded test projects in isolated stores; all are small; all are dated. Full protocols are in the project's technical documentation (Režun, 2026c) — in particular [activation: put the discipline where the harness cannot skip it](../../docs/working-state.md#activation-put-the-discipline-where-the-harness-cannot-skip-it) and [what a handoff cannot do](../../docs/working-state.md#what-a-handoff-cannot-do-it-cures-ignorance-not-disagreement).

**Table 3.** Summary of measurements.

| # | Question | Setting | Result (counts out of N) |
|---|---|---|---|
| E1 | Does carrying state change the next-step answer? | Real project handoff, open "what next?" question; Gemini 2.5 Flash-Lite; N = 4 / 8 | Correct top priority: 0/4 without state, 8/8 with state |
| E2 | Does state suppress already-rejected proposals? | Seeded project, two providers; N = 4 per condition; 2026 | Recorded-failed command proposed: 3/4 → 0/4; ruled-out architecture: 4/4 → 0/4 |
| E3 | Does a handoff bind the next session? | As E1 | Proposal the handoff ruled out: 3/4 without, 3/8 with; constraint moved from narrative to decisions: respected 4/4 |
| E4 | Does an installed skill make agents save? | Headless, one task, Haiku 4.5; 2026-09-10; N = 4 per arm | Claude Code: skill 0/4, skill + instruction block 3/4; opencode: 4/4 either way |
| E5 | Do lifecycle hooks close the gap? | Claude Code headless; 2026-09-20; N = 4 per arm | Skill + block + hooks: started with context 4/4, saved 4/4 |
| E6 | Do per-tool scope instructions hold? | Claude Code headless; 2026-09-25; N = 8 | Sonnet 5: saved 8/8, all in own scope; Haiku 4.5: saved 5/8 |
| E7 | Does an open conversation re-read on "continue"? | Two turns, another tool saves between; 2026-09-26; N = 8 / 4 | Sonnet 5: 0/8 → 8/8 with one added sentence; Haiku 4.5: no measurable change |
| E8 | Does a handover work between harnesses and computers? | Live, Claude Code ↔ Antigravity, one Mac and two; 2026-09-25/26 | Worked in both directions; one failure (no re-read in an open conversation) fixed by E7 |
| E9 | Does ingestion capture the subject of a source? | Synthetic announcement article, 29 live ingests; 2026-09-30 | Product given its own entity page: Gemini 1/6 → 6/6, Haiku 4.5 6/6, after a prompt rule |

### 8.2 Carrying state changes what an agent proposes (E1, E2)

Two measurements asked whether reading a handoff changes an agent's behaviour. In E2, a seeded software project with an open architecture question was run on two providers. Without working state, the model proposed a command the project had already recorded as failed in 3 of 4 runs, and an architecture the team had ruled out for compliance reasons in 4 of 4. With the handoff present, both fell to 0 of 4. In E1, the project's own real handoff was saved through the store and read back through the read path, and the model was asked an open "what should I do next?". Without state it named the correct top priority in 0 of 4 runs; with state, in 8 of 8.

### 8.3 A handoff cures ignorance, not disagreement (E3)

The same E1 runs contained a less comfortable result. The proportion of runs proposing something the handoff explicitly ruled out fell only from 3 of 4 to 3 of 8. In two runs the model quoted the recorded decision and overrode it in the same sentence. Recording a decision stops the next session being ignorant of it; it does not stop the next session concluding that it knows better.

Placement moved the number. Every constraint recorded in the handoff's *decisions* section, phrased as what not to do with its reason, was respected in every run. The one constraint that lived only inside a narrative in the *traps* section was re-argued until it was moved into *decisions*, after which it was respected in 4 of 4 runs. A constraint written as a story about what happened reads as history; the same constraint written as a decision reads as a boundary. This is why the handoff's sections are fields with distinct meanings rather than free text.

### 8.4 Storage is easy; capture is hard (E4, E5)

State exists only if agents save it, and an agent with an instruction to save is not the same as an agent that saves. In E4, an agent on one widely used harness saved in 0 of 4 runs with the continuity skill installed — with no error, no refusal and nothing on screen to indicate the failure. With the short instruction block placed in the file that harness loads every session, it saved in 3 of 4. On another harness, which activates skills itself, it saved in 4 of 4 either way. All sixteen runs completed the task correctly, so discipline was not bought at the expense of correctness.

E5 added lifecycle hooks. With skill, block and hooks, every session started with its context and every session saved (4 of 4). The arms without hooks exposed a further failure: in 5 of 6 save attempts, the agent located the save tool by name and then produced something shaped like a shell command named after it — a fabricated call, a function wrapper, a payload written to a file and never sent — instead of calling the tool. In the same headless mode, the end-of-session hook never fired.

The lesson is that the **placement of an instruction matters more than its wording**. An instruction in a skill the harness may never activate, however well written, is weaker than a few lines in the file the harness is guaranteed to load, and weaker again than a hook that injects the context itself.

### 8.5 Per-tool scopes and re-reading (E6, E7)

When the instruction block was changed to tell each harness to save under a scope named for itself, a capable model followed it completely (Sonnet 5: 8 of 8 saves, all in its own scope), while a small model was weaker on both the habit and the placement (Haiku 4.5: 5 of 8, two of them in the shared scope named explicitly). The store's default was changed so that a save naming no scope lands in the saving tool's own scope, making correct behaviour the default rather than something the model must remember.

E7 addressed a failure found in live use: a conversation that is already open, told "continue", may carry on from hours-old context while another tool or computer has moved the work on. Adding one sentence to the instruction block — call the bootstrap again on "continue", "resume" or after a pause — moved Sonnet 5 from 0 of 8 to 8 of 8 re-reading first. Haiku 4.5 showed no measurable change. In none of the runs did an agent act on the other tool's recorded next step without asking; all treated it as a record to be verified, as the store instructs.

### 8.6 Live handovers (E8)

On 25 September 2026, on one computer, a project was handed from Claude Code to Antigravity and back. With the instruction block in AGENTS.md, Antigravity read the context on a bare "Continue" and saved under its own scope without prompting. The failure case — the overwrite described in Section 7.2 — occurred on a project without that file. On 26 September, across two computers synchronised through the user's private repository, a new conversation in one harness on one machine opened the handoff written by the other harness on the other machine, identified as newest by the agents' recorded save times; the reverse direction also worked. These are single observations by one person, not a protocol.

### 8.7 Fidelity of the knowledge layer (E9)

A context store is only as good as what it holds. On 30 September 2026, a user reported that an article announcing his own software product had been ingested into concept pages but produced no entity page for the product itself. Investigation found no pipeline defect: the extraction prompt ([who tells the AI what to do during an ingest](../../docs/user-guide.md#who-tells-the-ai-what-to-do-during-an-ingest)) never stated that the product a source announces is itself a primary subject. Measured on a synthetic announcement article, the default model omitted or mis-filed the product in most runs (Gemini 2.5 Flash-Lite: correct in 1 of 6 runs of the original setting). A first rule improved this only partly (3 of 6 on Gemini). The final rule, which names the announced product as a primary subject with its own entity page and gives an example, filed it correctly in every run on both models (Gemini 2.5 Flash-Lite: 6 of 6, plus 3 of 3 on a long article; Haiku 4.5: 6 of 6, plus 2 of 2), in a campaign of 29 live ingests in total. The episode illustrates both a general property of LLM-built knowledge — omissions follow from what the prompt fails to say — and the value of an open development process in which a user's report becomes a measured fix within a day.

### 8.8 Naturalistic use

The store's own records from my daily work on 30 September 2026 describe the system in use (Table 4). Across seven projects in two domains, work was carried by several harnesses and models on two computers. The development project alone held 26 scopes with 29 saved handoff copies; the application's save monitor recorded at least 143 saves in the preceding seven days from two harnesses. These readings describe one practitioner's use and are offered as context, not as evidence of generality.

**Table 4.** Working-state records in the author's store, 30 September 2026.

| Project | Scopes | Saved handoff copies | Harnesses and models seen in latest saves |
|---|---|---|---|
| curator (this software) | 26 | 29 | Claude Code (Opus 5.5); Antigravity (Gemini) |
| lumina (production application) | 23 | 23 | Claude Code (Opus 5.5, Fable 5.1) |
| field-notes (publication) | 2 | 2 | Claude Code (Opus 5.5) |
| conduit | 3 | 4 | Antigravity (Gemini 3.8 Flash) on a second computer |
| ott | 3 | 4 | Antigravity (Gemini 3.8 Flash), Claude Code |
| posts; projects (domain defaults) | 1 each | 1 each | Antigravity (Gemini 3.7 Flash) |

> **In plain terms.** When the AI read the project's latest note, it found the right next step every time instead of never, and stopped suggesting things the team had already rejected. But it only reliably wrote those notes when the instruction sat in the one file its tool always reads, and it still sometimes argued with recorded decisions unless they were written as clear rules rather than stories.

## 9. Discussion

### 9.1 Principal findings

Seven findings emerge from the design work and the measurements.

**F1. The session boundary, not the window, is the constraint.** Larger windows do not remove it, and every change of harness, model or machine is another instance of it. Context must therefore live outside any single session, and outside any single vendor's product, if it is to survive the boundaries practitioners actually cross.

**F2. Write semantics must match the kind of truth.** The same store cannot correctly hold knowledge, state and canonical documents under one merge rule. This is the most consequential design decision in the system and, I would argue, a useful distinction for any agent-memory system: whether a stored item accumulates, supersedes or is replaced whole determines whether it remains correct.

**F3. A handoff cures ignorance, not disagreement.** Carried state reliably informs the next session; it does not bind it. Constraints are most reliably respected when phrased as decisions with reasons, which suggests that the structure of stored context is part of its function rather than a matter of style.

**F4. Capture, not storage, is the hard problem.** Every part of the storage design worked as intended; whether anything was stored depended on activation. The practical hierarchy observed was: a skill the harness may not activate; an instruction in the file it always loads; a hook that acts without the model's cooperation.

**F5. Legibility of setup is the second hard problem.** Once several tools and computers are involved, the system's correctness depends on preconditions that fail silently. Explaining transport as three routes that never mix, and checking them in the interface, proved as important as any storage mechanism.

**F6. Fail towards staleness.** Making capture advisory, never refusing an over-budget save, and never composing a handoff by hook all follow one rule: a stale record is recoverable, a corrupted or fabricated one is not. In my view this is the correct default for any context infrastructure on which agents act.

**F7. Budgeting is a skill, and it can be taught with an instrument.** "The right context, not all of it" becomes concrete when the window is drawn to scale. The recurring surprise — that the harness, not the project, is the largest consumer of starting context — is invisible until measured.

### 9.2 Implications

**For practitioners**, the model offers a working discipline independent of any tool: write foundational documents before building; keep a short, owner-authored brief with firm decisions and their reasons; have agents overwrite a structured handoff throughout the session rather than once at the end; start near 10% and hand off by 80%; and place standing instructions where the harness is guaranteed to read them.

**For educators**, context engineering is teachable as a structural skill rather than a collection of prompting tips. In my MBA teaching, the placement test in Table 1 has proved an effective exercise precisely because its hard cases — when does a dead end become a lesson? — require judgement.

**For organisations**, the combination of a personal knowledge layer, an opt-in collective layer and agent context in one owner-controlled format is a practical form of organisational memory that people and agents share. Institutional knowledge that accumulates collectively, and project state that any authorised agent can resume, reduce dependence on any single person, tool or vendor.

**For builders of tools and harnesses**, the findings argue for published formats over proprietary stores, for explicit write semantics, for loading a standard instruction file reliably, and for exposing session-start consumption so that users can budget it.

### 9.3 Why openness matters here

The Curator is built in public, under the MIT licence, with its measurements, including unfavourable ones, in the repository. This is not incidental to the contribution. Context infrastructure is only as trustworthy as one's ability to inspect what it stores and how; a user's accumulated knowledge and project state should not be hostage to a vendor's product decisions; and a practice that many people are developing independently benefits from a reference implementation anyone can read, run, fork or reimplement from its published format. Several of the fixes described in Section 8 began as reports from users of the open repository.

## 10. Limitations and Threats to Validity

- **Self-study.** The designer, developer, principal user and evaluator are the same person. The measurements were designed to be falsifiable and several were unfavourable, but independent replication is required.

- **Small samples.** Most measurements use four or eight runs per condition. They establish the direction and shape of effects, not their rates.

- **Narrow settings.** Controlled measurements were mostly headless, on one task per campaign, and on a small number of models and harnesses. Interactive use, other task types and other harnesses may behave differently.

- **Harness coverage.** Live handover has been observed between two harnesses (Claude Code and Antigravity). Codex, Cursor and opencode have not been through a live handover; opencode has been measured only for skill activation.

- **Model drift.** Harnesses and models change monthly. Results are tied to the dated versions recorded.

- **Unmeasured quality.** Measurements count whether agents read and saved, and whether answers named the right priority; the quality of saved handoffs was not independently judged.

- **Multi-person work** on one project is permitted by the design and has not been tested.

- **Token estimates** in the budgeting instrument are approximate (four bytes per token) and read low for dense code.

## 11. Open Questions and Future Work

1. **A measurement matrix across harnesses.** Running the same protocols for reading, saving and re-reading on every major harness, one row at a time, and publishing the matrix.

2. **Small models.** Why capable models follow the continuity discipline and small ones follow it less, and whether structural defaults can close the gap.

3. **Promoting decisions.** A path for a decision recorded in a handoff to be promoted, with the owner's approval, into a canonical document, where it will be carried verbatim thereafter.

4. **Cross-scope digests.** Reading a project with many threads at a glance without loading every handoff.

5. **Source fidelity.** Original ingested files do not travel between machines; an agent on another computer sees the compiled pages but not the source. On-demand retrieval of originals is a design question in its own right.

6. **Shared Brain at agent speed.** The collective layer assumes human-paced contribution; agent-paced state is far faster.

7. **Independent implementations.** The on-disk format is published and pinned to the code, but no writer has yet been built by someone else from the specification alone.

8. **Local models.** Running the application's own AI tasks on local models, which the design anticipates but does not yet support.

9. **Multi-person projects**, including authority and conflict when several owners' agents share one project.

## 12. Conclusion

Long-horizon work with AI agents is limited less by how much a model can hold than by what survives when a session ends. This article proposed a model of that surviving context — knowledge that accumulates, state that supersedes, canonical documents replaced whole — and described an open, local-first implementation that serves the individual, the team and the agents from one owner-controlled store, reachable by any harness through an open protocol and movable between the owner's machines by explicit routes. Small, dated measurements indicate that carried state changes what agents do, that structure determines whether recorded decisions are respected, and that the reliability of capture depends above all on where instructions are placed. The broader claim is modest and, in my experience, robust: without the right context there are no good results from AI, and the right context is neither all of it nor something any single vendor should hold on the owner's behalf.

**Knowledge accumulates. State supersedes. Canonical documents are replaced whole. And all of it belongs to the person whose work it is.**

## Software, Documentation and Data Availability

The Curator is open-source software released under the MIT licence.

- Source code and releases: [github.com/talirezun/the-curator](https://github.com/talirezun/the-curator)

- Product website: [mycurator.xyz](https://mycurator.xyz)

- User guide: [docs/user-guide.md](../../docs/user-guide.md) — including [the three kinds of context](../../docs/user-guide.md#the-three-kinds-of-context-it-carries), [session start and the context window](../../docs/user-guide.md#session-start-and-the-context-window), [writing a standing brief](../../docs/user-guide.md#writing-a-standing-brief--what-goes-where-a-template-three-examples), [working with several agent tools and several computers](../../docs/user-guide.md#13d-working-with-several-agent-tools-and-several-computers--the-setup-checklist) and [the Setup check](../../docs/user-guide.md#13e-the-setup-check-in-the-app)

- README and costs: [README.md](../../README.md)

- Working state — technical reference and measurement protocols: [docs/working-state.md](../../docs/working-state.md)

- Published on-disk format: [docs/spec/working-state-v1.md](../../docs/spec/working-state-v1.md)

- My Curator MCP server: [docs/mcp-user-guide.md](../../docs/mcp-user-guide.md)

- Personal Sync: [docs/sync.md](../../docs/sync.md)

- Shared Brain: [docs/shared-brain-user-guide.md](../../docs/shared-brain-user-guide.md)

- Product overview: [docs/product-overview.md](../../docs/product-overview.md)

- Project brief template: [docs/project-brief-template.md](../../docs/project-brief-template.md)

- Agent skills: [skills/](../../skills/README.md)

- Accompanying long-form articles: [research/articles](../README.md)

- Field Notes (practitioner chapters on context engineering, agent memory and harnesses): [fieldnotes.talirezun.com](https://fieldnotes.talirezun.com)

Measurement records, with dates, models, harness versions and sample sizes, are kept in the repository's documentation and changelog.

## Glossary

- **Agent harness** — the software that wraps a language model with tools, file access, permissions and a control loop (for example Claude Code, Codex, Cursor, Antigravity, opencode).

- **Context** — everything a model can observe when it produces an output.

- **Context window** — the maximum amount of text, measured in tokens, a model can hold in one session.

- **Context rot** — degradation of model performance as the amount of input grows.

- **Session boundary** — the point at which one session ends and the next begins with an empty context window.

- **Compounded knowledge (wiki)** — entities, concepts and summaries built from sources; accumulates.

- **Working state** — the brief, handoff and journal describing where work stands; the handoff supersedes.

- **Canonical documents (foundations)** — the documents a project is built against; replaced whole and read verbatim.

- **Standing brief** — one owner-authored file per project of standing instructions and firm decisions.

- **Handoff** — an agent's complete statement of where one thread of work stands; overwritten on each save.

- **Journal** — an append-only line per save; history, not the present.

- **Scope** — a named thread of work within a project.

- **Domain** — one folder holding one topic's wiki and any projects built against it.

- **Shared Brain** — an opt-in collective wiki built from members' chosen domains, returned to each as a read-only mirror.

- **MCP (Model Context Protocol)** — an open protocol through which AI clients launch or connect to tool servers.

- **Personal Sync** — The Curator's synchronisation of the knowledge folder to the user's own private GitHub repository.

## Acknowledgements

I thank the users of the open repository whose reports shaped several releases described here, the students of the Vanguard MBA at COTRUGLI Business School whose questions shaped how this work is explained, and Dražen Kapusta, with whom the Shared Brain concept was developed.

## Declarations

**Competing interests.** The author is the creator and maintainer of The Curator. The software is free and open source; the author receives no revenue from it and has received no funding or compensation from any company named in this article.

**Use of AI tools.** Consistent with the subject of this work, AI agents were used extensively in building the software and in preparing this manuscript, including drafting and literature search. All claims, measurements and references were checked by the author, who takes full responsibility for the content.

## References

Ahrens, S. (2017). *How to take smart notes: One simple technique to boost writing, learning and thinking*. CreateSpace.

AGENTS.md. (n.d.). *AGENTS.md: A simple, open format for guiding coding agents*. Retrieved September 30, 2026, from https://agents.md

Anthropic. (2024, November 25). *Introducing the Model Context Protocol*. https://www.anthropic.com/news/model-context-protocol

Anthropic. (2025, September 29). *Effective context engineering for AI agents*. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

Anthropic. (2026, August 25). *Claude's memory works everywhere, and you decide what's in it*. https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it

Bush, V. (1945). As we may think. *The Atlantic Monthly, 176*(1), 101–108.

Chhikara, P., Khant, D., Aryan, S., Singh, T., & Yadav, D. (2025). *Mem0: Building production-ready AI agents with scalable long-term memory* (arXiv:2504.19413). arXiv. https://doi.org/10.48550/arXiv.2504.19413

Edge, D., Trinh, H., Cheng, N., Bradley, J., Chao, A., Mody, A., Truitt, S., & Larson, J. (2024). *From local to global: A graph RAG approach to query-focused summarization* (arXiv:2404.16130). arXiv. https://doi.org/10.48550/arXiv.2404.16130

Forte, T. (2022). *Building a second brain: A proven method to organize your digital life and unlock your creative potential*. Atria Books.

Hevner, A. R., March, S. T., Park, J., & Ram, S. (2004). Design science in information systems research. *MIS Quarterly, 28*(1), 75–105. https://doi.org/10.2307/25148625

Hong, K., Troynikov, A., & Huber, J. (2025). *Context rot: How increasing input tokens impacts LLM performance* [Technical report]. Chroma. https://www.trychroma.com/research/context-rot

Karpathy, A. (2026, April 4). *llm-wiki* [GitHub Gist]. https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

Kleppmann, M., Wiggins, A., van Hardenberg, P., & McGranaghan, M. (2019). Local-first software: You own your data, in spite of the cloud. In *Proceedings of the 2019 ACM SIGPLAN International Symposium on New Ideas, New Paradigms, and Reflections on Programming and Software (Onward! '19)* (pp. 154–178). ACM. https://doi.org/10.1145/3359591.3359737

Lewis, P., Perez, E., Piktus, A., Petroni, F., Karpukhin, V., Goyal, N., Küttler, H., Lewis, M., Yih, W., Rocktäschel, T., Riedel, S., & Kiela, D. (2020). Retrieval-augmented generation for knowledge-intensive NLP tasks. In *Advances in Neural Information Processing Systems 33* (pp. 9459–9474). Curran Associates.

Liu, N. F., Lin, K., Hewitt, J., Paranjape, A., Bevilacqua, M., Petroni, F., & Liang, P. (2024). Lost in the middle: How language models use long contexts. *Transactions of the Association for Computational Linguistics, 12*, 157–173. https://doi.org/10.1162/tacl_a_00638

Nonaka, I., & Takeuchi, H. (1995). *The knowledge-creating company: How Japanese companies create the dynamics of innovation*. Oxford University Press.

Packer, C., Wooders, S., Lin, K., Fang, V., Patil, S. G., Stoica, I., & Gonzalez, J. E. (2023). *MemGPT: Towards LLMs as operating systems* (arXiv:2310.08560). arXiv. https://doi.org/10.48550/arXiv.2310.08560

Park, J. S., O'Brien, J. C., Cai, C. J., Morris, M. R., Liang, P., & Bernstein, M. S. (2023). Generative agents: Interactive simulacra of human behavior. In *Proceedings of the 36th Annual ACM Symposium on User Interface Software and Technology (UIST '23)*. ACM. https://doi.org/10.1145/3586183.3606763

Rasmussen, P., Paliychuk, P., Beauvais, T., Ryan, J., & Chalef, D. (2025). *Zep: A temporal knowledge graph architecture for agent memory* (arXiv:2501.13956). arXiv. https://doi.org/10.48550/arXiv.2501.13956

Režun, T. (2026a). *The Curator* (Version 3.81.0) [Computer software]. GitHub. https://github.com/talirezun/the-curator

Režun, T. (2026b). *working-state/1: The on-disk format of The Curator's working state* [Specification]. https://github.com/talirezun/the-curator/blob/main/docs/spec/working-state-v1.md

Režun, T. (2026c). *Working state — carrying build context between sessions* [Technical documentation]. https://github.com/talirezun/the-curator/blob/main/docs/working-state.md

Režun, T. (2026d). *The context engine* [Article]. From Lab to Life. https://talirezun.substack.com/p/the-context-engine

Sumers, T. R., Yao, S., Narasimhan, K., & Griffiths, T. L. (2024). Cognitive architectures for language agents. *Transactions on Machine Learning Research*.

thedotmack. (n.d.). *claude-mem* [Computer software]. GitHub. Retrieved September 30, 2026, from https://github.com/thedotmack/claude-mem

Tulving, E. (1972). Episodic and semantic memory. In E. Tulving & W. Donaldson (Eds.), *Organization of memory* (pp. 381–403). Academic Press.

Wegner, D. M. (1987). Transactive memory: A contemporary analysis of the group mind. In B. Mullen & G. R. Goethals (Eds.), *Theories of group behavior* (pp. 185–208). Springer. https://doi.org/10.1007/978-1-4612-4634-3_9

Zhang, Z., Bo, X., Ma, C., Li, R., Chen, X., Dai, Q., Zhu, J., Dong, Z., & Wen, J.-R. (2024). *A survey on the memory mechanism of large language model based agents* (arXiv:2404.13501). arXiv. https://doi.org/10.48550/arXiv.2404.13501

## Appendix A. The Handoff's Sections and the Store's Limits

**Table A1.** Sections of a handoff and their role.

| Section | Holds | Why it is separate |
|---|---|---|
| Where things stand | The current state of the thread | The one statement read as the present |
| Next steps | The concrete next actions | Read as a proposal to confirm, never as an order |
| Decisions | What is settled, phrased as what not to do, with reasons | Constraints filed here were respected in every measured run (Section 8.3) |
| Observations | Facts with the time they were observed and, where possible, how to re-check them | Allows the next session to verify rather than trust |
| Traps and dead ends | Approaches that failed, and why | Prevents re-entering known dead ends |
| Open questions | What is unresolved | Distinguishes the unknown from the forgotten |
| Foundations read | Fingerprints of the canonical documents the session read | Lets the next session receive only what changed |

**Table A2.** Store limits (self-capping so that a read cannot exceed an MCP reply budget).

| Item | Limit |
|---|---|
| Handoff document | 48 KB |
| Standing brief | 32 KB |
| Canonical document | 512 KB each; 200 KB per project in total (over-budget accepted and disclosed) |
| Journal headline | 200 characters |
| Journal entries returned to agents | 8 by default, 20 at most |

An over-budget save is never refused, because an agent near the end of its context that has its handoff rejected loses the handoff entirely. The least material is trimmed instead, and the trimming is recorded in the document itself.

## Appendix B. The Shape of a Standing Brief

```markdown
# Project brief — <name>

## Standing brief
The goal in two or three sentences, and what "done" looks like.

## Operating directives
- Scope rule: how work-streams are named.
- How the work is to be done — one imperative line each, with its own
  fallback ("if your tool cannot, say so in your first reply").

## Firm decisions — do not re-litigate
- The decision — and the one-line reason.

## Read before you…
- …<kind of work>: <document>
```

The full template is published at [docs/project-brief-template.md](../../docs/project-brief-template.md).

---

## Where to read more in this repository

- [README](../../README.md) — what The Curator is, [the quick start](../../README.md#quick-start) and [what it costs](../../README.md#what-it-costs)
- [User guide](../../docs/user-guide.md) — in particular [the three kinds of context](../../docs/user-guide.md#the-three-kinds-of-context-it-carries), [the one rule that matters: state versus knowledge](../../docs/user-guide.md#the-one-rule-that-matters-state-versus-knowledge), [Memory — the brief, Handoffs and the Journal](../../docs/user-guide.md#memory--the-brief-handoffs-and-the-journal), [Documents — the files that travel with a project](../../docs/user-guide.md#documents--the-files-that-travel-with-a-project), [session start and the context window](../../docs/user-guide.md#session-start-and-the-context-window), [resuming — the one line to learn](../../docs/user-guide.md#resuming--the-one-line-to-learn), [ingesting a source](../../docs/user-guide.md#8-ingest-a-source), [what travels between your computers, and how](../../docs/user-guide.md#what-travels-between-your-computers-and-how) and [the Setup check](../../docs/user-guide.md#13e-the-setup-check-in-the-app)
- [Working state — the technical reference](../../docs/working-state.md) — the memory layer's design record: [the three tiers](../../docs/working-state.md#the-three-tiers), [the foundations tier](../../docs/working-state.md#the-foundations-tier--canonical-documents-that-travel), [limits](../../docs/working-state.md#5-limits) and [the activation measurements](../../docs/working-state.md#activation-put-the-discipline-where-the-harness-cannot-skip-it)
- [`working-state/1` — the public on-disk format](../../docs/spec/working-state-v1.md)
- The design decisions, as recorded for developers: [the memory layer](../../docs/dev/decisions-agents.md#memory-layer-working-state) (state supersedes, knowledge accumulates) and [the My Curator MCP](../../docs/dev/decisions-agents.md#my-curator-mcp); [the wiki write pipeline](../../docs/dev/decisions-knowledge.md#wiki-write-pipeline-and-health), [ingest](../../docs/dev/decisions-knowledge.md#ingest) and [sync and Shared Brain](../../docs/dev/decisions-knowledge.md#sync-and-shared-brain)
- [Architecture](../../docs/architecture.md) — including [the My Curator MCP data flow](../../docs/architecture.md#data-flow-my-curator-mcp)
- [My Curator MCP guide](../../docs/mcp-user-guide.md) — the 24 tools and [setup](../../docs/mcp-user-guide.md#setup-under-2-minutes) — [Personal Sync](../../docs/sync.md) and the [Shared Brain user guide](../../docs/shared-brain-user-guide.md)
- [Project brief template](../../docs/project-brief-template.md)
- [The two agent skills](../../skills/README.md) — `my-curator` and `curator-continuity`
- [The Curator's agent memory, written for language models](../../llm-docs/curator-agent-memory.md)

**The articles in this series — From Lab to Life**

- *The Second Brain That Grows Smarter and Lives on Your Computer* · [GitHub version](./the-second-brain-that-grows-smarter.md)
- *Building Knowledge Immortality Through the Second Brain Architecture and The Curator App* · [GitHub version](./knowledge-immortality-second-brain.md)
- *From Graph to Intelligence: The My Curator MCP* — the bridge, and why a graph reads differently from a folder · [GitHub version](./from-graph-to-intelligence-my-curator-mcp.md) · [Substack](https://talirezun.substack.com/p/from-graph-to-intelligence-the-my)
- *The Agent Memory Problem — And Why Your Second Brain Might Be the Answer* — the landscape of attempts at agent memory · [GitHub version](./the-agent-memory-problem.md) · [Substack](https://talirezun.substack.com/p/the-agent-memory-problem-and-why)
- *The Shared Brain: When Second Brains Start Thinking Together* — with Dražen Kapusta; the collective layer · [GitHub version](./the-shared-brain-thinking-together.md) · [Substack](https://talirezun.substack.com/p/the-shared-brain-when-second-brains)
- *Second Brain to Shared Brain: Building a Neural Network of Your Own Knowledge* · [GitHub version](./neural-network-of-your-own-knowledge.md) · [Substack](https://talirezun.substack.com/p/second-brain-to-shared-brain-building)
- *The Handoff Writes Itself* — the agent memory layer, when it shipped · [GitHub version](./the-handoff-writes-itself.md) · [Substack](https://talirezun.substack.com/p/the-handoff-writes-itself)
- *Where Your Context Lives* — three layers of context in one folder you own · [GitHub version](./where-your-context-lives.md) · [Substack](https://talirezun.substack.com/p/where-your-context-lives)
- *The Context Engine* — three kinds of context, three write rules, and the measurements (Režun, 2026d above) · [GitHub version](./the-context-engine.md) · [Substack](https://talirezun.substack.com/p/the-context-engine)
- *The Right Context, Not All of It* — the lesson in context engineering behind Section 6 · [GitHub version](./the-right-context-not-all-of-it.md) · [Substack](https://talirezun.substack.com/p/the-right-context-not-all-of-it)

**Field Notes** — [fieldnotes.talirezun.com](https://fieldnotes.talirezun.com): [Chapter 01 · Context Engineering](https://fieldnotes.talirezun.com/context-engineering) · [Chapter 02 · Agent Memory and Second Brains](https://fieldnotes.talirezun.com/agent-memory) · [Chapter 03 · Coding Agents and Harnesses](https://fieldnotes.talirezun.com/coding-agents)

---

## About the Author

**Dr. Tali Režun** is a Serial Entrepreneur, Business Developer, and Academic at the forefront of frontier technologies. As Vice Dean of Frontier Technologies at [COTRUGLI Business School](https://cotrugli.eu/), he leads AI innovation initiatives and shapes MBA curricula for the next generation of technology leaders. With over 30 years of entrepreneurial experience — founding and scaling ventures including The Curator, Lumina AI, Moj AI, Block Labs, 4thTech, Immu3, PollinationX, and Online Guerrilla — he bridges cutting-edge research in AI and Web3 with practical business transformation.

**Tali's Links:**

- [talirezun.com](https://talirezun.com/)
- [X (formerly Twitter)](https://x.com/talirezun)
- [LinkedIn](https://www.linkedin.com/in/talirezun)
- [ResearchGate](https://www.researchgate.net/profile/Tali-Rezun)
- [Substack](https://talirezun.substack.com/)
- [Field Notes](https://fieldnotes.talirezun.com/)
- [COTRUGLI Profile](https://cotrugli.org/talirezun/)
- [GitHub](https://github.com/talirezun/the-curator)

---

**Dr. Tali Režun**
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)

*Published: October 2026 (research article, ResearchGate) · repository copy prepared 11 October 2026, checked against v3.82.1*
*Part of: [The Curator Research Series](https://github.com/talirezun/the-curator/tree/main/research)*
*Previous in series: [The Second Brain That Grows Smarter](./the-second-brain-that-grows-smarter.md) · [Building Knowledge Immortality](./knowledge-immortality-second-brain.md) · [From Graph to Intelligence](./from-graph-to-intelligence-my-curator-mcp.md) · [The Agent Memory Problem](./the-agent-memory-problem.md) · [The Shared Brain: When Second Brains Start Thinking Together](./the-shared-brain-thinking-together.md) · [Second Brain to Shared Brain](./neural-network-of-your-own-knowledge.md) · [The Handoff Writes Itself](./the-handoff-writes-itself.md) · [Where Your Context Lives](./where-your-context-lives.md) · [The Context Engine](./the-context-engine.md) · [The Right Context, Not All of It](./the-right-context-not-all-of-it.md)*
*Open source | Local-first | Privacy-first*
