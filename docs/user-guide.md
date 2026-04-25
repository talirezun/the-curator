# User Guide — The Curator

This guide covers everything from first-time setup to daily use. No technical background is required.

---

## Table of contents

1. [What is this app?](#1-what-is-this-app)
2. [What you need before you start](#2-what-you-need-before-you-start)
3. [Installation](#3-installation)
4. [Get your API key (Gemini or Claude)](#4-get-your-api-key-gemini-or-claude)
5. [Configure the app](#5-configure-the-app)
6. [Start the server (and how lifecycle works)](#6-start-the-server-and-how-lifecycle-works)
7. [Open the app in your browser](#7-open-the-app-in-your-browser)
8. [Ingest a source](#8-ingest-a-source)
9. [Chat with your brain](#9-chat-with-your-brain)
10. [Manage your domains](#10-manage-your-domains)
11. [Browse the wiki tab](#11-browse-the-wiki-tab)
12. [See your knowledge graph in Obsidian](#12-see-your-knowledge-graph-in-obsidian)
13. [Three ways to talk to your knowledge (Chat · Obsidian · MCP)](#13-three-ways-to-talk-to-your-knowledge-chat--obsidian--mcp)
14. [Daily workflow](#14-daily-workflow)
15. [Sync across computers](#15-sync-across-computers)
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

> The installer is currently macOS-only because it auto-builds a `.app` Dock launcher. The Curator's *core* (Express + Node) is fully cross-platform — Windows and Linux users can clone the repo and run `node src/server.js` directly. Auto-update from the Settings tab is also macOS-specific (it rebuilds the `.app`); on Windows/Linux, run `git pull && npm install` to update.

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

When it finishes, the app opens automatically in your browser. The **onboarding wizard** appears on first launch and walks you through entering your API key, creating your first domain, and optionally setting up sync.

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

Open **http://localhost:3333** in your browser. The onboarding wizard will guide you through the rest.

**Linux / Windows specifics**

- Set `CURATOR_NO_OPEN=1` to skip the macOS-only `open` browser-launch on startup (the server still binds to `localhost:3333`; just open it manually).
- Set `DOMAINS_PATH=/path/to/your/knowledge` if you want your wiki folder somewhere other than `~/the-curator/domains`. The folder-picker UI button is macOS-only (uses AppleScript), but the env var works on every OS.
- Updating the app on Linux/Windows: run `git pull && npm install` from the `the-curator` directory, then restart `node src/server.js`. The Settings → Check for Updates button is macOS-only because it also rebuilds the `.app` bundle.

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

> The onboarding wizard also links directly to this page when you first open the app.
>
> Your API key is like a password. Never share it publicly or post it on the internet.

### Or use Anthropic Claude instead

If you'd rather pay Anthropic than Google (e.g. for privacy preference, or because you already have a Claude account):

1. Go to **[console.anthropic.com](https://console.anthropic.com/)**
2. Generate an API key under **Settings → API Keys**
3. Anthropic has **no free tier** — you must add billing before any call works
4. The Curator defaults to **Claude Haiku 4.5** (Anthropic's lowest-cost tier). For higher quality, set `LLM_MODEL=claude-sonnet-4-5` in `.env`.

If you configure both keys, **Gemini wins by default** (it's much cheaper). You can switch the active provider at any time in the Settings tab.

---

## 5. Configure the app

When you first open The Curator, the **onboarding wizard** appears and walks you through setup:

1. **API key** — paste your Gemini API key (from step 4) and click Continue
2. **Create a domain** — pick a name and template for your first knowledge domain
3. **Sync setup** — optionally connect a GitHub repository (you can skip this and set it up later)

That's it. You can change your API key anytime in the **Settings** tab (the gear icon in the navigation bar).

> **For developers:** You can also configure API keys by creating a `.env` file manually (`cp .env.example .env`) and setting `GEMINI_API_KEY=your_key_here`. The Settings tab takes priority over `.env` when both are present.

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

## 7. Open the app in your browser

With the server running, open your web browser (Chrome, Safari, Firefox — any browser works) and go to:

```
http://localhost:3333
```

You'll see the The Curator interface with six tabs at the top: **Ingest**, **Chat**, **Wiki**, **Sync**, **Domains**, and **Settings**.

> `localhost:3333` means "a web page running on your own computer, on port 3333". It only works when your server is running and is not accessible to anyone else on the internet.

---

## 8. Ingest a source

"Ingesting" means feeding a document to your The Curator. This is how you build up your knowledge.

### Supported file types

| File type | Extension | Example use |
|-----------|-----------|-------------|
| PDF | `.pdf` | Research papers, book chapters, reports |
| Text file | `.txt` | Articles you've copied, lecture notes |
| Markdown | `.md` | Notes from other apps, written summaries |

> **PDF tip:** Only text-based PDFs work. If a PDF is a scanned image (like a photo of a page), the text cannot be extracted. In that case, copy-paste the text into a `.txt` file instead.

### How to ingest

1. Click the **Ingest** tab
2. Select a **domain** from the dropdown (e.g. "AI Tech", "Business Finance", or "Personal Growth")
3. Drag your file onto the drop zone, or click it to browse your files
4. Click **Ingest**
5. Wait — you'll see a spinner that says "The Curator is reading your source and updating the wiki..." This usually takes **15–60 seconds** depending on the document length. Do not close the browser or refresh the page.
6. When finished, you'll see a list of all the wiki pages that were created or updated

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

In practice, The Curator's ingest pipeline currently caps the **input** at 80,000 characters (~20,000 tokens) per single LLM call to keep latency and cost predictable. For longer documents the pipeline automatically switches to **multi-phase mode**:

1. **Phase 1** — outline pass: the AI reads the whole document and decides what pages to write
2. **Phase 2** — batched content: pages are written in batches of 4 per LLM call
3. **Phase 3** — index update

**Practical guidance:**

| Document size | Behaviour |
|---|---|
| **≤ 25 pages / ~10–15 k words** | Single-pass ingest (15–60 seconds) — the most common case |
| **25–100 pages / book chapters / long research papers** | Multi-phase pipeline kicks in automatically (~1–5 minutes) — works reliably |
| **200–300 pages / full books** | Multi-phase pipeline still works — possible but **not yet stress-tested at scale**. The 1M-token context is large enough; expect ingest to take 10–20 minutes. If a very long PDF stalls or runs out of token budget, split it into chapters. |
| **Scanned PDFs (image-only)** | Won't work — there's no OCR step. Convert to text first. |

> The 80k-char-per-call cap is conservative; future versions may raise it now that Gemini 2.5 Flash Lite's full 1M window is generally available. For now, splitting very long sources by chapter is the safe bet.

### Tips for better results

- **Use descriptive filenames.** `atomic-habits-summary.txt` is better than `notes.txt` — the filename appears in the log.
- **One document at a time.** Don't combine ten articles into one file; each document should get its own ingest so it gets its own summary page.
- **Clean up copy-pasted text.** If you paste an article from a website, remove the navigation menus, cookie banners, and footer text first. Cleaner input = better wiki pages.
- **Mind the rate limits on the free tier.** If you're ingesting a batch of 5+ documents and you're on Gemini's free tier, expect to hit `429 RESOURCE_EXHAUSTED` partway through — see [§19](#19-api-keys-cost--free-tier).

---

## 9. Chat with your brain

After ingesting a few sources, you can have a full multi-turn conversation with your knowledge base. The AI answers from your wiki pages only, cites its sources, and remembers the entire thread — even after you restart the server.

### The chat interface

The Chat tab has two parts:

- **Left sidebar** — your conversation history. Each domain's conversations are listed separately. Click any conversation to reopen it.
- **Right panel** — the message thread. Your messages appear on the right (blue), the AI's replies on the left.

### Starting a conversation

1. Click the **Chat** tab
2. Select a **domain** from the dropdown at the top of the sidebar
3. Click **+ New Chat** (or just start typing — a new conversation is created automatically)
4. Type your question in the input box at the bottom
5. Press **Send** or use `Cmd + Enter` (Mac) / `Ctrl + Enter` (Windows)
6. Wait for the reply — usually 10–30 seconds

### What a good reply looks like

```
Retrieval-Augmented Generation (RAG) combines a retrieval step with
generation, so the model grounds its answer in real documents rather
than relying on memory alone [source: concepts/rag.md].

The key advantage over fine-tuning is that you can update the knowledge
base without retraining the model [source: summaries/rag-paper.md].
```

The `[source: ...]` tags tell you exactly which wiki page each claim came from. You can open that page in the Wiki tab or in Obsidian to read the full source.

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

- **Rename / revisit** — click any conversation in the sidebar to reopen it in full
- **Delete** — hover over a conversation in the sidebar and click the **✕** button that appears

### Good questions to ask

- "What is [concept] and why does it matter?"
- "What are the key differences between [X] and [Y]?"
- "How does [idea from one source] connect to [idea from another source]?"
- "Who are the main people mentioned in my notes on [topic]?"
- "What tools are recommended for [task]?"
- "Summarise everything I know about [topic]"
- "What have I learned about this topic over time?"

> The AI only answers from your wiki. If you haven't ingested any sources about a topic, it will say so honestly rather than making things up.

---

## 10. Manage your domains

The **Domains** tab is your control panel for organising your The Curator. Instead of manually creating folders in Finder, you can create, rename, and delete domains entirely from within the app.

### What is a domain?

A domain is a focused knowledge silo — a dedicated wiki for one topic area. Each domain gets its own AI schema, wiki pages, chat conversations, and Obsidian graph cluster. The three built-in domains are **AI / Tech**, **Business / Finance**, and **Personal Growth**, but you can create as many as you like.

### Viewing your domains

Click the **Domains** tab to see all your domains as cards. Each card shows:

- The domain name and its folder path (`domains/ai-tech/`)
- How many wiki pages it contains
- How many chat conversations it has
- When the last source was ingested

### Creating a new domain

1. Click **New Domain**
2. Type a display name — for example, `Health & Fitness`
   - The folder name is generated automatically (e.g. `domains/health-and-fitness/`) and shown as a live preview below the input
3. Optionally add a scope description — 1–2 sentences about what belongs in this domain
4. Choose a **template** — this determines how the AI structures your wiki:

| Template | Best for | Entity types | Concept style |
|----------|----------|-------------|---------------|
| ⚙️ Tech / AI | Software, research, tools | person, tool, company, dataset | How It Works / Applications |
| 📈 Business / Finance | Startups, investing, strategy | person, company, fund, institution | Why It Matters / Examples |
| 🌱 Personal Growth | Books, habits, mental models | person, book, framework | Why It Matters / How to Apply It |
| 📁 Generic | Any other topic | person, item, organization | Overview / Examples |

5. Click **Create Domain**

The domain appears immediately in all dropdowns (Ingest, Chat, Wiki) and in Obsidian's file explorer — no restart required.

### Renaming a domain

1. Click the **pencil icon** on any domain card
2. Type the new display name — the new folder path updates in the live preview
3. Click **Rename**

The folder is renamed on disk. All wiki pages, conversations, and chat history are preserved. Obsidian reflects the change immediately.

> **If sync is configured:** renaming a domain appears to GitHub as a delete + add. Click **Sync Up** soon after renaming so your other computers stay consistent.

### Deleting a domain

1. Click the **trash icon** on any domain card
2. Read the confirmation panel — it shows exactly how many wiki pages and conversations will be deleted
3. Click **Yes, delete permanently** to confirm

The folder is removed from disk and disappears from all dropdowns. Obsidian reflects the change immediately.

> ⚠️ **Deletion is permanent.** There is no undo. If you use sync, the domain will also be removed from GitHub on the next Sync Up.

### Obsidian and domain management

Because The Curator writes directly to the `domains/` folder that Obsidian watches, all domain changes are reflected in Obsidian instantly — no refresh or export needed. A new domain becomes a new folder in Obsidian's file explorer. A renamed or deleted domain updates the graph accordingly.

---

## 11. Browse the wiki tab

The **Wiki** tab is a simple built-in reader for your wiki pages.

1. Click the **Wiki** tab
2. Select a **domain**
3. Click **Load**
4. Browse pages in the left sidebar (grouped by type: summaries, concepts, entities)
5. Click any page to read it

This is useful for a quick check. For a much richer experience — including the interactive knowledge graph — use Obsidian (see the next section).

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

1. Go to the **Ingest** tab
2. Upload the same original document again (PDF, txt, etc.)
3. The app detects it has been ingested before and *updates* the existing wiki pages rather than duplicating them

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

Use the **Chat** tab when you want to:

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

### Option C — My Curator MCP (frontier-model research)

Use **My Curator** when you want a frontier model — Claude Opus, Sonnet, or any MCP-compatible AI client — to do **deep research** over your wiki, treating it as a structured graph rather than a folder of files.

This is the most powerful access path. You install a tiny local MCP bridge (one-time, under 2 minutes from the **Settings** tab), and from then on Claude Desktop (or VS Code with an MCP-aware coding agent, or LM Studio with a local model) can:

- Run topology overviews — *"Show me the most central hubs in my AI domain"*
- Trace bidirectional links — *"Every source that mentions OpenAI"*
- Find tag-driven clusters — *"All pages tagged `ai-safety`, then synthesise"*
- Search across every domain at once
- Reason about your knowledge as a graph (10 dedicated tools, including 3 graph-native ones)

Everything stays local — the MCP server is read-only and only sees your wiki folder.

> 📖 **Full setup guide:** [docs/mcp-user-guide.md](mcp-user-guide.md) — wizard-style 2-minute install, prompt patterns, troubleshooting.

### How the three combine

```
                 The Curator app
              (Chat tab — Gemini/Haiku)
                       │
                       │       Claude Desktop / VS Code / LM Studio
                       │       (Frontier model — Opus, Sonnet, local)
                       │              │
                       │              │ via My Curator MCP (read-only)
                       ▼              ▼
              domains/ folder ◄──────────────┐
                       │                     │
          Markdown files on disk             │
                                             │
                 Obsidian   ─────────────────┘
              (desktop app — visual graph)
```

All three read the same `domains/` folder. Nothing to sync between them. The intended daily flow:

1. Feed the app new documents (**Ingest** tab)
2. Quick lookups → built-in **Chat**
3. Visual exploration → **Obsidian**
4. Deep research / synthesis across years of notes → frontier model via **My Curator MCP**

---

## 14. Daily workflow

Here is the recommended way to use The Curator day-to-day:

### When you find something worth keeping

1. Save the article/chapter/notes as a `.txt` or `.pdf` file
2. Open The Curator (double-click the Dock icon, or go to `http://localhost:3333`)
3. Choose the right domain, upload the file, click **Ingest**
4. In Obsidian, press `Cmd/Ctrl + R` to see the new pages appear in the graph

### When you want to recall something

1. Open The Curator
2. Go to the **Chat** tab, pick a domain, and ask your question (or continue an old conversation)
3. Get a cited answer pointing to specific wiki pages
4. Click through to Obsidian to read the source page in full

### When you want to explore connections

1. Open Obsidian
2. Open the Graph view
3. Click on a topic you're curious about
4. Explore what it connects to

---

## 15. Sync across computers

The **Sync** tab keeps your wiki and chat history in sync across all your computers using a free, private GitHub repository — no subscription, no third-party service. Your notes never touch any server you don't control.

> 📖 **For the full sync deep-dive** (every wizard step with screenshots, conflict recovery, organisational/team-shared brain pattern, token expiry strategy), see **[docs/sync.md](sync.md)**. The summary below is enough for most users.

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
4. Click **Create repository** — leave everything else as default
5. Copy the URL from your browser (e.g. `https://github.com/your-username/my-brain`)

#### Step 2 — Create a Personal Access Token

This is how The Curator gets permission to read and write your private repository.

1. Go to **[github.com/settings/tokens/new](https://github.com/settings/tokens/new?scopes=repo&description=the-curator)** (you may need to sign in)
2. Give the token any name — e.g. `the-curator`
3. Under **Select scopes**, check the **repo** box ☑
4. Set **Expiration** to "No expiration" (recommended — so you don't need to regenerate it)
5. Scroll down and click **Generate token**
6. **Copy the token immediately** — GitHub only shows it once. It starts with `ghp_`

#### Step 3 — Connect in the app

1. Click the **Sync** tab in The Curator
2. Click **Set Up Sync — takes 3 minutes**
3. **Step 1 of 3:** Paste your repository URL → click Continue
4. **Step 2 of 3:** Paste your token → click Continue
5. **Step 3 of 3:** Choose your role:
   - **First computer** — you have knowledge here already; push it to GitHub
   - **Other computers** — you've already synced on another machine; pull from GitHub

The wizard connects to GitHub, creates the initial snapshot, and confirms when done. The whole process takes about 30 seconds once your details are entered.

### Daily workflow

**Golden rule:** always Sync Up on the machine you just worked on, Sync Down before you start on a different machine.

```
Computer A (worked here)    →  click Sync Up  →  GitHub
                                                      ↓
Computer B (starting here)  ←  click Sync Down ←  GitHub
```

**What the buttons do:**

| Button | What happens |
|--------|-------------|
| **↑ Sync Up** | Saves all your local changes as a snapshot and sends them to GitHub |
| **↓ Sync Down** | Downloads the latest snapshot from GitHub to this computer |

After Sync Down, domain stats and the Wiki tab update automatically. Switch to the Chat tab to see newly arrived conversations.

### Setting up a second (or third) computer

On any additional computer:

1. Install the app (run the one-command installer, or `git clone` + `npm install`)
2. Open the app and complete the onboarding wizard
3. Click the **Sync** tab
4. Click **Set Up Sync**
5. Enter the **same repository URL** and the **same token** as before
6. Choose **Other computers — Pull**

The wizard downloads all your wiki pages and conversations from GitHub. Done.

### What happens if you forget to sync

If you worked on Computer A without syncing, then worked on Computer B without syncing first, the app handles it gracefully:

- When you click **Sync Down** on either machine, it automatically saves your local changes first before pulling from GitHub
- In most cases this resolves itself cleanly
- In rare cases (same page edited on two machines), you may see a conflict message — the fix is always: go to the machine where you last synced, Sync Up from there, then Sync Down on the other

### Disconnecting

If you want to remove the sync connection from one computer (without affecting GitHub or other computers):

1. Go to the **Sync** tab
2. Scroll to the bottom and click **Disconnect sync**
3. Confirm the prompt

Your GitHub repository is not changed. You can reconnect at any time using the wizard.

---

## 16. Settings

The **Settings** tab (gear icon) gives you control over app configuration without editing files.

### API keys

The Settings tab shows your currently configured API keys (masked for security) and which provider is active. To change a key:

1. Click the **Settings** tab
2. Paste a new key into the Gemini or Anthropic field
3. Click **Save**

The active provider switches automatically based on which keys are configured (Gemini takes priority when both are present).

> Keys entered in Settings are stored in `.curator-config.json` at the project root. This file is gitignored and never committed. If you also have keys in `.env`, the Settings tab values take priority.

### Version and updates

The Settings tab displays the current app version. Click **Check for Updates** to compare your version against the latest release on GitHub. If an update is available, click **Update Now** — the app pulls the latest code, reinstalls dependencies, rebuilds the Dock app, and restarts automatically. The browser reloads on its own.

### App info

A link to the project's GitHub repository is available in the bottom-right corner of every page.

---

## 17. Wiki Health

The **Health** tab scans a domain's wiki for structural issues and lets you fix them with one click. Use it if your wiki starts to feel messy — broken links, duplicate entities, pages that don't show up in the graph — or as part of your regular maintenance after a batch of ingests.

> 📖 **For the AI-assisted features** (Phase 1 broken-link rescue, Phase 2 orphan rescue, Phase 3 semantic-duplicate detection — what each phase does, what data leaves your machine, exact cost math), see **[docs/ai-health.md](ai-health.md)**. The summary below covers the regular structural scan.

### What it checks

| Issue | What it means | Action |
|-------|---------------|--------|
| **Broken links** | A `[[wikilink]]` points to a page that doesn't exist. Often a typo, hyphen drift, or a link to a page the LLM hasn't written yet. | **Apply** (if the scanner found a close match) rewrites the link to the suggested target. Rows without a suggestion now also show a ✨ **Ask AI** button (v2.4.3+) that calls your configured LLM to propose a target with rationale and confidence — see [ai-health.md](ai-health.md). Otherwise the row stays **Review** — either ingest more content on that topic, remove the brackets, or pick a different target manually. |
| **Orphan pages** | An entity or concept page has zero incoming links. Not necessarily an error — a page becomes connected as future ingests reference it. | **Review** — keep, merge, or delete from Obsidian. Many orphans resolve themselves over time as the wiki grows. From v2.4.4, each orphan row also gets a ✨ **Ask AI** button that proposes up to 5 existing pages which should link to this one, each with an AI-written bullet description — see [ai-health.md](ai-health.md). |
| **Folder-prefix links** | Links like `[[concepts/rag]]` instead of `[[rag]]`. Obsidian treats these as separate pages, breaking the graph. | **Fix** — strips the prefix automatically. |
| **Cross-folder duplicates** | The same page exists in both `entities/` and `concepts/` (e.g. `entities/google.md` + `concepts/google.md`). | **Fix** — merges the concept into the entity version, keeping all bullets. |
| **Hyphen variants** | Entity files differing only in hyphenation (e.g. `tali-rezun` + `talirezun`). | **Fix** — merges into the canonical hyphenated slug. |
| **Missing backlinks** | A summary lists an entity under *Entities Mentioned* but the entity's *Related* section doesn't link back. | **Fix** — injects the missing `[[summaries/...]]` backlink. |

**Auto-fixable issues** have a **Fix** button (and a **Fix all (N)** button at the top of the section). **Broken links** use the same flow per-row but with an **Apply** button — only rows where the scanner found a plausible target are applicable; the bulk action is **Apply all suggestions (N)**. **Orphans** are review-only because no mechanical rule determines whether an unconnected page should stay, merge, or go.

### How to use it

1. Click the **Health** tab (heartbeat icon in the top bar)
2. Pick a domain
3. Click **Scan** — results appear within a second or two
4. For each issue, click **Fix** (or **Apply** for broken links with a suggested target) to apply the repair, or **Fix all (N)** / **Apply all suggestions (N)** to batch the category
5. After fixing, the wiki auto-re-scans so you can see counts drop to zero

### When to run it

- After a large batch of ingests (e.g. 10+ sources in a day)
- When a new user forks an existing knowledge base via sync and wants a clean baseline
- Periodically — once a month is plenty for active domains
- Whenever Obsidian's graph looks noisier than it should

The Health tab doesn't touch source files or conversations — it only cleans the wiki itself. Running it is always safe and idempotent.

### Semantic duplicates (v2.4.5+)

Below the main Health report, when you have an API key configured, a separate **Semantic duplicates** section offers **✨ Scan for semantic duplicates**. This finds pages that the algorithm can't catch — like `[[rag]]` and `[[retrieval-augmented-generation]]`, or `[[email]]` and `[[e-mail]]`, or `[[neural-network]]` and `[[neural-networks]]`.

Unlike the other Health fixes, this one:

- **Costs a small amount** — typically $0.005–$0.03 per scan on Gemini Flash Lite. A confirm dialog shows the estimate before you run it.
- **Is opt-in and user-gated.** Nothing happens until you click Scan, then Confirm.
- **Is destructive when you merge a pair.** The duplicate file is deleted and every `[[old-slug]]` link in the domain is rewritten to the canonical slug. For this reason, the Merge button stays disabled until you open the **Preview diff** for that pair — the preview shows exactly which files will change.

You can tune **Cost ceiling per scan** and **Maximum candidate pairs per scan** in Settings → AI Wiki Health. Defaults (50k tokens, 500 pairs) are suitable for domains up to ~5k pages; raise them for larger wikis.

For the full guide, see [ai-health.md](ai-health.md).

---

## 18. Troubleshooting

**"command not found: node" when I type `node src/server.js`**

Node.js is not installed, or the terminal can't find it. Download it from [nodejs.org](https://nodejs.org) (LTS version), install it, then close and reopen your terminal.

**"No LLM API key found" error when starting the server**

No API key is configured. Open the app in your browser — the onboarding wizard will prompt you to enter your key. Alternatively, go to the **Settings** tab and paste your key there. If you prefer to use a file, check that `.env` exists in the `the-curator` folder with `GEMINI_API_KEY=your_key_here`.

**The server starts but `http://localhost:3333` shows "This site can't be reached"**

The server stopped or crashed. Go back to your terminal and run `node src/server.js` again.

**Ingest spins for a very long time then fails**

- Check your internet connection (the app needs to reach Google's API)
- Check that your Gemini API key is valid at [aistudio.google.com](https://aistudio.google.com)
- Try a smaller file first (under 50 pages) to confirm the setup works

**PDF text comes out garbled or empty**

The PDF is scanned (an image of a page, not real text). Copy the text manually and save it as a `.txt` file instead.

**Pages are not showing up in Obsidian after an ingest**

Press `Cmd/Ctrl + R` in Obsidian to force a refresh, or close and reopen the vault. Obsidian does not always detect new files automatically.

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

Then double-click the Dock icon again. If the log shows a different error (e.g. a missing API key), the onboarding wizard will help when you open `http://localhost:3333` manually in your browser.

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
| **Ingest** — by far the biggest consumer | **Wiki tab** (browse) |
| **Chat tab** — every message + reply | **Domain management** (create / rename / delete) |
| **Wiki Health — ✨ Ask AI on broken links** (Phase 1) | **GitHub Sync** (Sync Up / Sync Down) |
| **Wiki Health — ✨ Ask AI on orphan pages** (Phase 2) | **Wiki Health structural scan** + deterministic fixes (folder-prefix, hyphen variants, cross-folder dedup, missing backlinks) |
| **Wiki Health — Semantic duplicate scan** (Phase 3, opt-in & cost-gated) | **Settings**, **API key management**, **updates** |
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
- Chat tab usage adds ~1 call per message.

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

For a typical 10-page article:

| | Gemini 2.5 Flash Lite | Claude Haiku 4.5 |
|---|---|---|
| Input tokens (article + index + entity list) | ~10k | ~10k |
| Output tokens (5–15 wiki pages, frontmatter, links) | ~5k | ~5k |
| Cost per ingest | **~$0.003** (≈€0.003) | **~$0.035** (≈€0.03) |
| Cost per 100 ingests | ~$0.30 | ~$3.50 |

These numbers ignore prompt caching (Anthropic only) and the small per-call overhead from the LLM-not-found fallback chain (v2.4.0+).

### Practical guidance

1. **Start on Gemini free tier** to make sure the app is right for you (1–5 ingests, browse the wiki, try the Chat tab).
2. **As soon as you want to ingest a batch or a book, enable billing in Google AI Studio.** No credit card = no scaling. The bill will almost always be under €10/month for personal use.
3. **Use Claude Haiku 4.5 only if you specifically need Anthropic.** It is 10× the price for ~equivalent quality on this workload.
4. **Set an AI Studio budget alert** on your Google Cloud project (e.g. €20/month) so you can't be surprised.
5. **Don't worry about chat cost** — it's a fraction of ingest cost. Multi-turn conversations on a 2,000-page wiki cost cents.

### What about MCP / Health / semantic dupe scans?

- **My Curator MCP** runs entirely on your machine and **costs you nothing** in API fees — it's just a local read-only bridge. The frontier model you connect *to* it (Claude Desktop, etc.) bills you separately on its own plan.
- **Wiki Health structural scan** is local and **free**.
- **Wiki Health Phase 1 / 2 (✨ Ask AI)** uses your configured provider; ~$0.0001–0.0005 per click. Trivial.
- **Wiki Health Phase 3 (semantic dupe scan)** is **opt-in and cost-gated**. A 500-pair scan on Gemini Flash Lite costs ~$0.03; a confirm dialog shows the estimate before you run it. See [docs/ai-health.md](ai-health.md).

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
6. Open the URL once the server is running so I can complete the onboarding wizard (API key + first domain).
7. Tell me what to do if I want to enable GitHub sync (point me to docs/sync.md).

Do not edit any files outside ~/the-curator. Do not commit anything to my git config. Do not ask me for my API key — the in-app onboarding wizard will handle it. After the install finishes, summarise what you did in 5 bullet points.
```

### What you should know

- Most agents will ask before running `npm install` and before launching the server. Approve those — they're the install.
- If the agent doesn't have permission to install Node.js system-wide, it will tell you. On Linux, `sudo apt install nodejs npm` (or your distro's equivalent) is enough.
- After the install, the **onboarding wizard** in the browser handles the rest: API key, first domain, optional sync setup. The agent should not need to touch any of that.
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
| 🔁 [Sync Guide](sync.md) | The full GitHub sync workflow — including team-shared brains and conflict recovery |
| 📁 [Adding Domains](adding-domains.md) | Create domains via the UI or by hand |
| 🎨 [Domain Schemas](domain-schemas.md) | Customise how the AI structures knowledge per domain |
| 🔄 [Model Lifecycle](model-lifecycle.md) | What happens when a provider retires a model — fallback chain explained |
| 🍎 [Mac App Setup](mac-app.md) | Detailed Mac Dock launcher instructions |
| 🛠 [API Reference](api-reference.md) | REST API endpoints (for developers) |
| 🏗 [Architecture](architecture.md) | System design (for developers) |
