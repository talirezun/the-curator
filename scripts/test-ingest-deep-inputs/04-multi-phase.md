---
title: "A Field Guide to Agent Architectures, 2024–2026"
author: "Dr. Tali Rezun"
date: "2026-05-21"
---

# A Field Guide to Agent Architectures, 2024–2026

The phrase "AI agent" has been used so loosely over the past two years
that it has nearly lost meaning. Sometimes it refers to a chatbot with
a memory file. Sometimes it refers to a multi-step workflow that calls
tools. Sometimes it refers to a fully-autonomous program that books
hotels, writes code, and emails clients. This article is an attempt to
impose order on the chaos — to lay out the major agent architectures
that have actually shipped between mid-2024 and mid-2026, what each is
good for, and where each breaks down.

## 1. The single-turn classifier

The simplest "agent" in the wild is a single-turn classifier — you send
the model a query, it returns one of N predefined labels, and you act
on the label. Many production systems labelled "AI" are in fact this:
sentiment classifiers, intent routers, content moderators.

Strengths: cheap, predictable, easy to evaluate. Weaknesses: it cannot
reason, cannot recover from misclassification, and degrades silently
when the input distribution drifts.

Practical examples include Stripe's fraud-detection routing, Intercom's
inbound-message triage, and the auto-tagger inside Notion AI. None of
these are really "agents" in the sense most people mean — they are
filters with a learned threshold — but they are the foundation that
makes the more interesting architectures economically viable.

## 2. The retrieval-augmented chatbot

The next step up is the RAG chatbot: a conversational interface backed
by a vector database (Pinecone, Weaviate, Chroma, Qdrant) that retrieves
relevant context for each turn. The agent does no planning — it
retrieves, generates a response, and waits for the next turn.

This was the dominant pattern from late 2023 through late 2024.
Companies built whole product categories on it: Perplexity for search,
Glean for enterprise knowledge, Mendable for documentation. The
architecture is simple enough to ship in a weekend and reliable enough
to put in front of real users.

The cracks started showing in 2025. Frontier models gained 1M+ token
context windows. For corpora under ~500k tokens (most company wikis,
most personal knowledge bases), it became cheaper and more accurate to
just stuff the whole corpus into the context window than to maintain
an embedding pipeline. Two distinct camps formed: the "kill RAG" camp
(Rezun, Karpathy, Han Xiao) and the "RAG is here forever" camp (most
enterprise vendors, who had already shipped vector DBs as the product).

The reality, as usual, is in between. RAG is genuinely necessary at
multi-million-document scale (web search, legal discovery, genomics).
For smaller corpora, "load everything into context" wins every time
on quality and is now competitive on cost.

## 3. The tool-using agent (ReAct family)

Yao et al.'s 2022 ReAct paper described an agent that interleaves
"thoughts" with "actions" (tool calls) — think, then call a calculator
or web search, then think about the result, then call another tool,
and so on until the task is done. ReAct was the architectural ancestor
of every modern tool-using agent.

The 2024–2025 evolution of ReAct involved four refinements:
- Structured tool calls via OpenAI's `tools:` parameter and Anthropic's
  `tools:` block instead of free-text "Action: search(query='...')"
  which the model had to parse.
- Constrained decoding so the tool-call JSON is always syntactically
  valid.
- Parallel tool calls — the model can request multiple tool invocations
  in a single response, and the runtime executes them concurrently.
- Better failure recovery — when a tool call errors, the agent sees the
  error and adjusts its plan rather than hallucinating success.

Implementations: OpenAI Assistants, Anthropic Claude tool use,
LangChain's `create_react_agent`, Microsoft's AutoGen.

## 4. The planner-executor split

ReAct agents make every decision turn-by-turn. The planner-executor
architecture separates concerns: a higher-level planner produces a
multi-step plan up-front; a lower-level executor runs each step. This
mirrors classical AI planning (STRIPS, PDDL) but with an LLM doing the
planning instead of a search algorithm.

Strengths: better at long-horizon tasks, easier to debug (you can
inspect the plan), easier to inject human-in-the-loop checkpoints.
Weaknesses: rigid — when the plan needs to change mid-execution, you
either restart planning (expensive) or graft a recovery branch (messy).

Notable implementations include AutoGPT (the OG, much-mocked but
ahead of its time), Microsoft's PromptFlow, and the planning layer of
Anthropic's Claude Code (which uses an internal "TodoWrite" tool to
maintain an explicit plan visible to both the model and the user).

## 5. Multi-agent / agentic teams

The next layer up: multiple specialized agents collaborating on a task,
with one agent acting as orchestrator. CrewAI, AutoGen, and OpenAI's
Swarm framework popularized this in 2024–2025. A typical setup has a
"researcher" agent, a "writer" agent, and a "critic" agent passing a
document between them.

