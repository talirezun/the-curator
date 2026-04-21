# Architecture

> This document is intended for developers who want to understand how the system works internally.

## Overview

The Curator is a local Node.js web application. It has no external database — all knowledge is stored as plain markdown files on disk. An LLM (Google Gemini or Anthropic Claude, selected by which API key is configured) is the only external dependency at runtime.

### Core design philosophy: Curation, not retrieval

The Curator implements the "compiling wiki" pattern rather than standard RAG. When a source is ingested, the LLM does not merely index it for later retrieval — it integrates the knowledge into persistent wiki pages. On every subsequent ingest, existing entity and concept pages are updated rather than duplicated. The result is a knowledge base that compounds over time: cross-references are pre-built, contradictions are flagged at write time, and the synthesis already reflects the full corpus when a query arrives. This is why the chat pipeline can send the entire wiki to the LLM in a single context window rather than relying on embedding-based chunk retrieval.

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
│  /api/sync     /api/config          │
│  /api/restart                       │
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
                 │  API call (key from config.js)
                 ▼
┌─────────────────────────────────────┐
│  Google Gemini  OR  Anthropic Claude│
│  (key priority: config file → .env) │
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
the-curator/
├── src/
│   ├── server.js               Express entry point (port 3333, auto-opens browser)
│   ├── routes/
│   │   ├── domains.js          GET/POST/PUT/DELETE /api/domains[/:domain]
│   │   ├── ingest.js           POST /api/ingest
│   │   ├── chat.js             GET/POST/DELETE /api/chat/:domain[/:id]
│   │   ├── wiki.js             GET  /api/wiki/:domain
│   │   ├── health.js           GET/POST /api/health[/:domain][/fix|/fix-all]
│   │   └── config.js           GET/POST /api/config (settings, API keys, updates)
│   ├── brain/
│   │   ├── llm.js              LLM abstraction (Gemini + Claude)
│   │   ├── files.js            Filesystem helpers (wiki + conversations)
│   │   ├── ingest.js           Ingest pipeline (single-pass + multi-phase)
│   │   ├── chat.js             Chat pipeline (multi-turn, persistent)
│   │   ├── health.js           Wiki health scanner + auto-fix logic
│   │   ├── health-ai.js        AI suggestions for broken links (v2.4.3+) and orphans (v2.4.4+) — READ-ONLY
│   │   └── config.js           Persistent config (API keys, domains path)
│   └── public/
│       ├── index.html          Single-page UI shell
│       ├── app.js              Vanilla JS frontend (includes Settings tab + onboarding wizard)
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
├── scripts/
│   ├── fix-wiki-duplicates.js  One-time deduplication: merges near-duplicate entity/concept files
│   ├── fix-wiki-structure.js   One-time migration: moves non-canonical folders → entities/
│   ├── bulk-reingest.js        Re-ingests all raw files in a domain to rebuild the wiki
│   ├── inject-summary-backlinks.js  Retroactively injects [[summaries/...]] backlinks into all entity pages
│   ├── repair-wiki.js         Comprehensive wiki repair (cross-folder dedup, link normalization, backlinks)
│   └── build-app.sh           Rebuild The Curator.app from the AppleScript template
├── package.json
├── .env                        API key — developer fallback (never committed)
├── .curator-config.json        API keys + settings from UI (never committed)
└── .gitignore
```

---

## LLM provider selection (`src/brain/llm.js`)

The app auto-detects which LLM provider to use based on which key is available. Keys are resolved by `config.js` with this priority: `.curator-config.json` (set via Settings UI) takes precedence over `.env` (developer fallback). `GEMINI_API_KEY` takes priority over `ANTHROPIC_API_KEY` if both are set.

```
GEMINI_API_KEY set      →  Google Gemini  (default model: gemini-2.5-flash-lite)
ANTHROPIC_API_KEY set   →  Anthropic Claude (default model: claude-sonnet-4-6)
Neither set             →  Error on startup (onboarding wizard prompts for key)
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
      ├─ 5.5 Deduplicate result.pages (multi-phase ingest can return the same
      │     path in multiple batches; keep last occurrence per path)
      ├─ 6. Write each page → domains/<domain>/wiki/<path>
      │     Each writePage() call runs a full post-processing pipeline:
      │       Step 1a: underscore → hyphen slug (two_worlds_of_code → two-worlds-of-code)
      │       Pass A: title-prefix strip (dr-tali-rezun → tali-rezun.md)
      │       Pass B: hyphen-normalised dedup (talirezun → tali-rezun.md)
      │       Step 3b: cross-folder dedup (concepts/google → entities/google)
      │       injectFrontmatter(), mergeWikiPage(), stripBlanksInBulletSections()
      │       deduplicateBulletSections() — safety net for merge edge cases
      │       folder-prefix link cleanup ([[entities/foo]] → [[foo]])
      │       Step 5c: variant link normalization (Pass A+B+C)
      │         Pass A: [[dr-tali-rezun]] → [[tali-rezun]]
      │         Pass B: hyphen-normalised match (entities + concepts)
      │         Pass C: prefix-tolerant match across all wiki files (incl. summaries)
      │     For every summary page written, injectSummaryBacklinks() also fires:
      │       reads "Entities Mentioned", injects [[summaries/<slug>]] into the
      │       Related section of each referenced entity or concept (creates section
      │       if missing; checks entities/ first, falls back to concepts/)
      ├─ 7. Post-write reconciliation via syncSummaryEntities()
      │     The LLM reliably under-lists entities in "Entities Mentioned"
      │     (writes 5–7 while creating 20–30 entity pages). This step:
      │       a. Derives the full entity + concept list from actual pagesWritten paths
      │       b. Injects all missing [[slug]] bullets into the summary's
      │          "Entities Mentioned" section (dedup-safe + deduplicateBulletSections)
      │       c. Re-fires injectSummaryBacklinks() with the complete list so
      │          every entity/concept page receives [[summaries/<slug>]] — not just
      │          the few the LLM remembered to mention
      ├─ 8. Write updated index.md
      └─ 9. Append timestamped entry to log.md

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

