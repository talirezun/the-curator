# Second Brain

<p align="center">
  <img src="images/icon-192.png" alt="Second Brain" width="96" height="96" />
</p>

A local, AI-powered knowledge system. Feed it documents — articles, PDFs, notes — and it automatically builds an interlinked wiki of key people, tools, and ideas. Have a multi-turn AI conversation with your knowledge. Explore everything as a visual knowledge graph in Obsidian. Sync seamlessly across computers via a private GitHub repository.

Built on the [Karpathy llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) concept: instead of one general-purpose second brain that tries to cover everything, you maintain **dedicated wikis per domain** (e.g. AI/Tech, Business, Personal Growth). Each one gets smarter with every source you add.

## How it works

```
1. Upload a PDF, article, or note
         ↓
2. AI reads it and writes 5–15 interlinked wiki pages
   (summary + entity pages + concept pages)
         ↓
3. Chat with your knowledge — multi-turn AI conversations
   with full memory, cited answers, persistent history
         ↓
4. Open Obsidian → explore the visual knowledge graph
         ↓
5. Sync Up → your knowledge is on GitHub, available everywhere
```

Everything is stored as plain markdown files on your computer. No subscriptions, no database, no accounts — except a free Gemini API key.

## Features

- Drop in a `.pdf`, `.txt`, or `.md` file — the AI does the rest
- Automatic extraction of people, tools, companies, frameworks, and concepts
- Every page cross-references related pages with `[[wiki-links]]`
- **Multi-turn AI chat** with persistent conversation history — ask follow-ups, connect the dots across sources, pick up where you left off
- Visual knowledge graph via [Obsidian](https://obsidian.md) (free app, reads the same files)
- **GitHub sync** — one-time 3-minute setup, then Sync Up / Sync Down across any number of computers. Uses a free private repository you own
- Supports **Google Gemini** (recommended, very cheap) and **Anthropic Claude**
- Three built-in domains: AI/Tech · Business/Finance · Personal Growth
- Add unlimited custom domains — no code changes required
- Mac Dock app — double-click to launch, no terminal needed

## Two ways to explore your knowledge

| Mode | Tool | Best for |
|------|------|----------|
| **Chat** | Built-in AI (Chat tab) | "How does X relate to Y?", synthesising across sources, multi-turn conversation |
| **Visual** | Obsidian graph view | Seeing the full knowledge map, spotting clusters, browsing pages |

Both read the same files — no sync or export needed between them.

## Quick start

### Prerequisites
- [Node.js 18+](https://nodejs.org) (free)
- A [Google Gemini API key](https://aistudio.google.com/app/apikey) (free)
- [Obsidian](https://obsidian.md) for the knowledge graph (free, optional)

### Setup

```bash
# 1. Download the project
git clone https://github.com/talirezun/second-brain.git
cd second-brain

# 2. Install dependencies
npm install

# 3. Create your config file
cp .env.example .env
```

Open `.env` in any text editor and add your API key:
```
GEMINI_API_KEY=AIza...your key here...
```

### Run

```bash
node src/server.js
```

Then open **http://localhost:3333** in your browser.

> First time? Read the full **[User Guide](docs/user-guide.md)** — it covers every step in plain language, including how to get your API key, how to use the chat, and how to set up Obsidian.

## Chat with your knowledge

The **Chat tab** is a full multi-turn conversation interface. Ask anything about your wiki — the AI answers from your own pages, cites its sources, and remembers the entire conversation thread. Past conversations are saved and survive server restarts.

```
You:  What is RAG and why does it matter?
AI:   RAG combines retrieval with generation… [source: concepts/rag.md]

You:  How does it compare to fine-tuning?
AI:   As I mentioned, the key advantage is… [source: summaries/rag-paper.md]
```

Create multiple conversations per domain. Delete old ones. Pick up any thread later.

## Sync across computers

The **Sync tab** connects your Second Brain to a private GitHub repository so your wiki and chat history are available on every machine you work on.

**One-time setup (~3 minutes):**
1. Create a free private repository on GitHub
2. Generate a Personal Access Token with `repo` scope
3. Open the Sync tab → follow the 3-step wizard

**Daily use:**
- Click **Sync Up** after working on any computer
- Click **Sync Down** before starting on a different computer

What syncs: wiki pages, chat history, domain schemas.  
What stays local: source files, API keys, app code.

See [docs/sync.md](docs/sync.md) for the full guide.

## Using Obsidian for the knowledge graph

After ingesting your first document, open Obsidian → **Open folder as vault** → select the `second-brain/domains` folder. Click the graph icon in the sidebar to see all your knowledge as an interactive, zoomable network. No configuration needed — it reads the same files the app writes.

## Project structure

```
second-brain/
├── src/
│   ├── server.js           Express server (port 3333)
│   ├── routes/             API route handlers
│   ├── brain/
│   │   ├── llm.js          LLM abstraction (Gemini + Claude)
│   │   ├── ingest.js       Ingest pipeline (single-pass + multi-phase for large docs)
│   │   ├── chat.js         Multi-turn chat with persistent conversations
│   │   ├── sync.js         GitHub sync (git --git-dir / --work-tree)
│   │   └── files.js        Filesystem helpers
│   └── public/             Web UI (vanilla JS, no build step)
├── domains/
│   └── <domain>/
│       ├── CLAUDE.md       Domain schema (instructions for the AI)
│       ├── raw/            Your original uploaded files (local only)
│       ├── wiki/           Auto-generated knowledge pages
│       └── conversations/  Saved chat threads
├── images/                 App icon in multiple sizes (32, 180, 192 px)
└── docs/                   Full documentation
```

## Documentation

| | |
|-|-|
| [User Guide](docs/user-guide.md) | Full setup + usage guide for all levels |
| [Sync Guide](docs/sync.md) | GitHub sync — setup, daily workflow, troubleshooting |
| [Mac App Setup](docs/mac-app.md) | Double-click Dock launcher for Mac |
| [Adding Domains](docs/adding-domains.md) | Create custom domain wikis |
| [Domain Schemas](docs/domain-schemas.md) | Customise how the AI structures knowledge |
| [API Reference](docs/api-reference.md) | REST API documentation |
| [Architecture](docs/architecture.md) | System design for developers |

## App icon

The Second Brain icon is available in the [`images/`](images/) folder for reference, customisation, and use in launchers or documentation:

| File | Size | Use |
|------|------|-----|
| [`images/icon-32.png`](images/icon-32.png) | 32×32 | Browser favicon |
| [`images/icon-192.png`](images/icon-192.png) | 192×192 | General purpose / Android |
| [`images/icon-180.png`](images/icon-180.png) | 180×180 | Apple touch icon / iOS |

## Security

- Your API key lives in `.env` — gitignored, never committed
- Sync token lives in `.sync-config.json` — gitignored, never committed
- The app runs entirely on your local machine — the only outbound calls are to Gemini/Claude and (when syncing) to your own private GitHub repo
- Do not expose the server on a public network (it has no authentication)

> **Axios note:** This project does not use Axios. If you extend it to fetch URLs, avoid compromised versions `axios@1.14.1` and `axios@0.30.4`.

## License

MIT — see [LICENSE](LICENSE).