The honest empirical finding from late-2025 evaluations: multi-agent
setups outperform single agents on creative, open-ended tasks (writing,
brainstorming, ideation) but UNDERPERFORM on tasks with clear answers
(code, math, structured extraction). The reason appears to be that
"committee" dynamics introduce noise without adding signal when the
ground truth is well-defined.

This nuance is missing from most marketing copy. Multi-agent is not
strictly better than single-agent; it is differently better, and only
for certain task classes.

## 6. The coding agent

A category that has consolidated dramatically since mid-2024: agents
specialized for software engineering. The reference systems in 2026 are
Anthropic's Claude Code, OpenAI's Codex CLI, and Augment Code. Each
takes a slightly different philosophical stance.

Claude Code emphasizes "elastic context" — it dynamically expands and
compresses its working memory, summarizing earlier turns when needed.
It also exposes a TodoWrite tool that the model uses to maintain an
explicit plan, giving the user visibility into what the agent intends
to do before it does it.

Codex CLI takes the opposite philosophy: stateless, single-shot
invocations with a fresh context each time. The reasoning is that
context bleed across requests is the #1 cause of regression in coding
tasks, and explicit statelessness eliminates it.

Augment Code blurs the line — it maintains long-running context but
indexes the user's codebase aggressively, treating retrieval over the
codebase as a first-class operation. (Disclaimer: see "Three
Philosophies, One Goal" for a longer comparison.)

## 7. The reactive autonomous agent

The most ambitious category — agents that operate continuously, with
no per-turn human prompt, reacting to events from the outside world.
Examples: AutoGPT in its full "agent" mode, GPT-Engineer, Devin (the
original launch demo), Manus.

Empirical state in 2026: reactive autonomous agents reliably solve
tasks under ~5 steps of horizon and reliably FAIL on anything longer.
The failure mode is well-studied — they accumulate small errors that
compound into off-task behaviour, and there is no in-built mechanism
to notice the drift before it derails the run.

This is the category most likely to be sold to enterprise buyers with
exaggerated claims. Be skeptical. Demand evals on a realistic task
distribution, not curated demos.

## 8. The browser agent

A specialization of the tool-using agent: an agent whose primary tool
is a web browser. The agent navigates pages, fills forms, clicks
buttons, scrapes results. Implementations: Anthropic's Computer Use,
Playwright-MCP, OpenAI's Operator, Multion, and Adept's ACT-1.

Browser agents are a particularly hard case because the web is hostile
to automation: CAPTCHAs, bot-detection, login walls, layout drift. The
state-of-the-art workaround in 2026 is to use the user's actual
browser via Chrome DevTools Protocol or a browser extension (Anthropic's
Claude in Chrome, for instance) so the agent inherits the user's
authenticated session and cookie context.

## 9. The MCP-native agent

The Model Context Protocol (MCP), introduced by Anthropic in late 2024,
standardized how external tools advertise themselves to an LLM-driven
agent. By 2026, MCP servers expose everything from filesystems to
databases to email to your second brain — and any MCP-aware client
(Claude Desktop, Claude Code, several IDE extensions) can use them all
through a unified interface.

The architectural shift: agents stop bundling their tool surface and
start discovering it. An MCP-native agent does not "have a search
tool" baked in; it inherits whatever tools the user's MCP configuration
exposes. The Curator's "My Curator" MCP server is one example among
hundreds.

## 10. Synthesis — which architecture wins?

The honest answer is: none of them, in isolation. The frontier of 2026
is COMPOSED systems. Claude Code is a planner-executor with tool use
and elastic context. Cursor is RAG-augmented at the codebase level
with tool use on top. The Curator is compiled-memory built ON TOP OF a
tool-using agent.

The era of "the AI agent" — singular, monolithic, mythological — is
over. The era of "AI agents" — plural, specialized, composed — has
begun. The interesting engineering work in 2026 is at the seams
between architectures, not inside any one of them.

Tags: agent-architecture, react, planner-executor, multi-agent,
coding-agent, browser-agent, mcp

---

This source is deliberately >15k chars to force the multi-phase ingest
pipeline. Expected entities: Yao, Karpathy, Han Xiao, OpenAI, Anthropic,
Microsoft, Google, Pinecone, Weaviate, Chroma, Qdrant, Perplexity,
Glean, Mendable, LangChain, AutoGen, AutoGPT, CrewAI, Claude Code,
Codex CLI, Augment Code, Devin, Manus, Computer Use, Playwright-MCP,
Operator, Multion, Adept, ACT-1, Chrome DevTools Protocol, MCP, The
Curator, Dr. Tali Rezun. Expected concepts: agent-architecture,
react, retrieval-augmented-generation, multi-agent, coding-agent,
browser-agent, model-context-protocol.
