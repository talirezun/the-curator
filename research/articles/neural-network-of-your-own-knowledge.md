# Second Brain to Shared Brain: Building a Neural Network of Your Own Knowledge

**By Dr. Tali Režun**
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)
Serial Entrepreneur · AI Researcher · Builder of Second Brains

> The road from a single idea in a GitHub gist to a knowledge system two chapters deep: a personal Second Brain that has been stable since April, and a Shared Brain that just came through five structured hardening phases and is waiting on the one test that matters most. This article picks up directly where ["The Shared Brain: When Second Brains Start Thinking Together"](./the-shared-brain-thinking-together.md) left off.
>
> *From Lab to Life Series · The Curator: Article 6*

---

## Table of Contents

1. [Picking Up Where We Left Off](#picking-up-where-we-left-off)
2. [Why Build a Neural Network of Your Own Knowledge](#why-build-a-neural-network-of-your-own-knowledge)
3. [What The Curator Actually Is](#what-the-curator-actually-is)
4. [My Curator MCP: The Bridge to Frontier Models](#my-curator-mcp-the-bridge-to-frontier-models)
5. [The Agent Memory Problem, Revisited](#the-agent-memory-problem-revisited)
6. [Shared Brain: The Collective Layer, Properly Explained](#shared-brain-the-collective-layer-properly-explained)
7. [Five Phases, Two Bugs, and What "Battle-Tested" Actually Means](#five-phases-two-bugs-and-what-battle-tested-actually-means)
8. [Where Shared Brain Actually Helps: The Real Use Cases](#where-shared-brain-actually-helps-the-real-use-cases)
9. [The Engineering Philosophy Behind All of This](#the-engineering-philosophy-behind-all-of-this)
10. [What's Still Open, and What Comes Next](#whats-still-open-and-what-comes-next)
11. [Where This Leaves Us](#where-this-leaves-us)
12. [Clarification: Key Terms](#clarification-key-terms)
13. [Sources and References](#sources-and-references)
14. [About the Author](#about-the-author)
15. [Disclaimer](#disclaimer)

---

## Picking Up Where We Left Off

Dražen Kapusta and I ended [the last article in this series](./the-shared-brain-thinking-together.md) on an invitation. Start small, we said. One cohort, one team, one domain, one shared repository, one weekly synthesis cycle. Watch what happens when a group starts seeing patterns it couldn't see before.

Seven weeks have passed since then. This article is the honest answer to the question that invitation was really asking: did it hold up?

I want to answer it the way I try to answer everything in this series, which is without the pitch version. Not "Shared Brain works." Not "collective intelligence is here." Just: here is exactly what we built, exactly what broke, exactly what we fixed, and exactly what is still unproven.

The short version, if you want it before the long version: Second Brain is no longer a question mark. It has been public, stable, and dogfooded hard since April, and this article is also the first time I'm laying out the complete case for why it exists at all, not just what it does. Shared Brain went from a specification to a public beta to five structured hardening phases in about seven weeks, and came out the other side with a green test suite, real admin tooling, GDPR-grade erasure, and two production-grade concurrency bugs caught and closed before any user could hit them. It is mature enough to trust. It is not yet proven at the one scale that counts most, which is a real group of people building a real collective wiki together, over time, without me in the room.

That's where we stand. Now let me build the whole case, from the foundations up, because a few things about *why* any of this matters got compressed in earlier articles and deserve the full explanation this time.

---

## Why Build a Neural Network of Your Own Knowledge

Here is the felt problem, before any of the architecture. You read something. It's good. You finish it, you nod, maybe you highlight a paragraph, and then it's gone. Not deleted — gone the way most of what we read is gone, dissolved into a vague impression that surfaces, if you're lucky, as a half-remembered feeling the next time someone brings up the topic. Multiply that by every article, every paper, every book, every meeting, every year of a career, and you get the actual state of most people's accumulated expertise: enormous in volume, almost entirely unretrievable in practice.

This isn't a discipline problem. I've tried the discipline route — folders, tags, a personal wiki maintained by hand, the whole Notion-and-good-intentions stack. It fails for a structural reason, not a willpower reason: **the tedious part of maintaining a knowledge base was never the reading or the thinking. It was the bookkeeping.** Deciding where a new idea connects to twelve old ones, updating every page that idea touches, catching the contradiction between something you believed in 2023 and something you learned in 2025 — that's clerical work, and clerical work is exactly what nobody sustains for years on their own.

Andrej Karpathy named this precisely in the small [GitHub gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) that started this entire project. His proposal, which I've built my last two years of work around, was to stop asking AI to search your documents every time you have a question, and instead ask AI to continuously build and maintain a structured wiki — a living, compounding collection of plain markdown files that integrates every new source you add. His metaphor: [Obsidian](https://obsidian.md) is the IDE, the LLM is the programmer, the wiki is the codebase.

I want to sit with the word "neural network" for a moment, because I use it deliberately and not just as a metaphor borrowed from AI hype. A neural network gets its power not from any single node, but from the density and weighting of connections between nodes — the same input produces a richer output as more connections form around it. A personal knowledge graph works the same way. A single fact sitting alone in a note is nearly worthless. The same fact, cross-linked to the six other things it relates to, backlinked from everywhere it's been referenced, sitting inside a graph that's had two years to densify around it — that's not a note anymore. That's a structure that can surface a connection you made unconsciously, that you'd never have thought to search for, because you didn't know to ask the question.

This is the actual distinction between **curation and retrieval**, and I think it's the most important idea in this entire project. Retrieval-Augmented Generation — RAG — treats your documents as a lookup table: chunk everything, embed it, and at query time fetch whatever is mathematically closest to your question. It works fine for simple lookups. But it starts from zero every single time. Nothing compounds. The tenth question you ask gets no benefit from the fact that you asked nine questions before it. Curation is the opposite bet: read once, integrate permanently, and let every new source deepen a structure that already exists. The knowledge is compiled once and kept current — not re-derived on every query. (I made the full case for this in [Article 1 of this series](./the-second-brain-that-grows-smarter.md).)

Why does this matter now, specifically, in 2026, more than it would have five years ago? Because for the first time, the compiling can happen automatically. Karpathy's own workflow required a terminal, an LLM agent, and a level of technical comfort that put it out of reach for almost everyone — including, frankly, most of the smart, curious people who would benefit from it the most. That gap between "elegant idea" and "usable by a non-engineer" is exactly the gap I built The Curator to close. And once a single person's knowledge graph is automatable, the next question is unavoidable: if this works for one mind, why would it stop at one? That's the thread this whole article pulls on — from a personal neural network of knowledge, to a collective one, and everything in between.

---

## What The Curator Actually Is

[The Curator](https://github.com/talirezun/the-curator) is a local, open-source application, MIT-licensed, currently at **v3.0.6**, built on a Node.js/Express backend with a vanilla JavaScript frontend — no build step, nothing to compile — and an LLM abstraction layer that runs on Google Gemini or Anthropic Claude, your choice. If you want to follow along from zero, the [User Guide](../../docs/user-guide.md) walks through installation, your first ingest, and daily use in plain language.

You drop in a PDF, an article, a note, a transcript. The Curator reads it and **atomizes** it — a process we call [Atomic Decomposition](../../docs/architecture.md#design-decisions) — into three kinds of interlinked markdown pages instead of indexing it for later retrieval:

- **Entities** — the nouns. Named people, companies, tools, institutions. Each gets a dedicated page that accumulates facts and connections over time, the same way a Wikipedia entry does, except it's compiled from everything *you've* personally read, not everything the internet collectively agrees on.
- **Concepts** — the ideas. Frameworks, techniques, principles, recurring themes. The connective tissue that lets the graph reason across sources rather than just storing them side by side.
- **Summaries** — the narrative glue. One per source, distilling the key takeaways and linking back to every entity and concept that source introduced or touched.

Every subsequent ingest updates existing pages rather than duplicating them, so the wiki gets *denser*, not just bigger — that's the compounding property I described above, made literal, and the [ingestion pipeline](../../docs/ingestion-pipeline.md) is the part of the codebase I've hardened most obsessively to make that guarantee hold. [Obsidian](https://obsidian.md) reads the same folder natively as a zoomable, color-coded knowledge graph, with entities, concepts, and summaries auto-tinted so you can see the shape of your own thinking at a glance. A built-in multi-turn chat answers questions from the wiki with citations back to the exact source page. [GitHub sync](../../docs/sync.md) keeps everything consistent across machines — a three-minute one-time setup, then a click to push and a click to pull.

Each wiki is organised into focused [domains](../../docs/domains.md) — one for AI research, one for business strategy, one for personal notes — because a single general-purpose brain that covers everything ends up good at nothing. Each domain is a specialist that compounds on its own.

The engineering underneath this has matured in ways that don't show up in a feature list. Early versions of the app produced duplicate ghost files the moment a wiki got large enough — the same entity spawning three slightly different pages because the deduplication logic wasn't strict enough. That's the unglamorous work that had to hold before anything else could be built on top: entity and concept deduplication, bidirectional backlink injection, wikilink normalization. By **v2.0.0**, The Curator passed its first "ready for public release" audit — clean codebase, zero exposed secrets, documentation current. From there it kept adding real capability: a [model-lifecycle fallback chain](../../docs/model-lifecycle.md), so a provider quietly retiring a model doesn't break your ingest pipeline mid-project; three phases of [**AI Wiki Health**](../../docs/ai-health.md) — broken-link rescue, orphan-page rescue, semantic near-duplicate detection — each opt-in, cost-estimated before you run it, and gated behind a preview so nothing destructive happens without your sign-off; and [**Compile to Wiki**](../../docs/user-guide.md#compiling-a-conversation-to-your-wiki-v250), which turns any chat conversation into permanent, cross-referenced wiki pages with one click, so research you do *inside* a conversation doesn't evaporate the moment you close the window.

I've been dogfooding this hard. My own `articles` domain — the one behind every piece I've published in this series — ran past 2,000 nodes by June, and by the time of a live audit demo mid-month, had reached 3,305 nodes and 15,095 edges. That's not a demo number. That's two years of reading and writing, made concrete, navigable, and — this is the part that still gets me every time — *queryable*, in a way it never was when it just lived in my head.

---

## My Curator MCP: The Bridge to Frontier Models

Building a second brain is valuable on its own. Connecting it to a frontier model is where it stops being a filing system and starts being a research partner. I told this part of the story in full in [Article 3 of this series](./from-graph-to-intelligence-my-curator-mcp.md); here's the updated shape of it.

[**My Curator MCP**](../../docs/mcp-user-guide.md) was born in **v2.3.0** as a local [Model Context Protocol](https://modelcontextprotocol.io) server, and it now exposes **seventeen dedicated tools** to any MCP-compatible client — Claude Desktop, VS Code with an MCP-aware agent, LM Studio with a local model, or anything else that speaks the protocol.

Ten of those tools are for reading the graph, and they're not simple keyword search. Seven are retrieval-shaped — `list_domains`, `get_index`, `get_node`, `get_summary`, `get_tags`, `search_wiki`, and `search_cross_domain` for querying across every domain you've ever built simultaneously. The other three are genuinely graph-native: `get_graph_overview` for an orientation snapshot of a domain's topology in a single call, `get_connected_nodes` to traverse outward from any starting page across multiple hops, and `get_backlinks` for the bidirectional edge — "show me every page that links *to* this one," which a flat search index can't answer at all.

The remaining seven tools write. `compile_to_wiki` is the flagship — it's what turns "let's research this together" into a permanent wiki page the moment the conversation ends, using the same merge pipeline as a normal ingest, so compiling the same conversation twice is a safe no-op rather than a duplicate. The other six — `scan_wiki_health`, `scan_semantic_duplicates`, `fix_wiki_issue`, `dismiss_wiki_issue`, `undismiss_wiki_issue`, `get_health_dismissed` — let an agent maintain the wiki's structural integrity from inside a conversation: find broken links, propose fixes, track which issues you've already decided aren't worth fixing, without you ever touching the app's UI.

This became read-and-write at **v2.5.2**, and it changed what a conversation with Claude could actually accomplish. The canonical query pattern is simple: `list_domains` to see what's available, `get_index` to see a domain's shape, `search_wiki` or `search_cross_domain` to find relevant pages, `get_node` to pull full content. From there, an agent can traverse — pivot from a tag to its pages, from a page to its links, from a link to its incoming references — the way a researcher walks a library rather than the way a search engine returns ten blue links.

And because typing out the same disciplined instructions every session gets old fast, **v2.5.7** packaged all of this into the [**My Curator Claude Skill**](../../docs/mcp-user-guide.md#the-my-curator-claude-skill--best-results-out-of-the-box-v257) — a reusable playbook that ships in the repo and, once dropped into Claude Code's skills folder or a Claude Desktop project's knowledge files, makes every MCP conversation follow the same rules by default: ground every wikilink in a slug that actually exists before writing, refuse speculative links on a fresh domain that hasn't earned them yet, respect the fact that domains are siloed unless you explicitly cross-search them.

What this opens up, in practice, is a conversation like this one, which I have regularly now: *"What are the most important ideas in my AI domain that I've never explicitly connected to my business-strategy domain?"* The model traverses both graphs, pulls the hubs, finds the intersections, and surfaces a connection I made unconsciously over two years of reading without ever noticing I'd made it. Or: *"Compile everything we just figured out and save it to my `business` domain as a research summary."* And it lands, permanently, cited, cross-linked — ready for the next session to build on, instead of evaporating the moment I close the laptop.

That loop — ask, traverse, synthesize, write back — is not a chat interface. It's a frontier model doing deep research over your own intellectual history and committing the conclusions back into it. Which brings me to the part of this that I think matters more than anything else in this article.

---

## The Agent Memory Problem, Revisited

I wrote about this at length back in May, in [Article 4 of this series](./the-agent-memory-problem.md), and I want to update rather than repeat it, because the shape of the problem hasn't changed but the stakes have.

There is a race happening across the entire AI infrastructure industry, and it isn't about which model is smartest. It's about memory. Agents forget. They re-read documents they already summarized. They re-derive context that should already be sitting there. Pinecone shipped a product that essentially concedes vector search alone isn't enough for agentic work. SAP is spending heavily on tabular and graph memory. Microsoft keeps investing in graph-based memory for AI. Cloudflare shipped a memory product specifically for agents. When that many serious players move in the same direction simultaneously, the problem they're racing to solve is real.

The reason the standard answer — RAG — falls short for agentic work specifically is worth being precise about, because it's not that RAG is bad, it's that it's the wrong shape for the job. An agent isn't a chatbot. A chatbot receives a question, retrieves a few relevant chunks, generates an answer, done. An agent *runs a task* — it opens a file, cross-references a policy, writes a summary, calls a tool, verifies a result, loops back and does it again. For that kind of work, the relevant context is never three semantically similar paragraphs. It's the full package: the policy *and* the exception to the policy, the contract clause *and* the definition section that changes what it means. Miss one piece of that package and the agent either fails outright or, worse, produces something plausible and wrong.

Large context windows helped, but only as a bridge. I've watched this personally, running coding agents daily on real projects: even with a million-token window and an Opus-level model, once you're sitting at eighty or ninety percent context utilization, quality degrades in ways that are subtle but real. The model starts losing track of decisions made earlier in the session. This is sometimes called "context rot," and no amount of raw window size fixes it, because the problem was never really about capacity — it's about whether the right information is presented in a form the model can actually use, with clear provenance and structural coherence, rather than just being technically present somewhere in a very long prompt.

I think it's useful to separate agent memory into four distinct layers, because conflating them is where most confusion comes from: **in-context memory**, which is whatever's sitting in the active session and evaporates when it ends; **external memory**, the RAG/vector-search pattern, fast but stateless and re-derived every query; **persistent memory**, plain files that survive between sessions but don't inherently connect to each other; and **semantic memory**, a compiled, cross-referenced structure that compounds — which is exactly what a Curator wiki is.

Here is the thing I didn't fully spell out back in May, and it's the throughline of this whole article: **a semantic memory layer doesn't have to belong to one person.** Everything I described above about `get_graph_overview`, `get_connected_nodes`, and `get_backlinks` works identically whether the graph on the other end is my personal wiki or a Shared Brain that twenty people built together. An agent reasoning over a Shared Brain isn't drawing on one person's reading. It's drawing on a compiled synthesis of many people's reading, attributed, cross-referenced, and — critically — built the same way a personal wiki is built, so none of the graph-native tooling has to be reinvented for the collective case. That's not a minor technical convenience. It's the reason Shared Brain could exist as a natural extension of the architecture rather than a separate product.

Which is exactly what we built next.

---

## Shared Brain: The Collective Layer, Properly Explained

A [**Shared Brain**](../../docs/shared-brain.md) is a collective Curator wiki that a cohort, team, or research group builds together. Each contributor keeps a fully private personal wiki on their own machine, and opts in *only* the specific [domains](../../docs/domains.md) they choose to share — not their journal, not unfinished thinking, not unrelated work. Only the selected contribution.

Here's the part that makes it structurally different from a shared folder or a Confluence page, and it's the single design decision the entire feature hangs on: an LLM running **locally, on each contributor's own machine**, pre-processes their changed pages into compact delta summaries *before anything leaves the device*. Not raw files. The collective side receives structured knowledge, not a copy of someone's private notes. It resolves conflicting formulations, eliminates cross-contributor broken links, and attributes provenance to every fact it integrates. Every contributor then pulls the synthesized result back to their own machine as a separate, read-only mirror domain — queryable through Chat, Obsidian, or [My Curator MCP](../../docs/mcp-user-guide.md), exactly like any personal domain. If you want the full step-by-step, both roles are covered in the [Shared Brain User Guide](../../docs/shared-brain-user-guide.md), and the design reasoning is laid out in the [architecture doc](../../docs/shared-brain.md).

**Private brains remain private. Shared intelligence is built only from explicit contributions.** That one sentence is the whole design philosophy, and it's the answer to a trade-off that most collective-intelligence tools force on you badly: either everyone keeps their knowledge private and the group never actually learns together, or everything goes into one shared platform and individual ownership, nuance, and privacy disappear. We wanted a third path, and this is it.

The flagship use case, from day one, has been the **Vanguard MBA cohort at [COTRUGLI](https://cotrugli.eu/)** — a group of students, each running their own Curator, contributing a shared course-knowledge domain that compounds across the whole cohort instead of evaporating at the end of each module. The feature was co-developed with **Dražen Kapusta**, and its positioning is tied to the **Beautiful Mind thesis** we've been building together — the idea that collective intelligence, properly structured and attributed, can become something of a genuinely different order than the sum of individual minds, without flattening anyone's individual sovereignty in the process. That thesis also surfaces in a EU EIC Pathfinder Challenge submission — DeepRAP — where The Curator is listed as an open-source exploitation asset and a "dual-graph memory integration" research demonstrator.

The path from idea to working software ran through a full implementation spec finalized in mid-May: storage abstraction with both GitHub and Cloudflare R2 adapters, the delta-synthesis architecture, the local-pull mirror-domain model, and a set of explicitly flagged open questions we knew we'd need to research before writing more code. The storage infrastructure landed quietly first, in **v2.8.0**, not yet user-facing. Then **v3.0.0-beta.1** shipped everything at once — the setup wizard, push/pull, synthesis, and the opt-in feature flag. That's the beta I announced publicly around May 21, with 547 battle-test assertions behind it even at that early stage: 519 offline, 21 live-network, 7 live personal-access-token validation.

That was the beginning, not the end. What happened in the seven weeks since is the part worth stating plainly, because it's the actual answer to "how far has this progressed."

---

## Five Phases, Two Bugs, and What "Battle-Tested" Actually Means

A structured, four-track code audit — backend, routes and security, UI/UX, and tests, with every claim independently verified against the real code before anything was actioned — kicked off a five-phase hardening program. Running in parallel with it was a long, community-bug-report-driven sprint (the v3.0.1 beta series I wrote up separately) that fixed real issues surfaced by real users on real machines: Windows sync failures, Anthropic output-token ceilings, a semantic-duplicate scanner that had quietly become unreachable behind a UI regression. Along the way, that sprint delivered a security bundle — loopback-only binding so the app can't be reached by other devices on your network, cross-origin request guards, locked-down credential file permissions — and the test infrastructure that made the five formal phases below possible at all. (You can confirm your own install's lockdown at any time from the app's [System Check panel](../../docs/system-check.md).)

**Phase 1, v3.0.2, stopped the bleeding.** The audit's verified critical issue plus roughly ten high-severity ones got fixed: synthesis could be permanently bricked by a single malformed contribution, push only ever covered one opted-in domain at a time, and failed operations could silently render as a false "success" to the user.

**Phase 2, v3.0.3, closed the trust boundary.** Contribution tracking moved from wall-clock filtering to a proper processed-submission watermark, so a contributor's clock skew can no longer silently drop facts from the synthesis. Server-side sanitization closed a forged-provenance attack path — someone couldn't spoof whose contribution a fact came from.

**Phase 3, v3.0.4, added real visibility.** Pending-page counts, last-synthesis status, named conflicts instead of silent ones, skipped-page retry, a working read-only membership tier, and full keyboard and screen-reader accessibility.

**Phase 4, v3.0.5, shipped admin tooling that actually deserves the name.** A real admin token, a member directory, a [GDPR-compliant right-to-erasure flow](../../docs/shared-brain-compliance.md) with typed confirmation, invite-token re-display — everything that previously required hand-editing config files by hand. The operational side of all of this now lives in the [admin operations guide](../../docs/shared-brain-admin.md).

**Phase 5, v3.0.6, is the one I want to spend real time on**, because it's the clearest evidence that the testing behind this was real rather than performative. This phase ran production battle-testing: real GitHub storage, real Gemini *and* real Anthropic calls (not mocked), simulated multi-machine concurrency, and a ten-contributor by fifty-page scale probe. It found and fixed two genuine bugs that no offline test would ever have caught.

The first was a **concurrent-create race**: two contributors' apps writing a brand-new page at the exact same instant could throw an error for whichever one lost the race. Annoying, but visible — you'd know something went wrong.

The second was quieter, and it's the one that actually worries me in retrospect, because it wouldn't have announced itself. A **stale-read timing bug in the revoke and erasure path** meant that removing a contributor from a Shared Brain could delete their pages and then silently rebuild the collective wiki as *completely empty* — while the system still reported success. Imagine running that on a real cohort's shared course wiki: a routine administrative action, a green checkmark, and a semester of collective work quietly gone, with no error anywhere to tell you it happened.

Both bugs were root-caused, fixed, and re-verified against the live GitHub API before the release closed. The offline suite sits at 22 of 22 green. The live sweep against both LLM providers is green too. That's the honest state of the automated evidence, and I want to be precise about what it does and doesn't tell us: it tells us the software behaves correctly under everything we could think to simulate, including real concurrency and real network conditions. It does not yet tell us how it behaves when twenty actual humans, with actual inconsistent habits and actual half-finished contributions, use it together for a full semester. That test can't be simulated. It has to happen.

What hasn't happened yet, and what the project's own [roadmap](../../docs/shared-brain.md) names as the actual gate to a v3.1.0 general-availability release, is a structured pilot with a real cohort. Everything up to this point has been verified by tests, simulations, and solo or paired dogfooding between me and a handful of early testers. The Vanguard MBA cohort remains the natural first audience for that pilot, and it's the piece I'm most looking forward to writing about next, because it's the one chapter of this story that no amount of careful engineering can substitute for.

---

## Where Shared Brain Actually Helps: The Real Use Cases

It's easy to describe an architecture and harder to be concrete about who actually needs it. Here's where I think Shared Brain earns its place, beyond the cohort use case that's driven the build so far. (The full catalogue of workflows, personal and collective, lives in the [use-cases reference](../../docs/use-cases.md).)

**Education, at the cohort level**, is the use case we designed for first, and it's the clearest case for why this matters. The old model of a course assumes knowledge flows one direction, professor to student, and evaporates the moment the semester ends. A cohort running a Shared Brain leaves with something categorically different: a living, structured, attributed knowledge graph containing hundreds of pages — papers, frameworks, thinkers, cases, contradictions, and open questions the group surfaced together — instead of a folder of slides nobody reopens.

**Organizational memory** is the case I think is most underrated. Most enterprise knowledge-management systems fail because they treat knowledge as content storage, when the most valuable organizational knowledge is actually *context*: why an architecture decision was made, why a client relationship succeeded, what a senior engineer knew that never got written down. A software company could build a Shared Brain out of architectural decision records, post-mortems, and internal RFCs, and a new hire could ask an agent *"why did we choose Postgres over MongoDB for the auth service"* and get an answer with a citation back to the actual decision record, rather than three different half-remembered stories from three different senior people.

**Research labs and literature reviews** are a natural fit precisely because contradiction-surfacing is a feature, not a bug, of the synthesis process. A research group building a living literature graph together sees where papers disagree with each other in a way that a shared Zotero library never surfaces on its own.

**Consulting firms** can build a sanitized client-insights brain, where consultants contribute patterns and lessons without exposing confidential client material, compounding firm-wide expertise without the confidentiality risk of a raw shared document store.

**And AI agents themselves** are, I'd now argue, the use case that ties all the others together. Everything I described in the agent-memory section above about a personal wiki as a semantic memory layer applies identically to a Shared Brain, except the agent is now reasoning across accumulated *group* understanding rather than one person's. An agent can ask a Shared Brain which concepts are central to a group's thinking, where contributors disagree, which assumptions keep appearing but were never actually tested, which past decisions are relevant to a problem the team is facing right now. That's not a knowledge base anymore. That's a cognitive partner operating inside structured, governed, attributed collective memory — which is, I think, a meaningfully different thing from every other AI-agent-plus-company-wiki integration currently being sold as "enterprise AI memory."

---

## The Engineering Philosophy Behind All of This

A handful of principles show up in almost every release note across this entire project, and I think they matter as much as any individual feature, because they're the reason I trust the system enough to be honest about it publicly.

**Additive only.** New features are not allowed to break what already works. Every phase of the Shared Brain hardening arc ends with some version of "zero schema changes, backward-compatible." That discipline is the entire reason a solo-run Second Brain from April still works identically today, untouched by seven weeks of Shared Brain engineering happening around it.

**Local-first and privacy-preserving are non-negotiable, not a feature flag.** The decision to run the LLM synthesis step on each contributor's own machine, specifically so raw content never has to leave the device, shaped the entire delta-summary architecture from the ground up. It wasn't a footnote added after the fact. It's why the architecture looks the way it does.

**Honest framing as credibility.** Real trade-offs get documented, not smoothed over — manual sync, no mobile app yet, an admin-erasure procedure that's deliberately irreversible. The [Shared Brain compliance documentation](../../docs/shared-brain-compliance.md) says outright that it isn't legal advice and isn't a DPA. I'd rather a reader trust one honest limitation than believe ten polished claims, and that candor is a deliberate positioning choice that shows up in every article in this series, this one included.

**Test discipline scales with risk.** Every hardening phase shipped with both a deterministic offline suite and a live-provider verification pass, and the two bugs Phase 5 caught are the direct payoff of insisting on that live pass even after the offline suite was already fully green. If I'd stopped at "the offline tests pass," a cohort's collective wiki could have been silently deleted on my watch.

---

## What's Still Open, and What Comes Next

**v3.1.0 GA** is next for Shared Brain, gated on a Playwright automated wizard pass and then, critically, the structured cohort pilot described above. **v3.1** adds Cloudflare R2 as a second storage backend, unlocking [EU data residency](../../docs/shared-brain-compliance.md) and custom-domain endpoints for organizations that need them. **v3.2** targets enterprise mode — GitHub App authentication, SSO, SIEM integration. Beyond that: branch-per-cohort support so one repository can host multiple parallel cohorts, a diff-history UI, admin roll-up dashboards, and scheduled or triggered synthesis instead of a manual admin click. (The living version of this roadmap lives in the [architecture doc](../../docs/shared-brain.md).)

A few adjacent threads are worth naming honestly rather than glossing over. The Curator is roughly **80% aligned** with the emerging Open Knowledge Format (OKF) standard today, and the open tension is Obsidian-style `[[wikilinks]]` versus OKF's standard markdown link syntax — I'm adopting non-breaking changes incrementally as OKF itself evolves, rather than forcing a disruptive migration now. On monetization: API-gated access to curated expert knowledge wikis, per-brain API keys, and a B2B licensing angle are documented, not yet productized — the [Shared Brain monetization guide](../../docs/shared-brain-monetization.md) in the repo already lays out a no-code path for independent experts, professors, and firms to charge for access to their brain, and I expect this to become a real announcement once it's more than a specification. And on distribution: directory submissions are sequenced ahead of a joint Product Hunt and Show HN launch, alongside subreddit and MCP-directory campaigns — SEO foundation first, community-driven launches as the actual growth lever, not the other way around.

---

## Where This Leaves Us

I keep coming back to the same question every time I write one of these updates: what actually justifies building a neural network of your own knowledge, instead of just trusting search, or trusting memory, or trusting whichever AI product ships next with a "memory" feature attached to it?

My honest answer, after two years of living inside this system, is ownership. Not ownership as an ideological position — ownership as a practical property that changes what the system can become. A knowledge graph you built, that runs on your machine, in a format that will still open in a text editor decades from now, doesn't depend on a company's roadmap, doesn't disappear if a subscription lapses, and doesn't have someone else's incentives baked into what it chooses to surface. Extend that same property to a group, with explicit consent and attribution at every step, and you get something the current wave of "enterprise AI memory" products isn't really offering: collective intelligence that a group actually owns together, rather than intelligence a vendor rents back to them.

Second Brain proved that property holds for one person, over years, at real scale — 3,305 nodes and counting, stable since April, dogfooded hard. Shared Brain just proved it can survive five structured hardening phases and a real production battle-test, including two bugs that would have been genuinely bad if they'd shipped. What it hasn't proven yet is the thing that matters most: whether a real group of people, without me managing every step, will actually build something together that neither of us could have built alone.

That's the next article in this series. I intend for it to be about the Vanguard cohort actually doing this, not about the architecture that makes it possible. The architecture, I think, is finally ready to get out of the way.

If you want to start before that article lands, the fastest paths in are the [User Guide](../../docs/user-guide.md) for a personal Second Brain and the [Shared Brain User Guide](../../docs/shared-brain-user-guide.md) for a cohort or team.

---

## Clarification: Key Terms

- **[Atomic Decomposition](../../docs/architecture.md#design-decisions):** The Curator's core process — breaking any source into three interconnected component types (Entities, Concepts, Summaries) rather than storing it as an undifferentiated blob or a set of retrieval chunks.
- **RAG (Retrieval-Augmented Generation):** A technique where AI retrieves relevant document chunks at query time to answer questions. Fast for simple Q&A; stateless, so nothing compounds across sessions, and structural context between chunks is lost.
- **Semantic Memory (Compiled Wiki):** A persistent, cross-referenced knowledge structure built from plain markdown, distinguished from RAG by compounding — each new source integrates with and deepens the existing graph rather than being re-derived on every query.
- **[MCP (Model Context Protocol)](../../docs/mcp-user-guide.md):** An open standard letting AI models use external tools and data sources in a structured way. My Curator MCP is a local server exposing a Curator wiki's read and write operations to any MCP-compatible client.
- **Graph-Native Access:** Retrieval that understands topology — traversing links, following backlinks, pulling neighborhoods — as opposed to flat keyword or vector search, which can't answer relational questions like "what links to this."
- **[Delta Summary](../../docs/shared-brain.md):** The compact, LLM-generated synthesis of a contributor's changed pages, produced locally on their own machine before anything is pushed to a Shared Brain — the mechanism that lets raw private content stay private.
- **Knowledge Sovereignty:** The organizing thesis of this entire project — personal ownership of your own knowledge graph (Second Brain), extending to collective ownership of a shared one (Shared Brain), without either layer depending on a vendor's infrastructure or goodwill to remain accessible.

---

## Sources and References

- Karpathy, A. *LLM Wiki — A pattern for building personal knowledge bases using LLMs.* GitHub Gist. <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>
- *The Curator* — open-source Second Brain and Shared Brain application by Dr. Tali Režun. GitHub: <https://github.com/talirezun/the-curator>
- Režun, T. *The Second Brain That Grows Smarter and Lives on Your Computer.* From Lab to Life. <https://talirezun.substack.com/p/the-second-brain-that-grows-smarter> · GitHub version: <https://github.com/talirezun/the-curator/blob/main/research/articles/the-second-brain-that-grows-smarter.md>
- Režun, T. *Building Knowledge Immortality Through the Second Brain Architecture and The Curator App.* From Lab to Life. <https://talirezun.substack.com/p/building-knowledge-immortality-through> · GitHub version: <https://github.com/talirezun/the-curator/blob/main/research/articles/knowledge-immortality-second-brain.md>
- Režun, T. *From Graph to Intelligence: The My Curator MCP and the Art of Querying Your Second Brain.* From Lab to Life. <https://talirezun.substack.com/p/from-graph-to-intelligence-the-my> · GitHub version: <https://github.com/talirezun/the-curator/blob/main/research/articles/from-graph-to-intelligence-my-curator-mcp.md>
- Režun, T. *The Agent Memory Problem, and Why It Matters.* From Lab to Life. <https://talirezun.substack.com/p/the-agent-memory-problem-and-why> · GitHub version: <https://github.com/talirezun/the-curator/blob/main/research/articles/the-agent-memory-problem.md>
- Režun, T. & Kapusta, D. *The Shared Brain: When Second Brains Start Thinking Together.* From Lab to Life. <https://talirezun.substack.com/p/the-shared-brain-when-second-brains> · GitHub version: <https://github.com/talirezun/the-curator/blob/main/research/articles/the-shared-brain-thinking-together.md>
- Režun, T. *The Curator — Product Update (v3.0.1-beta.20 → beta.23).* From Lab to Life. <https://talirezun.substack.com/p/the-curator-product-update>
- *The Curator — Documentation.* User guides referenced throughout this article: [User Guide](../../docs/user-guide.md) · [Shared Brain User Guide](../../docs/shared-brain-user-guide.md) · [Shared Brain architecture](../../docs/shared-brain.md) · [Admin operations](../../docs/shared-brain-admin.md) · [Compliance reference](../../docs/shared-brain-compliance.md) · [Monetization](../../docs/shared-brain-monetization.md) · [My Curator MCP](../../docs/mcp-user-guide.md) · [Use cases](../../docs/use-cases.md).

---

## About the Author

**Dr. Tali Režun** is a Serial Entrepreneur, Business Developer, and Academic at the forefront of frontier technologies. As Vice Dean of Frontier Technologies at [COTRUGLI Business School](https://cotrugli.eu/), he leads AI innovation initiatives and shapes MBA curricula for the next generation of technology leaders. With over 30 years of entrepreneurial experience — founding and scaling ventures including The Curator, Lumina AI, Moj AI, Block Labs, 4thTech, Immu3, PollinationX, and Online Guerrilla — he bridges cutting-edge research in AI and Web3 with practical business transformation.

**Tali's Links:**

- [talirezun.com](https://talirezun.com/)
- [X (formerly Twitter)](https://x.com/talirezun)
- [LinkedIn](https://www.linkedin.com/in/talirezun)
- [Substack](https://talirezun.substack.com/)
- [COTRUGLI Profile](https://cotrugli.org/talirezun/)
- [GitHub](https://github.com/talirezun/the-curator)

---

## Disclaimer

### Research and Educational Purpose

This article is published for research and educational purposes only. The content represents my personal experiences, observations, and analysis based on extensive hands-on development and testing of The Curator and Shared Brain over the past several months.

### No Commercial Relationships

I have not been compensated, sponsored, or otherwise financially supported by any of the companies, platforms, or tools mentioned in this article. All opinions, assessments, and recommendations are my own, based solely on independent research and practical experience.

### Beta Software

Shared Brain remains beta-labeled software as of this writing. Behavior, configuration paths, and admin workflows may change before general availability. Treat any cohort or organizational deployment as an active experiment, and keep independent backups of contributed knowledge until you're confident the system meets your operational requirements.

### Evolving Landscape

The AI and collective-intelligence ecosystem is developing rapidly. Version numbers, feature status, and specific figures cited in this article reflect the state of the project as of early July 2026, and may have changed by the time you read this — check [github.com/talirezun/the-curator](https://github.com/talirezun/the-curator) for the current state.

### Your Responsibility

You are solely responsible for evaluating whether and how to implement AI or collective-intelligence technologies in your specific context. Consider your risk tolerance, regulatory requirements, and organizational capabilities before deployment.

---

**Dr. Tali Režun**
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)

*Published: July 2026*
*Part of: [The Curator Research Series](https://github.com/talirezun/the-curator/tree/main/research)*
*Previous in series: [The Second Brain That Grows Smarter](./the-second-brain-that-grows-smarter.md) · [Building Knowledge Immortality](./knowledge-immortality-second-brain.md) · [From Graph to Intelligence](./from-graph-to-intelligence-my-curator-mcp.md) · [The Agent Memory Problem](./the-agent-memory-problem.md) · [The Shared Brain: When Second Brains Start Thinking Together](./the-shared-brain-thinking-together.md)*
*Open source | Local-first | Privacy-first*
