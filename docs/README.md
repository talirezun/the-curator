# The Curator — Documentation

## What is The Curator?

**The Curator is where your context lives** — both the knowledge you have accumulated and the
state of the work you are doing — as plain markdown files on your own machine. Any editor opens
them, your own private GitHub repo syncs them, and any local MCP client reads and writes them.

That matters because the alternatives do not work that way. Claude Projects, ChatGPT Projects and
Cursor rules each hold your accumulated context inside one vendor's product, and you leave it
behind on the day you switch tools, models or machines. There is nothing here to leave behind:
the files *are* the product, and the app is a convenience over them.

### The three layers

> **Your brain → your team's brain → your agents' brain.**

| Layer | What it holds | Behaviour | Where it lives |
|---|---|---|---|
| **1. Your brain** | Knowledge you have read and understood — entities, concepts, summaries, cross-linked | **Accumulates**: a new source updates existing pages rather than duplicating them | `domains/<d>/wiki/` |
| **2. Your team's brain** | The same, built collectively by a cohort, team or research group. Opt-in; your other domains never leave your machine | **Accumulates**, collectively | `domains/shared-<slug>/wiki/` (read-only mirror) |
| **3. Your agents' brain** | Where the work stands: what is settled, what to do next, what was tried and ruled out | **Supersedes**: each save replaces the previous handoff, so a resolved blocker cannot come back | `domains/<d>/state/` |

One format, one owner, three layers. Layers 1 and 2 are built by *ingesting* sources — that is
the means, not the point. Layer 3 is written by an agent over MCP and read back by the next
session, on any tool and any machine.

