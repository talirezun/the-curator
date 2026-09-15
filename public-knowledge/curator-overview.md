# The Curator — what it is, what it costs, and what it does not do

## What is The Curator?

The Curator is a program you run on your own computer. You drop in the things you read — PDFs, Markdown and text files: articles, notes, transcripts — and it turns them into a connected personal wiki: a page for every person, tool and idea worth one, all linked to each other.

Every new source updates the pages that already exist instead of adding another copy, so the wiki gets better the more you feed it. You can ask it questions in ordinary language and get answers that point at the pages they came from.

All of it lives on your own computer as plain markdown text files you can open, edit and back up yourself. There is no account with the project, no database, no proprietary format and no export step — the files are already the deliverable. Any text editor opens them. Obsidian renders them as a visual graph.

The software is free and open source. The only thing you pay for is an API key with an AI provider you choose yourself.

A typical source becomes about 18 to 20 interlinked pages: one summary page for the source, plus entity pages (people, tools, companies, datasets) and concept pages (ideas, techniques, principles). That figure is the model's, not a constant — across the measured model catalogue the same document produces between 5 and 27 pages, and the app prints the figure for whichever model you pick.

## What are the three layers, and what is the one rule?

The Curator holds three layers of the same idea, in one format, with one owner: your brain, then your team's brain, then your agents' brain.

| Layer | What it holds | How it behaves |
|---|---|---|
| 1. Your brain — a personal wiki per domain | What you have read and understood: entities, concepts and summaries, cross-linked into a graph | Knowledge accumulates — a new source updates existing pages instead of duplicating them |
| 2. Your team's brain — Shared Brain, opt-in | The same, built collectively by a cohort, team or research group, one opted-in domain at a time; your other domains never leave your machine | Knowledge accumulates, collectively |
| 3. Your agents' brain — working state | Where the work stands, per project: what is settled, what to do next, what was already tried and ruled out | State supersedes — each save replaces the previous handoff, because a resolved blocker must not come back |

The one rule to learn before using it: **knowledge accumulates, state supersedes.** Layers 1 and 2 add new material to what is already there. Layer 3 overwrites. Put something durable into state and the next save removes it, and nothing warns you — from the store's point of view, overwriting is correct.

All three live inside the same container, called a domain, so they share one folder, one sync, one backup, one editor and one bridge to your agents.

## Why does The Curator exist?

Claude Projects, ChatGPT Projects and Cursor rules each hold your accumulated context inside one vendor's product, and you leave it behind on the day you switch tools — or switch models, or switch machines.

The Curator's answer is structural rather than clever: there is no proprietary store to leave behind. Your knowledge is plain markdown in a folder you chose. Your sync is your own private GitHub repository, with no service of the project's anywhere in the picture. The bridge to AI assistants is MCP, a protocol spoken by any local MCP client, rather than an integration with one vendor. The files are the product; the app is a convenience over them.

It is built on the Karpathy llm-wiki concept: instead of one giant notebook where everything gets lost, you keep dedicated, compounding wikis per domain.

## How is this different from RAG or a search over my documents?

Most AI-over-your-documents products use retrieval (RAG): the model scans raw files, pulls back chunks at query time, answers, and forgets. It rediscovers your material from scratch on every question. Nothing compounds.

The Curator compiles instead. When you ingest a source, a model reads it once and writes persistent pages, then every later ingest updates those same pages and inserts cross-links in both directions. There is no vector database, no embeddings and no index to rebuild — the `[[wikilink]]` graph is the structure, and it stays human-readable.

| | Retrieval (RAG) | The Curator (compiled) |
|---|---|---|
| What is stored | Raw chunks plus an index | Written pages, cross-linked |
| When work happens | At query time, every time | At ingest time, once |
| What accumulates | Nothing — the index grows, the understanding does not | The pages themselves: a second source about the same person deepens that person's page |
| The structure | Similarity in a vector space, rebuilt as the corpus changes | A `[[wikilink]]` graph, written by the thing that read the sources |
| What you can open | An opaque index | A markdown file you can read, edit and keep |

The tradeoff is real. The writing pass costs money and time up front, and ingest is where nearly all of a Curator bill goes. A model can be wrong at write time and the wrong page persists until something corrects it — which is why the app ships a maintenance surface, Wiki Health, and keeps the original source file reachable from its summary. Improving your model does not retroactively improve pages already written.

## Who is it for?

