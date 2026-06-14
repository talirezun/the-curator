# The Curator — Documentation

## What is The Curator?

We live in the age of information overload. Every day you read articles, watch lectures, skim research papers, and save "interesting things" — then forget them completely within a week. Your notes app is a graveyard. Your bookmarks are never opened again. And when you actually need to recall something, it's gone.

**The Curator solves this.** It is a local, AI-powered knowledge system that turns the documents you consume into a living, searchable, interconnected wiki — one that you can actually chat with like a knowledgeable assistant, and sync across all your computers.

The core insight, from researcher Andrej Karpathy and educator Nick Spisak: **one general-purpose second brain that covers everything ends up good at nothing.** Instead, you maintain focused wikis per domain — one for AI/Tech, one for Business, one for Personal Growth. Each one is a specialist. Each one compounds in value with every source you add.

### What you can do with it

- **Ingest** any PDF, article, or note — the AI reads it and automatically writes interlinked wiki pages: summaries, entity pages (people, tools, companies), and concept pages (ideas, frameworks, techniques)
- **Chat** with your knowledge base in a full multi-turn conversation — ask follow-up questions, connect ideas across sources, and get cited answers from your own wiki. Conversations are saved and survive server restarts
- **Explore** your knowledge visually as an interactive graph in Obsidian — see how ideas, people, and tools connect across everything you've read
- **Sync** your entire wiki and chat history across computers using a free private GitHub repository — one 3-minute setup, then a single **Sync now** button (with optional Push-only / Pull-only advanced controls) for daily use
- **Build** a personal library that gets smarter over time — the more you add, the richer the connections

### Why it matters

Most people consume information passively and retain almost none of it. The Curator turns passive consumption into active knowledge. Instead of reading an article and forgetting it, you ingest it — and from that point on, it's part of a growing, conversational, visual knowledge system that is entirely yours, stored on your computer, with no subscriptions or cloud accounts required.

For students, researchers, entrepreneurs, and lifelong learners: this is the difference between having a pile of notes and having a thinking partner that knows everything you've ever read — on every computer you own.

---

## Start here

**New to the project?** Read the [User Guide](user-guide.md) — it covers everything from installation to chat, sync, and Obsidian, written in plain language for non-technical users.

**Want to sync across computers?** Read the [Sync Guide](sync.md) — a 3-minute setup connects your knowledge to a private GitHub repository. Prefer to let an AI agent do it? See [Set up sync with a coding agent](sync-via-coding-agent.md).

**Want to contribute to a collective wiki with your cohort or team?** Start with the [Shared Brain User Guide](shared-brain-user-guide.md) — step-by-step setup for contributors and admins. `v3.0.0-beta+`, opt-in beta feature. Each contributor keeps a private brain; only opted-in domains push to the shared repo. The [architecture doc](shared-brain.md) covers what's happening under the hood; [admin operations](shared-brain-admin.md) cover ongoing duties; [compliance reference](shared-brain-compliance.md) covers GDPR/IP/EU residency.

**On a Mac?** Read [Mac App Setup](mac-app.md) to turn The Curator into a double-click app in your Dock — no terminal needed.

---

## All documents

**For users**

| Document | What's inside |
|----------|---------------|
| [user-guide.md](user-guide.md) | The master guide — setup, ingest, chat, Obsidian, sync, daily workflow, troubleshooting |
| [use-cases.md](use-cases.md) | Detailed workflows for every user profile |
| [mcp-user-guide.md](mcp-user-guide.md) | My Curator MCP — connect your wiki to Claude Desktop / VS Code / LM Studio for frontier-model research and write-back |
| [ai-health.md](ai-health.md) | AI-assisted Wiki Health — broken-link rescue, orphan rescue, semantic-duplicate detection, persistent dismissals |
| [sync.md](sync.md) | Personal Sync — GitHub backup of your full wiki across your own computers (wizard, token permissions, troubleshooting) |
| [sync-via-coding-agent.md](sync-via-coding-agent.md) | Set up sync automatically with a coding agent (Claude Code, Cursor, opencode…) — one copy-paste prompt |
| [shared-brain-user-guide.md](shared-brain-user-guide.md) | **Shared Brain — User Guide (v3.0.0-beta+)** — step-by-step setup for contributors AND admins, daily workflow, troubleshooting |
| [shared-brain.md](shared-brain.md) | Shared Brain — concept, architecture, engineering decisions, v3.x+ roadmap |
| [shared-brain-admin.md](shared-brain-admin.md) | Shared Brain — advanced admin operations (synthesis cadence, revocation, contributor management) |
| [shared-brain-compliance.md](shared-brain-compliance.md) | Shared Brain — GDPR / IP / data residency reference for orgs evaluating deployment |
| [shared-brain-monetization.md](shared-brain-monetization.md) | Shared Brain — monetizing access (paid subscriptions, knowledge products, tiered access for independent experts and organisations) |
| [domains.md](domains.md) | Domains end-to-end — managing them, the CLAUDE.md schema, siloing model, custom templates |
| [mac-app.md](mac-app.md) | How to create a double-click Dock app on macOS so you never need the terminal |

**For developers**

| Document | What's inside |
|----------|---------------|
| [ingestion-pipeline.md](ingestion-pipeline.md) | **The technical deep dive on the most critical code path in The Curator** — every stage, every safeguard, the quality contract, Mermaid diagrams. Read this before debugging or extending the ingest code. |
| [architecture.md](architecture.md) | System design, data flow, module reference |
| [api-reference.md](api-reference.md) | Full REST API documentation |
| [model-lifecycle.md](model-lifecycle.md) | Provider/model fallback policy and what happens when a model is retired |
| [audits/](audits/) | Historical audit reports per release (snapshots of the codebase quality at each version) |

---

## Quick start (experienced users)

```bash
# 1. Clone and install
git clone https://github.com/talirezun/the-curator.git
cd the-curator
npm install

# 2. Create .env and add your Gemini API key
cp .env.example .env
# Open .env and set: GEMINI_API_KEY=your_key_here

# 3. Start
node src/server.js

# 4. Open the app
# Go to http://localhost:3333 in your browser
```

Get a free Gemini API key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).

To sync across computers, go to the **Sync tab** in the app and follow the 3-step wizard. See [sync.md](sync.md) for details.
