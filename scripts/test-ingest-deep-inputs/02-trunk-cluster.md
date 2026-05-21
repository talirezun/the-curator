# The Many Faces of Memory in AI Systems

By Dr. Tali Rezun · 2026

Memory is the single most-debated capability in modern AI systems. When
we talk about "an agent's memory", we are usually conflating four
fundamentally different mechanisms, each with its own trade-offs,
storage substrate, and failure modes. This article disambiguates them.

## Memory as context window

The simplest form of memory is the **context window** — the literal
token buffer the model sees on each turn. Frontier models in 2026 offer
1 to 2 million tokens of context; smaller models offer 32k–200k.
Context-window memory is fast (no extra system to query), perfect-
recall (the model literally sees every token), and impossible to scale
across sessions (the buffer resets at every new conversation).

## Memory as retrieval

The next layer up is **retrieval memory** — typically a vector database
that stores text chunks indexed by semantic embedding. On each turn, a
retriever fetches the top-K most relevant chunks and stuffs them into
the model's context window. This trades latency (the vector search) for
unbounded long-term storage. Pinecone, Weaviate, and Chroma are the
common backends.

## Memory as compiled knowledge

The third layer — and the one The Curator is built on — is **compiled
memory**. The agent reads source documents and writes structured pages
(entities, concepts, summaries) to a persistent wiki. Compiled memory
is slower to build (you need an LLM pass per document) but compounds
across sessions: every new document adds to a growing knowledge graph.

## Memory as fine-tuning

The fourth and oldest mechanism is **fine-tuning memory** — baking
information into the model weights themselves via gradient descent.
Fine-tuning memory is the most "intrinsic" form (the model knows the
content the way it knows English grammar) but it is by far the most
expensive (compute-wise) and least updatable (each new fact requires a
fresh training pass).

## Memory as procedural skill

A fifth, often-overlooked form is **procedural memory** — the agent's
remembered way of solving a class of problems. Procedural memory in
modern systems takes the form of saved tool-use traces, scratchpads,
and "playbooks" the agent keeps as artifacts. This is the closest analog
to how humans encode skill rather than facts.

## Which one should you use?

The honest answer is "all four, in layers". Context window for the
current turn. Retrieval for unbounded archives. Compiled memory for
durable, queryable structure. Fine-tuning for ubiquitous knowledge.
Procedural for skills. A modern agent needs every layer, and the
interesting engineering happens at the seams between them.

Tags: memory, agent-memory, context-window, retrieval, rag, fine-tuning

---

This source deliberately develops five sibling concepts of "memory" with
no parent page. The v3.0.1-beta.8 trunk-page detector should fire and
inject a parent `concepts/memory.md` page covering the umbrella idea.