## Data flow: Domain management

```
User clicks Create / Rename / Delete in Domains tab
      │
      ▼
POST/PUT/DELETE /api/domains[/:slug]
      │
      ▼
src/routes/domains.js  —  validates slug, calls files.js helpers
      │
      ├─ createDomain()
      │    ├─ mkdir raw/, wiki/{entities,concepts,summaries}/, conversations/
      │    ├─ Write wiki/index.md and wiki/log.md (empty scaffold)
      │    └─ Write CLAUDE.md via generateClaudemd() — selects template
      │         (tech / business / personal / generic)
      │
      ├─ renameDomain()
      │    ├─ fs.rename() — atomic on same filesystem
      │    ├─ Patch # Domain: header in CLAUDE.md
      │    ├─ Patch # Wiki Index — header in wiki/index.md
      │    ├─ Patch # Ingest Log — header in wiki/log.md
      │    └─ Update conv.domain field in every conversations/*.json
      │
      └─ deleteDomain()
           └─ rm -rf domain directory

HTTP response → { slug, displayName } or { deleted, syncWarning }

Obsidian sees all changes instantly — it watches the same domains/ folder.
If sync is configured, syncWarning: true is returned so the UI can
prompt the user to Sync Up.
```

---

## Data flow: Wiki Health

```
User clicks Scan on the Health tab
      │
      ▼
GET /api/health/:domain
      │
      ▼
src/routes/health.js  —  validates domain
      │
      ▼
src/brain/health.js  →  scanWiki(domain)  (pure, no writes)
      ├─ Walk wiki/*.md files
      ├─ For every [[wikilink]]: resolve target; record incoming links;
      │   flag folder-prefix violations; flag broken targets with suggestions
      ├─ Orphan pass: entity/concept files with zero incoming links
      ├─ Cross-folder dedup pass: entities/X + concepts/X with same
      │   hyphen-normalised slug
      ├─ Hyphen variant pass: group entity files by normKey (strip hyphens,
      │   article prefix); prefer the form with the most hyphens as canonical
      └─ Missing backlink pass: for each summary's "Entities Mentioned"
          bullet, check the target page's "Related" section for a
          [[summaries/<slug>]] bullet

HTTP response → { counts, brokenLinks, orphans, folderPrefixLinks,
                  crossFolderDupes, hyphenVariants, missingBacklinks }

User clicks Fix / Fix all:

POST /api/health/:domain/fix[-all]    body: { type, issue? }
      │
      ▼
src/brain/health.js  →  fixIssue(domain, type, issue?)
      └─ Dispatch by type:
         brokenLinks       → regex rewrite [[old]] → [[issue.suggestedTarget]]
         folderPrefixLinks → strip [[entities/|concepts/]] prefixes in-place
         crossFolderDupes  → merge bullet sections, delete concept copy,
                             normalise frontmatter type to entity
         hyphenVariants    → union bullets into canonical slug, delete variants
         missingBacklinks  → injectSingleBacklink() into scan-resolved entity
         orphanLink        → injectRelatedLink(): AI orphan-rescue bullet (v2.4.4+)
                             — pseudo-type, never emitted by scanWiki

UI re-scans automatically after every fix so counts drop in real time.

AI-assisted suggestions (v2.4.3+) flow through a separate READ-ONLY module:

POST /api/health/:domain/ai-suggest    body: { type, issue }
      │
      ▼
src/brain/health-ai.js  →  suggestBrokenLinkTarget / suggestOrphanHomes
      │
      └─ generateText() in llm.js  (provider-agnostic, fallback-chain aware)
      └─ Validate all returned slugs against on-disk filenames before response
         (hallucinated slugs are coerced to null / dropped)

This module NEVER writes. Applying an AI suggestion goes back through
the /fix endpoint above — same chokepoint as every other Health write.

Orphans and broken links are surfaced as Review-only — they require
human judgement and the app refuses to auto-fix them.
```