| Profile | What they use it for |
|---|---|
| Content creators — writers, podcasters, YouTubers | Turning years of reading into a fully cited script or outline instead of facing a blank page |
| Researchers and academics | Batch-loading 20 or more PDFs and hunting the gaps between methodologies that no existing paper has addressed |
| Executives and strategists | Synthesising quarterly reports, competitor analyses and interview transcripts past their own recency bias |
| Software architects and development teams | Asking why a decision was made years ago, from ingested decision records, post-mortems and API specs |
| Medical and scientific researchers | Building a knowledge graph of genes, proteins, drugs and pathways across a dense literature corpus |
| Entrepreneurs and startup founders | Grounding strategy in the full history of customer interviews, investor updates and market research |
| Personal growth and self-analysis | Connecting journal entries, book highlights and therapy notes to see recurring patterns |
| Anyone coding with agents across sessions, tools and machines | Carrying where the work stands from one session, tool, model or computer to the next |
| Educational cohorts, research teams, consultancies and product teams | Building one collective wiki together through Shared Brain, without merging anyone's private notes |
| Independent experts, educators and consultancies | Selling recurring access to a curated brain they maintain |

## What platforms does it run on?

| Platform | How you install it | Status |
|---|---|---|
| Mac | A downloadable application, a `.dmg` from the Releases page, in two builds: `arm64` for Apple Silicon and `x64` for Intel. About 140 MB, because the app carries its own runtime | Supported |
| Mac | A one-command shell installer that fetches Node.js if needed, clones the repo, installs dependencies and builds the Dock application | Supported |
| Windows, Linux and Mac | Manual setup: Node.js 18 or newer, `npm install`, then run the local server and open it in a browser at `http://localhost:3333` | Supported, and first-class — not a legacy path |

There is no Windows application and no Linux application. On those platforms the browser install is the way in, and ingest, chat, wiki, MCP, sync and Health all work identically. What is Mac-only is the packaging, not the features.

The Mac application is **not yet notarised by Apple.** Developer enrolment is in progress. Until it completes, macOS cannot verify who built it, so the very first launch needs an explicit one-time approval through System Settings, Privacy and Security, using the **Open Anyway** button. That is a signing status, not a verdict on the app. The exception is remembered afterwards, and updates the app installs for itself never ask again. Builds from version 3.30.0 and earlier had a different and worse problem — a broken signature that made macOS call the app damaged — and the fix for those is to download version 3.31.0 or later.

## What is Mac-only?

Four things, all of them packaging rather than capability:

- The downloadable application bundle and the Dock launcher.
- Self-update: the app downloads a new version, verifies it against the sha256 that GitHub publishes on the asset, and swaps it in. On other platforms you update the checkout yourself.
- The native folder picker for choosing where your knowledge lives.
- The menu bar icon, which shows what your coding agents have just saved without opening the app. It is off by default, because a fresh install has no agent memory and would have nothing to show.

## Which AI providers does it work with?

Three, and any one of them is enough:

- **Google Gemini** — has a free tier, which is rate-limited: enough to try the product, not enough to work in it all day.
- **Anthropic** — paid only, no free tier.
- **OpenRouter** — one key onto many vendors, including one route that is free.

Local models are **not available.** A row for them exists in Settings and is marked unavailable. The OpenRouter connection speaks an OpenAI-compatible wire format, which is the name of a protocol and not the same thing as OpenAI support; it is groundwork for local runtimes later, not a capability today.

## How much does it cost to run?

The Curator itself is free, open-source software. The only paid component is the AI provider you connect, and only for the features that actually call a model. **Ingest is where nearly all of the cost goes**; chat and AI-assisted Health cleanup are cents.

| Model | Provider | Free? | Price per 1,000,000 tokens | Note |
|---|---|---|---|---|
| Gemini 2.5 Flash Lite (`gemini-2.5-flash-lite`) | Google Gemini | Free tier available, rate-limited | $0.10 in, $0.40 out | The pinned default. About 5 euros a month at heavy solo use |
| Claude Haiku 4.5 (`claude-haiku-4-5`) | Anthropic | No | $1.00 in, $5.00 out | The Anthropic default. 10 times the Gemini bill on input, 12.5 times on output |
| Solar Pro 4 (`upstage/solar-pro4`) | OpenRouter | No | $0.03 in, $0.12 out | The OpenRouter default, about a third of the Gemini default per token |
| MiniMax M3 (`minimax/minimax-m3:free`) | OpenRouter | Yes | Nothing | The free route in the measured catalogue |

Those are the defaults, not the only options. A hand-measured catalogue spans all three providers, and on a connected install the app names the cheapest measured model you can reach on the same screen, beside each model's price and its measured pages-per-source. Across the measured Gemini and Anthropic models the span is roughly 50 times on input and 62 times on output, so changing model rescales the table above.

An administrator running cohort-scale Shared Brain synthesis weekly is more like 10 to 20 euros a month.

The app does not rank models and will not tell you which is best. Rows carry price, output ceiling, context window and what the measurement found. The one comparative label anywhere is *cheapest measured*, which is a fact. The word *verified* is never used about a model, because nine clean runs are still consistent with a meaningful failure rate.

