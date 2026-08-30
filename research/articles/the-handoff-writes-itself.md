# The Handoff Writes Itself

**By Dr. Tali Režun**
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)
Serial Entrepreneur · AI Researcher · Builder of Second Brains

> Your brain → your team's brain → your agents' brain. The third layer has shipped, and it automates the one part of my build process I had never managed to stop doing by hand.
>
> *From Lab to Life Series · The Curator: Article 7*

---

## Table of Contents

1. [The barrier almost nobody names](#the-barrier-almost-nobody-names)
2. [What I have been doing by hand](#what-i-have-been-doing-by-hand)
3. [The cost of doing it by hand](#the-cost-of-doing-it-by-hand)
4. [Three words: your brain, your team's brain, your agents' brain](#three-words-your-brain-your-teams-brain-your-agents-brain)
5. [The one rule that makes the third layer work](#the-one-rule-that-makes-the-third-layer-work)
6. [The three layers of context in a real build](#the-three-layers-of-context-in-a-real-build)
7. [What a day looks like now](#what-a-day-looks-like-now)
8. [What it does not do](#what-it-does-not-do)
9. [Why this matters beyond code](#why-this-matters-beyond-code)
10. [Clarification: Key Terms](#clarification-key-terms)
11. [Sources and further reading](#sources-and-further-reading)
12. [About the Author](#about-the-author)
13. [Disclaimer](#disclaimer)

---

Ten days ago I published a chapter of my [Field Notes](https://fieldnotes.talirezun.com/) on carrying context between sessions, and I closed it with an admission I did not enjoy writing:

> *I still manually remind the agents, every single session, that all documentation must be in sync before we close. Manually. Every time. Some of this is a discipline problem that better tooling should solve and has not solved yet.*

Yesterday a piece of it got solved. Not all of it, and I will be precise later about exactly which part, because an overclaim here would be worse than the gap. But the heaviest part, the part that costs twenty minutes at the end of every session and that I have now performed several hundred times over two years, is gone.

I stopped writing handoff files.

---

## The barrier almost nobody names

Every complaint I read about building software with AI describes the same symptom in different words. It loses the thread. It hallucinates a function that does not exist. It rewrote something we agreed not to touch. It solved a problem it had already solved yesterday, differently, and broke the first fix in the process.

Almost none of these are model failures. They are context failures, and they are the single most misunderstood thing in this entire field.

I have been working on this specific problem for a bit over two years, which means I started when a good context window was about fifty thousand tokens. Then Anthropic shipped a hundred thousand and it felt like a different profession. Then two hundred thousand, which is still where a surprising number of models sit today. The frontier models now advertise a million, and a million is genuinely workable, in the sense that you can hold a real codebase and its documentation in one session and get through an afternoon.

What has not changed, at any of those sizes, is the thing underneath.

**Every new session starts from zero.** The model has no idea who you are, what you are building, or what the two of you decided yesterday. And well before the window is technically full, quality begins to slide: the model starts contradicting decisions it made an hour earlier, quietly redoing work, choosing differently than it chose the first time and never flagging that it has done so. I watch the context indicator the way a pilot watches a fuel gauge, and at roughly eighty percent I stop adding work.

A bigger window moves that deadline. It does not remove it. Anyone waiting for context length to grow their way out of this is waiting for the wrong thing.

So the actual skill, the one that separates people who get production results out of coding agents from people who get demos and frustration, is context engineering: deciding what the agent sees, and when, continuously, through every phase of the build. Everything else is downstream of it.

---

## What I have been doing by hand

My process has three phases, and I have written about them at length elsewhere, so here is only the part that matters for this article.

**Phase one produces documents, not code.** No repository, no environment. The output is a small set of markdown files — `architecture.md`, `blueprint.md`, `ui_ux.md`, `security.md` — that decide the stack and say why, specify the features and the economics, describe how a real person moves through the thing, and settle the compliance questions before anything is built rather than after an audit finds the gaps. Three to seven days for a real product. It cannot be compressed, because the slow part is thinking.

**Phase two is the build**, and it is where context engineering earns its keep. I do not write code. I open the session, point the orchestrator at the foundational documents, set the standing rules, and then my job for the next several hours is judgement and verification: is that claim measured or reasoned, does that plan match what we agreed, is the documentation current. The orchestrator delegates to worker agents. I delegate to the orchestrator.

**And then, at eighty percent, comes the ritual.**

I tell the agent we are closing the session, and to write me a handoff — a text block I can paste into a fresh session anywhere. It has to carry the state of the build in compressed form, the decisions we settled, the things we tried that failed and why, what is still open, and what to do next. It also has to carry the role instruction forward, because a fresh agent does not know the house rules: you are the orchestrator and the auditor, you do not write code yourself, you delegate. Remind it that this is a production application with real users, so we test end to end before anything reaches main. Remind it that it has my authorisation to use the production API keys, because an agent that is not told this will quietly fall back to synthetic responses, and synthetic responses do not reveal real failures. Remind it that documentation is updated in the same release as the behaviour change, that we wait for CI to go green, and that versions get bumped according to the plan we already agreed.

Then I paste that block into a new window and the next agent starts at roughly ten percent of its context, already knowing everything.

This works. It works well enough that I build production stacks for clients this way and do not see the drift and hallucination that everyone else describes. It also has a property I did not fully appreciate until I started relying on it: **it makes me harness-agnostic.**

Because the continuity lives in files rather than in the tool, a session that started in Claude Code can finish in Codex. Or in Cursor, or opencode, or whatever ships next quarter. There is no centre point, no orchestrating harness holding it all together — just plain markdown that any agent can read. That matters more every month, because the models are visibly specialising. In my own work the GPT models audit better and the Anthropic models build better, and this year a whole class of open-weight frontier models has arrived, mostly out of China, that are outstanding at specific jobs. I ran a deep audit of the [Lumina platform](https://luminawidget.xyz/) through what was then 0x Alpha and is now GLM 5.3, and the results were genuinely valuable in a way that told me something about where this is heading.

Where it is heading is orchestration. Not you and one model, but you as the architect talking to a lead orchestrator that dispatches a fleet: this model audits, that model builds the front end, this one owns the back end. We are not there yet, and the honest reason is commercial rather than technical — the subscription plans from the frontier labs are subsidised so heavily against list API pricing that they are hard to leave, and those harnesses do not let you run other labs' models inside them. I wrote about that trap in *The Mixed Fleet*. It will be solved, by someone, fairly soon.

That is not today's story. Today's story is the layer underneath it, because a mixed fleet is impossible without portable memory. If your project context lives in a vendor's project folder, you cannot switch. That is not an incidental design detail. It is the whole thing.

---

## The cost of doing it by hand

The manual ritual has three problems, and I lived with all of them for two years.

The first is volume. Hundreds of handoff files. They pile up in the repository, they need naming conventions, they need cleaning, and after a while you are maintaining an archive rather than a project. Which handoff is current? The one with today's date, unless there were two sessions today, which there often were.

The second is that it is a ceremony at the end. One big write, performed once.

The third is the one that should worry you most, and it took me an embarrassingly long time to see it clearly. **The model that is nearest its context limit is exactly the model you are asking to write the most important document of the session.** You have spent all day filling its window, its judgement is measurably degrading, and at that precise moment you ask it to compress everything that happened into a perfect artefact. That is a single point of failure sitting at the worst possible position in the process.

---

## Three words: your brain, your team's brain, your agents' brain

The Curator started as a second brain. You feed it sources — PDFs, articles, research, your own notes — and instead of chunking them for retrieval it reads them and [decomposes them into an interlinked wiki](../../docs/architecture.md#core-design-philosophy-curation-not-retrieval) of three page types: entities, concepts, and summaries. Plain markdown, in [a folder you chose](../../docs/domains.md#1-what-is-a-domain), on your own machine, opening natively in Obsidian. Every new source makes existing pages richer rather than sitting beside them as a duplicate. It compounds.

Then came [the shared layer](../../docs/shared-brain.md), built with Dražen Kapusta: a team or a cohort each keeping a private local graph and opting specific domains into a collective one, attributed, without anyone surrendering ownership of their own notes.

And now the third: [an agent memory layer](../../docs/working-state.md). The app's left rail now reads **Chat · Domains · Shared Brain · Agent memory · Ingest**, and the shape of that rail is the whole product thesis in five words.

Your brain. Your team's brain. Your agents' brain.

---

## The one rule that makes the third layer work

Here is the sharpest idea in the entire feature, and it is worth slowing down for.

> ***Knowledge accumulates. State supersedes.***

A wiki should accumulate. Everything you learn about a topic is worth keeping, and every ingest should add to a page rather than replace it. That is exactly right for knowledge.

It is exactly wrong for state. "Blocked on the login bug" stops being true the moment you fix it. If the store merely *added* the fix, the stale blocker would still be sitting there next to it, and a union merge has no way at all to say *this is no longer the case*. A blocker you cleared on Tuesday would be resurrected by Wednesday's write.

So working state is [a deliberately separate store with overwrite semantics](../../docs/working-state.md#what-it-is-not). Each save replaces the previous handoff rather than merging into it. Knowledge grows; state is current, or it is worthless.

Getting that boundary right is now [part of the skill](../../docs/user-guide.md#the-one-rule-that-matters-state-versus-knowledge), so here is the practical version:

| What you want to keep | Where it goes |
|---|---|
| A wrong turn you took this week, in this workstream | Working state — it is local and it expires |
| A failure whose value is the *pattern* across many incidents | A wiki page — it compounds and joins the graph |
| "The suite was at 84 green before my change" | Working state — a point-in-time baseline |
| How a subsystem actually works | A wiki page |
| "We settled on X, do not re-litigate it" | Working state, as a firm decision |

Put durable material into working state and the next save quietly overwrites it. Nothing warns you, because from the store's point of view overwriting is precisely what it is for.

---

## The three layers of context in a real build

With that established, here is the full picture of what my agents actually read. Three layers, and knowing which one a piece of knowledge belongs in is most of the skill.

**Layer one: the foundational documentation, in your own repository.** Architecture, blueprint, UI/UX, security. This is the grounding — what the thing is and how it is built. It sits next to the code so any agent that opens the folder finds it. This layer existed before The Curator and would exist without it, and it is not locked in anyone's tool. It answers *what* and *how*.

**Layer two: your second brain, or your team's, [over MCP](../../docs/mcp-user-guide.md).** Optional, and enormously useful on a complex build. This is where the reasoning lives — why we chose this over that, what the strategy is, where the product is going, what a decision made eight months ago was actually responding to. It is the layer that compounds across projects and across years rather than across a sprint, and a coding agent reaches it through the same MCP bridge as everything else. It answers *why*.

**Layer three: working state — the agent memory layer.** New, and the subject of this article. It answers *where things stand right now*.

That third layer has [three tiers of its own](../../docs/working-state.md#the-three-tiers), and the distinction between them is the design.

```
domains/<project>/state/
  project.md                          the standing brief — one per project
  <scope>/<machine>/current.md        the handoff — overwritten every save
  <scope>/<machine>/journal.jsonl     one line per save, append-only
```

**The standing brief** is what is true across all the work: what this project is, how you want your agents to operate, the firm decisions that hold across every session, pointers to where the depth lives. It changes rarely and deliberately, and it is returned on *every* read no matter which workstream you ask about, because a session resuming cold needs it before anything else. Mine tells the orchestrator that the app is in production and depth of verification outranks speed of shipping; that production API keys are authorised, so a claim about a model's behaviour must be measured rather than reasoned about; that it orchestrates and does not build; that the repository is public and stays clean; and that documentation ships in the same release as the behaviour change, because several of those documents are read by *models* and a false claim in them changes agent behaviour rather than merely misinforming a reader.

**[A scope](../../docs/working-state.md#scopes)** is one workstream inside the project, and it holds the handoff. Three features of one product are three scopes, all sharing the one brief. My own convention is one scope per session, named `session-YYYY-MM-DD-topic` — the date *and* the topic, because two sessions can easily share a day.

**The journal** appends one line per save: timestamp, harness, model, the one-line headline. It is how a later session sees the shape of a work run rather than only its final frame.

[The handoff itself carries six sections](../../docs/working-state.md#the-sections-a-handoff-carries), and the order they render in was not chosen alphabetically:

- **Where things stand** — prose, the actual current state
- **Firm decisions** — settled, do not re-litigate
- **Traps and dead ends** — approaches tried and ruled out
- **Next steps** — what to do next
- **Observations** — point-in-time facts, each stamped with when it was observed and, ideally, the command that re-derives it
- **Open questions** — still genuinely open

Decisions and traps are rendered *above* next steps on purpose. Both of them say "do not do this", and a model that starts executing the action list on sight would otherwise meet the dead end before it meets the warning about it. That ordering was measured with live models rather than reasoned about, which is the standard I want everything in this feature held to.

---

## What a day looks like now

Setup is a conversation, once. You tell your coding agent to create a scope for this piece of work, and you tell it what belongs in the standing brief. It writes both. You install [two skills](../../skills/README.md) — `my-curator` for the wiki and [`curator-continuity`](../../docs/mcp-user-guide.md#the-curator-continuity-claude-skill--session-handoff-v3170) for the state discipline — by dropping them into your harness, and the agent handles the rest.

Then the ritual inverts.

Instead of one enormous write by the most degraded version of the model, you get **save early and save often**. A save overwrites, which makes it idempotent, which makes it cheap. [The discipline in the skill](../../docs/working-state.md#the-skill-that-carries-the-capture-discipline) is to save after any material decision, whenever something is tried and fails for a reason worth knowing, whenever a baseline is established, before anything long or risky, and at eighty percent as a hard floor rather than a target. If a save is missed you lose ten tool calls, not a session.

At the end I no longer compose anything. I ask whether the scope is current, and that is the whole ceremony.

The next session — new window, different model, different harness, or a different machine entirely — starts with one sentence: *read the working state for scope X in project Y and carry on*. The agent [reads the brief, reads the handoff](../../docs/working-state.md#3-the-two-mcp-tools), re-derives the observations that carry a recheck command, tells me in three lines where things stand and whether anything it re-checked came back different from what was recorded, and starts.

Here is a real one, from a session two days ago, exactly as it was written by the agent and rendered in the app:

> ***Current handoff.*** *v3.18.0 branch pushed with 7 commits, offline CI green, live CI running; remaining: bump version and merge.*
>
> ***Firm decisions.*** *CI was fixed by fetching full history, NOT by making the failing suite skip. A guard that quietly opts out on CI is useless in the one place it matters most. — Development must move into a git worktree before the next release; the maintainer's live app points at the main working tree, so in-flight work and his daily app share one checkout.*
>
> ***Traps and dead ends.*** *The Curator's own updater destroyed six commits from the working tree today. The app saw that commits differed, offered an update, and ran a hard reset to origin/main. Nothing was lost only because the push happened first. Never leave unpushed work in a tree a live Curator points at. — After that reset, the test suite reported 92/92 green, because it was running the previous version's suite. A convincing pass over the wrong code. Verify HEAD before trusting a suite count. — Never pipe a CI status check through another command; the pipeline returns the last command's status, so a failed run reads as success. This produced a false "CI passed" report today.*

Read that as a developer and you will recognise what it is. That is not a summary of what happened. It is the set of things that would each have cost the next session an hour to rediscover, written down at the moment the mechanism was still fresh, by the only participant who was actually there.

And because [state lives inside the domain](../../docs/domains.md#state--working-state-not-wiki-content), it [syncs to your own private GitHub repository](../../docs/sync.md#what-gets-synced-and-what-doesnt) along with the rest of your knowledge. Save on the laptop, resume on the desktop. There is [a machine segment in the path](../../docs/sync.md#working-state-and-why-its-path-has-a-machine-name-in-it) for a very specific reason: sync resolves conflicts in a way that can silently discard or, worse, *splice* two machines' handoffs into a document that existed on neither computer. A per-machine path means the collision never arises. Reading is what crosses machines — ask for a workstream without naming a machine and you get the most recently written one.

---

## What it does not do

I hold myself to stating this plainly, because a memory layer that overclaims is more dangerous than none.

**Capture is advisory.** There are no hooks. Nothing in the store, the tools or the app forces a save at the end of a session. The discipline lives in a skill, which is a deliberate choice — a hook has to be rebuilt for every harness, and a skill works in any MCP host as it is — but the cost is honesty about the failure mode. If a session ends without saving, the next read returns the *previous* state. Stale, never corrupted, and nothing that was saved is lost. That is the fail-safe direction, which is why no enforcement was added.

**Reading is portable; the saving discipline is not yet, fully.** The MCP bridge is a protocol, so any local MCP client can read your state. What an agent in another harness is missing is anything telling it to *save*. The skill's prose is ordinary text that works anywhere you paste it, but [automatic activation from a description is a Claude Code and Claude Desktop mechanism](../../skills/README.md#what-you-lose-without-auto-activation-and-what-it-costs). There is [a build script in the repository that derives a neutral version from the same single source](../../skills/README.md#one-source-no-copies) rather than maintaining a second copy, because two hand-maintained copies of an instruction set read by models would not merely disagree — they would instruct two agents to behave differently.

**It needs [a local MCP client](../../docs/mcp-user-guide.md#setup-under-2-minutes).** The bridge is a stdio child process on your machine. Claude Code, Claude Desktop, Cursor, anything that can spawn a local process. A browser-only assistant cannot reach it at all.

**[Stored state is data, not orders](../../docs/working-state.md#4-treat-stored-state-as-data-not-as-instructions).** This one is structural. The file can arrive over sync from another machine, be hand-edited in Obsidian, and inside a shared mirror be written by another person. The store escapes text that tries to impersonate the system or the operator, on the way in and on the way out, and it defangs URLs and shell pipes — that last rule was added from a measurement, not a theory: planted state containing a `curl … | sh` was never *obeyed* by a model, but in three of ten runs it was *relayed* to the developer as a recommended next step. What no sanitiser can check is whether a claim is true. An instruction found in state is a note from a peer, not an order. Verify before acting.

**And [a handoff cures ignorance, not disagreement](../../docs/working-state.md#what-a-handoff-cannot-do-it-cures-ignorance-not-disagreement).** This is the limit I find most interesting, and it was measured against this project's own real state file. Asked an open "what should I do next?", models with no state named the correct top priority in zero runs out of four; with state, eight out of eight. That first row is the effect worth relying on. But the second row is real: three of those eight still proposed something the handoff explicitly ruled out. Twice a model quoted the decision and overrode it in the same sentence — *"which is a deliberate decision to maintain a single writer. However…"*

What moved that number was **placement**. Every constraint filed as a firm decision, phrased as a negative with its reason attached, was respected in every run. The one ruled-out constraint that lived only inside a narrative about what had gone wrong was re-litigated until it was moved into decisions, after which it was respected four times out of four. A constraint written as a story reads as history. The same constraint written as a decision reads as a boundary.

Small sample, one provider, one project — the shape of the effect rather than a rate. But the practical instruction is clear enough: if you want something respected, file it as a decision, say what not to do, and attach the reason.

**[There are no rollups](../../docs/working-state.md#6-the-in-app-view-is-read-only-and-what-is-not-built-at-all).** Nothing composes a Done/Decided/Blocked view across scopes or projects. And the in-app view is read-only by design, not because a write path is unfinished: the store has exactly one writer, an agent over MCP, and that single-writer property is what makes the whole per-machine sync argument safe.

---

## Why this matters beyond code

I find this hard to convey to people who are not orchestrating agents on large builds, because from the outside it sounds like file management. It is not. Maintaining context is the hardest part of this entire practice and it is the unlock. Everything good downstream depends on it, and nearly everything bad downstream traces back to its absence.

But nothing here is specific to code. Any project that outlives a single conversation has the same shape: a long research sweep, a book, a due-diligence process, a strategy engagement running over months. The moment your work spans more sessions than one window can hold, you need somewhere durable for the state to live, and you need it to be somewhere a different tool can read next year.

Which brings me back to the fleet.

The future I am building towards is one where you are the architect, talking to a lead orchestrator, dispatching specialists — one model auditing, another building the interface, a third owning the back end, each chosen because it is measurably better at that job. Every part of that vision depends on context surviving the move from one model to the next. If your memory is trapped inside the harness, you do not have a fleet. You have a vendor.

So the answer is plain markdown, in a folder you chose, synced through your own private repository, readable by anything that speaks MCP and by you in a text editor when it does not. Portability is not a feature of this thing. It is the point of it.

Ten days ago I wrote that some of this was a discipline problem better tooling should solve and had not solved yet.

One of the three loops is closed. I will report honestly on the other two.

---

## Clarification: Key Terms

- **[Working state](../../docs/working-state.md):** The store this article is about — a small, deliberate place for the context a build carries between sessions, held as plain markdown inside a domain. Distinguished from the wiki by its overwrite semantics.
- **State supersedes; knowledge accumulates:** The rule that separates the two stores. A wiki page grows with every ingest and drops nothing; a handoff is replaced on every save, because a union merge has no way to express *this is no longer true*.
- **[The standing brief](../../docs/working-state.md#the-three-tiers) (`project.md`):** One per project. What is true across all the work — what the project is, how the agents should operate, the firm decisions that hold across every session. Returned on every read, whichever workstream you ask about.
- **[Scope](../../docs/working-state.md#scopes):** One workstream inside a project, and the thing that holds a handoff. Three features of one product are three scopes sharing one brief.
- **[The handoff](../../docs/working-state.md#the-sections-a-handoff-carries) (`current.md`):** Six sections — where things stand, firm decisions, traps and dead ends, next steps, observations, open questions — rendered with the negative constraints *above* the action list, because a model that starts executing on sight would otherwise meet the dead end before the warning.
- **The journal (`journal.jsonl`):** Append-only, one line per save: timestamp, harness, model, headline. It shows the shape of a work run rather than only its final frame.
- **[MCP (Model Context Protocol)](../../docs/mcp-user-guide.md):** The open standard the bridge speaks. It is a local stdio process, which is why any local MCP client can read your state and a browser-only assistant cannot reach it at all.
- **Context engineering:** Deciding what the agent sees, and when, continuously through every phase of a build — the skill this whole article is downstream of.
- **Harness-agnostic:** The property that follows from continuity living in files rather than in a tool. A session that started in one harness can finish in another, which is the precondition for a mixed fleet of specialised models.

---

## Sources and further reading

**The Curator** — open source, MIT licensed: [github.com/talirezun/the-curator](https://github.com/talirezun/the-curator)

- [Working state — carrying build context between sessions](../../docs/working-state.md) — the full technical reference: the three tiers, the fields a handoff carries, the size limits, [when a save is refused](../../docs/working-state.md#when-a-save-is-refused), the security posture and the measurements quoted above
- [The Curator user guide, §13b](../../docs/user-guide.md#13b-working-state--carrying-context-between-sessions) — the practical version, including how the brief and your workstreams relate, and [how to turn the whole thing off](../../docs/user-guide.md#turning-it-off)
- [Architecture](../../docs/architecture.md#srcbrainworking-statejs-v3170) — where the store sits in the system
- [The two agent skills](../../skills/README.md) — `my-curator` and `curator-continuity`, plus [the build script that derives harness-neutral versions from the same source](../../skills/README.md#one-source-no-copies)
- [Research articles](../README.md) — the long-form essays that accompany the project

**Field Notes** — [fieldnotes.talirezun.com](https://fieldnotes.talirezun.com)

- [Chapter 01 · Context Engineering](https://fieldnotes.talirezun.com/context-engineering) — the continuous practice, the three-phase build, what belongs in a context window and what does not
- [Chapter 02 · Agent Memory and Second Brains](https://fieldnotes.talirezun.com/agent-memory)
- [Chapter 03 · Coding Agents and Harnesses](https://fieldnotes.talirezun.com/coding-agents)

**From Lab to Life** — [talirezun.substack.com](https://talirezun.substack.com)

- [Context Is the Code: The Complete Three-Phase Process for Building with AI Agents](https://talirezun.substack.com/p/context-is-the-code-the-complete) — the full methodology this article assumes
- [Blueprint of a Frontier Coding Agent](https://talirezun.substack.com/p/blueprint-of-a-frontier-coding-agent) — what is actually happening inside a harness
- [The Agent Memory Problem, and Why It Matters](https://talirezun.substack.com/p/the-agent-memory-problem-and-why) — why context windows alone do not solve memory · [GitHub version](./the-agent-memory-problem.md)
- [The Shared Brain: When Second Brains Start Thinking Together](https://talirezun.substack.com/p/the-shared-brain-when-second-brains) — the middle layer · [GitHub version](./the-shared-brain-thinking-together.md)
- [The Mixed Fleet](https://talirezun.substack.com/p/the-mixed-fleet) — model specialisation, subscription lock-in, and why the orchestrating harness does not exist yet

**Teaching material**

- *Context & Memory Continuity for Coding Agents — A Chasing Jarvis Field Manual*, Vanguard MBA, COTRUGLI Business School — the manual version of the manual process this feature automates

---

## About the Author

**Dr. Tali Režun** is a Serial Entrepreneur, Business Developer, and Academic at the forefront of frontier technologies. As Vice Dean of Frontier Technologies at [COTRUGLI Business School](https://cotrugli.eu/), he leads AI innovation initiatives and shapes MBA curricula for the next generation of technology leaders. With over 30 years of entrepreneurial experience — founding and scaling ventures including The Curator, Lumina AI, Moj AI, Block Labs, 4thTech, Immu3, PollinationX, and Online Guerrilla — he bridges cutting-edge research in AI and Web3 with practical business transformation.

**Tali's Links:**

- [talirezun.com](https://talirezun.com/)
- [X (formerly Twitter)](https://x.com/talirezun)
- [LinkedIn](https://www.linkedin.com/in/talirezun)
- [Substack](https://talirezun.substack.com/)
- [Field Notes](https://fieldnotes.talirezun.com/)
- [COTRUGLI Profile](https://cotrugli.org/talirezun/)
- [GitHub](https://github.com/talirezun/the-curator)

---

## Disclaimer

### Research and Educational Purpose

This article is published for research and educational purposes only. The content represents my personal experiences, observations, and analysis based on extensive hands-on development and testing of The Curator over the past several months.

### No Commercial Relationships

I have not been compensated, sponsored, or otherwise financially supported by any of the companies, platforms, or tools mentioned in this article. All opinions, assessments, and recommendations are my own, based solely on independent research and practical experience.

### Measurements and Sample Sizes

The figures quoted in this article — including the with-state and without-state comparison — come from small, single-provider runs against this project's own real state file. They describe the shape of an effect, not a rate, and they are reported that way deliberately. The underlying method is set out in [the technical reference](../../docs/working-state.md#what-a-handoff-cannot-do-it-cures-ignorance-not-disagreement).

### Evolving Landscape

The AI and agent-tooling ecosystem is developing rapidly. Version numbers, feature status, and specific figures cited in this article reflect the state of the project at the time of writing, and may have changed by the time you read this — check [github.com/talirezun/the-curator](https://github.com/talirezun/the-curator) for the current state.

### Your Responsibility

You are solely responsible for evaluating whether and how to implement AI or agent-memory technologies in your specific context. Consider your risk tolerance, regulatory requirements, and organizational capabilities before deployment.

---

**Dr. Tali Režun**
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)

*Published: August 2026*
*Part of: [The Curator Research Series](https://github.com/talirezun/the-curator/tree/main/research)*
*Previous in series: [The Second Brain That Grows Smarter](./the-second-brain-that-grows-smarter.md) · [Building Knowledge Immortality](./knowledge-immortality-second-brain.md) · [From Graph to Intelligence](./from-graph-to-intelligence-my-curator-mcp.md) · [The Agent Memory Problem](./the-agent-memory-problem.md) · [The Shared Brain: When Second Brains Start Thinking Together](./the-shared-brain-thinking-together.md) · [Second Brain to Shared Brain](./neural-network-of-your-own-knowledge.md)*
*Open source | Local-first | Privacy-first*
