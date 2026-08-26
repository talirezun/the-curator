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

## 10. The evaluator agent

By 2025 the bottleneck in agent development had moved from "can it do the
task" to "can we tell whether it did the task". The evaluator agent — an
LLM asked to grade another model's output against a rubric — became the
default answer, and it brought its own pathologies.

The best-documented is self-preference: a model grading its own output
scores it higher than a blind human would. The second is rubric drift,
where an evaluator asked for a 1-5 score gradually compresses toward 4
across a long batch. The third, and the one that costs teams the most
money, is that an evaluator is only as good as the reference it is given;
a rubric written from three cherry-picked examples generalises about as
well as a regex.

The practical countermeasures that survived contact with production are
narrow: pairwise comparison instead of absolute scoring, a different
model family for the evaluator than for the generator, and a held-out
human-graded set used to calibrate the evaluator itself rather than the
system under test. Braintrust, LangSmith and Anthropic's own eval tooling
all converged on roughly this shape independently, which is usually a
sign that the shape is forced by the problem rather than chosen.

The deeper point is architectural. An evaluator agent is not a testing
tool bolted onto an agent system; it is a second agent with its own
failure modes, its own cost curve, and its own need for evaluation. Teams
that treat it as infrastructure rather than as a component ship
confidently broken systems.

## 11. Memory architectures

Every architecture above has to answer the same question: what does the
agent remember between turns, between sessions, and between users? Four
answers shipped in volume.

Scratchpad memory keeps the reasoning trace inside the context window and
discards it at session end. It is free, it is what ReAct does, and it
loses everything the moment the window rolls.

Vector memory embeds past turns and retrieves the nearest neighbours.
MemGPT popularised the pattern and Letta productised it. It scales, but
it inherits every RAG weakness: retrieval misses are invisible, and the
agent cannot tell the difference between "I never knew that" and "I
failed to retrieve it".

Compiled memory writes durable structured artefacts — notes, wiki pages,
a knowledge graph — and reads them back as ordinary context. It is
slower to write and far cheaper to read, and it has the property no other
scheme has: a human can open the memory, read it, and correct it. The
Curator is built on this thesis; so, in a different register, is
Obsidian's own graph.

Parametric memory fine-tunes the weights on the interaction history. It
is the only scheme where recall costs nothing at inference time, and the
only one where a mistake is effectively unfixable without retraining.

The 2026 consensus, to the extent one exists, is that these are layers
rather than alternatives. Scratchpad for the turn, compiled for the
project, vector for the archive, parametric for nothing anyone wants to
be responsible for.

## 12. The economics nobody puts on the slide

An agent architecture is a cost curve wearing a diagram. The single-turn
classifier costs one short call. The ReAct agent costs one call per step
and re-sends the entire trace each time, so a ten-step task costs
quadratically more input tokens than a one-step task, not ten times more.
Multi-agent teams multiply that by the number of agents and then add the
coordination traffic between them.

Prompt caching changed the shape of this curve more than any model
release did. When a stable prefix — instructions, tool definitions, the
source document — can be cached and re-read at roughly a tenth of base
input price, the quadratic term stops dominating. The engineering
consequence is specific and unglamorous: put everything stable first and
everything variable last, and never let a timestamp or a counter leak
into the prefix.

The second economic fact is that recovery ladders are unbounded. A
pipeline that retries a failed batch page-by-page turns one failure into
O(pages) calls. That is the right trade for correctness and the wrong
trade for a budget cap, and the only honest way to present it is to say
so rather than to quote an average.

## 13. Failure modes in the wild

Four failure modes recur across every architecture surveyed here.

Silent truncation: the model hits its output limit mid-JSON, the caller
parses what it got, and the missing half is never reported. The fix is a
finish-reason check at the single call site every request passes through,
not a try/catch at each caller.

Runaway generation: a repetitive source pushes the model into a
degeneration loop that fills the entire output budget with near-identical
entries. Notably this correlates with enumerable content, not with
document size — small, list-shaped documents overflow while much larger
prose documents do not.

Confident hallucinated references: the agent invents an identifier that
looks exactly like a real one. In a knowledge system this is the most
expensive failure of all, because the artefact it produces is
indistinguishable from a correct one until someone follows the link.

Guard decay: a safety check is written for one call site, a sibling call
site is added later, and the guard is never extended. The countermeasure
is to enumerate the class mechanically rather than to inspect the
instances by hand.

## 13b. Observability and the trace problem

Debugging an agent is not debugging a program. A program that misbehaves
leaves a stack trace; an agent that misbehaves leaves a plausible
paragraph. The industry response was the trace: a structured record of
every prompt, every tool call, every intermediate output, stitched into
a tree that a human can walk.

LangSmith shipped this first at scale, Weights and Biases followed with
Weave, Arize added Phoenix for the open-source tier, and OpenTelemetry
eventually grew semantic conventions for LLM spans so the whole thing
could ride existing infrastructure. The convergence on OpenTelemetry
matters more than any individual vendor: it means an agent trace can sit
in the same store as the HTTP spans around it, and the question "why was
this request slow" stops having two separate answers.

What traces do not solve is attribution. A ten-step trace tells you what
happened; it does not tell you which step caused the wrong answer. The
current best practice is counterfactual replay — re-run the trace with
one step's output replaced by a known-good value and see whether the
outcome changes. It is expensive, it is manual, and it is the only
technique that reliably distinguishes a bad plan from a bad execution of
a good plan.

The uncomfortable implication for architecture is that observability is
not free to retrofit. An agent that streams its output and discards its
intermediate state cannot be traced after the fact. The decision to
persist intermediate state is made on day one, usually by someone who
has not yet had to debug the system.

## 14. Synthesis — which architecture wins?

The honest answer is: none of them, in isolation. The frontier of 2026
is COMPOSED systems. Claude Code is a planner-executor with tool use
and elastic context. Cursor is RAG-augmented at the codebase level
with tool use on top. The Curator is compiled-memory built ON TOP OF a
tool-using agent, with an evaluator agent watching the seams.

The era of "the AI agent" — singular, monolithic, mythological — is
over. The era of "AI agents" — plural, specialized, composed — has
begun. The interesting engineering work in 2026 is at the seams
between architectures, not inside any one of them.

Tags: agent-architecture, react, planner-executor, multi-agent,
coding-agent, browser-agent, mcp, evaluator-agent, compiled-memory

---

FIXTURE NOTE — this file is deliberately sized ABOVE
MULTI_PHASE_INPUT_THRESHOLD (15,000 chars, src/brain/ingest.js) so the
ingest takes the Phase-1 outline + Phase-2 batched path. It was 10,256
chars until v3.9.1 and therefore took the single-pass path, which made
SYN-4's "multi-phase" label decorative. If you edit this file, re-check
its length; test-ingest-deep.js asserts the threshold is exceeded and
asserts from the progress stream that more than one Phase-2 batch ran.
