# User Guide — The Curator

This guide covers everything from first-time setup to daily use. No technical background is required.

---

## Table of contents

1. [What is this app?](#1-what-is-this-app)
2. [What you need before you start](#2-what-you-need-before-you-start)
3. [Installation](#3-installation)
4. [Get your API key (Gemini or Claude)](#4-get-your-api-key-gemini-or-claude)
5. [First run — the Getting started panel](#5-first-run--the-getting-started-panel)
6. [Start the server (and how lifecycle works)](#6-start-the-server-and-how-lifecycle-works)
7. [Finding your way around](#7-finding-your-way-around)
8. [Ingest a source](#8-ingest-a-source)
9. [Chat with your brain](#9-chat-with-your-brain)
10. [Manage your domains](#10-manage-your-domains)
11. [Read a wiki page](#11-read-a-wiki-page)
12. [See your knowledge graph in Obsidian](#12-see-your-knowledge-graph-in-obsidian)
13. [Three ways to talk to your knowledge (Chat · Obsidian · MCP)](#13-three-ways-to-talk-to-your-knowledge-chat--obsidian--mcp)
14. [Daily workflow](#14-daily-workflow)
15. [Sync across computers (Personal Sync)](#15-sync-across-computers)
15b. [Shared Brain](#15b-shared-brain)
16. [Settings](#16-settings)
17. [Wiki Health](#17-wiki-health)
18. [Troubleshooting](#18-troubleshooting)
19. [API keys, cost & free tier (read this before serious use)](#19-api-keys-cost--free-tier)
20. [Install with a coding agent (Claude Code, Cursor, Augment, Cline)](#20-install-with-a-coding-agent)
21. [Further reading](#21-further-reading)

---

## 1. What is this app?

The Curator is a local, AI-powered knowledge curation system. You feed it documents — articles, PDFs, notes — and it:

- Automatically **atomizes** them into three network components: *Entities* (people, tools, companies), *Concepts* (ideas, techniques, frameworks), and *Summaries* (source narratives that connect them)
- Builds a **compounding wiki** of interlinked pages — unlike RAG systems that re-derive knowledge on every query, The Curator writes persistent pages that grow richer with every source you add
- Lets you have a **multi-turn AI conversation** with your knowledge base, with full memory of past conversations
- Produces a **visual knowledge graph** you can explore in Obsidian, with auto-colored nodes by type

The big idea: instead of one giant notebook where everything gets lost, you have **separate, focused wikis per topic** (e.g. AI/Tech, Business, Personal Growth). Each one compounds with every source you add. You are the curator; the AI is the diligent librarian.

> 📖 **For the long-form story** of why a second brain matters and how the parts of The Curator fit together philosophically, read **[Knowledge Immortality — Building a Second Brain with The Curator](../research/articles/knowledge-immortality-second-brain.md)**. It's a 15-minute essay covering the Karpathy spark, what markdown gives you, every section of the app in plain language, and the case for *compounding* knowledge. Recommended before you start ingesting.

---

## 1b. Who this is for

The Curator is domain-agnostic. Here are the main profiles who benefit from it:

**Content Creators (Writers, Podcasters, YouTubers)**
You consume hundreds of articles, books, and podcasts, but face a blank page when it's time to create. Ingest all your research — the Curator builds a content assembly line. The graph shows which themes you naturally gravitate toward; clicking an entity shows every source you've read about it.

**Researchers & Academics**
Batch-upload 20+ PDFs on a topic. The Curator extracts all distinct methodologies and authors. Use the graph's visual "Idea Collisions" to identify gaps in the literature — intersections between concepts that no existing paper has yet addressed. The chat synthesises findings across all papers with source citations.

**Executives & Strategists**
Upload reports, competitor analyses, and meeting transcripts. Build an intelligence layer where the most-referenced nodes grow largest, giving you a visual heat map of your knowledge. Query for synthesised strategic answers that bypass recency bias.

**Software Architects & Development Teams**
Ingest architecture decision records, API specs, and post-mortems. New team members can ask *"Why did we choose X over Y?"* and get an answer cited directly from a document written years ago. The Curator becomes a conversational Senior Engineer that never leaves.

**Medical & Scientific Researchers**
Drop in clinical trial PDFs and papers. The graph reveals hidden intersections — a compound used in one domain showing efficacy in another study — by visually bridging entity nodes across your entire literature corpus.

**Entrepreneurs & Startup Founders**
Feed it customer interview transcripts, investor updates, and market research. Query for synthesised strategic answers grounded entirely in your own collected intelligence, not generic AI output.

**Personal Growth & Self-Analysis**
Ingest journal entries, book highlights, and podcast notes. Query recurring patterns across months of writing. The Curator provides the objectivity of a third party on your own thinking.

→ See [docs/use-cases.md](use-cases.md) for detailed workflows for each profile.

---

## 2. What you need before you start

| Requirement | What it is | Where to get it |
|-------------|-----------|-----------------|
| A computer running macOS, Windows, or Linux | See the platform notes below | — |
| An AI provider API key | Powers ingest, chat, and AI-assisted Wiki Health | [Google Gemini](https://aistudio.google.com/app/apikey) (free tier exists, paid is very cheap) **or** [Anthropic Claude](https://console.anthropic.com/) (paid only) |
| Obsidian (optional) | Visualises the knowledge graph | Free at [obsidian.md](https://obsidian.md) |
| Node.js 18+ | Runtime that powers the local server | Auto-installed on Mac by the one-line installer; on Windows/Linux install manually from [nodejs.org](https://nodejs.org) |

### Platform support

| Platform | One-line installer | Manual `npm install` | Dock launcher app | Auto-update / folder-picker |
|---|---|---|---|---|
| **macOS** | ✅ Recommended | ✅ Works | ✅ `.app` is built automatically | ✅ |
| **Linux** | ❌ — script checks for Darwin | ✅ Works (`node src/server.js`) | ❌ — no `.app` bundle | ⚠️ Some UI buttons (auto-update, folder picker) are macOS-only; everything else (ingest, chat, wiki, MCP, sync, Health) works identically |
| **Windows** | ❌ | ✅ Works (PowerShell or WSL2; set `CURATOR_NO_OPEN=1`) | ❌ | ⚠️ Same caveat as Linux |

> The installer is currently macOS-only because it auto-builds a `.app` Dock launcher. The Curator's *core* (Express + Node) is fully cross-platform — Windows and Linux users can clone the repo and run `node src/server.js` directly. Auto-update is also macOS-specific (it rebuilds the `.app`); on Windows/Linux, run `git pull && npm install` to update.

> **Don't have a coding agent?** A Claude-Code-style CLI agent can do the install on any platform for you — see [§20 Install with a coding agent](#20-install-with-a-coding-agent).

---

## 3. Installation

### One-command installer (recommended)

Open **Terminal** (search for it in Spotlight) and paste this single command:

```bash
curl -fsSL https://raw.githubusercontent.com/talirezun/the-curator/main/install.sh | bash
```

The installer handles everything automatically:

1. Detects whether Node.js and git are installed — installs them if missing
2. Downloads the project into `~/the-curator`
3. Installs all dependencies
4. Builds **The Curator.app** for your Dock

When it finishes, the app opens automatically in your browser. A **Getting started** panel appears in the corner on first launch and walks you through the three things that have to happen before the app is useful: add an API key, create your first domain, ingest your first source. It doesn't block anything — see [§5](#5-first-run--the-getting-started-panel).

> ⚠️ **Pin The Curator to your Dock manually.** The installer puts **The Curator.app** inside `~/the-curator/` but does **not** add it to your Dock automatically. Open Finder → `~/the-curator/` → drag **The Curator** icon down into your Dock. From now on, one click launches everything.

> You only need to run the install command **once**. After that, click The Curator in your Dock to launch the app.

### Manual setup (alternative — works on Mac, Linux, Windows)

If you prefer to set things up yourself, or you're on Linux/Windows:

```bash
# 1. Clone the project
git clone https://github.com/talirezun/the-curator.git
cd the-curator

# 2. Install dependencies
npm install

# 3. Start the server
node src/server.js                         # macOS / Linux
# Windows PowerShell:
# $env:CURATOR_NO_OPEN=1; node src\server.js
```

Open **http://localhost:3333** in your browser. The Getting started panel will guide you through the rest.

**Linux / Windows specifics**

- Set `CURATOR_NO_OPEN=1` to skip the macOS-only `open` browser-launch on startup (the server still binds to `localhost:3333`; just open it manually).
- Set `DOMAINS_PATH=/path/to/your/knowledge` if you want your wiki folder somewhere other than `~/the-curator/domains`. The folder-picker UI button is macOS-only (uses AppleScript), but the env var works on every OS. If you've also set a folder in **Settings → Knowledge base**, that value takes priority over `DOMAINS_PATH`, and the My Curator MCP now resolves it the same way. (If you use the MCP, re-run its setup wizard after changing the knowledge base folder so Claude Desktop picks up the new location too — see [mcp-user-guide.md](mcp-user-guide.md).)
- Updating the app on Linux/Windows: run `git pull && npm install` from the `the-curator` directory, then restart `node src/server.js`. See [§16 → Version and updates](#version-and-updates) for how updating works on macOS — it currently has to be started from the previous interface at `/old`.

> For the Mac Dock app (double-click to launch, no Terminal needed), see **[docs/mac-app.md](mac-app.md)**.

---

## 4. Get your API key (Gemini or Claude)

The app uses an AI provider to read your documents and power chat. You need an API key from one of two providers — **Google Gemini** (recommended, has a free tier and the lowest pay-as-you-go cost) or **Anthropic Claude** (paid only, costs roughly 10× more).

> ⚠️ **About "free" — read this before you commit to free-tier-only usage.**
>
> The Gemini free tier exists, and it's enough to *try* the app and ingest a few articles. It is **not enough for serious use.** As of the [December 2025 quota tightening](https://ai.google.dev/gemini-api/docs/rate-limits), Gemini 2.5 Flash Lite (the model The Curator uses by default) is capped at:
>
> - **15 requests per minute** (RPM)
> - **1,000 requests per day** (RPD)
> - **250,000 tokens per minute** (TPM)
>
> A typical batch ingest of 5–10 PDFs can hit those limits and stall mid-run with `429 RESOURCE_EXHAUSTED` errors. **For real use, enable billing in Google AI Studio.** The pay-as-you-go price is so low that most users pay €1–€10/month — see [§19](#19-api-keys-cost--free-tier) for actual numbers.

### How to create a Gemini key

1. Go to **[aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)**
2. Sign in with your Google account
3. Click **Create API key**
4. Copy the key — it starts with `AIza` and is about 40 characters long
5. **(Strongly recommended)** Click **Set up Billing** in the same console and link a payment method — the upgrade unlocks the higher paid-tier rate limits and is what enables most users to actually run the app at scale. You will not be billed until you exceed the free tier.
6. Keep the key somewhere safe — you'll paste it in the next step

> Your API key is like a password. Never share it publicly or post it on the internet.

### Or use Anthropic Claude instead

If you'd rather pay Anthropic than Google (e.g. for privacy preference, or because you already have a Claude account):

1. Go to **[console.anthropic.com](https://console.anthropic.com/)**
2. Generate an API key under **Settings → API Keys**
3. Anthropic has **no free tier** — you must add billing before any call works
4. The Curator defaults to **Claude Haiku 4.5** (Anthropic's lowest-cost tier). For higher quality, set `LLM_MODEL=claude-sonnet-4-5` in `.env`.

**Switching between providers when you have both keys.** The Curator uses *last-saved-wins*: whenever you save a key, that provider automatically becomes the active one. So if you've been on Anthropic and then paste a Gemini key, the app switches to Gemini on its own — that's expected. To flip back **without re-pasting or deleting anything**, open **Settings → Providers & keys** and click **Set active** on the row you want. That button appears on any provider that has a key saved and isn't already active; the switch is instant and applies to ingest, chat, and AI Wiki Health. The word `active` next to a row is always the truth about which provider is live. See [§16 → API keys](#api-keys).

---

## 5. First run — the Getting started panel

The first time you open The Curator there is nothing to talk to yet, so a small **Getting started** panel appears in the corner with a three-item checklist:

1. **Add an AI key** — *"Nothing else works without a model. Paste a Gemini or Anthropic key in Settings."* → **Open Settings**
2. **Create your first domain** — *"A domain is one subject area with its own wiki — 'articles', 'research', 'work'."* → **Open Domains**
3. **Ingest your first source** — *"Drop in a PDF, Markdown or text file. The Curator reads it and writes the wiki pages."* → **Open Ingest**

Each item has a button that takes you straight to the right place. The panel tracks real state, not clicks: it reads *"2 of 3 done"* and ticks items off by itself as you actually complete them, and it stops appearing once all three are done.

**It never blocks you.** It is a panel, not a modal — you can click past it, start typing, and ignore it entirely. Dismiss it with the **✕** in its corner. Dismissing is not permanent: **Settings → General → Show setup guide** brings it back at any time.

> Step 1 is the only one you truly cannot skip in substance — without a key, ingest and chat have no model to call. Nothing stops you dismissing the panel first and adding the key later.

> **For developers:** you can also configure API keys by creating a `.env` file manually (`cp .env.example .env`) and setting `GEMINI_API_KEY=your_key_here`. Keys saved in Settings take priority over `.env` when both are present. Note that a `.env`-only key does **not** tick off step 1 — the checklist reads keys saved through the app (`.curator-config.json`), so it will keep showing "Add an AI key" even though the app can already make calls.

---

## 6. Start the server (and how lifecycle works)

### macOS — using the Dock app

Click **The Curator** icon in your Dock. The app starts the local server and opens in your browser automatically.

> If The Curator is not yet in your Dock, open Finder → `~/the-curator/` → drag the app icon down into your Dock first (one-time step).

### Manual / Linux / Windows

Open a terminal in the project folder and run:

```bash
node src/server.js                            # macOS / Linux
# Windows PowerShell:
# $env:CURATOR_NO_OPEN=1; node src\server.js
```

Then open **http://localhost:3333** in your browser.

### How the lifecycle actually works

The Curator is a **local web app** — a small Express server runs on your machine and renders the UI inside whichever browser you have open. Three things to know:

| You do… | What happens |
|---|---|
| Close the browser tab | The server **keeps running** in the background, idling at near-zero CPU. Nothing is lost. |
| Click the Dock icon again (Mac) | The browser tab reopens and reconnects to the already-running server. Fast — there is no restart. |
| Right-click Dock icon → **Quit** (Mac) | The server actually stops. Use this when you want the process gone. |
| Press `Ctrl + C` in the terminal (manual mode) | The server stops. |
| Reboot your computer | The server is gone; relaunch it (Dock click or `node src/server.js`). |

> **There is no "Stop server" button in the UI.** It was deliberately removed in v2.1 because AppleScript's reopen handler is broken on modern macOS. Use the Dock right-click menu instead.

> If you ingest a 200-page PDF, **don't quit until you see the success banner** — the ingest stream lives inside the server process.

---

## 7. Finding your way around

With the server running, open your web browser (Chrome, Safari, Firefox — any browser works) and go to:

```
http://localhost:3333
```

> `localhost:3333` means "a web page running on your own computer, on port 3333". It only works when your server is running and is not accessible to anyone else on the internet.

### The layout

There are no tabs across the top. Everything is reached from a narrow **icon rail down the left edge**, and the screen is three columns: the rail, a **contextual panel** beside it that changes with the view, and the **main column**.

The rail, top to bottom:

| Rail item | What it's for |
|---|---|
| **Chat** | Ask questions of one domain's wiki. This is where the app opens. |
| **Domains** | Your knowledge, one domain at a time — page counts, **Wiki health**, and the page list. |
| **Shared Brain** | Collective wikis you contribute to with a cohort or team. Off by default. |
| **Agent memory** | A placeholder for a feature that doesn't exist yet — see below. |
| **Ingest** | Drop in PDFs, Markdown or text files. |

Then, at the **bottom of the rail**, separated by a gap:

| Rail footer | What it's for |
|---|---|
| **☀/☾ theme toggle** | Switch between the dark and light themes. Also in **Settings → General → Appearance**. |
| **Sync** | Back your wiki up to a private GitHub repository. |
| **Settings** | Keys, MCP bridge, scan limits, knowledge base folder, version. |

Hover any rail icon to see its name.

### Two things are not rail destinations

**Reading a wiki page** happens in an **overlay** that slides over the main column. You open it by clicking a `[source: …]` citation in a chat answer, or from a domain's page list. Press **Esc**, click the dimmed area outside it, or click its **✕** to close it. It never survives moving to another rail item. See [§11](#11-read-a-wiki-page).

**Wiki Health** lives **inside a domain**. Open **Domains**, pick a domain, and the **Wiki health** panel is right there on that domain's page — because a health problem is always a problem with one specific wiki, not with the app. See [§17](#17-wiki-health).

### Where did that tab go?

If you used The Curator before this release, this is the whole map:

| The old tab | Where it is now |
|---|---|
| **Chat** | **Chat** in the rail. Picking a domain is now the **SCOPE** pill row above the thread, not a dropdown. |
| **Ingest** | **Ingest** in the rail. Unchanged otherwise. |
| **Wiki** | Gone as a destination. Open pages from **Domains → Browse pages**, or by clicking a citation in chat. |
| **Health** | Gone as a destination. It's the **Wiki health** panel inside each domain in **Domains**. |
| **Domains** | **Domains** in the rail. Now the hub: stats, health, page list, and the create/rename/delete controls. |
| **Sync** | **Sync**, in the rail *footer*. |
| **Settings** | **Settings**, in the rail *footer*. |

### The previous interface is still there, at `/old`

The redesign is the primary interface, but the old seven-tab app has not been removed. It is served at:

```
http://localhost:3333/old
```

Everything there works exactly as it did — same server, same files on disk, same wiki. Nothing was migrated or moved; the two interfaces are two views onto the same `domains/` folder, and you can use both.

The first time you open the app after updating, a one-time bar appears at the top saying **"The Curator has a new look."** with a **Use the previous interface** link and a **Got it** button. Dismissing it is permanent. (Brand-new installs never see it — there's nothing to be surprised by.)

> **`/old` is temporary.** It's kept for two or three releases to give you a way back while you settle in, then it goes. Learn the rail; don't build a workflow that depends on `/old`.
>
> **Two things you currently still need `/old` for**, both noted where they come up in this guide: **applying an app update** ([§16](#version-and-updates)), and the **Reveal in Finder** bar for a summary's original source file ([§11](#finding-the-original-document-behind-a-summary)).

### Agent memory is an honest placeholder

The **Agent memory** rail item opens a page that says *"This feature doesn't exist yet."* That is deliberate, not a bug. The rail's shape is *your brain → your team's brain → your agents' brain*, and the slot is there so the shape is honest about what's coming rather than only about what's built. There is nothing to configure and nothing to do with it today.

---

## 8. Ingest a source

"Ingesting" means feeding a document to your The Curator. This is how you build up your knowledge.

> **For developers:** [docs/ingestion-pipeline.md](ingestion-pipeline.md) is the technical deep dive — every stage, every safeguard, the full failure-mode catalogue, the quality contract.

### Supported file types

| File type | Extension | Example use |
|-----------|-----------|-------------|
| PDF | `.pdf` | Research papers, book chapters, reports |
| Text file | `.txt` | Articles you've copied, lecture notes |
| Markdown | `.md` | Notes from other apps, written summaries |

> **PDF tip:** Only text-based PDFs work. If a PDF is a scanned image (like a photo of a page), the text cannot be extracted. In that case, copy-paste the text into a `.txt` file instead.

### How to ingest

1. Click **Ingest** in the rail
2. Pick a **Domain** from the dropdown
3. Drag your file onto the drop zone — *"Drop file(s) here or browse — 2 or more starts a batch"* — or click **browse** to pick one
4. Click **Ingest**
5. Wait. A progress bar names the current step ("AI is analyzing the document…") with a percentage and a running timer beside it. This usually takes **15–60 seconds** depending on the document length. Do not close the browser or refresh the page. See *Understanding the progress bar* below if it looks like it's stuck.
6. When it finishes you get a specific result, not a "Done!" — e.g. *"Wrote 7 new pages · updated 4 existing · +6.1 KB"* — followed by the full list of pages created or updated

> The chat sidebar also shows a drop zone. It is **not connected** — it says so on itself, and clicking **Ingest** on it brings you here. Ingesting from chat isn't wired up yet.

### Batch ingest — queue many files at once

If you select **two or more files**, The Curator switches from the single-file flow above into a **batch queue**: one durable, resumable job that ingests every file, one at a time, and survives you closing the browser tab or even restarting the app. Selecting a single file still uses the plain flow described above — nothing about it changes.

**You don't have to choose them all at once.** Selections *add up*, so you can build a batch from as many folders and as many drops as you like: pick a few files, then pick a few more from somewhere else, or drop one file and then drop three more — they all join the same queue rather than replacing what you already chose. The confirm screen lists everything currently queued, with an **× on each file** to drop it, **Add more files** to keep going, and **Clear all** to start over. Adding the same file twice does nothing — files are matched on name and size, so re-picking a folder won't queue anything twice. The cost estimate recalculates every time the list changes.

Once you're in batch mode you stay there, even if you remove files until only one is left — a one-file batch is perfectly valid. Only **Clear all** takes you back to the plain single-file flow.

**1. You see a cost estimate first — nothing is spent yet.** As soon as you pick your files, The Curator shows a confirm screen: every file that will be included (largest first — see below), any files it won't accept (wrong file type, over 50MB), and an estimated cost range in dollars and tokens. **No file is uploaded and no AI call is made until you click Start batch.** You're free to cancel at this screen at no cost.

> **The single most counter-intuitive thing about ingest cost: it depends on how big your wiki *already* is, not just on the files you're adding — and there's no single "roughly twice as much" rule of thumb.** Every ingest call re-sends the list of your domain's existing pages, so the AI can link to what's already there instead of creating duplicates. That overhead is a near-fixed cost per AI call, so it weighs far more heavily on a short note than on a long document. Measured against a real ~3,300-page wiki versus an empty one, the *same* document costs roughly **39x** more as a 2 KB note, **27x** more as a 5 KB short article, **15x** more as a 13 KB article, **3.3x** more as a 40 KB chapter, and **2.1x** more once a document is long enough to hit the per-ingest size cap. The confirm screen doesn't guess at any of this — it computes the real ratio **for the files in front of you** (the same files, run through the same estimator, against your domain versus an empty one) and shows that number, not a generic multiplier.
>
> **There's also a size where cost jumps, not just tapers.** Around 15,000 characters, a source crosses from being handled in a single AI call to The Curator's multi-phase pipeline (see below). That roughly doubles the input tokens for the same document — so two similar-looking files just either side of that line can show noticeably different estimated costs, and that's expected, not a bug.
>
> **The estimate is a range, not a ceiling.** `usdLow` assumes prompt caching kicks in; `usdHigh` assumes it doesn't. Real spend can land above `usdHigh` — on one real measured batch it came in at just over 103% of the high estimate. Treat the range as your best guide going in, not a guarantee of the final bill.

**2. Files are processed one at a time — always.** Even with a hundred files queued, The Curator ingests them strictly one after another, never in parallel — this is enforced as a hard guarantee, not just an ordering convention: even if you double-click Start, open two tabs, or otherwise fire off several requests for the same batch at once, only one file is ever being ingested at any instant. This isn't a speed limitation, it's a correctness rule: two files ingesting into the same domain at once would each start out believing the same set of pages already exists, and both could try to create (say) `openai.md` at the same time — producing two competing versions instead of one properly merged page. Processing one at a time is what keeps every page merging correctly. For the same reason, while a batch is actively working on a domain, the single-file **Ingest** button for that *same* domain is disabled (you can still start a normal single-file ingest into a *different* domain — a batch on `articles` doesn't stop you from ingesting into `projects`).

**3. The biggest files go first.** Within a batch, The Curator ingests the largest document first and works down to the smallest. Bigger documents build up more of the wiki's vocabulary (entities, concepts) early, so the smaller files later in the batch get to link into an already-richer wiki instead of starting from nothing.

**4. Pause, resume, cancel — you stay in control, and Cancel really does stop.**

- **Pause** finishes the file that's currently ingesting, then stops. It never interrupts a file partway through — that's what makes it the safe, "nothing is ever left half-done" option. Resume it whenever you like.
- **Cancel** stops the batch **and stops the file that's currently ingesting, right away** — it interrupts at the next AI call rather than waiting for the file to finish. On a large multi-part document that used to mean watching the batch keep spending for minutes after you clicked Cancel while it finished the file it was on; now it stops within a fraction of a second. Files that hadn't started yet are left as **not started**; anything already fully ingested before you clicked Cancel stays in your wiki — cancelling never undoes completed work.
- **Resume** continues exactly where the batch left off.

**Pause and Cancel are deliberately NOT the same kind of "stop," and it's worth knowing which one you're clicking.** Pause is lossless by design — it only ever stops between files, so nothing is ever caught mid-write. Cancel means "stop spending, right now," and accepts a small, honestly-labelled cost for that: the file that was interrupted shows as **Stopped**, with a note that says *"Stopped partway through — some pages may already have been written. Re-ingest this file to complete it."* In practice, an interrupted file usually has written nothing yet — The Curator only writes pages to your wiki after the AI has finished planning and generating content for that file, and Cancel interrupts before that point far more often than after it — but the wording is deliberately cautious rather than promising a guarantee it can't make. Nothing is ever deleted or rolled back by Cancel. To finish a **Stopped** file, re-ingest it — since it's already recorded in `raw/` as started, you'll need to tick **Overwrite** on the re-ingest (the same "already ingested" rule that applies to any file you deliberately re-run).

**Dismissing a finished batch.** Once a batch has finished, been cancelled, or failed, a **Dismiss** button clears the panel and returns the Ingest view to normal. Dismiss only tidies your screen — it doesn't delete anything or undo any work, and it's deliberately unavailable while a batch is still live so you can't accidentally hide something that's still running.

**5. The batch can pause itself — here's what each reason means and what to do:**

| Paused because... | What happened | What to do |
|---|---|---|
| **The AI provider rate-limited us** | The Curator already retried with backoff and still hit the limit. Nothing was lost. | Wait a few minutes, then click Resume. |
| **The AI provider is temporarily unavailable** | Same idea as rate-limiting, but the provider itself is briefly down rather than throttling you. The Curator already retried with backoff. Nothing was lost — this is on the provider's side, not yours. | Wait a few minutes, then click Resume. |
| **Budget cap reached** | You set an optional dollar cap (see below) and the batch reached it. | Raise the cap, or resume without one, to keep going. |
| **3 files failed in a row** | Three files in a row failed, for any reason — often a sign something systemic is wrong (an unexpected file type, a domain problem), not just one bad document. | Check the error messages on the failed files before resuming. |
| **The app restarted mid-batch** | You (or an app update) restarted The Curator while a file was mid-ingest. | The interrupted file will safely re-run from the start — see below. Just click Resume. |
| **This domain is locked** | Another process (an app update, a sync, or the My Curator MCP) is writing to this domain right now. | Wait for it to finish, then Resume. |
| **Paused** (no other reason shown) | You clicked Pause yourself. | Resume whenever you're ready. |

**6. You can close the tab — or even restart the app.** The batch lives on the server, not in your browser tab, so closing the tab doesn't stop it. Come back later, or just reopen the Ingest view, and The Curator shows you the batch exactly where it stands, reattaching to the live progress if it's still running.

If the **app itself** restarts mid-batch (a crash, or an update), the batch is deliberately **never resumed automatically** — spending money while you're not there to see it is not a decision The Curator makes for you. Instead, whichever file was mid-ingest when it stopped is safely reset to "waiting," and the batch pauses with an "app restarted" message. **Re-running that file is completely safe.** Ingesting the same source twice never creates duplicate pages — the same file always lands on the same summary page, and every entity or concept page it touches merges instead of duplicating. Just click Resume when you're ready to continue.

**7. Files you've already ingested are skipped — and you're told before anything is spent.** If a file in your selection was already ingested into this domain, The Curator marks it **Skipped** the moment you create the batch, before a single file is uploaded or a single AI call made. You'll see it called out on the confirm screen and in the panel, so you know up front rather than discovering it partway through a batch you've already paid for. Tick **Overwrite existing pages for files already ingested** on the confirm screen if you actually want to re-ingest a file that was skipped for this reason.

**8. When the batch finishes: an aggregate report, plus a free Health check.** Once every file has been processed (or skipped, or failed), the panel shows a summary — how many completed, how many failed, how many were skipped, total pages written, total warnings, and total spent. The Curator then automatically runs a **free, local Wiki Health scan** (no AI cost) across the whole domain and shows the results — broken links, orphans, and so on — so you can see the batch's overall effect on your wiki in one place. To act on anything it found, open **Domains**, pick that domain, and use its **Wiki health** panel ([§17](#17-wiki-health)).

**About the spend figure on a cancelled batch.** If you cancelled the batch, the total is shown as **"at least $X"** rather than a flat number. That's honest, not vague: the AI call that was in flight when you clicked Cancel is never billed back to us in a way we can measure, so every dollar counted was really spent but the last fraction of one is missing. (Separately, if the model in use has no published price, the figure reads **"approx. $X"** instead — that one is an estimate share and can land either side of the real number.)

**9. Optional: set a budget cap.** On the confirm screen you can set a dollar amount as a spending cap for the batch. Once the running total reaches that cap, the batch pauses (see the table above) rather than continuing to spend. Leave it blank for no cap. If the AI model currently in use has no published price on file (this can happen with a custom/override model), The Curator refuses to accept a cap at all rather than accept one it can't actually enforce — you'll see a clear message explaining why. The batch itself still works fine without a cap; only the cap is refused.

### Understanding the progress bar (v3.0.17)

While an ingest runs, the progress bar shows the current step (e.g. *"Phase 1: planning wiki structure…"*) with a percentage next to it. On a large document, that percentage can sit at the same number for a minute or more. **This is normal — it does not mean the ingest is stuck.**

Here's why: several steps are a single request to the AI, and there's no way to show "70% done" partway through one AI response — it's either still working or it's finished. Planning the structure for a long document (Phase 1) is exactly this kind of step, and it's the one most likely to look frozen even though nothing is wrong.

Two things make this clearer:

- **A running timer** next to the percentage (e.g. `42s`, then `1m 15s`) counts up every second for as long as the current step is working. If the timer is moving, the AI is working. If you ever see the timer stop moving *and* nothing changes for several minutes, something has genuinely gone wrong — refresh the page and try again.
- **A short note under the progress bar** says: *"Large documents can take a minute or more per phase — especially planning. The timer above keeps ticking while the AI works; it isn't stuck."*

**If the AI provider is briefly overloaded**, The Curator automatically waits and retries (see [§19](#19-api-keys-cost--free-tier)). During that wait, the progress label turns **amber** and the bar pulses gently, e.g. *"Service busy — retrying in 9s… (attempt 2/3)"*. The timer keeps counting through these retries instead of resetting — so if a step needed two retries before succeeding, the timer shows the whole time it actually took, not just the final attempt.

**In short:** a still percentage with a moving timer = working normally. A frozen timer with no error message = worth refreshing and trying again.

### What happens automatically

The AI reads your document and creates:

- **1 summary page** — the key takeaways in bullet points
- **Entity pages** — one page for each person, tool, company, or framework mentioned
- **Concept pages** — one page for each key idea or technique
- **Cross-references** — every page links to related pages
- An updated **index** — a master catalog of everything in this domain
- A **log entry** — a record of this ingest with today's date

On the second, third, and subsequent ingests, the AI reads what's already in the wiki and *updates* existing pages rather than duplicating them. The more you add, the smarter it gets.

### How big a document can The Curator handle?

Gemini 2.5 Flash Lite has a **1,048,576-token context window** (~1 million tokens, roughly 700,000 English words). In principle, a single ingest could swallow an entire 300-page book.

In practice, The Curator's ingest pipeline currently caps the **input** at 80,000 characters (~20,000 tokens) per ingest to keep latency and cost predictable. **If your source is longer than that, you'll see a red ⚠ Attention entry on the result panel telling you exactly how much was processed and how much was dropped** — content past the cap is not seen by the AI. For long sources, split by chapter or use the multi-phase pipeline (kicks in automatically for inputs > 15k chars):

1. **Phase 1** — outline pass: the AI reads the whole document and produces a list of pages to write (with a required-coverage checklist: one summary, originator entity, every named person/tool/company, every key concept, consolidation rule for closely related sub-ideas)
2. **Phase 2** — batched content: pages are written in batches of 4 per LLM call
3. **Index merge** — the app appends new rows to `index.md` programmatically (no LLM call), so the index stays consistent even on large domains

**Practical guidance:**

| Document size | Behaviour |
|---|---|
| **≤ 25 pages / ~10–15 k words** | Single-pass ingest (15–60 seconds) — the most common case |
| **25–100 pages / book chapters / long research papers** | Multi-phase pipeline kicks in automatically (~1–5 minutes) — works reliably |
| **200–300 pages / full books** | Multi-phase pipeline still works — possible but **not yet stress-tested at scale**. The 1M-token context is large enough; expect ingest to take 10–20 minutes. If a very long PDF stalls or runs out of token budget, split it into chapters. |
| **Scanned PDFs (image-only)** | Won't work — there's no OCR step. Convert to text first. |

> The 80k-char-per-call cap is conservative; future versions may raise it now that Gemini 2.5 Flash Lite's full 1M window is generally available. For now, splitting very long sources by chapter is the safe bet.

### Tips for better results

- **Use descriptive filenames.** `atomic-habits-summary.txt` is better than `notes.txt` — the filename becomes the summary page's slug (v3.0.1-beta.1+), so the file `report-2024.pdf` always lands on `summaries/report-2024.md`.
- **One document per file.** Don't combine ten articles into one file — each document should get its own file so it gets its own summary page. To ingest many documents at once, select them all and use **batch ingest** (see above) rather than manually combining them or running the single-file flow over and over.
- **Clean up copy-pasted text.** If you paste an article from a website, remove the navigation menus, cookie banners, and footer text first. Cleaner input = better wiki pages.
- **Mind the rate limits on the free tier.** If you're ingesting a batch of 5+ documents and you're on Gemini's free tier, expect to hit `429 RESOURCE_EXHAUSTED` partway through — see [§19](#19-api-keys-cost--free-tier).
- **Watch the warnings panel after each ingest.** If you see "⚠ Source truncated to 80,000 chars" or "⚠ Stub page created", the ingest finished but with reduced quality — the warning tells you exactly what to do. Re-ingesting the same source is safe (see below).

### Understanding the ingest report (what those "warnings" really mean)

When an ingest finishes, you may see a coloured banner at the top of the result panel that says something like *"Ingest finished — 12 notes"*. Despite the older "warning" label, **most of these entries are SUCCESSES, not problems** — they're the Curator's safeguards reporting what they caught and fixed for you. As of v3.0.1-beta.12, each entry is now categorised so you can tell at a glance what needs your attention.

There are four categories:

| Category | Icon | Colour | What it means |
|---|---|---|---|
| **Auto-fixed** | ✓ | green | The Curator detected something the LLM did wrong and **already fixed it**. Nothing for you to do — your wiki is cleaner than it would have been. |
| **For review** | ⚠ | amber | The Curator detected something it **can't auto-resolve**. Read the entry; you may want to act via Wiki Health or by re-ingesting. |
| **Attention** | ⚠ | red | Something material happened — usually source truncation. Read the entry; you may need to split the source or take other action. |
| **Info** | ℹ | blue | Contextual note. Usually safe to ignore. |

The banner's outer border colour matches the most-severe entry, so at a glance:

- **Green border** → everything's fine, the safeguards just did some work
- **Amber border** → one or more items need your review
- **Red border** → source truncation or similar — read the report

#### When one line represents many pages (v3.0.17)

Some issues can happen many times in a single ingest — for example, a dozen pages missing their `.md` extension, or several content batches that each had to be retried. Showing every occurrence as its own line would bury the few entries that actually need your attention under a wall of repeats. A real ingest that used to show 75 separate warning lines now shows 11.

So, any issue that happens **3 or more times** in one ingest is collapsed into a single summary line — e.g. *"12 page paths came back from the AI without the '.md' extension and were written correctly (a, b, c, …and 9 more)"* — instead of 12 near-identical lines. Below that (1 or 2 occurrences), you'll still see the individual entry, because at that count the specific page name is more useful to you than a summary.

**No detail is lost by grouping** — it only affects the warnings banner. Every page written during the ingest, including every one folded into a grouped line, is still listed individually — with its full path and whether it was created or updated — in the change list shown above the warnings.

Two kinds of entries are deliberately **never** grouped, even when they happen many times: semantic near-duplicate redirects, and a newly-injected "trunk" parent page. Both name a specific pair or page you may want to look at individually — folding "12 duplicates were merged" into one line would hide exactly the thing worth double-checking.

#### Full reference of ingest-report entries

| Entry text | Category | What it means | What the Curator did | What you should do |
|---|---|---|---|---|
| *"Outline had N `prefix-*` pages without a parent `concepts/<prefix>.md` — injected the trunk page (granularity-inversion fix)"* | ✓ Auto-fixed | The LLM created several specific sub-concept pages (e.g. `taste-as-moat`, `taste-as-judgment`) but skipped the obvious parent `taste`. | Auto-injected the parent concept page with a clean umbrella summary. | Nothing. You can edit the parent page later in Obsidian if you want richer content. |
| *"Outline omitted originator '<author>' — injected `entities/<slug>.md`"* | ✓ Auto-fixed | The source had a clear byline ("By Dr. X") but the LLM didn't create an entity page for the author. | Detected the byline + injected the missing author entity. | Nothing. |
| *"Outline used originator slug `entities/dr-tali-rezun.md` — redirected to canonical `entities/tali-rezun.md`"* | ✓ Auto-fixed | The LLM used a honorific-prefixed slug. | Redirected to the canonical slug so honorific variants don't pile up. | Nothing. |
| *"Outline proposed `concepts/X.md` — semantic near-duplicate (Jaccard 0.XX) of existing `concepts/Y.md`. Redirected; bullets will merge."* | ✓ Auto-fixed | A new concept slug was ≥85% similar to an existing one (e.g. `experts-roundup-format` vs `expert-roundup-format`). | Auto-merged the new content into the existing page. | Nothing. |
| *"Hub linkification: added N wikilinks across M hub-shaped concept page(s)"* | ✓ Auto-fixed | The LLM wrote a "hub" concept page (one that enumerates many sibling concepts) using plain-text item names instead of `[[wikilinks]]`. | Detected hub-shape pages, found plain-text mentions of siblings, wrapped them in `[[brackets]]`. | Nothing — your hub now connects to all its items in Obsidian's graph. |
| *"The AI invented N extra summary page(s) (...) — merged into the canonical summary '...' instead of creating duplicates"* | ℹ Info | The AI wrote its content for a second, differently-named summary page instead of the one the file name always produces for this source. | Merged the extra summary's content into the canonical one and never wrote the duplicate to disk. | Nothing. Re-ingesting this same source will keep updating the one canonical summary, as intended. |
| *"Page path '...' was missing the .md extension — wrote it as '...'"* | ℹ Info | The AI returned a page path with no file extension (e.g. `concepts/some-idea` instead of `concepts/some-idea.md`). | Added the extension and wrote the page normally — previously this page would have been silently dropped. | Nothing. |
| *"N page paths came back from the AI without the '.md' extension and were written correctly (a, b, c, …and N more)"* (v3.0.17, the grouped form — appears once 3 or more pages hit this in one ingest, see "When one line represents many pages" above) | ℹ Info | Same issue as the row above, happening on 3 or more pages in this ingest. | Same fix, applied to every affected page — grouped into one line instead of listing it N times. | Nothing. Every affected page is still listed individually, with its full path, in the change list above the warnings. |
| *"The AI's first attempt at '...' came back unusable, so The Curator asked for a shorter version and saved that instead. This is real content, but it is briefer than the rest — open it and re-ingest if it reads too thin."* (v3.0.17) | ⚠ For review | The AI's first attempt at writing this one page ran past the response length limit, or came back unparseable. | Automatically retried with a strict "be brief" instruction, and that attempt succeeded. | Open the page from **Domains → Browse pages**. It's genuine content, just shorter than the rest of the wiki — re-ingest the source later if it reads too thin. |
| *"N pages had to be rewritten more briefly: the AI's first attempt at each came back unusable... (examples). These are real content, but they are briefer than the rest..."* (v3.0.17, grouped form) | ⚠ For review | Same as the row above, happening on 3 or more pages in this ingest. | Same brevity retry, applied to each page, grouped into one line. | Same as above — check the pages named as examples, or anything in the change list that reads unusually thin. |
| *"Outline proposed `concepts/X.md` — possible semantic near-duplicate (Jaccard 0.XX) of existing `concepts/Y.md`. Keeping both."* | ⚠ For review | A new concept slug is 50–85% similar to an existing one (probable but not certain duplicate). | Kept BOTH pages because the similarity was below the auto-merge threshold. | Open **Domains → the domain → Wiki health**, then **✨ Find duplicate pages** under QUICK MAINTENANCE. The AI-judged scan will tell you whether they're truly the same concept; if yes, merge via the Preview-then-Merge flow. |
| *"N of M wikilinks (X%) don't resolve to an existing page. Examples: ..."* | ⚠ For review | The LLM mentioned some entities in body text that weren't on the page plan, leaving phantom links. | Wrote the pages as-is with the broken links visible. | Open **Domains → the domain → Wiki health** → expand Broken links → use **Ask AI** to either find the right target or strip them. Or re-ingest with broader coverage if it's a content gap. |
| *"Stub page created: `<path>` — AI failed to write content for this page"* | ⚠ For review | The LLM failed to generate content for a planned page even after the page-by-page fallback and the v3.0.17 brevity retry above. | Wrote a clearly-marked stub with the LLM's planned summary preserved. | Re-ingest the source. The stub page has a `stub` tag so you can find it. |
| *"The AI wrote N page(s) that were not in its own plan (...). They were kept — check them"* | ℹ Info | The LLM wrote a page it never listed in its own outline — sometimes a legitimate addition, sometimes a near-duplicate under a slightly different name. | Kept the page rather than silently discarding content you paid for. | Open it from **Domains → Browse pages**. If it duplicates an existing page, delete it (or merge it manually); otherwise, nothing to do. |
| *"Source truncated to 80,000 chars (was X chars). Content past the cap not seen by the AI."* | ⚠ Attention | The source was longer than the 80k character cap. | Truncated the input and warned you. The pages it DID write are still good. | Split the source by chapter/section and re-ingest each part. Or wait for a future release with chunk-and-recombine support. |
| *"Could not extract text from `<file>`"* | ⚠ Attention | The PDF is encrypted, scanned (image-only), or malformed. | Refused the ingest and rolled back the raw file so retry isn't blocked. | Run OCR on the PDF (macOS Preview → Tools → Adjust Text → OCR, or `ocrmypdf` on the command line). Or copy the article text into a `.md` file. |
| *"Refused an unsafe/malformed page path '...' — nothing was written"* | ⚠ Attention | The AI returned a page path that can never be a valid wiki page (e.g. empty, a folder with no filename, or containing characters that aren't allowed). This is rare and is a hard safety refusal, not an auto-correction. | Refused to write that one page — every other page from the same ingest still wrote normally. | That one page's content was lost. Re-ingest the source; if it recurs on the same source, open an issue — this shouldn't normally happen. |
| *"Claude / Gemini hit the output token limit (N tokens)"* | ⚠ Attention | The LLM's response was cut off mid-write and every automatic recovery attempt for that call was exhausted. Rare — most token-limit hits now recover automatically (see the batch and page entries below, and the planning-recovery entry further down). | Reported the failure honestly — this specific case is NOT transient, retrying the exact same call hits the same wall. | Split the source into smaller parts and ingest each separately. There is **no model picker in Settings** — the Settings → API Keys control switches *provider* (Gemini ↔ Claude), not model, and each provider's model is pinned by the app. Switching provider is still worth trying, since the two have different output ceilings. If you run from a git checkout, you can pin a larger-budget Anthropic model with `LLM_MODEL=claude-sonnet-4-6` in `.env` (Sonnet 4.6 and Sonnet 5 allow 128,000 output tokens; Haiku 4.5 and Sonnet 4.5 allow 64,000 — see [model-lifecycle.md](model-lifecycle.md)). |
| *"Batch N of M was too large for the AI's output limit — wrote those pages individually instead."* (v3.0.17) | ℹ Info | A group of up to 4 pages the AI was writing together didn't fit in one response. | Automatically retried the same pages one at a time instead of as a group. Nothing was lost. Different from the "hit the output token limit" entry above — that one is an unrecoverable failure; this one is a normal, successful recovery. | Nothing. This just means the ingest took a little longer than usual. |
| *"N content batches were too large for the AI's output limit — those pages were written one at a time instead. Nothing was lost; the ingest just took longer than usual."* (v3.0.17, grouped form) | ℹ Info | Same as the row above, happening on 3 or more batches in this ingest. | Same per-batch recovery, grouped into one line. | Nothing. |
| *"The AI returned a page with no path — it could not be written."* (v3.0.17) | ℹ Info | The AI's response for one planned page arrived with no file path attached, so there was nothing to write it to. | Skipped that one page. Nothing else in the ingest was affected. | That page's content did not make it into the wiki. Re-ingest the source, and check the result for anything that seems to be missing. |
| *"N pages came back from the AI with no file path, so they could not be written. That content did not make it into the wiki..."* (v3.0.17, grouped form) | ℹ Info | Same as the row above, happening on 3 or more pages. | Same skip-and-report handling, grouped into one line. | Same as above — re-ingest the source and check the change list for anything missing. |
| *"While planning the page list, the AI ran past its response length limit… The Curator asked again for a shorter plan and that succeeded, so the ingest completed. Note that the retry explicitly asks for FEWER, broader pages, so the page list below is coarser than a first-attempt plan would have been… Planning took N AI calls instead of 1, and your source document was sent to the AI twice."* (or the same message opening with *"The AI's first page plan came back as malformed JSON"*) (v3.0.17) | ℹ Info | On a large or unusual document, the AI's first attempt at planning which pages to write either ran past its own response limit or came back malformed. | Automatically asked again with a stricter, more concise prompt, and that succeeded — the ingest completed normally. | Nothing required. But be aware: because the recovery prompt explicitly asks for fewer, broader pages, the resulting wiki is genuinely **coarser** than a first-attempt plan would have been — some detail may be grouped under one parent page instead of getting a page of its own. If a topic feels under-covered, re-ingest to try again (the AI's output varies from run to run), or split the source and ingest the parts separately. |
| *"An ingest is in progress for `<domain>` — please wait"* | ℹ Info | You clicked Sync, Update, or Delete-domain while an ingest was running. | Refused the conflicting operation with a 409. The Update / Sync / Delete buttons auto-grey while an ingest runs, so you usually won't see this. | Wait for the progress bar to finish, then retry. |
| *"Another process is already writing to `<domain>` (file lock held)"* | ℹ Info | The MCP via Claude Desktop tried to write while an in-app ingest is running. | Refused the MCP write — the in-app ingest takes priority. | Wait for the in-app ingest to finish. The lock auto-clears after 30 minutes if a process crashed; you can manually delete `<domain>/.write-lock` if needed. |
| *"This domain has grown large enough that the AI request had to be trimmed: N of M entity/concept pages were left out..."* | ℹ Info | **Very rare** — only appears on an extremely large domain (thousands of pages in a single folder), where the full list of existing page names would be too big for the AI to read in one request. | Kept only the most relevant existing pages in the AI's request instead of failing the ingest outright. The full, untrimmed page list is still checked separately for near-duplicates after the AI responds, so this doesn't weaken duplicate protection. | Nothing, usually. If a near-duplicate page appears anyway, merge it from **Domains → the domain → Wiki health → ✨ Find duplicate pages**. |

Below the change list and warnings, you'll also see a compact **token & cost footer** — see the next section.

#### Understanding the token & cost footer (v3.0.17)

Below the change list and any warnings, a small line reports the real API usage for this specific ingest — not an estimate. It looks something like:

> `gemini · gemini-2.5-flash-lite   4 calls   38,204 in / 6,112 out   24,900 cached read`

Reading it left to right:

- **Provider · model** — which AI service and model handled this ingest.
- **N calls** — how many separate requests were made to the AI. A short document is usually 1 call; a longer one that needs the multi-phase pipeline (see above) makes several — one for planning, plus one per batch of pages.
- **X in / Y out** — input and output tokens. Input is roughly your source document plus the AI's instructions; output is the wiki pages it wrote back.
- **cached read / cache write** (shown only when non-zero) — on longer, multi-batch ingests, The Curator reuses parts of the prompt across batches instead of re-sending them every time. "Cached read" tokens are the ones it reused — reading from cache costs a small fraction of a normal input token, so a large cached-read number is where the caching saving (see [docs/ingestion-pipeline.md](ingestion-pipeline.md) §8.1 for developers) actually shows up. "Cache write" is the one-time, slightly-more-expensive cost of setting that cache up on the first batch.

You don't need to act on anything here — it's informational, useful if you're curious what an ingest actually cost, or comparing providers.

### What is Jaccard similarity? (for the semantic-dupe entries)

Several entries above mention a "Jaccard 0.XX" score. Jaccard similarity is a simple math measure of how similar two sets are. The Curator uses it to detect concept slugs that are different strings but probably mean the same thing.

The formula (in plain English):

```
similarity = (words both slugs share) / (total unique words across both)
```

Worked examples from a real ingest report:

| Pair | Tokens A | Tokens B | Shared | Unique total | Jaccard |
|---|---|---|---|---|---|
| `the-human-touch` vs `human-touch` | `{the, human, touch}` | `{human, touch}` | 2 | 3 | **0.67** |
| `wisdom-cultivation-accelerates` vs `wisdom-cultivation` | `{wisdom, cultivation, accelerates}` | `{wisdom, cultivation}` | 2 | 3 | **0.67** |
| `expert-roundup-format` vs `experts-roundup-format` | `{expert, roundup, format}` | `{experts, roundup, format}` | 2 (after stem) | 3 | **0.50** raw → **1.0** with stem |
| `community-relationships-deepen` vs `deepening-community-relationships` | `{community, relationships, deepen}` | `{deepening, community, relationships}` | 2 (3 after stem) | 4 | **0.50** |

The scale and what the Curator does at each:

| Jaccard score | What it means | Curator's action |
|---|---|---|
| **0.00 – 0.49** | Independent concepts (share few words) | Keeps both, no message. |
| **0.50 – 0.84** | Possible duplicate, but uncertain | Keeps both + emits a "For review" entry so you can decide via Wiki Health. |
| **0.85 – 1.0** | Almost certainly the same concept | Auto-redirects the new slug onto the existing one. Bullets from the new page merge into the existing one. |

#### Lightweight singular/plural normalisation

Before computing Jaccard, the Curator trims trailing `s` if the resulting token would still be ≥3 chars long. This catches:

- `collections` → `collection`
- `roundups` → `roundup`
- `relationships` → `relationship`

Without this step, `expert-roundup-format` and `experts-roundup-format` would compute Jaccard 0.50 (3 unique tokens, 2 shared). WITH it, they compute 1.0 (same token set after stem) — and get auto-merged. The stem step is conservative on short words: `is`, `as`, `os` are NOT stemmed (would damage real meaning).

#### Why entities are never auto-merged by Jaccard

The Jaccard guard ONLY operates on **concept** pages, never entities. Entities are usually proper nouns (people, companies, countries) where slug variants may genuinely be different things:

- `open-ai` vs `open-source-ai` — Jaccard might be high but these are different
- `microsoft` vs `microsoft-research` — different entities sharing a name
- `tali-rezun` vs `tali-reziuncipher` — could be honest typo or actual different people

For entity dedup, the Curator relies on the structural passes (honorific-prefix strip, hyphen-normalisation, cross-folder dedup) which work on slug shape, not semantics. The Health-side semantic-duplicate scan remains the LLM-judged tool for entity-side merges if you ever need them.

### Related: things you might also see during ingest

These are status messages during the ingest itself (not part of the report banner):

- **"Service busy — retrying in 9s… (attempt 2/3)"** — Gemini API returned HTTP 503 (overloaded). The Curator retries automatically with exponential backoff (3s → 9s → 27s), shown in amber on the progress bar while it waits (v3.0.17 — see *Understanding the progress bar* above). Ingest almost always succeeds after the wait. See [§19](#19-api-keys-cost--free-tier).
- **"AI is analyzing the document…"** — The LLM call is in flight. This can take 10–60 seconds depending on document size — watch the timer next to the progress bar rather than the percentage (see *Understanding the progress bar* above). Don't refresh.
- **"Phase 2: writing content, batch N of M…"** — Multi-phase ingest is processing a batch. Wait for it to finish.
- **"Could not extract text from PDF"** — See the table above.

### Re-ingesting a source (and why it's safe)

If you find an ingested page looks incomplete, or you've updated The Curator and want fresh ingests to apply newer prompt rules to old sources, re-ingest. **The pipeline is fully idempotent on re-ingest (v3.0.1-beta.1+):**

| What could duplicate | What prevents it |
|---|---|
| Summary page | The slug is computed from the source filename, so `report.pdf` always becomes `summaries/report.md`. The second ingest merges into the existing summary — bullets accumulate, no second file. |
| Entity pages (Alice, Google, etc.) | The AI is shown a list of existing entity filenames before it picks slugs, plus `writePage` runs three dedup passes (title-prefix strip, hyphen-normalised match, cross-folder dedup). Same entity = same file = bullets merge. |
| Concept pages | Same mechanism as entities. |
| Index rows | The index is updated programmatically — rows for slugs already mentioned are skipped. |
| Bullets within sections | After every write, `deduplicateBulletSections` removes any duplicates produced by the merge. |

**How to re-ingest a single source:**

1. Open **Ingest** in the rail and pick the same domain
2. Drop in the same file again (or browse to it) and click **Ingest**
3. The Curator recognises it and stops before spending anything: *"**&lt;filename&gt;** has already been ingested into this domain."*
4. Click **Re-ingest & update wiki** to proceed, or **Cancel** to back out

The result panel will show which pages were "updated" vs "unchanged" — you can confirm at a glance that nothing was duplicated.

> There is no list of previously-ingested files in the app — re-ingesting means handing The Curator the file again. The original files live in `domains/<domain>/raw/` on the machine you ingested them on, if you need to find one.

> In a **batch**, the same check happens at the confirm screen instead: already-ingested files are marked **Skipped** before anything is uploaded, and the **Overwrite existing pages for files already ingested** checkbox re-includes them.

**To re-ingest every source in a domain** (after a Curator update with significant ingest improvements, for example):

```bash
node scripts/bulk-reingest.js <domain>
# e.g.: node scripts/bulk-reingest.js articles
```

There's a 3-second pause between files by default to avoid rate-limit hits on the free tier. Add `--delay=5000` for slower pacing.

---

## 9. Chat with your brain

After ingesting a few sources, you can have a full multi-turn conversation with your knowledge base. The AI answers from your wiki pages only, cites its sources, and remembers the entire thread — even after you restart the server.

> **Chat retrieval (v3.0.1-beta.13)** — the chat now uses three layered techniques to find the right pages for your question:
> 1. **Entity pivot** — if your question mentions an entity that exists in your wiki (a person, tool, company, etc.), chat automatically loads that entity's page AND every summary it backlinks to. So "list articles by Dr. Tali Rezun" loads her entity page plus all 50+ summaries that reference her, not just the few summaries with "tali" or "rezun" in the filename.
> 2. **Author-aware catalogue** — every summary in your domain shows up in the catalogue with a "referenced by: X, Y, Z" suffix listing which entities link to it. The chat can enumerate "everything by X" from this catalogue alone.
> 3. **Intent detection (v3.0.8)** — the chat reads what you're actually asking and shapes the answer to match: a **decision** question ("which of these should I write — recommend one") gets a direct recommendation up front; a **list** question ("list all…", "how many…") gets a focused, de-duplicated list; everything else gets a synthesised answer. It classifies your *question* (not text you paste in), so a word like "everything" buried in pasted notes no longer turns a recommendation request into a full-domain dump.
>
> **This is what makes chat work on large mature domains** (3,000+ pages, multi-megabyte wikis). Earlier versions hard-truncated wiki content at 90 KB and dropped 98% of pages on large domains; beta.11 added keyword scoring; beta.13 added entity-pivot + author metadata + intent detection.

### Best practices for asking the chat questions

- **Mention specific entities** when you want comprehensive coverage: *"What articles do I have by Dr. Tali Rezun?"* triggers entity pivot. *"What articles do I have?"* doesn't.
- **Be explicit about enumeration** when you want a complete list: *"list all"*, *"how many"*, *"name every"* trigger the enumeration prompt. *"summarize"*, *"explain"*, *"tell me about"* trigger the synthesis prompt.
- **Specific is better than vague**: *"What does my wiki say about HNSW vs IVF?"* finds the right pages. *"Tell me about vector search"* is much broader and may hit the catalogue fallback.
- **For comprehensive author/topic queries, the My Curator MCP via Claude Desktop is even more thorough** — its `get_backlinks` tool gives the canonical, complete list. The in-app chat is best for content questions; MCP is best for graph-traversal queries.

### The composer — Length and Model selectors

The message box has its controls tucked along its own bottom edge, to the left of the **Send** button:

- **Length** (always shown) — Concise · Balanced · Detailed, described below.
- **Model** (shown only if you've configured **both** a Gemini and an Anthropic key) — pick **Gemini** or **Anthropic** for this chat. This lets you compare how each model answers the same question, without changing your active provider in Settings. If you have just one key, there's nothing to choose and the selector is hidden. The model version shown under each option (e.g. `gemini-2.5-flash-lite`) is whatever The Curator currently uses for that provider — you don't pick specific model versions; that's set globally, and the label updates automatically when The Curator moves to a newer model.
- A **paperclip** button sits to the left of both. It is **disabled** — ingesting from chat isn't connected yet. Use **Ingest** in the rail.
- To the right, a small note reads *"cost varies with response length"*.

Both dropdowns open **upward**. Both choices are remembered in your browser between questions.

### Answer length — Concise · Balanced · Detailed

The **Length** selector controls how much detail you get back. It's independent of the question type above — it changes *how much* the AI writes, not *what shape* the answer takes.

| Setting | What you get | Good for |
|---|---|---|
| **Concise** | A short, direct answer — 1–3 tight paragraphs (or a short list), leading with the point, with the 2–3 most important sources. | Quick lookups, a fast recommendation, checking a fact. |
| **Balanced** (default) | A well-rounded answer — the normal experience. | Most questions. |
| **Detailed** | A thorough answer — more depth and more supporting sources where they genuinely add value. | Research, briefing yourself before writing, exploring a topic in full. |

Your choice sticks between questions and across restarts (it's remembered in your browser). The three settings are reliably ordered — **Concise** is the shortest, **Detailed** the longest — and "Detailed" is more thorough but **never** dumps your whole domain (the same guardrails that keep answers focused apply at every length). Tip: start on **Balanced**; drop to **Concise** when you just want the answer, switch to **Detailed** when you're going deep on a topic.

Answers render with proper formatting — headings, **bold**, bullet lists, and code are shown styled rather than as raw Markdown, and citations appear as tidy `[source: …]` chips.

The chat adapts its answer shape to your question: a **decision** question ("which of these should I write — recommend one") gets a direct recommendation up front with a few supporting citations; a **list** question ("list all articles by X", "how many sources do I have?") gets a focused, de-duplicated list; everything else gets a synthesised answer. You don't need to do anything to trigger this — just phrase the question naturally. If you ever want the exhaustive list behind a focused answer, ask a follow-up like "now list every related page".

> **If an answer ends with "⚠ This answer was cut off…"** — the AI reached the per-reply length limit on a very long answer. The chat now shows you the partial answer (still useful) with a note, instead of failing. Ask a more specific or narrower follow-up (e.g. focus on one of the options, or one section) to get the rest. This is expected behaviour on unusually broad questions, not a bug or a provider outage.

### The chat interface

Chat is the app's default view — it's what you land on. It has three parts:

- **The panel beside the rail** — a **New chat** button, a **Search conversations…** box, and this domain's conversation history grouped into **TODAY** and **EARLIER**. Click any conversation to reopen it. Hover one and a **trash** button appears to delete it.
- **A SCOPE bar across the top of the thread** — one pill per domain. **Chat talks to exactly one domain at a time**; click a pill to switch. On the right of that bar you'll see how much is in scope, e.g. *"3,336 pages in scope"* — and, once a conversation has a question in it, the **Compile to Wiki** button.
- **The thread and the composer** below it.

Under the composer, a line reminds you: *"Answers cite the pages they came from. Click a citation to read the page."*

> Conversations belong to a domain. Switching the SCOPE pill switches which set of conversations the sidebar lists.

### Starting a conversation

1. Click **Chat** in the rail
2. Pick a domain from the **SCOPE** pills above the thread
3. Click **New chat** (or just start typing — a new conversation is created automatically)
4. Type your question in the box at the bottom
5. Press **Send** or use `Cmd + Enter` (Mac) / `Ctrl + Enter` (Windows)
6. Wait for the reply — usually 10–30 seconds

> **No domains yet?** Chat says so and offers a **Go to Domains** button. Chat has no create-domain form of its own — there is exactly one place domains are created, and it's [§10](#10-manage-your-domains).
>
> **A shortcut worth knowing:** in **Domains**, the **Ask this domain** button on a domain's page drops you into Chat already scoped to it.

### What a good reply looks like

```
Retrieval-Augmented Generation (RAG) combines a retrieval step with
generation, so the model grounds its answer in real documents rather
than relying on memory alone [source: concepts/rag.md].

The key advantage over fine-tuning is that you can update the knowledge
base without retraining the model [source: summaries/rag-paper.md].
```

The `[source: ...]` tags tell you exactly which wiki page each claim came from. Click a citation to open that page in the reader overlay ([§11](#11-read-a-wiki-page)), or open it in Obsidian to read the full source.

### Multi-turn memory

You can keep asking follow-up questions and the AI remembers the entire conversation:

```
You:  What is RAG?
AI:   RAG stands for… [source: concepts/rag.md]

You:  How does it compare to fine-tuning?
AI:   As I mentioned, RAG updates knowledge without retraining…
      [source: summaries/rag-paper.md]

You:  Who are the key researchers in this area?
AI:   Based on your notes, the main contributors are…
```

Conversations are saved automatically and persist across server restarts. You can have as many conversations per domain as you like.

### Managing conversations

- **Revisit** — click any conversation in the panel beside the rail to reopen it in full
- **Find one** — type in the **Search conversations…** box; it filters by title as you type
- **Delete** — hover a conversation and click the trash button that appears

### Good questions to ask

- "What is [concept] and why does it matter?"
- "What are the key differences between [X] and [Y]?"
- "How does [idea from one source] connect to [idea from another source]?"
- "Who are the main people mentioned in my notes on [topic]?"
- "What tools are recommended for [task]?"
- "Summarise everything I know about [topic]"
- "What have I learned about this topic over time?"

> The AI only answers from your wiki. If you haven't ingested any sources about a topic, it will say so honestly rather than making things up.

### Compiling a conversation to your wiki (v2.5.0)

A chat is a great place to think out loud, but the conversation itself is not part of your wiki — it lives in the chat history. **Compile to Wiki** turns any conversation into permanent wiki pages. Use it after a focused brainstorm, a research thread, or a working session whose conclusions you want to keep.

**How it works**

1. Have a conversation in **Chat**. The **Compile to Wiki** button appears on the right of the **SCOPE** bar above the thread as soon as you've asked one question — so even a single sharp question worth keeping can be compiled (v3.0.1-beta.15; previously it needed two messages).
2. Click **Compile to Wiki**. A progress bar shows what's happening — loading the conversation, asking the AI to extract durable knowledge, writing pages, syncing entity backlinks, updating the index.
3. After 15–45 seconds a **result card appears inline in the conversation**, right below the last message: how many pages were **created** (✨) and how many were **updated** (✏️), with byte sizes and per-section bullet deltas. Unchanged pages are hidden by default — click *"Show unchanged"* if you want to see them. The card is part of the thread, so it scrolls with the conversation and you can keep chatting underneath it at full size (before v3.0.14 the result opened in a fixed panel above the input box that permanently squeezed the chat area — that's fixed). The card scrolls into view at its top, so the title and the ✨/✏️ counts are always what you see first. Compile again and you get a second card; the cards clear when you switch conversations or start a new chat. If you switch conversations *while* a compile is running, the pages are still written — you just won't see the card, since it belongs to the other conversation.

**What gets written**

- **One summary page** under `summaries/` capturing what was learned. Filename is `<conversation-title>-<YYYY-MM-DD>-<short-hash>.md` — the hash makes the slug deterministic, so re-compiling the same conversation never creates a duplicate file.
- **Entity and concept pages** for any people, tools, or ideas central to the discussion — created if new, merged if they already exist in the wiki.
- **Cross-links** between everything: every entity mentioned in the summary gets a backlink to it; the summary references all the entities and concepts.
- An entry in the wiki's `log.md` recording the compile.

The same merge pipeline that handles ingest runs here too: typo-variant slugs are normalised, duplicates are caught, folder-prefix link errors are stripped, summary backlinks are injected automatically.

**Compiling the same conversation twice**

The Curator refuses re-compiles when nothing has changed:

> *Already compiled to summaries/X.md. Send another message in this conversation to extend it, or delete that file in your wiki to start over.*

That message is a **normal outcome, not an error** — on a short conversation it's the most common thing you'll see the first time you try Compile, and nothing went wrong.

This is intentional — a second LLM run on identical input produces slightly different bullet phrasings, and the merge pipeline would silently inflate every related page's section bullets across dozens of files. If you want to add to the compiled summary, send another message in the conversation and click Compile again. The new turn changes the conversation hash → new slug → no collision → a fresh summary file is created alongside the old one.

**Compiling a very large conversation (v3.0.1-beta.27)**

Most compiles finish in one pass. If a conversation is unusually long or dense, the AI can run out of room to write all the pages at once. The Curator now handles this automatically instead of failing:

1. It retries with a **more concise extraction** (fewer, broader pages). If that works, you'll see a small note at the top of the result card: *"compiled with a more concise extraction."*
2. If it's still too large, it falls back to saving **just the summary page** — the conversation is still captured, but the individual entity/concept pages aren't created this time. The note will say so.
3. Only if even the summary can't fit does it stop, with a clear message: *"This conversation is too large or complex to compile… compile a shorter conversation, or split this discussion into separate conversations by topic."*

If you hit step 3, the fix is to compile a shorter thread (or break a sprawling chat into focused ones and compile each). This is an AI output-size limit, not a problem with The Curator or your data.

**Good use cases**

- **Brainstorming sessions** — explore an idea with the AI, then commit the conclusions to the wiki when you're done.
- **Research threads** — ask "what does my wiki say about X, and how does it connect to Y?", then compile the synthesis.
- **Meeting / dictation notes** — paste meeting notes or speak through a tool that types into the chat, then compile to a structured wiki entry.
- **Decision records** — talk through a decision with the AI ("should we use approach A or B?"), then save the reasoning permanently.

**Tips**

- Give the conversation a focused topic before compiling. A wide-ranging chat compiles into a noisy summary.
- Re-read the summary page after compile (**Domains → Browse pages**) — you can edit it directly in any text editor or in Obsidian if you want to refine it.
- The conversation itself stays in the Chat sidebar after compile — compile doesn't delete it.

---

## 10. Manage your domains

A domain is a focused knowledge silo — a dedicated wiki for one topic area. Each domain gets its own AI schema, wiki pages, chat conversations, and Obsidian graph cluster.

**Domains is the hub of the app.** Everything that is *about one wiki* lives here: what's in it, how healthy it is, what pages it contains, and the create / rename / delete controls.

### The Domains view

Click **Domains** in the rail. The panel beside the rail lists every domain under a **KNOWLEDGE** heading, one row each, showing the domain's name and its page count. Two markers can appear on a row:

- **RO** — this is a read-only Shared Brain mirror
- a small dot on the right — this domain has open health issues

Above the list is **New domain**. Click any row to open that domain in the main column.

### What a domain's page shows you

- Its folder path, in monospace: `domains/articles/`
- Its display name, and — if it's a mirror — a **read-only mirror** pill
- A one-line scope sentence: *"A compounding wiki of 3,336 pages — 600 entities, 2,651 concepts, 83 summaries."* (a fourth "other pages" count is added only if any page sits outside those three folders)
- **Rename** · **Delete** · **Ask this domain** — the last of which jumps to Chat, already scoped here
- **Stat cards**: PAGES · ENTITIES · CONCEPTS · SUMMARIES (plus OTHER when non-zero)
- The **Wiki health** panel — see [§17](#17-wiki-health)
- **PAGES** — a **Browse pages** button that opens the full page list, see [§11](#11-read-a-wiki-page)

### Creating, renaming, deleting

- **New domain** — give it a **Name**, an optional **Description**, and pick a **Template**: **Generic** (a balanced starting schema, the good default) · **Tech** · **Business** · **Personal**. The template writes the domain's starting schema, which tells the AI how to categorise what you ingest — you can edit it later. Nothing is written until you click **Create domain**.
- **Rename** — changes the display name immediately. The folder name is chosen by the server and only changes if your new name produces a different one; wiki pages, conversations, and Obsidian links are preserved either way. A **read-only Shared Brain mirror cannot be renamed** — its folder name is what marks it as a mirror — and the app says so instead of letting you try.
- **Delete** — the confirmation names the folder and the exact page count: *"This permanently removes `domains/articles/` and all 3,336 pages in it, including its raw sources and saved conversations. It cannot be undone from inside The Curator."* The button is **Delete permanently**.

If one of these is refused because something else is writing to that domain right now (an ingest, a sync, an MCP write), you get a clearly-marked **"Not done — the server refused this."** message in the same card — not a silent failure. Wait for the other operation to finish and try again.

Changes are reflected everywhere in the app and in Obsidian instantly — no restart needed. If sync is configured, run **Sync now** soon after a rename or delete so your other computers stay consistent.

> 📖 **Going deeper?** The full reference — schema anatomy, manual setup, custom templates for History / Health / Legal / etc., and (importantly) **how domains relate to each other** (siloed by default, accidental Obsidian edges, the four-level model) — lives in **[docs/domains.md](domains.md)**.

---

## 11. Read a wiki page

Reading a page is not a place you navigate to — it's an **overlay** that opens over whatever you were doing, and closes again. There are two ways in.

**From a chat answer.** Click any `[source: …]` citation. The page the answer drew from opens immediately, so you can check the claim without losing the conversation underneath.

**From a domain's page list.** Open **Domains**, pick a domain, scroll to **PAGES**, click **Browse pages**. You get:

- a **Filter by name…** box that narrows the list as you type
- tabs — **All · Entities · Concepts · Summaries** — each with its own count
- one row per page, colour-dotted by type, with its full path in monospace

Click a row to open it. Very large lists render the first 150 matches with a note telling you to narrow the filter to see the rest.

### Inside the reader

The overlay shows the page's path across the top, its title, a coloured type badge (`entity` / `concept` / `summary`) and any tags, then the page body **rendered as proper Markdown** — headings, bold, lists and code appear styled, not as raw `##` and `**` source. Below the body is a **BACKLINKS** list of every page that links to this one; **click a backlink row and the reader loads that page**, so you can walk the graph without leaving the overlay.

**To close it:** press **Esc**, click the dimmed area outside it, or click the **✕**. It also closes on its own the moment you click anything in the rail — an overlay never survives a change of view.

> `[[wikilinks]]` inside the page body are highlighted but **not clickable** in the reader today. Use the backlinks list, or open Obsidian, to follow links forward.

For a much richer experience — including the interactive knowledge graph — use Obsidian (see the next section).

### Finding the original document behind a summary

Every summary page is a lossy rendering — the AI kept what it judged important and left the rest behind. The Curator records where each summary came from, and there are two ways to get back to that original.

**From Claude, via the MCP bridge.** Say *"check the actual source for that figure"* and Claude calls `get_raw_source` to pull the extracted text of the original file. This works today and is the better route — see [§13 Option C](#option-c--my-curator-mcp-frontier-model-research-plus-writes-from-v252).

**In the app — currently only in the previous interface at `/old`.** Open `/old` → the **Wiki** tab → a summary page, and a small bar appears above the content showing the original filename, its size, and a **Reveal in Finder** button that opens your file browser with the file selected. The new reader overlay does not have this bar yet; it is a known gap, not a removed feature.

**Seeing "the original file isn't on this machine" is normal, not a problem.** Raw source files (the PDFs, `.txt`, and `.md` files you originally dropped in) are deliberately never synced — only your wiki pages are. So on any machine other than the one you ingested a document on — including right after a Personal Sync pull, or on a Shared Brain mirror — this is the expected state, not a sign anything is broken or lost: your wiki page and everything it says are completely unaffected. The Curator still tells you what it knows — the filename, size, and when it was ingested — so you can go find the file again if you need it, even though it can't open it from here.

A few other things you might see instead of the file:

- **"Built from a web page, not a local file"** — some summaries came from a web article rather than an uploaded document; the source is shown as plain text (never a clickable link — The Curator never fetches or previews it).
- **"The recorded source can't be opened"** — rare. Covers a couple of edge cases (the recorded filename isn't a real file anymore, or points somewhere The Curator won't follow) where there's nothing useful to open.
- **Nothing at all** — most summaries you compiled from a chat conversation, or ingested before this feature existed, simply don't record a source and show no bar. That's expected too.

---

## 12. See your knowledge graph in Obsidian

Obsidian is a free note-taking app that reads the exact same markdown files that The Curator writes. It gives you an interactive, visual knowledge graph — like the one shown in the concept video.

The Curator is purpose-built to act as the *engine* for Obsidian's visual interface. Obsidian is the IDE; the AI is the programmer; the wiki is the codebase. The Curator handles Atomic Decomposition — breaking sources into Entities, Concepts, and Summaries — so Obsidian can visualize the resulting neural network.

### First-time setup

1. Download and install **Obsidian** from [obsidian.md](https://obsidian.md) (it's free)
2. Open Obsidian
3. On the welcome screen, click **Open folder as vault**
4. Navigate to your `the-curator` folder on your computer, then go inside the `domains` folder
5. Select `domains` and click **Open**

Obsidian will scan all the markdown files and build an index instantly.

### Opening the knowledge graph

In Obsidian's left sidebar, click the **graph icon** (it looks like a network of dots). This opens the Graph View — an interactive, zoomable map of all your wiki pages and how they connect.

- **Each dot** is a wiki page (summary, concept, or entity)
- **Each line** is a `[[link]]` between pages
- **Bigger dots** are pages with more connections
- **Click any dot** to open that page
- **Scroll to zoom** in and out
- **Drag to pan** around the graph

The more documents you ingest, the richer the graph becomes.

### Activate graph colors (one-time setup)

Every wiki page now contains a **type tag** in its metadata (`type/entity`, `type/concept`, `type/summary`). You can tell Obsidian to use these tags to automatically color-code every node in the graph.

**You only need to do this once.** After that, every future ingest automatically colors new nodes — no manual work.

1. Open Obsidian and go to the Graph View (graph icon in the left sidebar)
2. Click the **gear icon** (⚙) at the top-right of the Graph View panel
3. Find the **Groups** section and click **New Group** three times

Set up each group exactly like this:

| Group | Query | Suggested color |
|-------|-------|----------------|
| Entities | `tag:#type/entity` | Blue |
| Concepts | `tag:#type/concept` | Green |
| Summaries | `tag:#type/summary` | Purple or Red |

4. Click the color circle next to each group and choose your color

**Result:** Entities (people, tools, companies) appear blue; concepts (ideas, techniques) appear green; summaries (source documents) appear purple/red. Your neural network is now visually segmented — you can instantly see at a glance whether a cluster contains mostly ideas or mostly sources.

**Pro tip — node size:** In the same Graph View gear panel, find **Node size** → set it to **Linked mentions**. Pages with more connections grow larger, making your most-connected concepts and entities visually prominent.

### Using the Properties panel

Each wiki page now has structured metadata (called "Properties") at the top — you can see it in Obsidian's right panel when a page is open. It shows the page type, all tags, and the date it was created. You can filter and query this data using the free **Dataview** plugin:

1. In Obsidian, open **Settings → Community plugins → Browse**
2. Search for **Dataview** and install it
3. Create a new note and paste this to see all entities in your AI/Tech domain:

```dataview
TABLE tags, created FROM "ai-tech/wiki/entities"
WHERE type = "entity"
SORT created DESC
```

### How Obsidian and the app work together

They share the same files — there is nothing to sync or export.

```
The Curator app          Obsidian
(localhost:3333)          (desktop app)
       │                       │
       │   Both read/write     │
       └──► domains/ folder ◄──┘
```

**The intended workflow:**

1. Use **The Curator app** to ingest documents and ask questions
2. Open **Obsidian** to visually explore the knowledge graph, browse pages, and manually add your own notes

You can have both open at the same time. When you ingest something in the app, switch to Obsidian and press `Ctrl/Cmd + R` to refresh — the new pages appear instantly.

### What about my existing wiki files?

If you already had wiki pages before this update, those older files do not yet have the structured metadata (YAML frontmatter) needed for graph coloring and Dataview queries. They will appear as uncolored nodes in the graph.

**To update existing pages, simply re-ingest the same source file:**

1. Open **Ingest** in the rail
2. Drop the same original document in again (PDF, txt, etc.)
3. The app detects it has been ingested before, asks, and — on **Re-ingest & update wiki** — *updates* the existing wiki pages rather than duplicating them

Re-ingesting is safe — it merges new information with what already exists. Pages that get updated will gain the YAML metadata and immediately appear colored in Obsidian.

> **Tip:** If you have many existing files and don't want to re-ingest them manually, you can skip this step. The old pages still appear in the graph as uncolored nodes, and all new ingests going forward will be colored automatically.

### Useful Obsidian features

| Feature | How to access | What it does |
|---------|--------------|--------------|
| Graph view | Graph icon in left sidebar | Interactive knowledge map |
| Quick switcher | `Cmd/Ctrl + O` | Jump to any page by name |
| Search | `Cmd/Ctrl + Shift + F` | Search across all pages |
| Backlinks | Right panel when a page is open | See which pages link to the current page |
| Local graph | Three-dot menu on any open page | Graph of just that page's connections |
| Properties | Right panel → Properties | Structured metadata for the current page |

### The Local Graph test

A healthy knowledge network passes this test: open any **concept** page, set the local graph depth to 2. You should see the concept connected to multiple summaries *and* multiple entities. If a concept connects to only one or two things, you need to ingest more sources that reference it.

**The Orphan check:** In Obsidian's Graph View, zoom out and look for dots floating alone with no connections. Every page should have at least one `[[link]]`. Your goal is zero orphans — The Curator actively cross-references all pages during ingest.

---

## 13. Three ways to talk to your knowledge (Chat · Obsidian · MCP)

Once you have ingested several documents, you have **three complementary** access paths into the same `domains/` folder. They don't compete — each is best at a different kind of question.

### Option A — Built-in AI chat

Use **Chat** in the rail when you want to:

- Ask a specific question and get a synthesised, cited answer
- Have a back-and-forth conversation to dig into a topic
- Connect dots across multiple sources ("how does X relate to Y?")
- Pick up a thread you started in a previous session

The AI reads your wiki on every message, reasons across all of it, and saves the conversation. Powered by your configured low-cost provider (Gemini Flash Lite or Claude Haiku) — perfect for fast everyday Q&A.

### Option B — Obsidian graph

Use **Obsidian** when you want to:

- See the big picture — all your knowledge on a visual map
- Spot unexpected clusters and connections spatially
- Browse and edit individual wiki pages by hand
- Explore "what is connected to this page?" using the local graph

### Option C — My Curator MCP (frontier-model research, plus writes from v2.5.2+)

Use **My Curator** when you want a frontier model — Claude Opus, Sonnet, or any MCP-compatible AI client — to **research** your wiki AND, since v2.5.2, **save findings back into it** without leaving the conversation.

You install a tiny local MCP bridge (one-time, under 2 minutes from **Settings → MCP bridge**), and from then on Claude Desktop (or VS Code with an MCP-aware coding agent, or LM Studio with a local model) can:

- **Research as a graph** — topology overviews, bidirectional link tracing, tag-driven clusters, cross-domain search. There are **18 tools in total: 14 that read your wiki and 4 that write to it.**
- **Read the original document, not just the summary** — say *"check the actual source for that figure"* and Claude calls `get_raw_source` to pull the extracted text of the original file a summary was built from (never the raw bytes — PDFs are text-extracted first). If the file isn't on this machine (raw sources aren't synced), Claude is told the filename and when it was ingested instead.
- **Write to your wiki** (v2.5.2+) — say *"save what we discussed to my second brain"* and Claude calls `compile_to_wiki` to commit the conversation as a summary page plus any new entity/concept pages. Same merge pipeline as the in-app Compile button.
- **Heal your wiki** (v2.5.2+) — say *"check my wiki for problems"* and Claude scans, auto-fixes the safe ones, asks before destructive merges, and respects your persistent dismissals.

Everything stays local — the MCP server only sees your wiki folder, and writes go through the same safety pipeline (path-traversal guards, hard caps, idempotency, audit log) the app uses.

**Two setup-wizard improvements in v3.6.1:**

- **If your `claude_desktop_config.json` has a JSON syntax error, the wizard now stops instead of offering to overwrite it.** Previously the "your file after" preview showed a config containing *only* My Curator — so a user with three other MCP servers and one stray comma was shown a merged preview that, if pasted, would have deleted them. The wizard now says the file can't be read, tells you to fix the syntax error first, and still gives you the entry-only snippet to add by hand.
- **The Self-test now launches the bridge exactly the way your pasted config does** — including the `--domains-path` argument, which it previously omitted. That argument is the one thing the config uniquely contributes, so it was also the one thing the test never checked: a wrongly-configured knowledge folder still passed, and the wizard then pointed you at your config file. The result is also more honest about what it found — an empty knowledge folder and a *missing* one used to look identical ("no domains yet"); they are now reported separately, so a broken path says so.

> 📖 **Full setup guide:** [docs/mcp-user-guide.md](mcp-user-guide.md) — wizard-style 2-minute install, prompt patterns, write-tool walkthroughs with sample dialogues, troubleshooting.
>
> 💡 **Pro tip:** install the [My Curator Claude skill](mcp-user-guide.md#the-my-curator-claude-skill--best-results-out-of-the-box-v257) for one-click best practices. It's a small markdown file you drop into Claude Code's `~/.claude/skills/` (or a Claude Desktop project's knowledge files); after install, every conversation that uses the my-curator MCP automatically grounds wikilinks, refuses speculative writes on fresh domains, and applies the three-tier Health model. Eliminates the need to type detailed prompt instructions every time.

### How the three combine

```
                 The Curator app
             (Chat view — Gemini/Haiku)
                       │
                       │       Claude Desktop / VS Code / LM Studio
                       │       (Frontier model — Opus, Sonnet, local)
                       │              │
                       │              │ via My Curator MCP (read+write)
                       ▼              ▼
              domains/ folder ◄──────────────┐
                       │                     │
          Markdown files on disk             │
                                             │
                 Obsidian   ─────────────────┘
              (desktop app — visual graph)
```

All three read the same `domains/` folder. Nothing to sync between them. The intended daily flow:

1. Feed the app new documents (**Ingest** in the rail)
2. Quick lookups → built-in **Chat**
3. Visual exploration → **Obsidian**
4. Deep research / synthesis across years of notes → frontier model via **My Curator MCP**

---

## 14. Daily workflow

Here is the recommended way to use The Curator day-to-day:

### When you find something worth keeping

1. Save the article/chapter/notes as a `.txt` or `.pdf` file
2. Open The Curator (click the Dock icon, or go to `http://localhost:3333`)
3. Open **Ingest**, choose the right domain, drop the file in, click **Ingest**
4. In Obsidian, press `Cmd/Ctrl + R` to see the new pages appear in the graph

### When you want to recall something

1. Open The Curator
2. Open **Chat**, pick the domain from the **SCOPE** pills, and ask your question (or continue an old conversation)
3. Get a cited answer pointing to specific wiki pages
4. Click a citation to read that page in the overlay, or open it in Obsidian for the full graph context

### When you want to explore connections

1. Open Obsidian
2. Open the Graph view
3. Click on a topic you're curious about
4. Explore what it connects to

---

## 15. Sync across computers

**Sync** — the ↻ icon in the **rail footer**, bottom left — keeps your wiki and chat history in sync across all your computers using a free, private GitHub repository. No subscription, no third-party service. Your notes never touch any server you don't control.

> 📖 **For the full sync deep-dive** (every wizard step, token permissions, conflict recovery, troubleshooting, token expiry strategy), see **[docs/sync.md](sync.md)**. The summary below is enough for most users.
>
> 🤖 **Prefer to let an AI agent do it?** If you use Claude Code, Cursor, opencode, Aider, or another coding agent, paste one prompt and it sets up sync end-to-end — see **[docs/sync-via-coding-agent.md](sync-via-coding-agent.md)**.

### What gets synced

| Gets synced | Stays local only |
|-------------|-----------------|
| ✓ All wiki pages | ✗ Original source files (PDFs, etc.) |
| ✓ Chat conversations | ✗ Your Gemini/Claude API key |
| ✓ Domain schemas | ✗ App code |

### First-time setup (~3 minutes)

You only do this once. After that, syncing is two button clicks.

#### Step 1 — Create a private GitHub repository

1. Go to **[github.com/new](https://github.com/new)** (create a free account if you don't have one)
2. Name the repository anything — e.g. `my-brain`
3. Make sure **Private** is selected
4. **Leave the repo empty** — do **NOT** tick "Add a README", ".gitignore", or "license". The Curator fills the repo on the first sync; a pre-filled repo makes the first push fail.
5. Click **Create repository**
6. Copy the URL from your browser (e.g. `https://github.com/your-username/my-brain`)

#### Step 2 — Create a Personal Access Token

This is how The Curator gets permission to read and write your private repository. GitHub offers two token types — **either works**; fine-grained is more secure (scoped to one repo), classic is lower-maintenance (can never expire). Full comparison in [docs/sync.md](sync.md#step-4--create-and-enter-a-personal-access-token-wizard-step-2).

**Fine-grained token (recommended):**

1. Go to **[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)** (you may need to sign in)
2. Name it anything — e.g. `the-curator-sync` — and pick an **Expiration** (up to 1 year)
3. **Repository access** → **Only select repositories** → pick the repo you created in Step 1
4. **Permissions** → **Repository permissions** → set **Contents** to **Read and write** (this is the critical one; Metadata: Read-only is added automatically)
5. Scroll down → **Generate token** → **copy it immediately**. It starts with `github_pat_`

**Or a classic token (can be set to never expire):**

1. Go to **[github.com/settings/tokens/new](https://github.com/settings/tokens/new?scopes=repo&description=the-curator)**
2. Name it, set **Expiration** to "No expiration", tick the top-level **`repo`** scope
3. **Generate token** → **copy it immediately**. It starts with `ghp_`

#### Step 3 — Connect in the app

1. Click **Sync** in the rail footer
2. You'll see a **Connect a GitHub repository** card with three fields, all on one screen:
   - **Repository URL** — paste the URL from Step 1
   - **Personal access token** — paste the token from Step 2
   - **Starting direction** — **Push my wiki** (this machine has the knowledge; send it up) or **Pull an existing wiki** (you've already synced elsewhere; bring it down)
3. Click **Connect**

The Curator connects to GitHub, creates the initial snapshot, and confirms when done. It takes about 30 seconds once your details are entered.

### Daily workflow

**Golden rule (v2.6.0+):** click **Sync now** at the start and end of each work session. It pulls anything new from GitHub, then pushes anything new from this machine — both directions, one button. You don't have to remember which computer is "ahead".

```
Computer A (just worked here)
   ↓ click Sync now  (pulls remote first, then pushes local)
GitHub
   ↑ click Sync now  (pulls remote first, then pushes local)
Computer B (about to start here)
```

**The primary button:**

| Button | What happens |
|--------|-------------|
| **↻ Sync now** | Pulls remote changes from GitHub, then pushes your local changes. Safest for everyday use — handles both directions automatically. |

After **Sync now**, domain stats and page lists update automatically. Open **Chat** to see newly arrived conversations.

**One-way operations.** Next to **Sync now** sit **Push only** and **Pull only**. Use these only when you know exactly what you need: *Push only* uploads your local changes without pulling first; *Pull only* downloads remote changes without pushing yours. For everyday use, prefer **Sync now**.

**How to tell whether you have anything to push.** The Sync view shows a **Connected** pill, your repository URL, when you last synced, and — beside the buttons — a plain count: *"7 local changes not pushed"*. That count is the signal to look at.

> There is no badge on the Sync rail icon in the redesigned interface. If you want a pending count, open Sync and read it there.

**If a button is greyed out**, something else is writing to your wiki right now — an ingest, a Health fix, a Shared Brain push. Hover it and it tells you what. Wait for that to finish; the buttons re-enable on their own. This is deliberate: a sync mid-write would commit a half-written wiki.

### Setting up a second (or third) computer

On any additional computer:

1. Install the app (run the one-command installer, or `git clone` + `npm install`)
2. Open the app and add your API key (see [§5](#5-first-run--the-getting-started-panel))
3. Click **Sync** in the rail footer
4. Enter the **same repository URL** and the **same token** as before
5. Set **Starting direction** to **Pull an existing wiki**
6. Click **Connect**

The Curator downloads all your wiki pages and conversations from GitHub. Done — you don't need to create a domain first; they arrive with the pull.

### What happens if you forget to sync

If you worked on Computer A without syncing, then worked on Computer B without syncing first, the app handles it gracefully:

- **Sync now** on either machine commits your local changes, merges the remote version in, then pushes — so the two machines reconcile in one click
- In most cases this resolves itself cleanly, because the two machines touched different parts of the wiki
- ⚠️ **If the same part of the same page was edited on both machines**, the merge does **not** stop to ask you: it silently keeps the **GitHub (remote)** version for the conflicting section and drops the local one from the file, while still reporting success. Your pre-merge local version is committed to local git history first, so it is recoverable — see [sync.md → What if you forget to sync?](sync.md#what-if-you-forget-to-sync) for the exact recovery commands and the full explanation. The reliable habit is to **Sync now at the start *and* end of every session.**

### Disconnecting

If you want to remove the sync connection from one computer (without affecting GitHub or other computers):

1. Open **Sync** in the rail footer
2. Scroll to the bottom and click **Disconnect this repository**
3. Confirm — the panel spells it out: *"Your local wiki files stay exactly as they are — only the sync connection is removed. You can reconnect any time."*

Your GitHub repository is not changed. You can reconnect at any time.

> The Sync view also has a **History** area which currently says commit history and revert are coming soon. Every sync already *is* a real git commit, so nothing is missing from your data — there just isn't a screen for browsing or reverting individual commits yet. A git client pointed at your knowledge base folder can do it today.

---

## 15b. Shared Brain

**Collective wikis with a cohort or team.** Opt-in beta. **Shared Brain** is a separate feature from Personal Sync (above). Personal Sync backs up YOUR full wiki to YOUR private repo. Shared Brain lets a **group of people** contribute to a **shared wiki** without merging private data.

### How it differs from Personal Sync at a glance

| | Personal Sync | Shared Brain |
|---|---|---|
| People | 1 (just you) | Many (cohort, team) |
| What's synced | Your full wiki | Only opted-in domains |
| Repo | Your private repo | Cohort's shared private repo |
| Direction | Bidirectional | Push (contribute) + Pull (mirror) |
| Visible in your Curator | Pages are your personal wiki | New `shared-<slug>/` domain (read-only mirror) |

### When you'd want it

- **Educational cohorts** — 20 students each running their own Curator, each contributing a `work-ai` domain. The collective grows with everyone's reading; each student keeps their personal notes private.
- **Research teams** — small group with a shared `research` domain that compounds everyone's literature reviews.
- **Enterprise knowledge management** — employees with private notes plus one opted-in `work` domain feeding the company brain.

Solo users don't need this — Personal Sync handles single-user backup. Shared Brain is for **groups**.

### The two-primitives security model (read this before you start)

Two completely different concepts that beginners often confuse. Get this right and the rest is easy:

| | Invite token (`sbi_…`) | Personal Access Token (`github_pat_…`) |
|---|---|---|
| Created by | The admin, once at brain setup | **Each contributor, on their own** |
| Contains | Metadata only — repo, brain name, branch, folder slug | A GitHub credential — the contributor's identity |
| Shared with | Whole cohort (Slack, email — safe to share) | NOBODY |
| Grants access? | **No.** It's just a label. | Yes — this IS the GitHub auth |
| Per cohort | 1 (the admin generates and shares one) | N (one per contributor) |

**The admin NEVER shares their PAT** with anyone. **Each contributor creates their own** PAT and pastes it into their own Curator. The invite token is metadata-only and safe to share via Slack/email.

### Getting started

Shared Brain has its own place in the rail. Click **Shared Brain** (the people icon, third from the top). On a fresh install it says *"Shared Brain is off on this install"* — click **Enable Shared Brain (beta)**.

Turning it on connects you to nothing. It only unlocks the view; nothing leaves your machine until you configure a brain and push a domain to it. Once enabled you choose your path:

| Path | Take this if… |
|---|---|
| **I have an invite token → Join** | You received an invite token (`sbi_...`) from your cohort admin |
| **I'm starting a new Shared Brain → Set up** | You're starting one for your cohort, team, or research group |

> **v3.6.1 — invite tokens are GitHub-only, and a non-GitHub one is now refused at step 1.** Joining a Shared Brain works by accepting an invitation to a GitHub repository and creating a Personal Access Token, so only a GitHub-backed brain can issue an invite. A token describing any other storage backend is rejected on paste, with an explanation — previously it was accepted and you were walked all the way to the final step, **creating a real PAT on github.com along the way**, before saving failed with an internal message that read like the app was broken. (The non-GitHub backends still exist for cohort simulation; they are configured directly, not via an invite.)

Each brain you join or create then appears as a card **in the Shared Brain view**, with **Push contributions** and **Pull updates** buttons and at-a-glance state: how many pages are ready to push, when the collective was last synthesised, any pages skipped after repeated failures (with a one-click **Retry these pages on next push**), and a "read-only member" pill for Pull-only memberships (a PAT with Contents: Read only). An **Advanced** area on each card holds the admin tools — generate or rotate an admin token, run synthesis, revoke a contributor — and **Leave**.

> **Shared Brain pushes are managed here, not in Sync.** The Sync view shows a single line naming your Shared Brain and when you last pushed to it, with an **Open** button that brings you back to this view. It reports; it doesn't act. Keep the two straight: **Sync** backs up *your* wiki to *your* repo; **Shared Brain** contributes to a *cohort's* repo.

> A Shared Brain you join arrives in **Domains** as a `shared-<slug>` domain marked **RO** — read-only. You can read it and chat with it like any other domain; you cannot ingest into it, compile into it, or fix its health, because the next Pull would overwrite whatever you changed. Fix things in the personal domain you contribute *from*, then push.

### Where to go from here

The full setup walkthrough, daily workflow, troubleshooting, and admin operations live in dedicated guides — keep them open when you're working with Shared Brain:

| Doc | When to read it |
|---|---|
| 📖 **[Shared Brain User Guide](shared-brain-user-guide.md)** | Step-by-step setup for contributors AND admins. Daily push/pull workflow. Troubleshooting. **Start here.** |
| 🧠 **[Shared Brain Architecture](shared-brain.md)** | What it is conceptually, how it works internally, the engineering decisions, the v3.x roadmap (Cloudflare R2, GitHub App, EU residency). Read this if you want to understand the system, or to compare options. |
| 🔧 **[Shared Brain — Admin Operations](shared-brain-admin.md)** | Advanced admin reference: periodic synthesis cadence, contributor management, GDPR Article 17 revocation procedure, admin-token security. |
| ⚖️ **[Shared Brain — Compliance Reference](shared-brain-compliance.md)** | For organisations evaluating deployment: GDPR (PII inventory, right to erasure procedure), IP modes (contributor_retains vs organisational), EU data residency, self-assessment checklist. |

---

## 16. Settings

**Settings** is the gear icon at the **bottom of the rail**. It has its own list of sections in the panel beside it:

| Section | What's in it |
|---|---|
| **General** | Appearance (theme), System check, Show setup guide |
| **Providers & keys** | Gemini, Anthropic — save, set active, disconnect |
| **MCP bridge** | My Curator setup wizard, self-test, default write domain |
| **Health & scan limits** | Cost ceilings and candidate-pair caps for the AI health scans |
| **Knowledge base** | Where your `domains/` folder lives; your Obsidian vault folder |

At the bottom of that list you'll see the version — e.g. `The Curator v3.9.0` — next to an **Updates** button.

### API keys

**Settings → Providers & keys.** Each provider gets a row showing its model, its key (masked), and whether it is `active`, `configured`, or `not set`.

To add or change a key:

1. Click **Replace** on that provider's row
2. Paste the key into the field that appears
3. Click **Save**

Saving a key makes that provider active (*last-saved-wins*). Two more buttons appear on a row once it has a key:

- **Set active** — makes this the provider used for ingest, chat and health scans, without re-pasting anything. Shown only on a provider that has a key and isn't already active.
- **Disconnect** — removes that key entirely. Use it only when you want to drop a provider, not just deactivate it.

You'll also see rows for **OpenAI** and **Local model** marked *"not available in this build"*. They are placeholders; there is nothing to configure.

> Keys are stored in `.curator-config.json` on this machine, with permissions locked to `0600`. Never committed, never sent anywhere except the provider you call. If you also have keys in `.env`, the Settings values take priority.

### If a model gets retired underneath you

AI providers retire models. When the model The Curator normally uses disappears, the app doesn't break — it automatically falls back to the next model on a short list, and everything (ingest, chat, Health, sync) keeps working.

> **You will not currently be told in the redesigned interface.** The amber "Using fallback model" banner exists only in the previous interface at `/old` → Settings. The fallback itself works either way; the notice hasn't been ported yet. If a big ingest suddenly costs more than you expect, this is the first thing to check — open `/old` and look at Settings.

In `/old`, the banner names the model it switched to and usually carries a second line:

> 💰 This model costs more than your usual one — every ingest, compile and chat is billed at the higher rate until the default is restored.

Take it seriously: with Gemini, **every** model the app can fall back to is more expensive than the default — the closest successor costs 2.5× more per input token and 3.75× more per output token, and a big ingest is where that shows up on your bill. (Claude users may land on a genuinely cheaper model, in which case no cost line appears at all.)

You may instead see a softer note:

> ℹ️ Pricing for this model may differ from your usual one — check your provider's pricing page before a large ingest.

That means the app doesn't have a published price for the model it landed on and won't guess. Check your provider's pricing page if you're about to ingest something large.

What to do, either way: update the app (see *Version and updates* below). New releases pin a current model, and the fallback clears on the first successful call. If you'd rather not ingest anything large until then, that's a reasonable call — chat and Health are cheap enough to ignore ([§19](#19-api-keys-cost--free-tier) has the numbers).

Full detail: [model-lifecycle.md](model-lifecycle.md).

### Appearance and the setup guide

**Settings → General** holds three things:

- **Appearance** — a **Dark** / **Light** pair. The same switch is the ☀/☾ button in the rail footer; either one works and they stay in step.
- **System check** — below.
- **Setup guide** — **Show setup guide** re-opens the first-run checklist from [§5](#5-first-run--the-getting-started-panel). Dismissing that panel is never permanent; this is the one place it can be found again.

### System check

**Settings → General → System check** confirms the **app itself** is set up correctly. It's the fastest way to answer "is everything working?" — and, when something fails, whether the problem is your setup or your AI provider.

- **Run system check** (free, instant) checks five things locally — no network call, no cost, and it never touches your wiki content: your installed version, whether an AI key is configured, that your knowledge folder is writable, that your credential files are locked down (`0600`), and your sync status. Each row shows OK, needs attention, failed, or info, with a one-line summary above them.
- **Verify AI connection · $0.0001** makes one tiny request to your provider. It asks first — *"This makes one real API call to your active provider to confirm it responds. Estimated cost: $0.0001. Nothing else is read or written."* — and you click **Confirm — run it** or **Cancel**. On success it reports the provider, model, and response time; on failure, the exact error, so you can tell a bad key apart from a provider outage (e.g. an HTTP 503) in one click.

> **System check** verifies the *app and your setup*. It's different from a domain's **Wiki health** panel ([§17](#17-wiki-health)), which scans your wiki *content* for broken links and duplicates. Rule of thumb: System check = is the app working? · Wiki health = is my wiki clean? Full details: [system-check.md](system-check.md).

### Version and updates

The version is shown at the bottom of the Settings section list, e.g. `The Curator v3.9.0`. Next to it, **Updates** compares your version against the latest release on GitHub and tells you whether one is available.

> **Updates can only be *applied* from the previous interface today.** The **Updates** button in the redesigned Settings *checks* and reports; it deliberately does not run the update, and it says so. Applying an update rewrites your actual checkout (`git reset --hard` + `npm install` + a rebuild of the Dock app), and that path is still wired only in the old interface.
>
> **To install an update on macOS:** open **`http://localhost:3333/old`** → **Settings** tab → **Check for Updates** → **Update Now**. The app pulls the latest code, reinstalls dependencies, rebuilds the Dock app, and restarts; the browser reloads on its own and lands you back on the redesigned interface.
>
> **On Linux/Windows,** or if you prefer the terminal: `cd ~/the-curator && git pull && npm install`, then restart the server.
>
> If the version badge shows **restart** next to it, files were updated but the running process hasn't been relaunched yet. Quit The Curator (right-click the Dock icon → **Quit**) and start it again.

### Default domain for MCP writes (v2.5.2+)

When you talk to Claude Desktop via My Curator MCP and say *"save this to my wiki"* without naming a domain, Claude needs to know which one to use. **Settings → MCP bridge → Default domain for MCP writes** sets that fallback.

Pick a domain from the dropdown, or leave it on *"— none (require an explicit domain) —"*. Claude's write tools will use it whenever you don't specify; if it's unset, Claude must explicitly ask you which domain to write to.

> Multi-domain users: leaving this unset is the safer default — every MCP write requires you to confirm the domain. Single-domain users can set the default for smoother conversation flow.

The same section holds the MCP setup wizard (**Set up Claude Desktop** / **Re-connect** / **Re-run setup**, depending on your current state), **Run self-test**, **View config**, and **Copy snippet**. Full walkthrough: [mcp-user-guide.md](mcp-user-guide.md).

### Knowledge base folder

**Settings → Knowledge base** shows where your `domains/` folder lives and lets you move it — **Choose folder** (macOS only; it opens Finder) or **Copy** the path to paste into Obsidian's *Open folder as vault*. Moving the folder loses nothing: point The Curator at the new location and the graph is picked up as-is.

The **Choose folder** button greys out while anything is writing to your wiki. That's deliberate — changing the folder mid-ingest would scatter the rest of that document's pages into the new location.

---

## 17. Wiki Health

**Wiki health lives inside a domain, not in a tab of its own.** Open **Domains** in the rail, click a domain, and the **Wiki health** panel is on that domain's page, between the stat cards and the page list. That's where it belongs: a health problem is always a problem with one specific wiki.

**It scans by itself.** You don't have to press anything — selecting a domain runs the free, local scan and the panel fills in. **Rescan** re-runs it after you've made changes. The panel opens with a plain sentence: *"Found 14 issues, last scanned 2 min ago. Structural repairs run locally and free; anything needing judgement stays review-only, and anything that spends tokens asks first."* Under it is a line of what was scanned, then a row of chips — one per issue type, with its count. Zero counts stay grey.

Use it if your wiki starts to feel messy — broken links, duplicate entities, pages that don't show up in the graph — or as part of your regular maintenance after a batch of ingests.

> A domain's row in the Domains list carries a small dot when it has open issues, so you can see at a glance which wiki needs attention without opening each one.

> **On a read-only Shared Brain mirror**, the scan still runs but no fix buttons appear. The panel explains why: fixes here would be overwritten on the next Pull. Fix the issue in your personal contributing domain and push instead.

> 📖 **For the AI-assisted features** (bulk broken-link fix, bulk orphan rescue, semantic-duplicate detection — what each does, what data leaves your machine, exact cost math), see **[docs/ai-health.md](ai-health.md)**. The **Quick maintenance** action bar (below) is the fast way to use them; the per-issue sections give you granular control.

### What it checks

| Issue | What it means | Action |
|-------|---------------|--------|
| **Broken links** | A `[[wikilink]]` points to a page that doesn't exist. Often a typo, hyphen drift, or a link to a page the LLM hasn't written yet. | **Best: ✨ Fix N broken links** under QUICK MAINTENANCE fixes them all in one reviewed batch (v3.0.1-beta.16). Per-row, **Apply** rewrites a link to a scanner-matched target, or ✨ **Ask AI** proposes one. |
| **Orphan pages** | An entity or concept page has zero incoming links. Not necessarily an error — a page becomes connected as future ingests reference it. | **Best: ✨ Rescue N orphans** under QUICK MAINTENANCE finds a home for each orphan in one reviewed batch (v3.0.1-beta.17). Per-row, ✨ **Ask AI** proposes up to 5 pages that should link to it. Or keep/merge/delete from Obsidian — many orphans resolve themselves as the wiki grows. |
| **Folder-prefix links** | Links like `[[concepts/rag]]` instead of `[[rag]]`. Obsidian treats these as separate pages, breaking the graph. | **Fix** — strips the prefix automatically. |
| **Cross-folder duplicates** | The same page exists in both `entities/` and `concepts/` (e.g. `entities/google.md` + `concepts/google.md`). | **Fix** — merges the concept into the entity version, keeping all bullets. |
| **Hyphen variants** | Entity files that refer to the **same person/thing** but differ in hyphenation **or** an honorific prefix. The scanner groups files whose normalised form (strip honorifics like `dr-` / `dr.-` / `prof-`, then strip all hyphens, then lowercase) is identical. Example groups: `tali-rezun` + `talirezun` + `dr.-tali-rezun`; `prof-smith` + `smith`. | **Fix** — merges all variants into the canonical slug (no honorific, most hyphens, shortest). See the detailed walk-through below. |
| **Missing backlinks** | A summary lists an entity under *Entities Mentioned* but the entity's *Related* section doesn't link back. | **Fix** — injects the missing `[[summaries/...]]` backlink. |

**Auto-fixable issues** have a **Fix** button per row, and a **Fix all N** button on the section header. **Broken links** use the same flow per row but with an **Apply** button — only rows where the scanner found a plausible target are applicable. **Orphans** are review-only per row, but you don't have to work through them one at a time; see **Quick maintenance** below.

### Quick maintenance — the action bar (v3.0.1-beta.17)

This is the recommended way to maintain a wiki, and it's what makes health usable on a large or shared brain with **hundreds or thousands** of issues. A **QUICK MAINTENANCE** block sits inside the Wiki health panel with one button per batch tool — each showing a live count, each only appearing when it has work to do, and **each AI button showing its estimated cost right on the button**:

| Button | What it does | AI? | Cost |
|---|---|---|---|
| **Fix N safe issues** | Applies every deterministic fix at once — folder-prefix links, cross-folder duplicates, hyphen variants, missing backlinks, and broken links the scanner already matched. One click, no AI, no preview needed (these are unambiguous). | No | Free |
| **✨ Fix N broken links** | Resolves broken `[[wikilinks]]` in bulk. Free formatting fixes first (slugifying, stripping `.md`), then the AI matches the rest to real pages when they're a clear variant, and removes the brackets on links that point at no real page. **You review the full plan before it's applied.** | Yes | shown on the button |
| **✨ Rescue N orphans** | For each orphan (a page nothing links to), the AI finds the existing page that should most naturally link to it and writes a short relationship note into that page's *Related* section. Orphans with no confident match are left for manual review. **You review the plan before it's applied.** | Yes | shown on the button |
| **✨ Find duplicate pages** | The semantic-duplicate scan (see below). Always offered when a key is configured — there's no free count to gate it on, so the cost is fetched when you open it. | Yes | shown when you open it |

**The pattern is always the same:** click → a confirm card names exactly what will happen and what it costs → confirm → the AI plans (with a progress bar) → **you see a preview** (what will be retargeted vs. removed, or which orphans get which home) → click **Apply** → the wiki re-scans so you watch the counts drop. The panel itself says so: *"Every AI action shows its cost before it runs. All changes are git-tracked and revertable from Sync."*

This is the difference between maintaining a 50-page personal wiki and a 3,000-page shared brain: you set the direction, the AI does the per-item judgement, and you approve the batch — instead of clicking a thousand times.

> Don't have an API key configured? You still get **Fix N safe issues** (deterministic, no AI). When there's nothing structural left to fix either, the panel says so and offers an **Open Settings** button to add a key and unlock the AI tools.

> **Buttons grey out while a fix is running** — including a fix you started, then navigated away from and came back to. If you see *"An earlier fix on this domain is still running — please wait for it to finish before starting another,"* that's a real operation still working on disk, not a stuck screen.

> **The first time you use any AI action**, a one-time notice explains what leaves your machine. You confirm once.

### How to use it (step by step)

1. Click **Domains** in the rail
2. Pick a domain — the health scan runs automatically
3. **For bulk maintenance** (recommended): use the **QUICK MAINTENANCE** buttons — start with **Fix N safe issues**, then the AI tools (each previews before applying)
4. **For granular control**: expand the per-type sections below and use the per-row **Fix** / **Apply** / **✨ Ask AI** / **Dismiss** buttons
5. After any fix the wiki re-scans so you see counts drop; when you're happy, push from **Sync**

### When to run it

- After a large batch of ingests (e.g. 10+ sources in a day)
- When a new user forks an existing knowledge base via sync and wants a clean baseline
- Periodically — once a month is plenty for active domains
- Whenever Obsidian's graph looks noisier than it should

Wiki health never touches your source files or your conversations — it only cleans the wiki itself. Running a scan is always safe and idempotent.

### Hyphen variants — when and how (v3.0.1-beta.3+)

The most common cause of hyphen-variant duplicates is an LLM picking a slightly different slug across multiple ingests of related sources. The Curator does its best to prevent this at write time (deterministic summary slug, existing-files list passed to the LLM, three dedup passes in `writePage`), but a few specific patterns can still slip through:

| Pattern | Example | Why it happens |
|---|---|---|
| **Honorific kept literally with period** | `dr.-tali-rezun.md` next to `tali-rezun.md` | The LLM occasionally preserves the dot from "Dr." when slugifying |
| **Honorific kept without period** | `dr-tali-rezun.md` next to `tali-rezun.md` | The LLM treats the title as part of the name |
| **Pure hyphenation drift** | `tali-rezun.md` next to `talirezun.md` | Different runs converge on different slug shapes for the same name |
| **Article-prefix drift** | `the-curtain.md` next to `curtain.md` | Article prefixes like "the/a/an" inconsistently included |

All four cases collapse to the same canonical slug after the scanner's normalisation, so the **Hyphen variants** section will surface them as one group regardless of the variation.

**Step-by-step fix walk-through:**

1. **Open the domain.** The **Hyphen variants** chip shows a count if any are detected.
2. **Expand the Hyphen variants section.** Each row shows the canonical file (kept) plus the variants that will be merged into it. Canonical selection priorities: (a) no honorific prefix; (b) most hyphens; (c) shortest length.
3. **Click Fix on the row** (or **Fix all** on the section header). The Curator:
   - Reads each variant file's bullet sections (Key Facts, Related, Entities Mentioned, etc.)
   - Unions them into the canonical file, deduplicating by link target
   - **Repoints every `[[link]]` in the domain that pointed at a variant, onto the canonical slug**
   - Deletes the variant files from disk
4. **The scan re-runs.** The Hyphen variants count drops to zero — and, because the links were repointed, it does not leave a pile of new broken links behind it.

**Merges now repoint links, and the confirm dialog says how many pages will be deleted.** This changed: a merge used to delete a page and leave every `[[link]]` to it dangling, so the Hyphen-variants fix had to be followed by a Broken-links pass to clean up after itself. It doesn't any more. Both destructive fix types — **Hyphen variants** and **Cross-folder duplicates** — now rewrite inbound links before deleting anything, and their confirmation spells out the damage before you commit:

> *"This MERGES each group and DELETES the duplicate pages, then repoints every `[[link]]` that pointed at them. **3 pages will be deleted.** Every change is git-tracked and can be reverted from Sync."*

The button on those two says **Merge and delete**, not "Fix now" — the wording tells you which kind of action you're about to take. Non-destructive fixes keep the plain **Fix now**.

**Real-world example.** Two author files end up on disk: `entities/dr.-tali-rezun.md` (2.5 KB, sparse) and `entities/tali-rezun.md` (19.8 KB, populated). Both describe the same person.

- The scan flags them as a hyphen-variant group with `tali-rezun.md` as canonical
- One click on Fix unions the bullet sections, repoints every `[[dr.-tali-rezun]]` link in the domain to `[[tali-rezun]]`, and deletes `dr.-tali-rezun.md`
- The re-scan comes back clean — no stranded links to chase

**Safety:** The merge is always non-destructive at the bullet level — `mergeBulletSections` unions content rather than overwriting. If the canonical file already had richer content than the variant (as in the example above), nothing is lost; the variant's unique bullets are added on top.

### Semantic duplicates (v2.4.5+)

In a domain's **Wiki health** panel, click **✨ Find duplicate pages** under **QUICK MAINTENANCE** (it appears whenever an API key is configured — including on a wiki that is otherwise structurally clean). This finds pages that the algorithm can't catch — like `[[rag]]` and `[[retrieval-augmented-generation]]`, or `[[email]]` and `[[e-mail]]`, or `[[neural-network]]` and `[[neural-networks]]`.

Unlike the other health fixes, this one:

- **Costs a small amount** — typically $0.005–$0.03 per scan on Gemini Flash Lite. A confirm card shows the estimate and the candidate-pair count before you run it. If there turn out to be no likely duplicates, it tells you that instead of charging you for a scan.
- **Is opt-in and user-gated.** Nothing happens until you click, then confirm.
- **Is destructive when you merge a pair.** The duplicate file is deleted and every `[[old-slug]]` link in the domain is rewritten to the canonical slug.

Each candidate comes back as its own card showing `remove-slug → keep-slug`, a confidence level (high / medium / low), and the AI's reasoning. Four buttons:

| Button | What it does |
|---|---|
| **Preview diff** | Opens the diff **inline, in that card** — the exact keep path and delete path, how many link rewrites across how many files (with the files named), and the first 4 KB of the merged page. |
| **↔ Flip** | Swaps which side is kept. Use it when the AI picked the wrong survivor. |
| **Merge** | Performs the merge. **Disabled until you have previewed that specific pair** — the card says *"Preview required before Merge"* until you do, then *"✓ previewed"*. |
| **Skip** | Dismisses this pair so it stops coming back on future scans. |

The preview gate is per pair, and it resets whenever you re-scan, switch domains, or flip a pair — a preview you looked at for one arrangement never authorises a different one. If a merge is refused (because something else is writing to that domain), the refusal appears **inside the card you are looking at**, not somewhere you'd have to scroll to find it.

**There is also a batch option** for high-confidence pairs, which names the count and what will happen before it runs: *"Combines each pair's bullet sections onto the kept page, retargets every `[[wikilink]]` across the domain…"*. Medium- and low-confidence pairs are deliberately one at a time — they're the ones most likely to be genuinely distinct.

You can tune **Cost ceiling per scan** and **Maximum candidate pairs per scan** in **Settings → Health & scan limits**. Defaults (50,000 tokens, 500 pairs) suit domains up to ~5k pages; raise them for larger wikis. A scan refuses to start when its estimate exceeds the ceiling.

For the full guide, see [ai-health.md](ai-health.md).

### Persistent dismissals (v2.5.1+)

Not every flagged issue is a real problem. Two pages you intentionally keep separate, an orphan you're planning to develop later, a draft with a deliberately broken link — before v2.5.1, clicking Skip just hid the issue until the next scan, and then you saw it again.

Now dismissals stick.

A **Dismiss** button appears on every review-only health row (orphans, broken links without an auto-fix suggestion), and **Skip** does the same job on a semantic-duplicate pair card. Click it once and the issue stops appearing on future scans.

The line under the panel's headline (*"Scanned 600 entities · 2,651 concepts · 83 summaries · 4 dismissed"*) tells you how many issues are being filtered out. Below the regular sections, a collapsible **Dismissed (N)** list shows everything you've dismissed, with a **Restore** button on each row to bring an item back.

**Three actions you'll see, in order of permanence:**

| Button | Where | What it does |
|---|---|---|
| **Apply** / **Fix** | Auto-fixable rows | Performs the repair now. The issue is resolved. |
| **Dismiss** / **Skip** | Review-only rows · semantic-dupe cards | Marks the issue as not-a-problem. Won't surface on future scans. Reversible from the Dismissed section. |
| **Cancel** | Inside a confirm card or an ✨ Ask AI panel | Backs out without doing anything. The underlying issue stays flagged on future scans. Use **Dismiss** if you want it gone for good. |

**Dismissals sync between your computers.** They live inside the wiki folder (`<wiki>/.health-dismissed.jsonl`), so your existing GitHub sync carries them along. Skip a 70-pair semantic scan on your laptop, sync, and the same false positives stay skipped on your desktop.

**Stale dismissals self-clean.** If you later rename a page or delete one of the files involved in a dismissed pair, the corresponding record is silently removed on the next scan — no clutter accumulates.

---

## 18. Troubleshooting

**"command not found: node" when I type `node src/server.js`**

Node.js is not installed, or the terminal can't find it. Download it from [nodejs.org](https://nodejs.org) (LTS version), install it, then close and reopen your terminal.

**"No LLM API key found" error when starting the server**

No API key is configured. Open the app in your browser and use **Settings → Providers & keys → Replace → Save** (the Getting started panel links you straight there). If you prefer to use a file, check that `.env` exists in the `the-curator` folder with `GEMINI_API_KEY=your_key_here`.

**The server starts but `http://localhost:3333` shows "This site can't be reached"**

The server stopped or crashed. Go back to your terminal and run `node src/server.js` again.

**The interface looks completely different / I want the old one back**

That's the redesign — it became the primary interface in v3.9.0. Nothing was migrated and nothing moved on disk: same domains, same wiki, same settings, same folder. [§7](#7-finding-your-way-around) has a table mapping every old tab to where it is now.

If you'd rather use the old one for a while, it's at **`http://localhost:3333/old`**. It is kept for two or three releases and then removed, so treat it as a bridge rather than a home.

**The app opens to a blank page, or a panel says "could not finish loading"**

Rare, but it can happen after an update if a file didn't download completely. Instead of an empty window you'll get a panel headed **"The Curator (preview) could not finish loading"**, with the technical error at the bottom.

**Your knowledge is not affected.** Every wiki page is a plain markdown file on your disk; a startup failure in the browser interface cannot touch them, and you can open your domains folder in Obsidian or a text editor while the app is broken.

Reload the page first — a partly-downloaded file usually fixes itself. If that keeps happening, go to **`http://localhost:3333/old`**, which is a completely separate interface and will load even when this one won't. Then quit The Curator (right-click the Dock icon → **Quit**) and relaunch. If it still fails, reinstall — and please paste the technical detail from the panel into a [GitHub issue](https://github.com/talirezun/the-curator/issues) so it can be fixed for everyone.

> The panel's own wording still calls itself "the preview shell" and tells you to *"go back to the shipping app at /"* — that text predates the cutover and is wrong now, because `/` is this interface. **`/old` is the address you want.**

**"Updates" says there's a new version but nothing installs it**

That's expected right now. The **Updates** button in Settings only *checks*. To actually apply an update on macOS, open **`http://localhost:3333/old`** → **Settings** → **Check for Updates** → **Update Now**. On Linux/Windows, `git pull && npm install` in the project folder. Full explanation in [§16 → Version and updates](#version-and-updates).

**Ingest spins for a very long time then fails**

- Check your internet connection (the app needs to reach Google's API)
- Check that your Gemini API key is valid at [aistudio.google.com](https://aistudio.google.com)
- Try a smaller file first (under 50 pages) to confirm the setup works

**PDF text comes out garbled or empty**

The PDF is scanned (an image of a page, not real text). Copy the text manually and save it as a `.txt` file instead.

**Pages are not showing up in Obsidian after an ingest**

Press `Cmd/Ctrl + R` in Obsidian to force a refresh, or close and reopen the vault. Obsidian does not always detect new files automatically.

**An ingest (single-file or batch) fails right at the end with a cryptic error mentioning `log.md`**

This means the AI already did its work and your pages are safely written to disk — the failure happens at the very last step, recording the ingest in the domain's log file, because that log file is missing. This can only happen on a domain whose folder structure was created by hand rather than through the app (creating a domain normally always creates the log file). **Nothing was lost.** The fix: create an empty file at `domains/<your-domain>/wiki/log.md`, then re-ingest the same file — re-ingesting is always safe (see *Re-ingesting a source* above) and this time the log step will succeed.

**"The Curator could not start" dialog appears when clicking the Dock icon**

Check the log for the exact error:
```bash
cat /tmp/the-curator.log
```

The most common cause is `nohup: node: No such file or directory` — this means Node.js was upgraded or its path changed since the app was built. Rebuild the app to pick up the current path:
```bash
cd ~/the-curator
bash scripts/build-app.sh
```

Then click the Dock icon again. If the log shows a different error (e.g. a missing API key), open `http://localhost:3333` manually and the Getting started panel will point you at the fix.

**"Port 3333 is already in use" error**

Another process is using port 3333. Either close that process or change the port in your `.env` file:
```
PORT=4000
```
Then restart the server and go to `http://localhost:4000` instead.

**I closed the terminal — the app stopped working**

If you are running the server manually from Terminal, the server stops when the terminal closes. To restart: open a new terminal, navigate to the project folder (`cd the-curator`), and run `node src/server.js`. If you use the Dock app instead, this is handled automatically — just double-click The Curator icon to relaunch.

**`429 RESOURCE_EXHAUSTED` or `Rate limit exceeded` errors during ingest**

You are on Gemini's free tier and have hit a daily/per-minute quota — see [§19](#19-api-keys-cost--free-tier). The fix is either to wait (limits reset), batch your ingests across days, or enable billing in [Google AI Studio](https://aistudio.google.com/app/apikey) so you move to the paid tier (still extremely cheap — typically €1–€10/month).

---

## 19. API keys, cost & free tier

> **Read this section before you commit to using The Curator at scale.** It is the single most common source of frustration for new users.

The Curator is **free software**. The only thing that costs money is the AI provider you call for the features that actually invoke an LLM. There are two providers you can plug in (Gemini or Claude), and a clear split between which features use tokens and which don't.

### Which features use tokens

| ✅ Uses tokens (paid) | ❌ Free / local-only |
|---|---|
| **Ingest** — by far the biggest consumer | **Reading wiki pages** (the reader overlay, Browse pages) |
| **Chat** — every message + reply | **Domain management** (create / rename / delete) |
| **Wiki health — ✨ Ask AI on broken links** (Phase 1) | **GitHub Sync** (Sync now / Push only / Pull only) |
| **Wiki health — ✨ Ask AI on orphan pages** (Phase 2) | **Wiki health structural scan** + deterministic fixes (folder-prefix, hyphen variants, cross-folder dedup, missing backlinks) |
| **Wiki health — Semantic duplicate scan** (Phase 3, opt-in & cost-gated) | **Settings**, **API key management**, **updates** |
| | **My Curator MCP server** (local bridge — free; the *frontier model* you connect to it bills you separately on its own plan) |

So when you see a bill, the dominant line item is **ingest**. Chat and Health Ask-AI are negligible by comparison; everything else is genuinely free.

### Provider comparison

| | **Google Gemini 2.5 Flash Lite** | **Anthropic Claude Haiku 4.5** |
|---|---|---|
| Default in The Curator | ✅ Yes | Optional fallback |
| Free tier | 15 RPM · 1,000 RPD · 250k TPM | ❌ No free tier |
| Paid input price | **$0.10 / 1M tokens** | $1.00 / 1M tokens |
| Paid output price | **$0.40 / 1M tokens** | $5.00 / 1M tokens |
| Context window | **1,048,576 tokens (~1M)** | 200,000 tokens |
| Cost vs Gemini | 1× | ~10× more expensive |
| Where to get a key | [aistudio.google.com](https://aistudio.google.com/app/apikey) | [console.anthropic.com](https://console.anthropic.com/) |

> Gemini has a free tier *and* the cheapest paid tier *and* the largest context window. That is why it is the default. Claude Haiku 4.5 is the right choice if you specifically want Anthropic — for example because you already have a corporate Anthropic account, or you prefer Anthropic's privacy stance — but expect a roughly 10× higher bill for the same workload.

### What the Gemini free tier actually gives you

After the [December 2025 quota changes](https://ai.google.dev/gemini-api/docs/rate-limits), free-tier Gemini 2.5 Flash Lite is limited to:

- **15 requests per minute (RPM)**
- **1,000 requests per day (RPD)** — resets at midnight Pacific Time
- **250,000 tokens per minute (TPM)**

In Curator terms:

- A single small-article ingest = ~1–4 LLM calls. So you can ingest **10 small articles per minute** before hitting RPM, or **maybe 200–400 articles per day** before hitting RPD.
- A single book ingest can be 50–100 calls (multi-phase). The free tier will likely **fail mid-book** with `429 RESOURCE_EXHAUSTED`. In our testing, a 100-page PDF reliably exhausted the free-tier daily quota in one go.
- Chat usage adds ~1 call per message.

**TL;DR for free tier:** fine for trying the app and ingesting a few articles; not viable for serious or batch use. **Enable billing.**

### What pay-as-you-go actually costs (real numbers)

**Author's own usage** (Tali, project creator) for one month of heavy use on Gemini Flash Lite:

- **~50 articles** ingested (each ≥10 pages)
- Daily chat usage on top
- **Total bill: ~€5**

That averages out to **~€0.10 per article** — including the wiki growing larger over time (which makes each ingest call read more existing context). Most casual users will pay closer to €1–€3/month.

**Estimated cost on Anthropic Haiku 4.5** for the same workload:

- ~10× input cost · ~12.5× output cost
- Realistic monthly bill: **€40–€60**

### Per-ingest math (back-of-envelope)

For a typical 10-page article on a small or fresh domain:

| | Gemini 2.5 Flash Lite | Claude Haiku 4.5 |
|---|---|---|
| Input tokens (article + existing entity/concept page names) | ~10k | ~10k |
| Output tokens (5–15 wiki pages, frontmatter, links) | ~5k | ~5k |
| Cost per ingest | **~$0.003** (≈€0.003) | **~$0.035** (≈€0.03) |
| Cost per 100 ingests | ~$0.30 | ~$3.50 |

**As of v3.0.16, the index page (`index.md`) is still sent to the AI on the planning step, unchanged from before** — an earlier attempt to remove it was tried and then reverted before release once live testing showed prompt caching (below) delivered roughly twice the saving with none of the open questions, so it wasn't worth the trade-off. If you're comparing notes with an earlier description of this release, that removal is not what shipped. This table's numbers are unaffected by v3.0.16 for that reason.

**A related, separate safety net:** on a genuinely huge domain (thousands of pages in one folder), the list of existing page names sent to the AI is capped to the most relevant ones so the request never overflows what the AI can read — this is a rare safety net, not something that fires on a normal-sized wiki, and it will show up as the *"This domain has grown large enough that the AI request had to be trimmed…"* note in §8's ingest-report reference below if it ever does.

**Prompt caching (Anthropic only) — this is where v3.0.16's real cost saving comes from.** For a multi-page document that needs two or more AI calls (a "multi-phase" ingest — see [§8](#8-ingest-a-source)), the batch requests are now ordered so their shared instructions form a stable block, and Claude reuses a cached copy of that block across calls instead of paying full price on every one — the content sent is identical either way, just reordered. Measured live across several ingests: roughly **50–70% less input-token cost** on the calls that could reuse the cache (the exact number depends on how many batches share it), and **-30.3%** on the total ingest cost for a typical multi-batch document. A short, single-call ingest gets no caching benefit — there's nothing to reuse it against. Gemini needs no such feature: it caches automatically and the saving already shows up in Google's own reported price. This table's numbers assume no caching (the worst case, and still accurate for a short article); the small per-call overhead from the LLM-not-found fallback chain (v2.4.0+) is also ignored.

### Practical guidance

1. **Start on Gemini free tier** to make sure the app is right for you (1–5 ingests, browse the wiki, try Chat).
2. **As soon as you want to ingest a batch or a book, enable billing in Google AI Studio.** No credit card = no scaling. The bill will almost always be under €10/month for personal use.
3. **Use Claude Haiku 4.5 only if you specifically need Anthropic.** It is 10× the price for ~equivalent quality on this workload.
4. **Set an AI Studio budget alert** on your Google Cloud project (e.g. €20/month) so you can't be surprised.
5. **Don't worry about chat cost** — it's a fraction of ingest cost. Multi-turn conversations on a 2,000-page wiki cost cents.

### What about MCP / Health / semantic dupe scans?

- **My Curator MCP** runs entirely on your machine and **costs you nothing** in API fees — it's just a local bridge to your wiki files (reading and, since v2.5.2, writing) and never calls an AI model itself. The frontier model you connect *to* it (Claude Desktop, etc.) bills you separately on its own plan.
- The **Wiki health** structural scan is local and **free**.
- **Wiki health Phase 1 / 2 (✨ Ask AI)** uses your configured provider; ~$0.0001–0.0005 per click. Trivial.
- **Wiki health Phase 3 (semantic dupe scan)** is **opt-in and cost-gated**. A 500-pair scan on Gemini Flash Lite costs ~$0.03; a confirm card shows the estimate before you run it. See [docs/ai-health.md](ai-health.md).

---

## 20. Install with a coding agent

Don't want to run a single terminal command? If you already have a CLI-aware AI coding agent — **Claude Code**, **Cursor**, **Augment**, **Cline**, **Aider**, **GitHub Copilot CLI**, or any other agent that can run shell commands — paste the prompt below into the agent and let it do the install for you.

This is the **easiest way to install on Linux and Windows**, where the one-line `curl | bash` installer doesn't apply.

### Copy-paste prompt

```
Please install "The Curator" on this machine for me.

Project: https://github.com/talirezun/the-curator
User Guide: https://github.com/talirezun/the-curator/blob/main/docs/user-guide.md

Steps:
1. Verify Node.js 18+ is installed; if not, install it (Homebrew on macOS, nodejs.org installer on Windows, system package manager on Linux).
2. git clone https://github.com/talirezun/the-curator.git into the user's home directory.
3. cd the-curator && npm install
4. On macOS: bash scripts/build-app.sh to build "The Curator.app", then move/copy it to /Applications and remind me to drag it from Finder into my Dock.
5. On Linux/Windows: skip the .app build; explain how to start the server (`node src/server.js`, with CURATOR_NO_OPEN=1 on Windows) and remind me to open http://localhost:3333.
6. Open the URL once the server is running so I can complete the in-app setup (API key + first domain).
7. Tell me what to do if I want to enable GitHub sync (point me to docs/sync.md).

Do not edit any files outside ~/the-curator. Do not commit anything to my git config. Do not ask me for my API key — I will paste it into the app's Settings myself. After the install finishes, summarise what you did in 5 bullet points.
```

### What you should know

- Most agents will ask before running `npm install` and before launching the server. Approve those — they're the install.
- If the agent doesn't have permission to install Node.js system-wide, it will tell you. On Linux, `sudo apt install nodejs npm` (or your distro's equivalent) is enough.
- After the install, the **Getting started** panel in the browser walks you through the rest: API key, first domain, first ingest. The agent should not need to touch any of that.
- The agent doesn't replace this guide — when you want to understand what the app actually does, [§4 (API keys)](#4-get-your-api-key-gemini-or-claude), [§13 (three ways to talk to your knowledge)](#13-three-ways-to-talk-to-your-knowledge-chat--obsidian--mcp), and [§19 (cost)](#19-api-keys-cost--free-tier) are the most important sections.

### Updating with a coding agent

The Mac Settings → Update button is `git pull && npm install && bash scripts/build-app.sh`. Any coding agent can do the equivalent on any platform:

```
Please update The Curator at ~/the-curator: cd into it, run `git pull && npm install`,
and on macOS also run `bash scripts/build-app.sh`. Then restart the server.
```

---

## 21. Further reading

| | |
|-|-|
| 📖 [Knowledge Immortality (essay)](../research/articles/knowledge-immortality-second-brain.md) | The why — what a second brain is, why markdown matters, and a section-by-section walkthrough of every part of the app |
| 🔌 [My Curator MCP Guide](mcp-user-guide.md) | Connect the wiki to Claude Desktop / VS Code / LM Studio for frontier-model research |
| 🧹 [AI Wiki Health Guide](ai-health.md) | Phase 1 / 2 / 3 details: broken-link rescue, orphan rescue, semantic duplicate detection — what data leaves your machine and what each call costs |
| 🩺 [System Check](system-check.md) | Settings → General → System check — confirm the app setup is correct + an optional AI connection test |
| 🔁 [Sync Guide](sync.md) | The full GitHub sync workflow — including team-shared brains and conflict recovery |
| 📁 [Domains](domains.md) | The full reference — managing domains, the CLAUDE.md schema, how domains relate to each other (siloed by default), custom templates for specialised topics |
| 🔄 [Model Lifecycle](model-lifecycle.md) | What happens when a provider retires a model — fallback chain explained |
| 🍎 [Mac App Setup](mac-app.md) | Detailed Mac Dock launcher instructions |
| 🛠 [API Reference](api-reference.md) | REST API endpoints (for developers) |
| 🏗 [Architecture](architecture.md) | System design (for developers) |
| ⚙ [Ingestion Pipeline](ingestion-pipeline.md) | The deep dive on the most critical code path — every safeguard, every failure mode, the quality contract, Mermaid diagrams (for developers) |
