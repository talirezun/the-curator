# Where Your Context Lives

## The Curator becomes an app — your brain, your team's brain, your agents' brain

**By Dr. Tali Režun**
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)
Serial Entrepreneur · AI Researcher · Builder of Second Brains

> A store of context that lives in plain markdown files, in a folder you chose, on a machine you own — readable by any editor, syncable through a private repository, and reachable by any agent that speaks MCP. This article is about what The Curator became on the way to **v3.45.0**, and about the smallest surface it has: a menu bar icon.
>
> *From Lab to Life Series · The Curator: Article 8*

---

## Table of Contents

1. [Where it came from](#where-it-came-from)
2. [Three layers, one format, one owner](#three-layers-one-format-one-owner)
3. [Why this is the argument, not a feature](#why-this-is-the-argument-not-a-feature)
4. [Getting it running](#getting-it-running)
5. [The widget, and why a menu bar earns its place](#the-widget-and-why-a-menu-bar-earns-its-place)
6. [The MCP bridge: twenty tools, and what they actually connect](#the-mcp-bridge-twenty-tools-and-what-they-actually-connect)
7. [What a build session actually looks like now](#what-a-build-session-actually-looks-like-now)
8. [Crossing machines, and the thing that makes it possible](#crossing-machines-and-the-thing-that-makes-it-possible)
9. [What is not finished, stated plainly](#what-is-not-finished-stated-plainly)
10. [Eleven days](#eleven-days)
11. [Where this goes](#where-this-goes)
12. [Clarification: key terms](#clarification-key-terms)
13. [Sources and further reading](#sources-and-further-reading)
14. [About the Author](#about-the-author)
15. [Disclaimer](#disclaimer)

---

Two hours ago an agent on my machine finished a piece of work and wrote down where it had got to. I know that not because I remember it, and not because I opened anything, but because there is a small icon in my Mac's menu bar that says so: **Last save · 2 hr ago · Claude Code (desktop app) · opus-5**. Underneath it, a row of purple bars showing the last seven days of saves. Underneath that, the five most recent workstreams, each with its own one-line summary written by the agent that saved it.

That menu is the smallest surface The Curator has, and it is the one that best explains what the project has become. It is not a dashboard. It is a window onto a store of context that lives in plain markdown files in a folder I chose, on a machine I own, readable by any editor, syncable through a private GitHub repository, and reachable by any agent that speaks [MCP](../../docs/mcp-user-guide.md).

This is the article about that transformation. The Curator is at **v3.45.0** as I write this. It started as something much smaller.

---

## Where it came from

The seed was Andrej Karpathy's **[llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** idea: instead of one giant notebook where everything gets lost, keep dedicated, compounding wikis per topic, built out of nothing more exotic than markdown files. Feed a model a source, have it decompose that source into interlinked pages, and let the graph get denser with every addition.

It is a genuinely great idea, and Karpathy framed it mostly as a context store for coding agents. I took it somewhere adjacent. I built The Curator as a **second brain builder** — for researchers, for people who work with AI, for anyone whose reading outpaces their ability to remember what they read. The whole point was to abstract away the complexity of building and maintaining a knowledge graph, so that the thing you actually do is [curate sources and ask good questions](../../docs/architecture.md#core-design-philosophy-curation-not-retrieval).

The first version was simple. One feature mattered: **[ingest](../../docs/ingestion-pipeline.md)**. Drop in a PDF or a markdown file, and The Curator reads it and writes five to fifteen interlinked wiki pages — one summary of the source, plus entity pages for the named things in it and concept pages for the ideas — all cross-referenced, all in your own folder, all openable in [Obsidian](https://obsidian.md). That case, from the foundations up, is [the first article in this series](./the-second-brain-that-grows-smarter.md).

Then the graphs got big, and big graphs rot. So **[Wiki Health](../../docs/ai-health.md)** arrived: broken-link rescue, orphan rescue, and later an opt-in AI scan for pages describing the same concept under different names. Maintenance, made tractable.

Then came the **[MCP bridge](../../docs/mcp-user-guide.md)**, so the graph was not trapped inside my app or only viewed in Obsidian. Any agent harness that speaks the Model Context Protocol could read it. That was primitive at first — [the article that introduced it](./from-graph-to-intelligence-my-curator-mcp.md) is about how a graph reads differently from a folder — and it is where the second life of this project began, because once agents could read the wiki, the obvious next question was whether they could also read something the wiki was not designed to hold.

Then **[Shared Brain](../../docs/shared-brain-user-guide.md)**, co-developed with Dražen Kapusta — [the same idea, built collectively](./the-shared-brain-thinking-together.md) by a cohort or a team, with each contributor keeping a private brain and opting in only the domains they choose.

And then the third layer, which is what this article is really about.

---

## Three layers, one format, one owner

Here is [the whole product in one line](../../docs/product-overview.md#1-the-spine-three-layers-one-idea):

> **Your brain → your team's brain → your agents' brain.**

People tell me this is self-explanatory and then ask me what it means, which tells me it is not. So, plainly:

| Layer | What it holds | How it behaves |
|---|---|---|
| **1. Your brain** — a personal [wiki per domain](../../docs/domains.md#1-what-is-a-domain) | What you have read and understood: entities, concepts, summaries, all cross-linked | Knowledge **accumulates** — every source deepens existing pages instead of duplicating them |
| **2. Your team's brain** — [Shared Brain](../../docs/shared-brain-user-guide.md), opt-in | The same thing, built collectively by a cohort, team or research group; your other domains never leave your machine | Knowledge **accumulates**, collectively |
| **3. Your agents' brain** — [working state](../../docs/working-state.md) | Where the *work* stands: what is settled, what to do next, what was already tried and ruled out | State **supersedes** — each save replaces the previous handoff, because a resolved blocker must not come back |

Layers 1 and 2 are built by ingesting sources via The Curator UI or an MCP. That is the means, not the point. Layer 3 is written by your coding agent at the end of a session and read back at the start of the next one — on a different tool, a different model, or a different computer.

**[The one rule to learn](../../docs/user-guide.md#the-one-rule-that-matters-state-versus-knowledge) before you use any of it** is the difference between the first two layers and the third. Knowledge accumulates; state supersedes. A wiki page unions its bullets: every ingest adds and nothing is dropped, which is exactly right for knowledge and exactly wrong for a handoff, because a union merge has no way to say *this is no longer true*. "Blocked on the login bug" stops being true the moment you fix it. So working state overwrites. Put something durable into state and the next save takes it, silently, because from the store's point of view overwriting is correct behaviour.

The reason all three belong in one product is mechanical rather than philosophical. They share one folder, one sync mechanism, one backup, one editor and one bridge to your agents. A knowledge base that cannot carry the state of the work leaves your agents starting cold. A state store that cannot reach durable knowledge makes them re-learn the same subsystem every week. Split them into two products and the user maintains two folders, two syncs, two sets of credentials and a boundary by hand.

---

## Why this is the argument, not a feature

Claude Projects, ChatGPT Projects and Cursor rules each hold your accumulated context inside one vendor's product. That works beautifully right up until the day you switch tools, or switch models, or switch machines — and then you leave it behind. Not by accident. By design.

The Curator's answer is [structural rather than clever](../../docs/product-overview.md#portability-as-the-product): **there is no proprietary store to leave behind.** The files are the product and the app is a convenience over them. If you dislike the app tomorrow, your knowledge is still markdown in a folder, still syncing to a repository you own, still openable in Obsidian, still readable by anything that speaks MCP.

That matters more every month, because the models are visibly specialising. In my own work the GPT models audit better and the Anthropic models build better, and a whole class of open-weight frontier models has arrived this year that is outstanding at specific jobs. The direction of travel is orchestration: you as the architect, a lead orchestrator dispatching a fleet, one model auditing, another building the front end, a third owning the back end. Every part of that depends on context surviving the move from one model to the next.

If your memory is trapped inside the harness, you do not have a fleet. You have a vendor.

---

## Getting it running

The biggest practical change in this generation is that **The Curator is now a [Mac application](../../docs/mac-app.md)**. You [download a `.dmg`](../../docs/mac-app.md#getting-the-packaged-app) from the releases page and install it like anything else. It carries its own runtime, needs no Terminal, and [installs its own updates](../../docs/mac-app.md#updating-the-packaged-app).

On **Windows and Linux** there is no packaged app, and [the browser install](../../README.md) remains a first-class way in: clone, `npm install`, `node src/server.js`, open `localhost:3333`. Ingest, chat, wiki, Health, MCP and sync all work identically. What is Mac-only is the packaging — the app bundle, [the Dock launcher](../../docs/mac-app.md#the-dock-launcher-installsh), the native folder picker and the menu bar widget.

### The one-minute detour on first launch

The app is not yet signed with an Apple developer identity. Enrolment is in progress; until it completes, macOS cannot verify who built The Curator, so [Gatekeeper refuses a plain double-click](../../docs/mac-app.md#getting-the-packaged-app). That is a **signing status, not a verdict on the app** — everything that goes into it is in the public repository.

1. Open **Applications** and double-click The Curator. macOS blocks it — dismiss the dialog.
2. Open **System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway**. Confirm, and enter your password if asked.
3. Open the app again.

The exception is remembered. You do this once, and [the updates the app installs for itself never ask again](../../docs/mac-app.md#no-security-warning-on-an-update-and-why).

### The wizard

On first launch The Curator walks you through two decisions.

**Where your knowledge lives.** A folder. If you already have one from a browser install, point the app at it and nothing is copied, converted or rebuilt — [pointing at the folder *is* the migration](../../docs/mac-app.md#moving-from-the-dock-launcher-to-the-packaged-app). One warning worth thirty seconds: pick the folder that **contains** [your domains](../../docs/domains.md#1-what-is-a-domain), not one of the domains.

**Which model does the work.** The Curator has no hosted service and no model of its own; you [bring an API key](../../docs/model-lifecycle.md). Three providers are supported:

| Provider | Free tier | Notes |
|---|---|---|
| **Google Gemini** | Yes, rate-limited | The default. `gemini-2.5-flash-lite`: a one-million-token context window at $0.10 in / $0.40 out per million tokens |
| **Anthropic Claude** | No | Roughly 10× the Gemini bill for the same workload. Right if you already have an Anthropic account or prefer their privacy stance |
| **OpenRouter** | Some models free | One key onto many vendors. [A refresh measured on 28 August](../../docs/user-guide.md#openrouter--one-key-two-lanes-and-a-model-list-you-refresh) turned 387 listed models into 189 offered in chat, taking the picker from 3 to 192 |

Ingest is where essentially all of the cost goes; chat and AI-assisted Health cleanup are cents, and reading pages, managing domains, syncing, structural Health scans and the MCP bridge itself are free. In practice [heavy solo use lands around **€5 a month**](../../docs/user-guide.md#what-pay-as-you-go-actually-costs-real-numbers). On the free Gemini tier or a free OpenRouter route it can be nothing at all — enough to try, though not enough to work at volume, which is worth saying plainly rather than discovering mid-batch.

One thing [v3.45.0](../../CLAUDE.md) fixed that had been the most surprising behaviour in the whole product: **saving a key no longer moves your build lane.** Until then, pasting an OpenRouter key to try a model in chat silently moved your ingests — and your bill — onto a different vendor's model. Connecting a provider now connects it, and nothing else. The model named under *What builds your wiki* is always the truth.

---

## The widget, and why a menu bar earns its place

The memory layer is written by agents, over MCP, while you are doing something else entirely — and increasingly by more than one agent, in more than one harness, on more than one machine. Before the widget, the only way to see any of that was to open the app and navigate to [the Agent Memory view](../../docs/working-state.md#6-the-in-app-view-is-read-only-and-what-is-not-built-at-all).

So there is now [a menu bar icon](../../docs/mac-app.md#the-menu-bar-icon-packaged-app-only). It is **off by default**, because a brand-new install has no agent memory and the only thing an on-by-default icon could say is "nothing here yet," which is the worst first impression a feature can make. You turn it on in **Settings → General → Menu bar**.

Click it and you get, [in this order](../../docs/product-overview.md#what-the-menu-shows-in-order):

- **The answer, first.** *Last save · 2 hr ago*, and underneath it which harness and which model wrote it.
- **The save pulse.** A drawn strip covering the last seven days, folded into twelve-hour cells, with a baseline axis, a day ruler and amber caps where the work changed hands between harnesses. Beside it: *6 days known · 73 saves · 2 tools*. It is a heartbeat, not a scoreboard — darkness means *how often*, never *how well*.
- **Recent scopes.** Up to five workstreams, newest first. Each carries a one-line headline the agent itself wrote, the harness and model that wrote it, and [a small recency mark](../../docs/product-overview.md#the-colours-encode-recency--not-quality) — a clock draining from full through three-quarters, half and a quarter to empty, teal for the last half hour, amber for earlier today, grey beyond. [Each row has a submenu](../../docs/product-overview.md#what-a-row-can-do): open it in The Curator, copy a resume prompt, copy the whole handoff as markdown, reveal the file in Finder.
- **Then the doors.** Open Agent Memory, Open The Curator, Settings, and an *Updated 11:30* line telling you when the reading was taken.

Two details in there are load-bearing and easy to miss.

The first is **[which clock a time came from](../../docs/product-overview.md#how-to-read-a-row--and-why-it-was-rebuilt)**. A row that says `4 min ago` is using the agent's own clock, recorded in the journal when it saved. A row that says `changed 4 min ago` is using the file's timestamp on this disk — and for a handoff that arrived over sync, that is when it *landed here*, not when it was written, because git rewrites file times on checkout. A row with no known save time says `time unknown` and sorts to the bottom, never the top. This is the one place the widget could most easily have lied: on a second computer, every handoff you pulled would read as "just now" if it used file times, and the strongest signal in the whole design would be wrong in exactly the situation it exists for.

The second is **[what it refuses to draw](../../docs/product-overview.md#the-save-pulse--and-what-it-is-not)**. No progress bar for a save, because a save is not partly done — it has happened or it has not, and a bar would be theatre. No line graph of saves over time, because a line between two points claims something existed in between. Nothing where "more saves" looks like "more progress," because save frequency is a setting, not an achievement. And no CPU or memory meter for The Curator itself, because nobody installed a second brain to watch it breathe.

Left on, [the whole thing costs roughly **0.025% of one core**](../../docs/product-overview.md#the-icon-itself-and-what-it-costs). It works by watching the folder and doing nothing until something changes.

---

## The MCP bridge: twenty tools, and what they actually connect

**[My Curator MCP](../../docs/mcp-user-guide.md)** is a local server that any MCP-capable client spawns as a child process. It exposes **[twenty tools](../../docs/mcp-user-guide.md#what-it-does)** — twelve that read and eight in the write block, of which five actually change anything on disk. It does not need the web app running, and nothing leaves your machine. [Setup is under two minutes](../../docs/mcp-user-guide.md#setup-under-2-minutes).

The read tools are not a search box. `list_domains` and `get_index` orient. `search_wiki` and `search_cross_domain` find, the second across every domain at once. `get_node` reads a page in full, with its outgoing links and its backlinks. `get_graph_overview` returns a topology snapshot — counts, hubs, orphans, top tags — in about 4 KB at any scale. `get_connected_nodes` traverses outward across hops. `get_backlinks` answers *who mentions this?*, which a flat index cannot answer at all. [`get_raw_source`](../../docs/mcp-user-guide.md#reading-the-original-source-from-claude-desktop-v350) fetches the original document a summary was built from. And [`get_working_state`](../../docs/working-state.md#3-the-two-mcp-tools) reads the handoff.

The write tools let a model maintain and grow the graph from inside its own conversation: [`compile_to_wiki`](../../docs/mcp-user-guide.md#writing-to-your-wiki-from-claude-desktop-v252) turns a research session into permanent pages through the same merge pipeline as an ingest, [the Health tools](../../docs/mcp-user-guide.md#healing-your-wiki-from-claude-desktop-v252) find and repair structural damage, and `save_working_state` writes the handoff.

Every write is capped, dry-runnable, idempotent and logged to a local audit file. A confused model cannot trash your wiki in one call.

**The honest boundary**, because it is structural rather than a bug: the bridge is a **stdio child process**. Any client that can spawn a local program reaches it — Claude Code, Claude Desktop, Cursor, Open Code and other MCP-capable agents. A browser-only assistant cannot, by construction. The limit is the transport, not the vendor.

---

## What a build session actually looks like now

The agent-memory layer has [three tiers](../../docs/working-state.md#the-three-tiers), and the distinction between them is the thing that makes it work.

**The standing brief** (`project.md`) is one per project, and **you write it by hand**. No tool writes it. It holds what this project is, the firm decisions that hold across every session, the working model, and where the depth lives. It changes rarely and deliberately, and it is returned on *every* read, whichever workstream you ask about. [An agent reading it](../../docs/working-state.md#tier-1-is-not-tier-2-the-brief-is-hand-authored-by-the-owner) is told to treat its standing directives as your instructions given in advance, to restate in one line which ones it is adopting, and to say so rather than go quiet if one clashes with its own rules.

**[A scope](../../docs/working-state.md#scopes)** is one workstream inside a project — `main`, `auth-refactor`, `v4-migration`. Three features of one product are three scopes sharing one brief. My own convention is one scope per session, named `session-YYYY-MM-DD-topic`, because two sessions can easily share a day.

**The handoff** (`current.md`) holds where things stand, and it carries [six sections](../../docs/working-state.md#the-sections-a-handoff-carries): where things stand, firm decisions, traps and dead ends, next steps, observations, open questions. The order was not chosen alphabetically. Decisions and traps render *above* next steps, because both of them say "do not do this," and a model that starts executing the action list on sight would otherwise meet the dead end before it meets the warning about it. That ordering was measured with live models rather than reasoned about.

**The journal** (`journal.jsonl`) appends one line per save — timestamp, workstream, machine, harness, model, headline. It is append-only, so the history of headlines survives even though the handoff itself does not.

The ritual has inverted. Instead of one enormous write performed by the most degraded version of the model — which is exactly what the old manual practice asked for, at the worst possible moment — [the discipline](../../docs/working-state.md#the-skill-that-carries-the-capture-discipline) is **save early and save often**. A save overwrites, which makes it idempotent, which makes it cheap. Save after any material decision, whenever something fails for a reason worth knowing, whenever a baseline is established, before anything long or risky. Miss one and you lose ten tool calls, not a session. [The full design of that layer](./the-handoff-writes-itself.md) is the previous article in this series.

The next session — new window, different model, different harness, or a different machine entirely — starts with one sentence: *read the working state for scope X in project Y and carry on*.

### Does carrying state actually change the answers?

[Our own measurement](../../docs/product-overview.md#what-it-measurably-does-and-what-it-does-not), not a benchmark, and small: one seeded realistic software project, one open architecture question, two providers, eight runs, $0.074 of API spend.

**Without** the working state, the model proposed a command the project had already recorded as failed in **3 of 4** runs, and an architecture the team had explicitly ruled out for compliance reasons in **4 of 4**. **With** the handoff present: **0 of 4** for both. On [a separate reading](../../docs/working-state.md#what-a-handoff-cannot-do-it-cures-ignorance-not-disagreement) against this project's own real handoff, asking an open "what should I do next?", the model named the correct top priority **0 of 4** times without state and **8 of 8** with it.

Read that as the shape of the effect at N=4 per condition, not as a constant. But the shape is worth having.

---

## Crossing machines, and the thing that makes it possible

Here is the part that surprises people most.

Working state lives inside a domain, and [a domain is a folder](../../docs/domains.md#1-what-is-a-domain). That folder [syncs to **your own private GitHub repository**](../../docs/sync.md). [Each machine writes into its own path](../../docs/working-state.md#why-machine-is-in-the-path), so two computers never collide, and a read that names a scope but not a machine returns the most recently written one — [which is precisely what makes cross-machine handoff work](../../docs/sync.md#working-state-and-why-its-path-has-a-machine-name-in-it).

So: laptop in the morning, desktop in the afternoon, a different harness in the evening because your credits ran out on the first one. [Sync the folder](../../docs/sync.md#setting-up-on-a-second-computer) and every agent, everywhere, knows exactly where the build stands. Not a summary of where it stands. The actual document the last agent wrote.

And that is the democratisation argument in concrete form. If you exhaust your quota in one harness, you continue in another. If you would rather run an open-weight model locally on a machine strong enough for it, you continue there. Nothing about your accumulated context objects, because your context was never inside the tool you are leaving.

### The full stack of context

The memory layer is not the whole picture, and I want to be precise about what sits where, because this is the part practitioners get wrong.

- **Foundational documentation** — architecture, blueprint, UI/UX, security — lives in the project's own repository, alongside the code. It is not locked into any harness and it is maintained throughout the build. This is Phase 1 work and nothing downstream gets easier because you skipped it.
- **[The standing brief](../../docs/working-state.md#the-three-tiers)** is the short, standing instruction set for agents on this project. You perfect it, you fine-tune it, and it stays put while scopes get replaced beneath it.
- **[The handoff](../../docs/working-state.md#the-sections-a-handoff-carries)** is the current state, and it is replaced on every save.
- **[The wiki](../../docs/product-overview.md#3-compiled-knowledge-not-retrieval)** is the compounding knowledge an MCP-connected agent can query — the reasoning and the timeline, not the source code, which version control already handles perfectly well.

Four things, one folder for two of them, one repository for the others, and a single bridge that reaches all of it.

---

## What is not finished, stated plainly

I would rather you hear this from me than discover it.

**Capture is advisory.** Nothing forces an agent to save. [The skill](../../skills/README.md) tells it to save after every decision and every ten or so tool calls, and the menubar widget re-reads the store every few minutes so you can see when it last did, but no timer and no hook writes on its behalf. A missed save returns the previous state, stale but never corrupted.

**The saving discipline is only partly portable.** The store is readable by anything that speaks MCP. The skill that carries the discipline of saving is ordinary prose and works anywhere you can paste it, but [how it *switches on*](../../skills/README.md#what-you-lose-without-auto-activation-and-what-it-costs) is Claude-shaped today. An agent in another harness can read working state fine; nothing yet tells it to write.

**[A handoff cures ignorance, not disagreement](../../docs/working-state.md#what-a-handoff-cannot-do-it-cures-ignorance-not-disagreement).** It reliably tells the next session what it does not know. It does not bind it.

**[Automatic sync is not built](../../docs/roadmap-automatic-sync.md).** Every sync operation happens because a human clicked something. The research concluded [automatic *push* is safe](../../docs/roadmap-automatic-sync.md#4-automatic-push--the-part-that-should-exist) and [automatic *pull* is not](../../docs/roadmap-automatic-sync.md#5-automatic-pull--the-part-that-should-not), so pull stays a decision you make.

**[Shared Brain](../../docs/shared-brain.md) is still opt-in beta.** It has been through a structured audit, a data-integrity pass, [real admin tooling](../../docs/shared-brain-admin.md), [GDPR-grade erasure](../../docs/shared-brain-compliance.md), and a production battle-test that found two real concurrency bugs before any user could hit them. The offline suite is green and the live sweep is green. What has not happened is the one test that cannot be simulated: a real cohort, using it together, over a term. The Vanguard MBA cohort at COTRUGLI remains the natural first audience, and that pilot is the gate to general availability.

**Local models are not available yet.** The provider row exists in Settings and is marked unavailable.

**The app is not notarised yet.** Hence [the one-minute detour](#getting-it-running) above.

---

## Eleven days

I want to close with something about how this got here, because it says more about the project than any feature list.

On **23 August** The Curator was at v3.1.2. On **2 September** it shipped **v3.45.0**. In the thirty hours between the morning of 1 September and mid-afternoon on the 2nd, ten releases went out: v3.37.0 through v3.45.0, six of them on a single day.

That pace is not a solo achievement and it is not a boast about typing speed. It is what happens when a maintainer uses his own tool for real work every day, a community reports precisely what broke, and the context to act on all of it survives from one session to the next. Most of the recent work in this project came directly from someone using it and saying what went wrong — including [one incident where connecting sync destroyed four hours of my own working state](../../CHANGELOG-ARCHIVE.md), which is why [the sync connect flow](../../docs/sync.md#if-another-install-already-syncs-this-folder) now measures and refuses rather than proceeds.

The repository sits at **56 stars and 9 forks** today. Small numbers. But the people behind them have shaped this product more than any roadmap did, and I am grateful for it in a way that is hard to put in a release note.

---

## Where this goes

This is a milestone, not a destination. [The next steps](../../docs/product-overview.md#designed-and-deliberately-not-built) are already visible: the cohort pilot that unlocks Shared Brain general availability; raw-source fidelity across machines; [connectors that let a Company Brain ingest from the systems an organisation already runs](../../docs/use-cases.md); a richer panel behind the menu bar icon; and eventually the mixed-fleet orchestration that all of this is quietly a prerequisite for.

But the thing I built, I built because I needed it. For two years I ran this process by hand — foundational documents, a standing brief file, hundreds of dated handoff markdown files, and the discipline to write one before every context ceiling. It worked, and it cost me something every single day. The Curator is the automation of that process, as much of it as can honestly be automated.

Without proper context you cannot get good results from AI. That is not an opinion. It is the single most reliable observation I have from three years of building this way. Everything good downstream depends on context, and nearly everything bad downstream traces back to its absence.

So: three layers, one format, one owner.

You.

---

## Clarification: key terms

- **Context window** — the total text a model holds in working memory during one session. Effective usable context is smaller than the advertised number; quality degrades well before the ceiling.
- **Context rot** — the gradual decline in output quality as a session fills. The model starts contradicting earlier decisions and quietly regenerating work it already did.
- **Agent harness** — everything wrapped around a model that lets it operate: tool integrations, memory, permissions, interface. Claude Code, Codex, Cursor and opencode are harnesses; they can run different models, and the same model behaves differently in each.
- **[State supersedes; knowledge accumulates](../../docs/user-guide.md#the-one-rule-that-matters-state-versus-knowledge)** — the rule separating the wiki from working state. A wiki page grows with every ingest and drops nothing. A handoff is replaced on every save, because a union merge cannot express *this is no longer true*.
- **[Scope](../../docs/working-state.md#scopes)** — one workstream inside a project, and the thing that holds a handoff. Multiple scopes share one standing brief.
- **[MCP (Model Context Protocol)](../../docs/mcp-user-guide.md)** — the open standard the bridge speaks. A local stdio process, which is why any local MCP client can read your state and a browser-only assistant cannot.
- **Harness-agnostic** — the property that follows from continuity living in files rather than in a tool. A session that started in one harness can finish in another, which is the precondition for a mixed fleet.

---

## Sources and further reading

**The Curator** — open source, MIT licensed: [github.com/talirezun/the-curator](https://github.com/talirezun/the-curator)

- [Product overview](../../docs/product-overview.md) — every capability, what it costs, and [what is designed but deliberately not built](../../docs/product-overview.md#designed-and-deliberately-not-built)
- [The Curator user guide](../../docs/user-guide.md) — the practical version, including [the one rule that matters](../../docs/user-guide.md#the-one-rule-that-matters-state-versus-knowledge) and [what pay-as-you-go actually costs](../../docs/user-guide.md#what-pay-as-you-go-actually-costs-real-numbers)
- [Working state — carrying build context between sessions](../../docs/working-state.md) — the full technical reference: [the three tiers](../../docs/working-state.md#the-three-tiers), [the sections a handoff carries](../../docs/working-state.md#the-sections-a-handoff-carries), [the limits](../../docs/working-state.md#5-limits), and the measurements quoted above
- [The Mac app](../../docs/mac-app.md) — the `.dmg`, the Gatekeeper detour, [the menu bar icon](../../docs/mac-app.md#the-menu-bar-icon-packaged-app-only) and how updates install themselves
- [My Curator MCP guide](../../docs/mcp-user-guide.md) — the twenty tools, [setup](../../docs/mcp-user-guide.md#setup-under-2-minutes), and how to prompt against a graph
- [Personal Sync](../../docs/sync.md) — what syncs, what does not, and [why a state path carries a machine name](../../docs/sync.md#working-state-and-why-its-path-has-a-machine-name-in-it)
- [Model lifecycle](../../docs/model-lifecycle.md) — providers, defaults, fallback chains, and how a model has to be measured before it can build your wiki
- [Roadmap — automatic sync](../../docs/roadmap-automatic-sync.md) — the research behind "push yes, pull no"
- [Shared Brain](../../docs/shared-brain-user-guide.md) — the collective layer, plus [admin](../../docs/shared-brain-admin.md) and [compliance](../../docs/shared-brain-compliance.md)
- [Architecture](../../docs/architecture.md) and [the ingestion pipeline](../../docs/ingestion-pipeline.md) — where each store sits in the system
- [The two agent skills](../../skills/README.md) — `my-curator` and `curator-continuity`
- [Use cases](../../docs/use-cases.md) — who this is for, in concrete shapes
- [Research articles](../README.md) — the long-form essays that accompany the project

**From Lab to Life** — [talirezun.substack.com](https://talirezun.substack.com)

- [Where Your Context Lives](https://talirezun.substack.com/p/where-your-context-lives) — the original of this article
- *The Handoff Writes Itself* — the design of the agent memory layer · [GitHub version](./the-handoff-writes-itself.md)
- *Second Brain to Shared Brain* — the collective layer, in build · [GitHub version](./neural-network-of-your-own-knowledge.md)
- [The Curator — Product Update](https://talirezun.substack.com/p/the-curator-product-update)
- [The Shared Brain: When Second Brains Start Thinking Together](https://talirezun.substack.com/p/the-shared-brain-when-second-brains) · [GitHub version](./the-shared-brain-thinking-together.md)
- [The Agent Memory Problem, and Why It Matters](https://talirezun.substack.com/p/the-agent-memory-problem-and-why) · [GitHub version](./the-agent-memory-problem.md)
- [From Graph to Intelligence: The My Curator MCP](https://talirezun.substack.com/p/from-graph-to-intelligence-the-my) · [GitHub version](./from-graph-to-intelligence-my-curator-mcp.md)
- [Context Is the Code: The Complete Three-Phase Process for Building with AI Agents](https://talirezun.substack.com/p/context-is-the-code-the-complete)
- [The Mixed Fleet](https://talirezun.substack.com/p/the-mixed-fleet) — model specialisation, subscription lock-in, and the orchestrating harness that does not exist yet

**Field Notes** — [fieldnotes.talirezun.com](https://fieldnotes.talirezun.com)

- [Chapter 01 · Context Engineering](https://fieldnotes.talirezun.com/context-engineering)
- [Chapter 02 · Agent Memory and Second Brains](https://fieldnotes.talirezun.com/agent-memory)
- [Chapter 03 · Coding Agents and Harnesses](https://fieldnotes.talirezun.com/coding-agents)

**Teaching material** — *Context & Memory Continuity for Coding Agents: A Chasing Jarvis Field Manual*, Vanguard MBA, COTRUGLI Business School. The manual version of the manual process this feature automates.

**Origin** — [Andrej Karpathy's llm-wiki concept](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

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

This article is published for research and educational purposes only. The content represents my personal experiences, observations, and analysis based on extensive hands-on development and testing of The Curator.

### No Commercial Relationships

I have not been compensated, sponsored, or otherwise financially supported by any of the companies, platforms, or tools mentioned in this article. All opinions, assessments, and recommendations are my own, based solely on independent research and practical experience.

### Measurements

Figures described as measurements are exactly that — small, dated readings taken against real data, reported with their sample sizes. They are not benchmarks and should not be read as constants. Model prices, model catalogues and tool counts move between releases. The method behind the with-state and without-state comparison is set out in [the technical reference](../../docs/working-state.md#what-a-handoff-cannot-do-it-cures-ignorance-not-disagreement).

### Evolving Landscape

The AI and agent-tooling ecosystem is developing rapidly. Version numbers, feature status, and specific figures cited in this article reflect the state of the project at the time of writing, and may have changed by the time you read this — check [github.com/talirezun/the-curator](https://github.com/talirezun/the-curator) for the current state.

---

**Dr. Tali Režun**
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)

*Published: September 2026*
*Part of: [The Curator Research Series](https://github.com/talirezun/the-curator/tree/main/research)*
*Previous in series: [The Second Brain That Grows Smarter](./the-second-brain-that-grows-smarter.md) · [Building Knowledge Immortality](./knowledge-immortality-second-brain.md) · [From Graph to Intelligence](./from-graph-to-intelligence-my-curator-mcp.md) · [The Agent Memory Problem](./the-agent-memory-problem.md) · [The Shared Brain: When Second Brains Start Thinking Together](./the-shared-brain-thinking-together.md) · [Second Brain to Shared Brain](./neural-network-of-your-own-knowledge.md) · [The Handoff Writes Itself](./the-handoff-writes-itself.md)*
*Open source | Local-first | Privacy-first*
