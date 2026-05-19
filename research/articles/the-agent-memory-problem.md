# The Agent Memory Problem — And Why Your Second Brain Might Be the Answer

**By Dr. Tali Režun**  
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)  
Serial Entrepreneur · AI Researcher · Builder of Second Brains

> How the race to solve AI agent memory led me back to markdown files, knowledge graphs, and the quiet power of a second brain.

> *From Lab to Life Series · The Curator: Article 4*

---

## Table of Contents

1. [The Agent Memory Problem](#the-agent-memory-problem)
2. [Where It All Started: The Chatbot Era and the RAG Approach](#where-it-all-started-the-chatbot-era-and-the-rag-approach)
3. [The Agent Shift: When Memory Becomes Critical](#the-agent-shift-when-memory-becomes-critical)
4. [The Memory Landscape: What the Industry Is Building](#the-memory-landscape-what-the-industry-is-building)
5. [A Different Approach: The Second Brain as Memory Layer](#a-different-approach-the-second-brain-as-memory-layer)
6. [What The Curator Is](#what-the-curator-is)
7. [What My Curator MCP Opens Up](#what-my-curator-mcp-opens-up)
8. [The Honest Assessment: What Works and What Remains Open](#the-honest-assessment-what-works-and-what-remains-open)
9. [Looking Ahead: Shared Second Brains and the Collective Layer](#looking-ahead-shared-second-brains-and-the-collective-layer)
10. [Clarification: Key Terms](#clarification-key-terms)
11. [Where This Leaves Us](#where-this-leaves-us)
12. [Sources and References](#sources-and-references)

---

## The Agent Memory Problem

There is a race happening right now, and it is not about which model is smarter or which company raises the most money.

It is about memory.

Every serious infrastructure vendor in artificial intelligence is currently trying to solve the same problem: agents forget. They forget what they learned two steps ago. They re-read documents they already summarised. They re-ask questions the system already answered. They waste enormous amounts of compute simply trying to reconstruct context that should already be there.

I have been watching this space closely for over a year and a half, and the signal has become unmistakable. [Pinecone](https://www.pinecone.io) — a vector database company — recently shipped a product that essentially admits vector search is not sufficient on its own. [SAP](https://www.sap.com) is spending heavily on AI memory infrastructure. Google made knowledge architecture the headline of Cloud Next. Cloudflare shipped a memory product specifically for agents. Microsoft keeps investing in graph-based memory for AI.

When that many serious players move simultaneously in the same direction, the problem they are racing to solve is real.

And here is what I find fascinating: the answer they are all circling points, in different ways, toward something I have been building for some time now — [**The Curator**](https://github.com/talirezun/the-curator), the open-source second brain application I introduced in [Article 1 of this series](./the-second-brain-that-grows-smarter.md).

But before I get there, let me explain how we arrived at this moment.

---

## Where It All Started: The Chatbot Era and the RAG Approach

When organisations first started deploying AI-powered knowledge tools, the dominant pattern was **Retrieval-Augmented Generation — RAG**. The idea is straightforward: take your documents, break them into small chunks, convert those chunks into numerical vectors that represent their meaning, and store everything in a vector database. When a user asks a question, find the chunks that are mathematically closest to the query and feed them to the language model as context.

For chatbot-era use cases, this worked reasonably well. A user types a question. The system retrieves three semantically similar chunks. The model generates a paragraph. Transaction complete.

But I spent a lot of time in that RAG world, building and testing retrieval systems across various applications. And what I found — consistently, across different implementations and use cases — was that the moment you needed genuine context, things fell apart. As soon as the task required cross-referencing multiple documents, understanding clauses in legal contracts, reasoning over structured data, or synthesising information from sources that only made sense together, the hallucination rate climbed sharply.

In my research and practice with RAG systems over the course of more than a year and a half, I documented hallucination rates exceeding twenty percent on context-dependent queries. That is not a rounding error. That is a structural limitation of the retrieval approach. **Chunking destroys structure. Semantic similarity does not equal contextual relevance. The model gets fragments instead of understanding.**

I found a partial solution in large context windows. Google's [Gemini Flash](https://ai.google.dev/gemini-api/docs/models#gemini-2.5-flash) models offered an extremely cost-effective path to one million token context windows, which meant I could ingest entire legal documents or large knowledge bases and get reliable results without chunking at all. For a broad class of applications, this was genuinely useful — and surprisingly affordable given the per-token pricing.

But it was a bridge solution, not a permanent answer. Once you move from isolated Q&A into actual agentic workflows, the context window approach runs into its own hard limits. And those limits matter a great deal.

---

## The Agent Shift: When Memory Becomes Critical

An agent is not a chatbot. The difference sounds obvious but its implications run deep.

A chatbot receives a question, retrieves relevant text, and generates an answer. The transaction is self-contained. An agent, by contrast, *runs a task*. It opens a file, checks a database, retrieves a customer record, cross-references a policy, writes a summary, calls an API, verifies a result, and loops back to do it again. Real work across multiple steps, sources, and systems.

This changes everything about what memory means.

For an agent doing meaningful work, the relevant context is not three semantically similar paragraphs. It is the **full package**: the policy and the exception to the policy. The contract clause and the definition section that changes what it means. The customer record and the prior history and the applicable threshold. The code architecture and the feature specification and the existing implementation. Miss one piece of that package and the agent either fails, hallucinates, or — worse — produces a plausible but incorrect result.

And the context window, however large, does not solve this. Even with one million tokens available, problems persist. Model performance degrades as context grows longer and more cluttered. Research from [Chroma](https://www.trychroma.com) has shown this clearly. The challenge is not only whether the right information is present somewhere in the window. It is whether that information is presented in a form the model can actually use — with clear provenance, appropriate freshness, and structural coherence.

I have seen this in practice with coding agents, which I use intensively for building The Curator and other projects. Even with Opus-level models and million-token windows, a large code stack with architecture documentation, feature specifications, and implementation history will fill that context window fast. And the experience near the ceiling — around eighty to ninety percent utilisation — degrades noticeably. The model starts forgetting what it did at the beginning of the session. It loses track of earlier decisions. The quality of its reasoning drops in ways that are subtle but consequential.

This is why agent memory has become one of the central unsolved problems in applied AI. And it is why so much infrastructure investment is suddenly flowing into this space.

---

## The Memory Landscape: What the Industry Is Building

The infrastructure layer is responding to the agent memory challenge in several distinct ways. Understanding these approaches — and their respective limitations — is important context for what comes next.

### Vector Search and Its Limits

Vector databases remain the most widely deployed retrieval layer. They are fast, scalable, and good at finding semantically similar content. But Pinecone's recent product launch is instructive: the company built a new query language specifically because it concluded that standard vector retrieval does not carry enough information for agents. An agent does not just need relevant text. It needs *operating context* — the shape of the information, its provenance, its access controls, its freshness. Similarity search alone cannot deliver that.

### Document Structure and Hierarchical Retrieval

Some newer approaches challenge the fundamental assumption of chunking. A financial filing's risk factors section is not interchangeable with its management discussion. A contract clause cannot be understood without the definition section that controls it. Approaches that preserve document hierarchy — building tree-structured representations that let models reason through structure rather than search across flat vectors — are showing meaningful accuracy improvements on complex document tasks.

The principle that emerges is important: **the retrieval unit must match the kind of work being done.** A chunk works for a FAQ. A section works for a filing. A table works for financial analysis. A graph neighbourhood works for dependency reasoning.

### Business Data and Tabular Reasoning

Enterprise knowledge is largely not stored in the kind of text that RAG was designed for. It lives in ERP systems, governed tables, CRM records, and structured databases. SAP's billion-euro acquisitions in this space — including investments in tabular foundation models — reflect this reality. Reasoning over a spreadsheet by converting it to text and asking a language model to interpret the result is simply the wrong abstraction. Some knowledge needs to be handled in its native form.

### Knowledge Graphs and Relational Memory

Some agent tasks are fundamentally relational. Which suppliers connect to which shipments? Which customers share a particular failure pattern? Which incidents trace back to the same root cause? These are graph questions, and neither chunks nor tables carry the answer. Graph-based memory approaches — most prominently Microsoft's GraphRAG — are expensive and imperfect, but they keep returning because relational knowledge is genuinely distinct and important.

The honest summary of where the field stands: **there is no single solution.** The right memory architecture depends on the shape of the knowledge your agent needs. Most real agents need a combination of approaches. And picking the wrong primitives — or picking them before you understand what your agent actually needs — creates technical debt that compounds quickly.

---

## A Different Approach: The Second Brain as Memory Layer

I want to introduce an idea that does not fit neatly into any of the categories above — and that I think deserves serious attention as the agent memory conversation evolves.

It starts with a thought experiment from [Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), one of the founding members of OpenAI and former director of AI at Tesla. Some time ago, he published a small document on GitHub describing what he called the **LLM Wiki pattern**.

The core insight was this: instead of using AI to search through your documents every time you need information, use AI to continuously build and maintain a structured wiki. A living, compounding collection of plain markdown files that integrates every new source you add — updating existing pages, adding cross-references, flagging contradictions, strengthening connections. **Knowledge compiled once and kept current. Not re-derived on every query.**

> *"The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the bookkeeping."* — Andrej Karpathy

Karpathy's metaphor for his own workflow was precise: [Obsidian](https://obsidian.md) is the IDE. The LLM is the programmer. The wiki is the codebase. The LLM agent writes and maintains the files; the user browses results in real time, following links and exploring the growing graph.

The idea was elegant. The implementation was technically demanding. Most people — even technically capable ones — lacked the infrastructure to make it work at scale.

**That gap is where I built The Curator.** I explored this origin story in depth in [the first article](./the-second-brain-that-grows-smarter.md) of this series, and extended it into the concept of [knowledge immortality](./knowledge-immortality-second-brain.md) in the second.

---

## What The Curator Is

[The Curator](https://github.com/talirezun/the-curator) is an open-source, locally-hosted application that automates the LLM Wiki pattern and makes it accessible without any technical background.

You feed it documents — articles, PDFs, research papers, notes, transcripts. The Curator reads them, understands them, and atomises them into a structured knowledge graph made up of three types of interconnected markdown files:

- **Entities** — the nouns. Named things: people, companies, tools, organisations. Each gets its own dedicated page that accumulates facts and connections over time.
- **Concepts** — the ideas. Frameworks, techniques, principles, theories. The connective tissue of intellectual knowledge.
- **Summaries** — the narratives. Each source gets a summary page that distils key takeaways and connects the entities and concepts it introduced or touched.

These files live in plain folders on your computer. Not in a proprietary database. Not behind a subscription wall. Not locked into any vendor ecosystem. **Plain markdown files** — readable in any text editor, backed up like any other file, and browsable visually in [Obsidian](https://obsidian.md) as an interactive knowledge graph.

The key property that makes this different from RAG is **compounding**. Every time you add a new source, The Curator does not just index it for retrieval. It *integrates* it — updating existing pages, adding new connections, deepening the graph. The wiki gets richer with every source added. Existing nodes expand. The neural network of connections between ideas grows denser. Knowledge does not sit in isolation. It compounds.

I have been using The Curator for my own knowledge base for over a month. My articles domain currently contains over two hundred and thirty nodes and more than four thousand eight hundred edges — a graph that represents years of reading, research, and thinking made concrete and navigable.

---

## What My Curator MCP Opens Up

Building a second brain is valuable. But connecting it to a frontier AI model is where the system becomes genuinely transformative. I explored this bridge in detail in [the third article](./from-graph-to-intelligence-my-curator-mcp.md) of this series — here is the short version in the context of agent memory.

**My Curator MCP** is the bridge. It is a [Model Context Protocol](https://modelcontextprotocol.io) server that ships with The Curator and exposes your wiki to any MCP-compatible AI client — [Claude Desktop](https://claude.ai/download), VS Code with an MCP-aware agent, [LM Studio](https://lmstudio.ai) with a local model, or any other compatible environment.

The MCP exposes seventeen dedicated tools — ten for reading the wiki and seven for writing to it. The read tools are not simple keyword search. They are **graph-native**: topology overviews, multi-hop neighbourhood traversal, bidirectional backlinks, cross-domain search across every knowledge domain you have built simultaneously. The write tools allow you to save research findings back into the wiki directly from a conversation — compiling what was discussed, updating existing pages, adding new connections.

This means that any LLM supporting the MCP protocol can now use your second brain as its **memory layer**. The agent can orient itself within your graph, traverse connections, pull the full context bundle it needs for a task, and save what it learns back into the knowledge base for future use.

The use cases extend far beyond what I originally imagined when I started building this. A research agent that ingests new papers and integrates their findings into an existing knowledge graph. A writing agent that can draw on years of accumulated thinking to produce well-grounded content. A coding agent that maintains a persistent architectural understanding of a project across sessions. A teaching tool where students build second brains that compound knowledge across an entire programme.

In the context of the agent memory problem — the problem the entire infrastructure industry is racing to solve — the second brain wiki approach offers something that most of the competing solutions do not: **a memory layer that is owned entirely by the user, costs nothing to operate, compounds knowledge across time rather than just retrieving it, and provides the kind of rich contextual graph that agents need to do real work.**

---

## The Honest Assessment: What Works and What Remains Open

I believe in intellectual honesty above all, so let me be direct about where this approach stands today.

### What works well

Retrieval from a mature second brain is fast and context-rich. The graph-native tools in My Curator MCP are designed to extract relevant information efficiently — topology overviews in a single call, deep neighbourhood traversal, cross-domain synthesis. For research workflows and knowledge-intensive tasks, the quality of context an agent can extract from a well-maintained second brain is genuinely impressive.

The privacy and ownership properties are unmatched among current solutions. No external database. No vendor lock-in. No subscription fee for the storage layer. Everything under the user's control, on their hardware, backed up via GitHub sync if desired.

The compounding nature of the knowledge graph is a structural advantage. An agent working from a second brain is not rediscovering knowledge every session. It is drawing on an accumulated, curated, cross-referenced body of knowledge that has been growing for months or years. This is qualitatively different from a vector index.

### What remains open

**Scale.** My Curator MCP has not yet been tested against very large second brains — tens of thousands of nodes, multiple active domains, years of ingestion. At that scale, questions of retrieval efficiency and token consumption for graph traversal remain unanswered. Some additional development will likely be needed to ensure performance holds as the graph grows.

**Write speed.** When an agent writes to the second brain — compiling a conversation, adding new pages, updating connections — the process involves health checks, merge operations, and frontmatter validation. For large or complex wikis, this can be slow. Ingestion through The Curator app itself is faster; MCP-driven writes are deliberately careful and thorough. The right architecture for high-frequency write operations is still evolving.

**This is generation one of something.** I am confident the direction is correct. The specifics of how to make it work at scale, how to optimise for high-throughput agent workflows, and how to handle edge cases gracefully — these are open engineering questions that will be answered in subsequent versions.

---

## Looking Ahead: Shared Second Brains and the Collective Layer

The agent memory race, as I see it, will not be won by any single approach. The infrastructure players are each solving for one shape of knowledge — vectors for prose, trees for structured documents, tables for business data, graphs for relationships. Real agent systems will need to assemble the right combination for their specific work.

But I want to suggest something that the current conversation is largely missing.

**The second brain wiki approach is not only a personal memory layer. It is a potential collective one.**

Imagine a shared second brain. A wiki that dozens or hundreds of people contribute to, each ingesting their own sources into a collective knowledge graph, with a federation layer that allows agents to query across the combined knowledge of many contributors. The graph nodes belong to the collective. The connections represent aggregated understanding. An agent drawing on that resource does not just have access to one person's reading — it has access to a compiled synthesis of many.

We have been calling this the **Beautiful Mind vision**, developed in conversation with my friend and mentor Dražen Kapusta at [COTRUGLI Business School](https://cotrugli.eu/). It represents the natural extension of The Curator beyond personal use — toward collective intelligence infrastructure built on the same principles: plain text, open format, no vendor lock-in, fully auditable, compounding over time.

The technical architecture for this exists. The three-tier model — personal node, domain export, collective index — is well-defined and buildable on the current markdown substrate. The deployment path runs through Cloudflare Workers and R2 storage for the hosted collective layer, building on the same infrastructure patterns I have already deployed for other projects.

The work is ahead of us. But the direction is clear.

---

## Clarification: Key Terms

- **RAG (Retrieval-Augmented Generation):** A technique where AI retrieves relevant document chunks at query time to answer questions. Documents are converted to numerical vectors and stored in a vector database; the most mathematically similar chunks are retrieved for each query. Fast for simple Q&A; loses structural context for complex tasks.
- **Context Window:** The maximum amount of text a language model can process in a single session. Measured in tokens (roughly 0.75 words per token). Larger windows allow more information to be provided, but performance can degrade as the window fills and cost scales proportionally.
- **Knowledge Graph:** A network of nodes (entities and concepts) connected by edges (relationships). Unlike a flat list or a vector index, a knowledge graph encodes how information relates to other information — enabling reasoning that follows connections rather than just matching similarity.
- **MCP (Model Context Protocol):** An open standard that allows AI models to use external tools and data sources in a structured, interoperable way. An MCP server exposes a set of tools that any compatible AI client can call — enabling LLMs to read from, write to, and reason over external systems like a second brain wiki.
- **Second Brain (Wiki):** A persistent, structured knowledge base built from plain markdown files. Unlike RAG, which re-derives knowledge on every query, a second brain compiles knowledge once and compounds it over time — each new source integrating with and deepening the existing graph.
- **Markdown:** A lightweight text formatting syntax. A markdown file is a plain text file with simple markup for headings, links, and emphasis. It opens in any text editor, survives indefinitely without software dependencies, and is natively readable by AI systems. The foundation of The Curator's storage model.

---

## Where This Leaves Us

The agent memory problem is real, it is growing, and it is generating enormous infrastructure investment across the industry. The solutions being built are serious, technically sophisticated, and each solving a genuine piece of the puzzle.

But I keep returning to a simpler question: **what if the best memory layer for an AI agent is not a new database or a proprietary service, but a knowledge graph you own, you built, and that has been compounding your thinking for years?**

[The Curator](https://github.com/talirezun/the-curator) is free. It is open-source. It installs in a single terminal command. It runs entirely on your hardware. With the exception of Google Gemini API used for ingestion and health checks, it requires no external database and no ongoing service fee. And through [My Curator MCP](./from-graph-to-intelligence-my-curator-mcp.md), it gives any MCP-compatible AI model access to a graph-native memory layer built from the most durable format that exists — plain text files.

Is this a complete solution to the agent memory challenge? No. Is it generation one of something that I believe will become increasingly important as agents take on more complex work? Yes.

**The memory wars are just beginning. And I think the answer might already be sitting in a folder on your computer, waiting to be connected.**

---

## Sources and References

- Karpathy, A. (2024). *LLM Wiki — A pattern for building personal knowledge bases using LLMs.* GitHub Gist. [https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- *The Curator* — Open-source second brain application by Dr. Tali Režun. GitHub: [https://github.com/talirezun/the-curator](https://github.com/talirezun/the-curator)
- Pinecone (2025). *Nexus product launch and the case for richer retrieval contracts.* Pinecone Blog. [https://www.pinecone.io](https://www.pinecone.io)
- Chroma Research (2025). *Context window degradation and "context rot" in long-context models.* Chroma Blog. [https://www.trychroma.com](https://www.trychroma.com)
- SAP (2025). *Announcement of Dreamio and Prior Labs acquisitions.* SAP Press Release. [https://www.sap.com](https://www.sap.com)
- Edge, T. (2025). *The Memory Wars: How Every Serious Infrastructure Vendor Is Racing to Solve the Agent Memory Problem.* Independent publication / Substack. *(Background research material — not quoted directly.)*
- Režun, T. (2024–2026). *From Lab to Life article series*, [Article 1](./the-second-brain-that-grows-smarter.md), [Article 2](./knowledge-immortality-second-brain.md), [Article 3](./from-graph-to-intelligence-my-curator-mcp.md). COTRUGLI Business School / Independent publication.

---

## About the Author

**Dr. Tali Režun** is a Serial Entrepreneur, Business Developer, and Academic at the forefront of frontier technologies. As Vice Dean of Frontier Technologies at [COTRUGLI Business School](https://cotrugli.eu/), he leads AI innovation initiatives and shapes MBA curricula for the next generation of technology leaders. With over 30 years of entrepreneurial experience — founding and scaling ventures including The Curator, Lumina AI, Moj AI, Block Labs, CR Systems, 4thTech, Immu3, PollinationX, and Online Guerrilla — he bridges cutting-edge research in AI and Web3 with practical business transformation.

**Tali's Links:**
- [talirezun.com](https://talirezun.com/)
- [X (formerly Twitter)](https://x.com/talirezun)
- [LinkedIn](https://www.linkedin.com/in/talirezun)
- [ResearchGate](https://www.researchgate.net/profile/Tali-Rezun)
- [Substack](https://talirezun.substack.com/)
- [COTRUGLI Profile](https://cotrugli.org/talirezun/)

---

## Disclaimer

### Research and Educational Purpose

This article is published for research and educational purposes only. The content represents my personal experiences, observations, and analysis based on extensive hands-on experimentation with AI agent technologies over the past eighteen months.

### No Commercial Relationships

I have not been compensated, sponsored, or otherwise financially supported by any of the companies, platforms, or tools mentioned in this article. All opinions, assessments, and recommendations are my own and based solely on independent research and practical experience.

### Individual Research Required

Readers are strongly encouraged to:

- Conduct their own independent research before adopting any AI agent technology
- Evaluate tools and platforms based on their specific use cases, requirements, and risk tolerance
- Test systems thoroughly in controlled environments before production deployment
- Consult with relevant technical, legal, and security professionals when implementing AI agents in business-critical or sensitive applications
- Stay informed about evolving best practices, security considerations, and regulatory requirements

### No Guarantees or Warranties

While I have made every effort to ensure accuracy based on my research and experience, I make no guarantees regarding the performance, reliability, security, or suitability of any AI agent technology for any particular purpose. Technology capabilities and limitations may vary significantly based on implementation details, use cases, and environmental factors.

### Evolving Landscape

The AI agent ecosystem is developing rapidly. Tools, platforms, protocols, and best practices referenced in this article may be superseded, deprecated, or fundamentally changed by the time you read this. Always verify current capabilities and recommendations with primary sources and official documentation.

### Your Responsibility

You are solely responsible for evaluating whether and how to implement AI technologies in your specific context. Consider your risk tolerance, regulatory requirements, security needs, and organisational capabilities before implementation.

---

## Discussion & Comments

Have thoughts on the agent memory problem, the second brain as a memory layer, or how you are using your own knowledge graph with frontier models?

**We'd love to hear from you.** Please use the [Discussions](https://github.com/talirezun/the-curator/discussions) tab in the GitHub repository to share your ideas, ask questions, or discuss your own use cases.

You can also open an [Issue](https://github.com/talirezun/the-curator/issues) if you've found a bug or have a feature request.

---

**Dr. Tali Režun**  
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)  
Serial Entrepreneur · AI Researcher · Builder of Second Brains

**Connect:**
- [LinkedIn](https://linkedin.com/in/talirezun)
- [X (formerly Twitter)](https://x.com/talirezun)
- [GitHub](https://github.com/talirezun/the-curator)

---

*Published: May 14, 2026*  
*Part of: [The Curator Research Series](https://github.com/talirezun/the-curator/tree/main/research)*  
*Previous in series: [The Second Brain That Grows Smarter and Lives on Your Computer](./the-second-brain-that-grows-smarter.md) · [Building Knowledge Immortality Through the Second Brain Architecture and The Curator App](./knowledge-immortality-second-brain.md) · [From Graph to Intelligence: The My Curator MCP and the Art of Querying Your Second Brain](./from-graph-to-intelligence-my-curator-mcp.md)*  
*Next in series: [The Shared Brain: When Second Brains Start Thinking Together](./the-shared-brain-thinking-together.md)*  
*Open source | Local-first | Privacy-first*
