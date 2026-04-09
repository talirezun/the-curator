# Architecture

> This document is intended for developers who want to understand how the system works internally.

## Overview

Second Brain is a local Node.js web application. It has no external database — all knowledge is stored as plain markdown files on disk. An LLM (Google Gemini or Anthropic Claude, selected by which API key is in `.env`) is the only external dependency at runtime.

```
Browser (http://localhost:3333)
        │
        │  HTTP
        ▼
┌─────────────────────────────────────┐
│           Express server            │
│           src/server.js             │
│                                     │
│  /api/domains  /api/ingest          │
│  /api/chat     /api/wiki/:domain    │
└───────────────┬─────────────────────┘
                │
        ┌───────┴──────────┐
        │                  │
        ▼                  ▼
┌──────────────┐   ┌──────────────┐
│  brain/      │   │  brain/      │
│  ingest.js   │   │  chat.js     │
└──────┬───────┘   └──────┬───────┘
       │                  │
       └─────────┬─────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│           brain/llm.js              │
│  Provider abstraction layer         │
│  (Gemini or Claude, auto-detected)  │
└─────────────────────────────────────┘
                 │
                 │  API call
                 ▼
┌─────────────────────────────────────┐
│  Google Gemini  OR  Anthropic Claude│
│  (whichever key is set in .env)     │
└─────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│           brain/files.js            │
│  read / write markdown on disk      │
└─────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│  domains/<domain>/                  │
│  ├── CLAUDE.md       (schema)       │
│  ├── raw/            (source files) │
│  ├── wiki/           (knowledge)    │
│  └── conversations/  (chat history) │
└─────────────────────────────────────┘
```

Obsidian (a separate desktop app) reads the same `domains/` folder directly — no sync or export required.

---

## Directory structure

```
second-brain/
├── src/
│   ├── server.js               Express entry point (port 3333)
│   ├── routes/
│   │   ├── domains.js          GET  /api/domains
│   │   ├── ingest.js           POST /api/ingest
│   │   ├── chat.js             GET/POST/DELETE /api/chat/:domain[/:id]
│   │   └── wiki.js             GET  /api/wiki/:domain
│   ├── brain/
│   │   ├── llm.js              LLM abstraction (Gemini + Claude)
│   │   ├── files.js            Filesystem helpers (wiki + conversations)
│   │   ├── ingest.js           Ingest pipeline (single-pass + multi-phase)
│   │   └── chat.js             Chat pipeline (multi-turn, persistent)
│   └── public/
│       ├── index.html          Single-page UI shell
│       ├── app.js              Vanilla JS frontend
│       └── styles.css          Dark-theme styles
├── domains/
│   └── <domain>/
│       ├── CLAUDE.md           Domain schema (system prompt for the LLM)
│       ├── raw/                Immutable uploaded source files
│       ├── wiki/
│       │   ├── index.md        Content catalog
│       │   ├── log.md          Chronological ingest log
│       │   ├── entities/       People, tools, companies, datasets
│       │   ├── concepts/       Ideas, techniques, frameworks
│       │   └── summaries/      One page per ingested source
│       └── conversations/      Saved chat threads (JSON, gitignored)
├── docs/                       This documentation
│   ├── user-guide.md           End-to-end guide for non-technical users
│   ├── architecture.md         This file — system internals
│   └── sync.md                 Step-by-step guide to the GitHub sync feature
├── package.json
├── .env                        API key (never committed)
└── .gitignore
```

---

## LLM provider selection (`src/brain/llm.js`)

The app auto-detects which LLM provider to use based on which key is present in `.env`. `GEMINI_API_KEY` takes priority if both are set.

```
GEMINI_API_KEY set      →  Google Gemini  (default model: gemini-2.5-flash-lite)
ANTHROPIC_API_KEY set   →  Anthropic Claude (default model: claude-sonnet-4-6)
Neither set             →  Error on startup
```

The optional `LLM_MODEL` env var overrides the default model for whichever provider is active.

`generateText(systemPrompt, userPrompt, maxTokens, responseFormat)` is the single function both `ingest.js` and `query.js` call. It handles the provider-specific API differences internally.