**The boundary between layers 1–2 and layer 3 is worth learning before you use it.** Knowledge
accumulates; state supersedes. Durable material put into state is overwritten by the next save,
and nothing warns you — from the store's point of view, overwriting is correct. The decision
table lives in [working-state.md](working-state.md#1-the-problem-it-solves).

### Two honest boundaries

- **The MCP bridge is a stdio child process.** It works with any MCP client that can spawn a
  local program — Claude Code, Claude Desktop, Cursor, and other MCP-capable agents — and it does
  not need the web app running. A browser-only assistant cannot reach it. The limit is the
  transport, not the vendor.
- **The skills are portable in content, Claude-shaped in activation.** Their text is ordinary prose
  and works anywhere you can paste it; what is Claude-specific is how they *switch on* (the
  tool-permission header, auto-triggering from a description, and the install path). So an agent in
  another harness can **read** working state through MCP fine, but nothing tells it to **save**.
  The store is portable; the discipline that fills it is not yet.
- **Capture is advisory.** Nothing forces a save at the end of a session; the skill layer prompts
  for one. A missed save means the next read returns the **previous** state — stale, never
  corrupted. The standing project brief is human-authored; no tool writes it.

### The insight behind layer 1

From researcher Andrej Karpathy and educator Nick Spisak: **one general-purpose second brain that covers everything ends up good at nothing.** Instead, you maintain focused wikis per domain — one for AI/Tech, one for Business, one for Personal Growth. Each one is a specialist. Each one compounds in value with every source you add.

### What you can do with it

- **Ingest** any PDF, article, or note — the AI reads it and automatically writes interlinked wiki pages: summaries, entity pages (people, tools, companies), and concept pages (ideas, frameworks, techniques)
- **Chat** with your knowledge base in a full multi-turn conversation — ask follow-up questions, connect ideas across sources, and get cited answers from your own wiki. Conversations are saved and survive server restarts
- **Explore** your knowledge visually as an interactive graph in Obsidian — see how ideas, people, and tools connect across everything you've read
- **Carry your work forward** — an agent saves the handoff at the end of a session and reads it at the start of the next one, across sessions, agents, models, harnesses and machines
- **Sync** your entire wiki, chat history and working state across computers using a free private GitHub repository — one 3-minute setup, then a single **Sync now** button (with Push only / Pull only alongside it) for daily use
- **Build** a personal library that gets smarter over time — the more you add, the richer the connections

---

## Start here

**New to the project?** Read the [User Guide](user-guide.md) — it covers everything from installation to chat, sync, and Obsidian, written in plain language for non-technical users.

**Want to sync across computers?** Read the [Sync Guide](sync.md) — a 3-minute setup connects your knowledge to a private GitHub repository. Prefer to let an AI agent do it? See [Set up sync with a coding agent](sync-via-coding-agent.md).

**Working with agents and losing context between sessions?** Read [Working state](working-state.md) — layer 3. Point your agent at a domain over MCP and the handoff survives a change of session, agent, model, harness or machine. Start with the [MCP guide](mcp-user-guide.md) to install the bridge.

**Want to contribute to a collective wiki with your cohort or team?** Start with the [Shared Brain User Guide](shared-brain-user-guide.md) — step-by-step setup for contributors and admins. `v3.0.0-beta+`, opt-in beta feature. Each contributor keeps a private brain; only opted-in domains push to the shared repo. The [architecture doc](shared-brain.md) covers what's happening under the hood; [admin operations](shared-brain-admin.md) cover ongoing duties; [compliance reference](shared-brain-compliance.md) covers GDPR/IP/EU residency.

**On a Mac?** Read [Mac App Setup](mac-app.md) to turn The Curator into a double-click app in your Dock — no terminal needed.

---

## All documents

The user documentation is grouped by layer, so you can enter at whichever one you came for. The
first group applies to all three.

**Everything — setup and the ground you stand on**

| Document | What's inside |
|----------|---------------|
| [user-guide.md](user-guide.md) | The master guide — setup, ingest, chat, Obsidian, sync, daily workflow, troubleshooting |
| [use-cases.md](use-cases.md) | Detailed workflows for every user profile, including coding continuity across sessions and tools |
| [domains.md](domains.md) | Domains end-to-end — managing them, the CLAUDE.md schema, siloing model, custom templates. A domain is the container all three layers live in |
| [sync.md](sync.md) | Personal Sync — GitHub backup of your wiki, chat history and working state across your own computers (wizard, token permissions, troubleshooting) |
| [sync-via-coding-agent.md](sync-via-coding-agent.md) | Set up sync automatically with a coding agent (Claude Code, Cursor, opencode…) — one copy-paste prompt |
| [system-check.md](system-check.md) | Settings → System Check — confirm the app setup (API key, knowledge folder, credential permissions, sync) + an optional AI connection test |
| [mac-app.md](mac-app.md) | How to create a double-click Dock app on macOS so you never need the terminal |

**Layer 1 — your brain** (the personal wiki; knowledge accumulates)

| Document | What's inside |
|----------|---------------|
| [ai-health.md](ai-health.md) | AI-assisted Wiki Health — broken-link rescue, orphan rescue, semantic-duplicate detection, persistent dismissals |
| [mcp-user-guide.md](mcp-user-guide.md) | My Curator MCP — expose the wiki *and* the working state to any local MCP client (Claude Code, Claude Desktop, Cursor) for frontier-model research and write-back |

**Layer 2 — your team's brain** (Shared Brain; opt-in, `v3.0.0-beta+`)

| Document | What's inside |
|----------|---------------|
| [shared-brain-user-guide.md](shared-brain-user-guide.md) | **Start here** — step-by-step setup for contributors AND admins, daily workflow, troubleshooting |
| [shared-brain.md](shared-brain.md) | Concept, architecture, engineering decisions, v3.x+ roadmap |
| [shared-brain-admin.md](shared-brain-admin.md) | Advanced admin operations (synthesis cadence, revocation, contributor management) |
| [shared-brain-compliance.md](shared-brain-compliance.md) | GDPR / IP / data residency reference for orgs evaluating deployment |
| [shared-brain-monetization.md](shared-brain-monetization.md) | Monetizing access (paid subscriptions, knowledge products, tiered access for independent experts and organisations) |

**Layer 3 — your agents' brain** (working state; state supersedes)

| Document | What's inside |
|----------|---------------|
| [working-state.md](working-state.md) | Carry build context across sessions, agents, models, harnesses and machines through MCP. What the store holds, why state supersedes while knowledge accumulates, how to treat what comes back, and what is deliberately not built |

**For developers**

| Document | What's inside |
|----------|---------------|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Developer setup, running the tests (`npm test` / `npm run test:live`), adding a test, cutting a release |
| [ingestion-pipeline.md](ingestion-pipeline.md) | **The technical deep dive on the most critical code path in The Curator** — every stage, every safeguard, the quality contract, Mermaid diagrams. Read this before debugging or extending the ingest code. |
| [architecture.md](architecture.md) | System design, data flow, module reference |
| [api-reference.md](api-reference.md) | REST API reference — the endpoints an integrator is most likely to need. Not exhaustive: some shipped routes (notably the `/api/sync/*` family) have no entry yet, so treat the routers under [`src/routes/`](../src/routes/) as the authoritative list |
| [model-lifecycle.md](model-lifecycle.md) | Provider/model fallback policy and what happens when a model is retired |
| [audits/](audits/) | Historical audit reports per release (snapshots of the codebase quality at each version) |

---

## Quick start (experienced users)

```bash
# 1. Clone and install
git clone https://github.com/talirezun/the-curator.git
cd the-curator
npm install

# 2. Create .env and add an AI provider key
cp .env.example .env
# Open .env and set ONE of:
#   GEMINI_API_KEY=your_key_here
#   ANTHROPIC_API_KEY=your_key_here
#   OPENROUTER_API_KEY=your_key_here

# 3. Start
node src/server.js

# 4. Open the app
# Go to http://localhost:3333 in your browser
```

Any one of the three is enough — all three can build your wiki. Get a free Gemini key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey), an Anthropic key at [console.anthropic.com](https://console.anthropic.com), or an OpenRouter key at [openrouter.ai/keys](https://openrouter.ai/keys). `.env` is a developer fallback; the ordinary route is to paste the key into Settings once the app is running, which stores it in `.curator-config.json` instead. Saving a key also makes that provider the active one — see [user-guide.md](user-guide.md#api-keys) and [model-lifecycle.md](model-lifecycle.md).

To sync across computers, click **Sync** in the app's left rail (bottom) and fill in the Connect card. See [sync.md](sync.md) for details.
