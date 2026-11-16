# My Second Brain Learned to Remember the Numbers

## How The Curator grew from a tool that understands ideas into one that also keeps the exact details: prices, dates, versions, thresholds and the reasons behind decisions

**By Dr. Tali Režun**
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)
Serial Entrepreneur · AI Researcher · Builder of Second Brains

> A second brain that understands ideas is useful. One that also remembers the exact price, the deadline, the version number and the reason a decision was made is something you can rely on. This article records how The Curator crossed that line in two days and six releases, what that opens up for companies, developers and open-source projects, and exactly how it was tested, including what it cost.
>
> *From Lab to Life Series · The Curator: Article 13*

> **About this repository copy.** The article was written against The Curator **v3.99.1**, and this copy was prepared on 16 November 2026 against the same release. Every product mention links to the part of the documentation that describes it. The tables are reproduced as text rather than as the images in the original, and the social-media graphics made for the launch are left out. The pricing document in the story is my own; its figures are deliberately not reproduced here.

![A cubist painting: a face assembled from geometric planes, half of it traced with a network of nodes and lines, in front of a desk with an open book and a collage of ledgers, grids and newspaper scraps.](../images/remember-the-numbers-cover.jpg)

---

## Table of Contents

1. [Why I keep writing these](#why-i-keep-writing-these)
2. [First, what The Curator is](#first-what-the-curator-is)
3. [How it evolved](#how-it-evolved)
4. [None of this happened alone](#none-of-this-happened-alone)
5. [The three layers of context](#the-three-layers-of-context)
6. [The gap I could not stop noticing](#the-gap-i-could-not-stop-noticing)
7. [Three kinds of knowledge](#three-kinds-of-knowledge)
8. [What changed, in plain language](#what-changed-in-plain-language)
9. [Why grounding in facts matters](#why-grounding-in-facts-matters)
10. [What this makes possible](#what-this-makes-possible)
11. [How it was tested, and what it cost](#how-it-was-tested-and-what-it-cost)
12. [Known limits, honestly](#known-limits-honestly)
13. [Try it](#try-it)
14. [Where to find everything](#where-to-find-everything)
15. [A closing thought](#a-closing-thought)
16. [Sources and further reading](#sources-and-further-reading)
17. [About the Author](#about-the-author)
18. [Disclaimer](#disclaimer)

---

## Why I keep writing these

This is the thirteenth article I have written about The Curator. I did not plan a series this long. It happened because of a simple habit: whenever the project reaches something that feels like a real breakthrough, I write it down. An article is the best way I know to record a discovery while it is still fresh: what I saw, why it mattered, what I tried, and what it cost.

This one records a breakthrough that came out of two very intense days of work, on 14 and 15 November 2026, and six releases (v3.98.0 to v3.99.1). But before I tell that story, I want to step back. Some of you have used The Curator since the first version. Some of you are reading about it for the first time today. Both groups deserve to know where the project stands, how it got here, and who made that possible.

---

## First, what The Curator is

If you are new: The Curator is a free, open-source app that builds a **second brain** for you. You give it the things you read and write (articles, research papers, PDFs, notes, transcripts, reports) and it reads them with an AI model of your choice. Then it writes a **wiki**: a set of linked pages that grows with every document.

Each document becomes three kinds of pages:

- **A summary** of the source itself: what it says and why it matters.
- **Entity pages** for the concrete things it mentions: people, companies, products, tools.
- **Concept pages** for the ideas: methods, principles, patterns.

The pages link to each other. When a new document mentions a company that already has a page, The Curator updates that page instead of creating a duplicate. Over months this becomes something like a neural network of your own knowledge. You can explore it visually in Obsidian, ask it questions in the [built-in chat](../../docs/user-guide.md#9-chat-with-your-brain), or let AI agents search and read it through the [My Curator MCP](../../docs/mcp-user-guide.md).

> **In plain words.** Think of it as a personal Wikipedia that writes itself from everything you feed it. Everything is stored as ordinary text files (markdown) on your own computer. No server, no account, no lock-in. If The Curator disappeared tomorrow, your knowledge would still be there, readable in any text editor.

---

## How it evolved

The Curator started from an idea Andrej Karpathy described as the LLM wiki: instead of asking an AI to search your documents every time, let the AI write and maintain a structured wiki once, and let that wiki compound. My first version did exactly that, and nothing more. Looking back at the twelve earlier articles, I can see the project growing in clear stages:

| Stage | What it added |
|---|---|
| 1. Second brain | [Ingest](../../docs/user-guide.md#8-ingest-a-source) documents, produce summaries, entities and concepts as linked markdown. Browse in Obsidian. Ask questions in chat. |
| 2. Agents can read it | The [My Curator MCP](../../docs/mcp-user-guide.md) bridge lets AI tools like Claude, Claude Code, Cursor or opencode search and read your wiki. It now offers 24 tools: 17 that read and 7 that write. |
| 3. Shared Brain | Introduced in v3.0.0-beta and developed with Dražen Kapusta and our COTRUGLI CoLab. A cohort or team contributes opted-in domains and everyone gets a read-only collective wiki ([Shared Brain user guide](../../docs/shared-brain-user-guide.md)). |
| 4. Your machines, in sync | [Personal Sync](../../docs/user-guide.md#15-sync-across-computers) through your own private GitHub repository, so the same brain lives on several computers. |
| 5. Wiki Health | [Scans](../../docs/user-guide.md#17-wiki-health) for broken links, orphan pages, duplicates and missing backlinks, and fixes them safely with Undo. |
| 6. Context engine for agents | [Foundations](../../docs/working-state.md#the-foundations-tier--canonical-documents-that-travel) (canonical documents, v3.59.0), [working state](../../docs/user-guide.md#13b-working-state--carrying-context-between-sessions) (handoffs, a standing brief, a journal), the `my-curator` command and harness hooks (September 2026). Agents can now continue work across sessions, tools and machines. |
| 7. A real app | A native [Mac app](../../docs/mac-app.md) with in-app updates and a menu bar widget; a one-line [Windows installer](../../docs/install-windows.md); newer models as they arrive (Claude Haiku, Sonnet and Opus 5.5 on 8 October 2026). |
| 8. The details (this article) | Ingest keeps exact facts and figures, follow-up documents update existing pages, and chat and agent search find the details. v3.98.0 to v3.99.1, 14 and 15 November 2026. |

Today the tagline on the website says it best: **your brain, your team's brain, your agents' brain.**

---

## None of this happened alone

I want to say this clearly, because it is true and because it is the real lesson of the project: **The Curator would not be where it is without its community.** The early adopters who tried a rough first version and told me what broke. The users who stayed and are now, honestly, veterans: people who run large wikis every day and find the edge cases I would never find myself. My students, who are a wonderfully unforgiving test group.

This is the power of open source. The Curator has a complex pipeline. A document is read, cut into the right pieces, turned into summaries, entities and concepts, merged with what already exists, linked, checked, synced. Then all of that has to be read back correctly: by the chat inside the app, by agents through the MCP, sometimes from wikis with tens of thousands of pages. There are a great many places where something can quietly go wrong. No single developer can test all of them. A community that uses the tool for real work, and reports back, can.

So, to everyone who opened an issue, sent a message, or simply kept using it and told me what they saw: thank you. Every release in this article stands on your feedback.

---

## The three layers of context

Before the new part, one more piece of background, because it explains why details matter so much. I use The Curator every day as a **context engine** for AI agents, and many other people now do the same. I have written about this in earlier articles ([*The Context Engine*](./the-context-engine.md), [*The Right Context, Not All of It*](./the-right-context-not-all-of-it.md), and the research paper [*Knowledge Accumulates, State Supersedes*](./knowledge-accumulates-state-supersedes.md)), and I still think it is one of the most important ideas in working with agents: an agent is only as good as the context it starts with.

The Curator splits that context into three layers, and the app now shows and manages each of them:

- **Foundations.** The documents you write when you start a big project: architecture, blueprint, conventions, firm decisions. They are kept word for word and handed to the agent at the start of every session ([how foundations work](../../docs/working-state.md#the-foundations-tier--canonical-documents-that-travel)).
- **State.** Where the work stands right now: the latest handoff, the standing brief with your instructions, the decisions made along the way. State **supersedes**: the newest save wins, so an agent never works from yesterday's plan ([working state](../../docs/user-guide.md#13b-working-state--carrying-context-between-sessions)).
- **Knowledge.** The big picture: your second brain or your organisation's shared brain. The agent can search this whole graph to understand the domain it is working in. Knowledge **accumulates**: nothing is thrown away.

> **Why this matters.** Foundations tell the agent how the project is built. State tells it what happened last. Knowledge tells it what the world around the project looks like. Most agents today get only a fraction of the first two and none of the third.

That third layer is where this update makes the biggest difference.

---

## The gap I could not stop noticing

For some time I had a feeling I could not quite name. When I ingested a document, The Curator gave me a very good understanding of it: the ideas, the people, how everything connected. But when I came back to ask for something specific, it was often not there. The exact price. The deadline. The version number. The reason a decision was made. Those had been summarised away.

It became impossible to ignore when I ingested a pricing strategy for a training course I teach. It was a dense, carefully worked-out document: a list price, a revenue-share model with three options, a guaranteed minimum, a go/no-go threshold, a cancellation fee, and a table simulating income at different numbers of participants.

The wiki came back with three summary bullets and three generic concept pages. It had kept the **idea** of the strategy and lost almost all of the numbers. I asked the chat a simple question: how much would I earn with 14 participants? It could not answer. The list price was not anywhere in the wiki.

This was not a crash, and not really a bug. The ingest step had been designed, on purpose, to write short, concise pages that connect ideas. Nothing in it asked the model to keep the numbers. For an article or an essay, that is exactly right. For a pricing document, a budget, a financial report, a specification or an architecture file, it throws away the most valuable part.

This update was entirely my own idea, born from that moment. Nobody had reported it. But once I saw it, I saw it everywhere.

---

## Three kinds of knowledge

The way I now think about it, a second brain has to hold three different kinds of knowledge:

| Kind | What it is | Examples |
|---|---|---|
| **Understanding** | Ideas, arguments, connections | Articles, research, essays, talks, notes |
| **Facts and figures** | Exact numbers, and the date or period they belong to | Pricing, budgets, financial reports, quarterly results, contracts, proposals, measurements |
| **Technical knowledge** | How something is built, and why | Architecture documents, specifications, API references, configuration, decision records |

Until now The Curator was built for the first. After these six releases it handles all three. And the second and third now **compound over time**: a newer version of a document updates what the wiki already knows, instead of sitting beside it as a stranger.

> **The Curator now keeps two things: the ideas, and the details.** Ideas tell you what something means. Details tell you exactly what it was, and when.

The user guide describes this with examples in [*Brains that hold numbers and technical knowledge*](../../docs/user-guide.md#brains-that-hold-numbers-and-technical-knowledge-v3980).

---

## What changed, in plain language

### 1. Ingest keeps the details

When a document is measurably full of numbers, technical names or tables, its summary now gets a **Key Facts** section. Every important figure is written exactly as it appears in the source, with its unit, its condition and its period or version. Technical names (services, settings, endpoints) are kept in code style. And the page for each company, product or concept keeps the figures that belong to it.

Ordinary articles are not touched. They get exactly the same instructions as before, so the readable, connected style people like stays the same. If you ingested a data-heavy document before this update, you can have it [read once more](../../docs/user-guide.md#re-ingesting-a-source-and-why-its-safe) to pick up its figures, and the app shows the cost before anything is spent. The full rules, with example pages, are in [*What ingest keeps from a document full of numbers or technical detail*](../../docs/user-guide.md#what-ingest-keeps-from-a-document-full-of-numbers-or-technical-detail).

When I ingested the pricing document again, the new Key Facts section held every important number. I asked the same question. The chat worked out the 14-participant income correctly from the stored price and revenue share, and mentioned the cancellation fee without being asked.

### 2. Newer documents update older pages

When a newer document changes a value, the existing page now gets the new value, with its version, and keeps the old one next to it. Nothing old is ever removed. So the wiki can answer not only *what is it now?* but also *how did it change?*

In one test, three yearly company reports were ingested in order, and the company page ended up with lines such as "2025 revenue: €4.4M (2024: €3.1M)". In another, an architecture document went from v1 to v1.5 and the service page now read "As of v1.5: port 7113 (was 7103)."

### 3. Chat finds the details

This was the hardest part, and it needs a short explanation. The [chat inside the app](../../docs/user-guide.md#9-chat-with-your-brain) cannot read your whole wiki for every question; that would be slow and expensive. It reads a limited amount, about 60 KB per question. Imagine a reading desk with room for only so many pages. One very large page could take up the whole desk, so the small page that actually held the answer was never opened.

Now the chat reads Key Facts first, and when the desk gets full it reads big pages **in part**: the title, the key facts, and the sections that match your question. That leaves room for the small pages too.

### 4. Agents find the right page

When an agent searched the wiki through the [MCP](../../docs/mcp-user-guide.md), big pages used to win simply because they were big. Search now ranks by relevance and properly understands exact names, version numbers, prices and percentages. The right page comes first about twice as often as before. Agents that save findings back to the wiki now keep exact figures the same way, and look in a page's Key Facts first when they are asked for a number. The [my-curator skill](../../skills/my-curator/SKILL.md) carries the same rule.

### 5. Safety fixes for wikis people rely on

Testing at this depth also uncovered problems that had nothing to do with numbers, and they were fixed along the way:

- **[Sync across two computers](../../docs/user-guide.md#15-sync-across-computers)** could make the app forget that a file had already been read, so you might pay to read it again. Records from both computers are now always kept.
- **Paid work is never thrown away.** A wiki built elsewhere could fail after the AI had been paid. Everything is now checked before any money is spent.
- **Old file encodings** silently lost letters like č, ž and é. You now get a clear warning that names the file, so you can fix it.
- **[Wiki Health](../../docs/user-guide.md#17-wiki-health)** now [repoints every form of link](../../docs/user-guide.md#which-links-a-merge-repoints) when merging duplicates, Undo restores everything, and a 22,000-page wiki scans in about 4 seconds instead of freezing for 8.

---

## Why grounding in facts matters

You might ask why I care so much about exact numbers when AI models are so good at reasoning. The answer is precisely because they are so good at reasoning. A model that does not have a number will often produce a plausible one. It sounds right, it is formatted nicely, and it is wrong. With a summary that says "the document discusses pricing", a model asked for the price has only two options: admit it does not know, or guess.

For understanding, a summary is enough. For decisions, it is not. If you are a founder checking last year's figures, a consultant recalling the day rate you agreed with a client, or a developer asking which port a service listens on, an approximate answer is worse than no answer. It costs you the time to verify it, or worse, the mistake of not verifying it.

That is why the new Key Facts follow a few strict rules: the number is copied **exactly as written**, it carries its **unit and period or version**, and **nothing old is deleted**. A fact in your wiki should be something you can trace back to its source and its date, the way a good accountant or engineer would want it. This is also why the testing below was so strict. A second brain that people rely on has to earn that trust with evidence.

---

## What this makes possible

Everything that worked before still works: a research brain, a learning brain, a shared brain for a cohort, memory for coding agents. What is new is everything that depends on details. (More examples in the user guide's [use cases](../../docs/user-guide.md#brains-that-hold-numbers-and-technical-knowledge-v3980) and in [docs/use-cases.md](../../docs/use-cases.md).)

- **A company or team brain that tracks change.** Annual plans, budgets, quarterly results and price lists go in; each figure is kept with its period. Ask *how did revenue and headcount change from 2024 to 2026?* and the answer comes from exact, dated facts.
- **A product brain built while you build.** This is the one I am most excited about. While you design and code a product, you also ingest its technical documentation: architecture, components, APIs, configuration defaults, data flows, and decisions with their reasons. Months later, or when you hand the project to a new developer or an AI agent, the context is there: *which service owns this, what port does it listen on, what is the default timeout and why was it chosen?*
- **Open-source projects that ship their own second brain.** Imagine a repository that publishes not only its code and documentation, but its wiki: the architecture, decisions, history and facts as plain markdown. Anyone clones it, opens it in The Curator and starts asking *why does the sync use a three-way merge?* No server needed.
- **Consultants and freelancers:** proposals, rate cards, contract terms. *What day rate and payment terms did we agree with this client last year?*
- **Researchers:** not only "the study found an effect", but the measured values, sample sizes and conditions.
- **Teaching and training:** syllabi, schedules, pricing per course run, participant numbers and outcomes, and how they evolve.
- **An organisation's [Shared Brain](../../docs/shared-brain-user-guide.md):** shared policies, prices and targets, the same exact number for everyone, with its date and its history.

For agents, the knowledge layer just became far more useful. A domain can now hold a project's full architectural detail (services, endpoints, defaults, versions, figures, decisions and their reasons) and keep it current as new documents arrive. An agent working on your code can look up exactly how something was built and why, instead of guessing from a summary.

---

## How it was tested, and what it cost

This is the part I want to share openly, because it is rarely visible from the outside.

The Curator is an open-source project I fund myself: no company, no investors, my own time and money. Every AI call in testing is paid from my own accounts. For this upgrade I expected to spend about €10 on API calls. It came to roughly **€60 to €70**: about €40 to €50 on Google Gemini, more than €20 on Anthropic, and a smaller amount on OpenRouter. Here is what that money bought.

### One rule: nothing ships that makes a right answer wrong

The Curator runs on real people's machines and updates automatically. So every change had to pass a strict rule: **no question answered correctly today may be answered wrongly after the change.** Better on average was not enough.

### Independent audits, not self-grading

Each change was built by one AI agent and then audited by a separate one that never saw the builder's reasoning. The auditor wrote its own test questions and tried to break the change. Across the two days there were more than a dozen audit rounds, and several changes went back three or four times before passing. This is the maker and checker pattern I have written about before, and once again it paid for itself. The audits caught real problems the builders' own tests had missed:

- a link fixer that would have rewritten an ordinary sentence;
- a cost estimate that could show $0 and then spend;
- a page excerpt that could have sent a secret from a page's properties to the AI;
- a chat change that broke a question about my own biography, because it did not connect "Režun" with my page name.

### Built, measured, and thrown away

- **Four designs for how chat picks pages were withdrawn.** Each one improved results on average, but each turned at least one correct answer wrong. The fifth design passed.
- **An automatic encoding detector was withdrawn.** Guessing an old file's encoding from its bytes produced 2,559 wrong letters in 43,742 randomised samples (Czech "Kč" became "Kè"). A wrong letter silently saved into your wiki is worse than a visible warning, so it became a warning.

These were the expensive parts. They are also the reason I trust what shipped.

### The scale of testing

| Area | What was tested |
|---|---|
| Ingest | About 250 measured ingests across three models (Gemini 3.5 Flash Lite, Claude Haiku 5.5, Solar Pro 4 via OpenRouter), on a real pricing document, a 62 KB operating plan, a 32 KB architecture document, a spec sheet, yearly reports and a v1 to v1.5 changelog. |
| Chat | 1,188 labelled questions from six real domains, a "What is X?" sweep over 1,417 entities, 6,066 title queries. Each question asked on the old and new version, twice each, six times for anything suspicious. Answers judged by a stronger model, disagreements read by hand. |
| Search | 507 questions plus the auditor's own 304, and targeted sets for version strings, page names, prices, percentages, dotted names, comma numbers and ratios. |
| Health | A synthetic 22,000-page vault, a 3,511-page copy of a real wiki that had to stay byte-identical, and six "torture" vaults full of tricky links. |
| Code safety | Mutation testing: deliberately break each new safety check and confirm the tests notice. Dozens of mutations per change, all caught. |

To give a sense of why it cost more than planned: a single chat test sends about 15,000 to 20,000 tokens of wiki content to the model. A fair before-and-after comparison doubles that, and repeated runs multiply it. The final chat round alone sent about 17 million tokens to Gemini.

### Results

**Facts captured from a document** (average of three runs per model, before → after):

| Source | Gemini 3.5 Flash Lite | Claude Haiku 5.5 | Solar Pro 4 |
|---|---|---|---|
| Pricing document (29 facts) | 5.7 → 18.7 | 16.0 → 26.3 | 12.0 → 25.0 |
| 62 KB operating plan (64 facts) | 14.3 → 37.7 | 50.3 → 60.3 | 49.0 → 63.7 |
| 32 KB architecture doc (47 facts) | 4.7 → 34.7 | 35.0 → 47 | 43.7 → 46.7 |

- **A newer document updates the existing page** (a changed port, v1 → v1.5): Haiku 5.5 went from 0 of 9 to 8 of 9; Solar Pro 4 from 1 of 9 to 7 of 9 (then 3 of 3); Gemini Flash Lite from 0 of 9 to 3 of 3. No old line was lost in any run.
- **Chat:** correct answers rose from 421 to 469 (Gemini) and from 386 to 440 (Solar), out of 636 each. No question went from always right to always wrong.
- **Agent search:** the right page came first 215 times out of 246, up from 113; across domains 44 of 58, up from 16.
- **Large wikis:** a scan went from 23 seconds with an 8.7-second freeze to about 4 seconds with no freeze longer than 0.08 seconds. Finding duplicates dropped from 203–299 seconds to 8–12 seconds.

The full measurements, with every known limit, are recorded release by release in the project's changelog ([CLAUDE.md](../../CLAUDE.md) for the newest releases, [CHANGELOG-ARCHIVE.md](../../CHANGELOG-ARCHIVE.md) for the rest).

### What I learned

- **Cheaper models keep fewer facts.** For data-heavy documents, a stronger model is worth it: Haiku 5.5 kept about 26 of 29 facts where Flash Lite kept about 19.
- **Fixed budgets force trade-offs.** In chat's limited reading space, every change that helps some questions risks others. Only measuring on real questions shows which way it goes.
- **Builders' own tests hide regressions.** The independent auditor, writing its own questions, found what the builder missed every single time.
- **Set a budget before testing.** I will from now on.

---

## Known limits, honestly

- A replaced endpoint in a follow-up document often lands only on the new summary, not on the existing page.
- Files in old encodings are warned about, not converted. Save them as UTF-8 and ingest again.
- A technical document written as plain prose, with no numbers, code names or tables, is not recognised as data-heavy.
- Large tables are summarised, not copied. The original file keeps the full tables.
- Chat still matches words fairly literally.

I have tested this as thoroughly as I can, and I am getting good results myself. But you will be the real judges. If you ingest a financial report, a spec or an architecture file and something is missing or wrong, [open an issue](https://github.com/talirezun/the-curator/issues) or send me a note and I will look at it. That is how every earlier version got better too.

---

## Try it

The Curator is free, open source ([MIT](../../LICENSE)) and stores everything as plain markdown on your own computer. If you want it on several machines, it syncs through your own private GitHub repository. Full instructions are in the user guide's [installation section](../../docs/user-guide.md#3-installation).

### What you need

One API key, from **Google Gemini, Anthropic or OpenRouter**, for ingest and chat. You enter it in Settings and it stays on your machine. Agent memory and the MCP bridge work without a key.

> **It works on a free tier.** I have been running The Curator with my students on the free tier of the Gemini API, and it works just fine. They built their own second brains without paying anything. The free tier is rate-limited, so very large batches go slower, but to start and learn it is more than enough. For data-heavy documents, a stronger paid model keeps more facts, as the results above show.

### macOS: the app

Download the `.dmg` for your Mac (Apple Silicon or Intel) from the [GitHub releases page](https://github.com/talirezun/the-curator/releases) and drag The Curator into Applications. The app updates itself and includes the menu bar widget ([Mac app guide](../../docs/mac-app.md)). Because the app is not yet signed, macOS blocks it on first launch: open **System Settings → Privacy & Security**, scroll to Security, and click **Open Anyway**.

Prefer a one-line install? Paste this into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/talirezun/the-curator/main/install.sh | bash
```

### Windows: one-line installer

A native Windows app is coming. Until then, Windows 10 and 11 users run The Curator as a local server and use it in their browser. The installer needs no administrator rights and adds Start and Stop icons ([Windows install guide](../../docs/install-windows.md)). Open **PowerShell** and paste:

```powershell
irm https://raw.githubusercontent.com/talirezun/the-curator/main/install.ps1 | iex
```

When it is running, open **http://localhost:3333** in your browser.

### Linux: local server

Linux works the same way as Windows: a local server you open in your browser. You need **Node.js 18 or newer** and **git**. In a terminal:

```bash
git clone https://github.com/talirezun/the-curator.git
cd the-curator && npm install
node src/server.js
```

Then open **http://localhost:3333**.

### Or let your coding agent install it

If you use Claude Code, Codex, Cursor or a similar tool, the user guide on the website has a single prompt you can paste, and the agent handles the installation. You add your API key in Settings yourself.

> **A small safety habit.** Any time you paste a one-line installer into a terminal, it is good practice to open the script first and read what it does. Both scripts are in the public repository: [install.sh](../../install.sh) and [install.ps1](../../install.ps1).

---

## Where to find everything

- **Website, guides and support assistant:** [mycurator.xyz](https://mycurator.xyz/)
- **Open-source repository:** [github.com/talirezun/the-curator](https://github.com/talirezun/the-curator)

The website has its own support assistant, powered by Lumina AI. You can simply talk to the documentation: ask how to install on your system, how to connect the MCP to your agent, how Shared Brain works or what a feature costs, and it answers from the user guides. Everything else (code, changelog, architecture, issues) lives in the open repository.

---

## A closing thought

Thirteen articles in, the thing that surprises me most is not any single feature. It is how far a simple idea can go when real people use it for real work and keep telling you the truth about it. The Curator began as a way to understand what I read. It became a place where a team can think together, and then a memory for the agents I build with. Now it also remembers the numbers.

If you build software, try this: ingest your project's architecture document today, and ask it a question a month from now. If you run a business, ingest last year's plan and this year's, and ask how things changed. Then tell me what you found.

And if The Curator is useful to you, a star on the [GitHub repository](https://github.com/talirezun/the-curator) helps other people find it. That, too, is how open source grows.

---

## Sources and further reading

- [User guide: What ingest keeps from a document full of numbers or technical detail](../../docs/user-guide.md#what-ingest-keeps-from-a-document-full-of-numbers-or-technical-detail)
- [User guide: Brains that hold numbers and technical knowledge](../../docs/user-guide.md#brains-that-hold-numbers-and-technical-knowledge-v3980)
- [User guide: Chat with your brain](../../docs/user-guide.md#9-chat-with-your-brain)
- [User guide: Wiki Health](../../docs/user-guide.md#17-wiki-health) and [which links a merge repoints](../../docs/user-guide.md#which-links-a-merge-repoints)
- [User guide: Sync across computers](../../docs/user-guide.md#15-sync-across-computers)
- [My Curator MCP guide](../../docs/mcp-user-guide.md)
- [Working state and foundations: technical reference](../../docs/working-state.md)
- [Use cases](../../docs/use-cases.md)
- Earlier in this series: [*The Context Engine*](./the-context-engine.md), [*The Right Context, Not All of It*](./the-right-context-not-all-of-it.md), [*Knowledge Accumulates, State Supersedes*](./knowledge-accumulates-state-supersedes.md)
- Andrej Karpathy's [LLM wiki pattern](https://github.com/karpathy/LLM-wiki), the idea The Curator started from

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

This article is published for research and educational purposes only. The content represents my own experiences, observations and analysis based on hands-on development and daily use of The Curator.

### No Commercial Relationships

I have not been compensated, sponsored, or otherwise financially supported by any of the companies, platforms, or tools mentioned in this article. Observations about models and their costs are my own experience, not vendor claims, and plans and prices change.

### Measurements

The measurements were made on 14 and 15 November 2026 on my own wikis and on synthetic test documents, by AI agents under my direction, with independent audits. Real wikis and labelled question sets were used read-only and are kept private. Costs are my own billing totals, rounded. These are careful engineering measurements by one person on his own projects, not a benchmark.

### Evolving Landscape

Version numbers and feature status reflect The Curator v3.99.1 on 16 November 2026. Check [github.com/talirezun/the-curator](https://github.com/talirezun/the-curator) for the current state.

---

**Dr. Tali Režun**
Vice Dean of Frontier Technologies, [COTRUGLI Business School](https://cotrugli.eu/)

*Published: November 2026 · repository copy prepared 16 November 2026*
*Part of: [The Curator Research Series](https://github.com/talirezun/the-curator/tree/main/research)*
*Previous in series: [The Second Brain That Grows Smarter](./the-second-brain-that-grows-smarter.md) · [Building Knowledge Immortality](./knowledge-immortality-second-brain.md) · [From Graph to Intelligence](./from-graph-to-intelligence-my-curator-mcp.md) · [The Agent Memory Problem](./the-agent-memory-problem.md) · [The Shared Brain: When Second Brains Start Thinking Together](./the-shared-brain-thinking-together.md) · [Second Brain to Shared Brain](./neural-network-of-your-own-knowledge.md) · [The Handoff Writes Itself](./the-handoff-writes-itself.md) · [Where Your Context Lives](./where-your-context-lives.md) · [The Context Engine](./the-context-engine.md) · [The Right Context, Not All of It](./the-right-context-not-all-of-it.md) · [Knowledge Accumulates, State Supersedes](./knowledge-accumulates-state-supersedes.md)*
*Open source | Local-first | Privacy-first*