For ingest calls, `responseFormat: 'json'` is passed, which enables Gemini's native `responseMimeType: 'application/json'` — this forces the model to produce structurally valid JSON even when the content contains markdown characters (backticks, quotes, backslashes) that would otherwise break parsing.

---

## Data flow: Ingest

```
User uploads file
      │
      ▼
POST /api/ingest  (multipart/form-data: file + domain)
      │
      ▼  multer saves to OS temp dir
src/routes/ingest.js  —  validates domain + file type
      │
      ▼
src/brain/ingest.js
      ├─ 1. Copy file → domains/<domain>/raw/<filename>
      ├─ 2. Extract text (.txt/.md → readFile, .pdf → pdf-parse)
      ├─ 3. Load domains/<domain>/CLAUDE.md  (system prompt)
      ├─ 4. Load domains/<domain>/wiki/index.md  (current wiki state)
      ├─ 5. Call LLM via llm.js  (JSON mode, 32 768 max output tokens)
      │     System:  domain CLAUDE.md schema
      │     User:    date + index + source text (≤80 000 chars) + instructions
      │     Returns: { title, pages: [{path, content}], index }
      ├─ 6. Write each page → domains/<domain>/wiki/<path>
      ├─ 7. Write updated index.md
      └─ 8. Append timestamped entry to log.md

HTTP response → { success: true, title, pagesWritten: [...] }
```

## Data flow: Chat

```
User sends message
      │
      ▼
POST /api/chat/:domain  { message, conversationId? }
      │
      ▼
src/brain/chat.js
      ├─ 1. Load or create conversation from domains/<domain>/conversations/
      ├─ 2. Load domains/<domain>/CLAUDE.md  (system prompt)
      ├─ 3. Read all .md files under domains/<domain>/wiki/
      ├─ 4. Build prompt with last 20 messages as conversation history
      ├─ 5. Call LLM via llm.js  (text mode, 4 096 max output tokens)
      │     System:  domain schema
      │     User:    all wiki pages (≤90 000 chars) + history + message
      │     Returns: markdown answer with [source: path] citation tags
      ├─ 6. Parse [source: ...] tags → deduplicated citation list
      ├─ 7. Append user + assistant messages to conversation
      └─ 8. Save conversation JSON to domains/<domain>/conversations/<id>.json

HTTP response → { conversationId, isNew, title, answer, citations: [...] }

Other chat endpoints:
  GET    /api/chat/:domain        → list conversations (id, title, messageCount)
  GET    /api/chat/:domain/:id    → full conversation (all messages)
  DELETE /api/chat/:domain/:id    → delete conversation
```

### Conversation persistence

Each conversation is a JSON file:

```json
{
  "id": "uuid",
  "title": "First message truncated to 60 chars…",
  "createdAt": "2026-04-09T10:00:00.000Z",
  "domain": "ai-tech",
  "messages": [
    { "role": "user",      "content": "What is RAG?" },
    { "role": "assistant", "content": "RAG stands for…", "citations": ["concepts/rag.md"] }
  ]
}
```

Conversations are gitignored — they are personal to each user's machine.

---

## Module reference

### `src/brain/llm.js`

| Export | Description |
|--------|-------------|
| `getProviderInfo()` | Returns `{ provider, model }` based on env vars |
| `generateText(system, user, maxTokens, responseFormat)` | Single LLM call; handles Gemini and Claude API differences |

### `src/brain/files.js`

Pure filesystem helpers. No LLM calls.

| Export | Description |
|--------|-------------|
| `listDomains()` | Names of all subdirectories under `domains/` |
| `readSchema(domain)` | Contents of `domains/<domain>/CLAUDE.md` |
| `readWikiPages(domain)` | All `.md` files under `wiki/`, returned as `{path, content}[]` |
| `writePage(domain, relativePath, content)` | Write a wiki page, creating parent directories as needed |
| `appendLog(domain, entry)` | Append a string to `log.md` |
| `readIndex(domain)` | Contents of `index.md` |

### `src/brain/files.js` — conversation helpers

| Export | Description |
|--------|-------------|
| `listConversations(domain)` | All conversations for a domain, sorted by date (newest first) |
| `readConversation(domain, id)` | Full conversation object, or `null` if not found |
| `writeConversation(domain, conversation)` | Persist conversation JSON to disk |
| `deleteConversation(domain, id)` | Delete a conversation file |