## What costs nothing?

Reading pages, managing domains, syncing to your own GitHub repository, structural Wiki Health scans, and the MCP bridge itself. None of those call a model.

## Is it really vendor-neutral?

Most of it is, by construction, and the project states the gap rather than glossing it.

Neutral: your knowledge is plain markdown in a folder you chose, with no database and no proprietary format. Your working state is markdown plus an append-only log. Your sync is your own private GitHub repository. The MCP bridge is a stdio JSON-RPC child process that any MCP client speaks, and it runs without the web app. The models are swappable between Gemini, Anthropic and OpenRouter whenever you like.

Not yet neutral, in two places:

- **Whether an AI tool picks up the agent skills is that tool's behaviour, not the skill's and not Claude's.** The skills are portable prose with no vendor-specific logic, and a harness-neutral form is generated from the same source rather than hand-copied, so there is no second copy to drift. What varies is activation, and it varies by host rather than by vendor. Measured: opencode loaded the continuity skill natively and ran it as its first action in 4 of 4 runs, while an agent on Claude Code headless never reached for it and saved in 0 of 4. The harness-neutral fix is prose, not a file format — a short block, generated by the app, pasted into the file your tool already loads every session, which took Claude Code headless to 3 of 4. Four runs per arm, headless only, one task and one model: read it as a shape, not a rate.
- **Local models are not available.** The Settings row exists and is marked unavailable.

## What is Shared Brain?

Shared Brain is the second layer: a cohort, team or research group building one wiki together without merging personal data. It is opt-in and one domain at a time.

Each contributor keeps a private Curator. Only opted-in domains push LLM-synthesised summaries to a shared private GitHub repository, and the synthesised collective comes back as a separate **read-only mirror domain** on every member's machine, never as an editable copy. The security model has two primitives: an invite token, which is metadata only, and a Personal Access Token, which is each contributor's own identity. GDPR Article 17 erasure is built in, and there are two intellectual-property modes, one aimed at cohorts and one at enterprises. Access can also be **sold** — experts, educators and consultancies can charge for it today, with no code changes.

It is still an **opt-in beta.** General availability is gated on a structured pilot with a real cohort, which has not started. Two limits are worth knowing up front: every working shared brain today stores its data in the United States, because the shipped backend can reach only one API host, and deleting a page in your own domain does not remove it from the collective — that is what the erasure operation is for.

## Can it remember what my AI coding agent was working on?

Yes — that is the third layer, called working state or agent memory. An agent writes where a piece of work stands at the end of a session over the local MCP bridge, and reads it back at the start of the next one, so the work survives a change of session, agent, model, tool or machine.

There is a dedicated file in this knowledge base covering how it is structured, what belongs in it, how it is set up and what it measurably does.

## What licence is it under, and can I use it at work?

The Curator is open source under the **MIT License** — the app, the interface, the ingest and chat pipeline, Wiki Health, Personal Sync, the My Curator MCP server, every test suite, and all documentation.

**Ten files are not.** The Shared Brain backend modules, listed by exact path in `LICENSES/ENTERPRISE-FILES.txt`, are source-available under the **Curator Enterprise License**. They stay fully readable, forkable, auditable and free for personal use; what the license reserves is paid organizational production use with storage backends other than the free GitHub one.

| What | Terms |
|---|---|
| The whole app, minus those 10 files | MIT, unchanged |
| Personal, educational, academic, evaluation, development, testing and research use | Free, always |
| The GitHub-backed Shared Brain — the one that exists today | Free for everyone, forever, organizations included. Written into the license at section 3.1, not merely promised |
| All other organizational production use | Free for this release, permanently. Curator Enterprise license keys do not exist and cannot be purchased, so the license grants organizational production use of this release at no charge, and that grant does not lapse when keys appear. Later releases may drop the clause — section 3.3, the grace clause |
| Two years after any release | That release's enterprise-licensed files convert to the MIT License automatically, section 5 |
| Anything you already have | Keeps the terms it shipped under, permanently, section 6 |

"GitHub-backed" means ordinary github.com. The shipped app has `api.github.com` written into it with no configurable endpoint, so as distributed it cannot reach GitHub Enterprise Server or EU-residency Enterprise Cloud — those sit outside the forever-free grant, though they are still free on this release like everything else.

The license text has not been reviewed by a lawyer, and says so at the top.

## Can I use the name and the logo?

No — neither licence grants rights in them. The Curator name and the Curator logo are trademarks of Tali Rezun. The licences grant rights in the code only.

You may fork the project freely. If you distribute or host a fork, the policy asks you to give it a different name and a different logo, so nobody is left unable to tell whether they are running The Curator or something else. A private fork you run for yourself is unaffected.