---

## Module reference

### `src/brain/config.js`

Persistent app configuration stored in `.curator-config.json` at the project root.

| Export | Description |
|--------|-------------|
| `getDomainsDir()` | Resolved absolute path to the domains folder (config file → env var → default) |
| `setDomainsDir(newPath)` | Persists a new domains path to `.curator-config.json` |
| `getConfig()` | Returns `{ domainsPath, domainsPathSource }` for the UI |
| `getApiKeys()` | Returns `{ geminiApiKey, anthropicApiKey }` from the config file |
| `setApiKeys({ geminiApiKey, anthropicApiKey })` | Saves API keys to the config file (partial update) |
| `getEffectiveKey(provider)` | Returns the active key for a provider: config file takes priority over `.env` |

### `src/brain/llm.js`

| Export | Description |
|--------|-------------|
| `getProviderInfo()` | Returns `{ provider, model }` based on effective keys (via `config.js`) |
| `generateText(system, user, maxTokens, responseFormat)` | Single LLM call; handles Gemini and Claude API differences |

### `src/brain/files.js`

Pure filesystem helpers. No LLM calls.

| Export | Description |
|--------|-------------|
| `listDomains()` | Names of all non-hidden subdirectories under `domains/` |
| `readSchema(domain)` | Contents of `domains/<domain>/CLAUDE.md` |
| `readWikiPages(domain)` | All `.md` files under `wiki/`, returned as `{path, content}[]` |
| `writePage(domain, relativePath, content)` | Full write pipeline: underscore→hyphen slug fix, dedup passes A+B on filename, cross-folder dedup (step 3b), `injectFrontmatter()`, `mergeWikiPage()`, `stripBlanksInBulletSections()`, `deduplicateBulletSections()`, folder-prefix cleanup, step 5c variant-link normalization (Pass A+B+C across all wiki folders, prefix-tolerant), write to disk, `injectSummaryBacklinks()` for summary pages; **returns the canonical path** so callers use redirected slugs |
| `injectSummaryBacklinks(summarySlug, summaryContent, wikiDir)` | After a summary is written, injects `[[summaries/<slug>]]` into the Related section of every entity listed under "Entities Mentioned"; checks entities/ first, falls back to concepts/; creates the section if it doesn't exist; deduplicates via `dedupKey()` |
| `syncSummaryEntities(domain, summaryPath, writtenPaths)` | Post-ingest reconciliation: uses the ground-truth `pagesWritten` list (not the LLM's truncated output) to fill in all missing entity AND concept slugs in the summary, then re-fires `injectSummaryBacklinks()` so every entity/concept page gets its backlink regardless of LLM compliance |
| `deduplicateBulletSections(content)` | Safety net: removes duplicate bullets from all accumulating sections (Key Facts, Related, Entities Mentioned, etc.) using `dedupKey()`; runs after every write and after `syncSummaryEntities()` |
| `injectBulletsIntoSection(content, sectionName, bullets)` | Dedup-aware bullet injection; creates the section if it doesn't exist (multiline regex for existence check) |
| `appendLog(domain, entry)` | Append a string to `log.md` |
| `readIndex(domain)` | Contents of `index.md` |
| `createDomain(slug, displayName, description, template)` | Scaffold full domain directory + auto-generate CLAUDE.md from template |
| `deleteDomain(slug)` | Recursively delete a domain directory |
| `renameDomain(oldSlug, newSlug, newDisplayName)` | Atomically rename domain folder, patch display name in CLAUDE.md / index.md / log.md, update conversation JSON files |
| `getDomainStats(slug)` | Return `{ slug, displayName, pageCount, conversationCount, lastIngestDate }` |

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

### `src/routes/config.js`

Settings and configuration endpoints.

```
GET  /api/config               → current app configuration
POST /api/config/domains-path  → set domains folder path
POST /api/config/pick-folder   → macOS native folder picker (osascript)
GET  /api/config/api-keys      → masked keys + active provider info
POST /api/config/api-keys      → save API keys (partial update)
GET  /api/config/update-check  → compare local vs GitHub version
POST /api/config/update        → git pull + npm install + rebuild .app (build-app.sh)
POST /api/restart               → spawn new server process, exit current one
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
The UI has six tabs and a handful of fetch calls. A framework adds build complexity and bundle size with no meaningful benefit for a local personal tool.

**Why JSON mode for ingest but not chat?**
Ingest requires structured output (pages + index as a JSON object) that must be machine-parsed. Chat returns free-form markdown prose; JSON mode would constrain the writing style unnecessarily.

**Why save conversations as JSON files instead of a database?**
Consistent with the project's "no external database" principle. JSON files are human-readable, portable, and trivially backed up or shared. SQLite would add a dependency and binary file for a feature that doesn't need relational queries. Each conversation is a self-contained document.

**Why are conversations gitignored from the app repo but synced through the knowledge repo?**
Conversations are personal knowledge — specific to each user's ingested documents and questions. They are gitignored from the app's own repository (so contributors don't accidentally commit private data), but they live inside `domains/*/conversations/` which is included in the knowledge repository managed by the Sync feature. This means conversations travel with the rest of your knowledge when you sync across computers, while still being invisible to anyone looking at the app's source code on GitHub.

**Why use git with `--git-dir` / `--work-tree` for sync instead of a library or dedicated sync service?**
Git is already a prerequisite for installing the app (`git clone`), so no new dependency is introduced. Using a bare repository at `.knowledge-git/` with `domains/` as the work-tree keeps the knowledge repository completely separate from the app's own git history — users can sync their notes without touching the app's commit log, and developers can work on the app without polluting the knowledge repo. For authentication, a Personal Access Token embedded in the remote URL is the simplest possible mechanism for non-developers: paste once, forget about it. Alternatives considered were rsync (no conflict resolution, no history), a dedicated sync library (new runtime dependency, no offline support), and Dropbox/iCloud folder syncing (platform-specific, unreliable with git-tracked folders, requires a separate account). Plain git gives version history, conflict detection, and works the same way on every platform.

**Why manage domains in the UI instead of only in the filesystem?**
Creating a domain manually requires writing a correctly formatted CLAUDE.md schema, initialising two markdown files, and creating five directories — a process documented step-by-step but easy to get wrong. The Domains tab automates all of this with four validated templates (Tech/AI, Business/Finance, Personal Growth, Generic). Each template generates a CLAUDE.md tuned for that domain's entity types and concept structure, eliminating a common source of poor ingest results. Rename and delete operations are also safer through the UI: the rename patches all affected files atomically and warns when sync is configured; the delete shows exact counts before confirming.

**Why YAML frontmatter instead of inline `Type:` / `Tags:` fields?**
Obsidian's Properties system (introduced 2023) and the Dataview plugin both consume YAML frontmatter natively — they do not parse inline body fields. By moving `type` and `tags` into a `---` block at the top of every entity, concept, and summary page, three things become possible without any plugin configuration: (1) the Obsidian Graph View can color-code nodes by tag (`tag:#type/entity`), (2) Dataview can query and table all pages by type, and (3) external AI agents reading the files get structured metadata without parsing prose. The `injectFrontmatter()` post-processor in `writePage()` acts as a safety net — if the LLM skips the instruction, the correct YAML is injected from the file path before the file is written. This means YAML is always present regardless of LLM compliance.

**Why include `type/entity`, `type/concept`, `type/summary` as tag values rather than a separate field?**
Obsidian's Graph View Groups filter operates on tags, not on arbitrary frontmatter fields. Using `tags: [..., type/entity]` means one setting in the graph panel (`tag:#type/entity → Blue`) colors all current and future entity nodes with no further configuration. A separate `nodeColor: blue` field would have no effect on the graph — Obsidian doesn't read custom fields for visual styling. The tag approach is the only mechanism that hooks into Obsidian's native graph coloring.

**Why "Atomic Decomposition" rather than "chunking"?**
Standard RAG pipelines chunk documents by token count or paragraph boundary — a mechanical split with no semantic awareness. The Curator's ingest pipeline performs Atomic Decomposition: the LLM reads the entire source and extracts discrete, named artifacts — Entities (nouns: specific people, tools, companies) and Concepts (verbs/ideas: techniques, frameworks, principles) — and writes a persistent page for each. These are semantically coherent units with cross-references baked in, not arbitrary text fragments. The distinction matters: chunks are retrieval units; atomic pages are knowledge units. They compound.