### `src/brain/ingest.js`

```js
ingestFile(domain, filePath, originalName, isOverwrite?)
  → Promise<{ title: string, pagesWritten: string[] }>
```

Single-pass for small/medium documents; automatically falls back to a three-phase pipeline (outline → batched content → index) for large documents that would exceed the model's output token ceiling.

### `src/brain/chat.js`

```js
sendMessage(domain, conversationId, userMessage)
  → Promise<{ conversationId, isNew, title, answer, citations[] }>

listConversations(domain)   → Promise<ConversationMeta[]>
readConversation(domain, id) → Promise<Conversation | null>
deleteConversation(domain, id) → Promise<void>
```

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@anthropic-ai/sdk` | ^0.39 | Anthropic Claude API client |
| `@google/generative-ai` | ^0.24 | Google Gemini API client |
| `express` | ^4 | HTTP server and routing |
| `multer` | ^2 | Multipart file upload handling |
| `pdf-parse` | ^1 | Extract text from PDF files |
| `fs-extra` | ^11 | Extended filesystem utilities |
| `dotenv` | ^16 | Load `.env` into `process.env` |

**No Axios.** All HTTP is handled by the Express server or Node's native `fetch`. If Axios is added in future (e.g. for URL ingestion), avoid compromised versions `1.14.1` and `0.30.4`; pin to a safe version such as `1.7.9`.

---

## Design decisions

**Why markdown files instead of a vector database?**
At the scale of a focused domain wiki (tens to low hundreds of pages), the LLM can read the entire wiki in a single context window and reason across all of it precisely. Markdown files are human-readable, portable, and work natively with Obsidian's graph view.

**Why a provider abstraction layer?**
`llm.js` keeps `ingest.js` and `query.js` free of provider-specific code. Switching between Gemini and Claude requires only changing an env var — no code changes. Adding a third provider (e.g. local Ollama) means only touching `llm.js`.

**Why one CLAUDE.md schema per domain?**
Domain context shapes how the LLM categorises knowledge. An AI/Tech wiki uses different entity types and concept hierarchies than a Personal Growth wiki. Per-domain schemas give each wiki a specialist, not a generalist.

**Why vanilla JS instead of React/Vue?**
The UI has three tabs and a handful of fetch calls. A framework adds build complexity and bundle size with no meaningful benefit for a local personal tool.

**Why JSON mode for ingest but not chat?**
Ingest requires structured output (pages + index as a JSON object) that must be machine-parsed. Chat returns free-form markdown prose; JSON mode would constrain the writing style unnecessarily.

**Why save conversations as JSON files instead of a database?**
Consistent with the project's "no external database" principle. JSON files are human-readable, portable, and trivially backed up or shared. SQLite would add a dependency and binary file for a feature that doesn't need relational queries. Each conversation is a self-contained document.

**Why are conversations gitignored from the app repo but synced through the knowledge repo?**
Conversations are personal knowledge — specific to each user's ingested documents and questions. They are gitignored from the app's own repository (so contributors don't accidentally commit private data), but they live inside `domains/*/conversations/` which is included in the knowledge repository managed by the Sync feature. This means conversations travel with the rest of your knowledge when you sync across computers, while still being invisible to anyone looking at the app's source code on GitHub.

**Why use git with `--git-dir` / `--work-tree` for sync instead of a library or dedicated sync service?**
Git is already a prerequisite for installing the app (`git clone`), so no new dependency is introduced. Using a bare repository at `.knowledge-git/` with `domains/` as the work-tree keeps the knowledge repository completely separate from the app's own git history — users can sync their notes without touching the app's commit log, and developers can work on the app without polluting the knowledge repo. For authentication, a Personal Access Token embedded in the remote URL is the simplest possible mechanism for non-developers: paste once, forget about it. Alternatives considered were rsync (no conflict resolution, no history), a dedicated sync library (new runtime dependency, no offline support), and Dropbox/iCloud folder syncing (platform-specific, unreliable with git-tracked folders, requires a separate account). Plain git gives version history, conflict detection, and works the same way on every platform.