Accurate references need no permission at all: "based on The Curator", "compatible with The Curator", "a fork of The Curator", "works with The Curator's Shared Brain". What is not permitted is presenting your product as The Curator, or using the logo in a way that implies endorsement.

## Is it secure, and where does my data go?

The app runs entirely on your local machine. The only outbound calls are to the AI provider you configured — Gemini, Anthropic or OpenRouter — and to GitHub, when you sync to your own private repository or when the app checks for updates.

The server binds to `127.0.0.1`, the loopback address, only. It is therefore not reachable from your local network, and a cross-origin guard rejects state-changing requests from other web origins, which defends against CSRF and DNS rebinding. It still has **no per-request authentication**: it is a single-user local app and should not be reverse-proxied onto a public network.

Credential files — `.curator-config.json`, `.sync-config.json`, `.sharedbrain-config.json`, `.env`, and the `.knowledge-git/config` that holds your sync token — are gitignored, never committed, and written with `0600` owner-only permissions.

One thing "local" does **not** mean: it is not private from your AI provider. What you ingest, what you ask in chat, and the wiki pages selected to answer a question are all sent to whichever provider you configured, on that provider's own terms. Choosing the provider is how you choose those terms.

## What can The Curator not do?

This list is deliberate. Every item is a limit, a refusal or a known gap the project states rather than hides.

- **It is not a hosted service.** No account with the project, no server of the project's, no cloud backup you did not set up yourself, no web-accessible version of your wiki and no support tier.
- **It does not read everything you point at it.** Three file types only — PDF, Markdown and plain text. No OCR, so a scanned or image-only PDF is refused. No web fetching: a source recorded as a URL is stored as text and never retrieved. There is a per-source input cap of 80,000 characters, so a very long document is truncated with a visible warning rather than silently half-read. There is no screen in the app listing the files you have already ingested.
- **It has no undo.** Not for a Wiki Health merge, not for deleting a domain, not for anything else. The recovery route is git, through Personal Sync, and only if you set that up. Browsing or reverting history from inside the app is not built.
- **It does not sync by itself.** No timer, no background push, no background pull. Every sync is a click. Automatic sync was researched and deliberately not built.
- **It is not multi-user and it is not a server.** Shared Brain is not real-time collaboration: it is push, administrator-run synthesis, and pull.
- **It does not force your agent to save.** Capture is advisory and there are no hooks. A session that ends without saving leaves the previous state — stale, never corrupted. That is the fail-safe direction and the reason no enforcement was added, but it means the memory layer is inert until the continuity discipline is installed in whatever agent you use.
- **The app cannot write your handoffs.** They have exactly one writer, an agent, by design. The app reads them. The standing brief is the exception and always was the human's.
- **A browser-only assistant cannot use the MCP bridge.** The bridge is a local child process, so the client has to be able to start a local program. That is a limit of the transport, not a choice about vendors.
- **Two agent tools on one computer will overwrite each other** in a shared work-stream. Give each one its own scope.
- **A handoff does not bind the next session.** It reliably tells the next session what it does not know; measurably, it does not stop a model deciding it knows better.
- **Chat is single-domain and bounded.** It talks to one domain at a time, never reads your other conversations, sends only the recent part of the current thread, and loads a bounded slice of the wiki per question. It cannot ingest a file you drop into it.
- **A chat inside a read-only Shared Brain mirror is not saved.** You can ask a mirror questions, but the thread lives only in memory while the app is running, and the answer says so.
- **Free is not unlimited.** The free provider tier is rate-limited — enough to try the product, not enough to work in it all day.
- **Cross-domain wikilinks are not supported.** Domains are siloed on disk; cross-domain reasoning happens at read time.
- **Two chat modes are designed and not built.** The chat ships Discover, which asks, and Compile, which writes; Dictate and Curate exist as designs only.
- **Some things have shipped without a human ever looking at them.** Several recent surfaces, including parts of the desktop shell, were verified by executing their logic in tests rather than by being rendered and photographed, and the changelog says so per release. Tested and seen working end to end are different claims here.
- **Small measurements are reported as shapes, not rates.** Where the project quotes a result at four runs per arm, that is the measurement it has, and it says so.

## What version is it, and is the project active?

Version **3.52.0**, as of 13 September 2026. The project is open source, active, and developed in the open at https://github.com/talirezun/the-curator, with releases published on GitHub. It had 85 stars and 14 forks on 14 September 2026; the live count is on the repository page.

Most of the recent work comes from the maintainer using the product for real and reporting what broke. The project keeps a long, unedited changelog as its memory, and treats a false claim in a document as a first-class defect, because several of its documents are read by AI models and a wrong sentence changes what an agent tells a user.

Downloads and release notes: https://github.com/talirezun/the-curator/releases — the official website, with a one-page overview and this assistant, is https://mycurator.xyz
