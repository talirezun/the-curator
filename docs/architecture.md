# Architecture

## Overview

The system is a local Node.js web application. It has no external database — all knowledge is stored as plain markdown files on disk. Claude (via the Anthropic API) is the only external dependency at runtime.

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
│  /api/query    /api/wiki/:domain    │
└───────────────┬─────────────────────┘
                │
        ┌───────┴────────┐
        │                │
        ▼                ▼
┌──────────────┐  ┌──────────────┐
│  brain/      │  │  brain/      │
│  ingest.js   │  │  query.js    │
└──────┬───────┘  └──────┬───────┘
       │                 │
       │   Anthropic API │
       ▼                 ▼
┌─────────────────────────────────────┐
│         claude-sonnet-4-6           │
└─────────────────────────────────────┘
       │                 │
       ▼                 ▼
┌─────────────────────────────────────┐
│           brain/files.js            │
│  read / write markdown on disk      │
└─────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  domains/<domain>/                  │
│  ├── CLAUDE.md  (schema)            │
│  ├── raw/       (source files)      │
│  └── wiki/      (knowledge pages)  │
└─────────────────────────────────────┘
```

---

## Directory structure

```
second-brain/
├── src/
│   ├── server.js               Express entry point
│   ├── routes/
│   │   ├── domains.js          GET  /api/domains
│   │   ├── ingest.js           POST /api/ingest
│   │   ├── query.js            POST /api/query
│   │   └── wiki.js             GET  /api/wiki/:domain
│   ├── brain/
│   │   ├── files.js            Filesystem helpers
│   │   ├── ingest.js           Ingest pipeline (Claude call + file writes)
│   │   └── query.js            Query pipeline (Claude call)
│   └── public/
│       ├── index.html          Single-page UI shell
│       ├── app.js              Vanilla JS frontend
│       └── styles.css          Dark-theme styles
├── domains/
│   └── <domain>/
│       ├── CLAUDE.md           Domain schema (instructions for Claude)
│       ├── raw/                Immutable uploaded source files
│       └── wiki/
│           ├── index.md        Content catalog
│           ├── log.md          Chronological ingest log
│           ├── entities/       People, tools, companies, datasets
│           ├── concepts/       Ideas, techniques, frameworks
│           └── summaries/      One page per ingested source
├── docs/                       This documentation
├── package.json
├── .env                        ANTHROPIC_API_KEY (not committed)
└── .gitignore
```

---

## Data flow: Ingest

```
User uploads file
      │
      ▼
POST /api/ingest
      │
      ▼  multer saves tmp file
src/routes/ingest.js
      │
      ▼  calls
src/brain/ingest.js
      ├─ 1. Copy file → domains/<domain>/raw/<filename>
      ├─ 2. Extract text (.txt/.md → readFile, .pdf → pdf-parse)
      ├─ 3. Load domains/<domain>/CLAUDE.md  (system prompt)
      ├─ 4. Load domains/<domain>/wiki/index.md  (current state)
      ├─ 5. Call Claude API
      │     System:  CLAUDE.md schema
      │     User:    index.md + source text + JSON instructions
      │     Returns: { title, pages: [{path, content}], index }
      ├─ 6. Write each page to domains/<domain>/wiki/<path>
      ├─ 7. Write updated index.md
      └─ 8. Append entry to log.md

Response → { title, pagesWritten: [...] }
```

## Data flow: Query

```
User submits question
      │
      ▼
POST /api/query  { domain, question }
      │
      ▼
src/routes/query.js
      │
      ▼
src/brain/query.js
      ├─ 1. Load domains/<domain>/CLAUDE.md  (system prompt)
      ├─ 2. Read all .md files under domains/<domain>/wiki/
      ├─ 3. Call Claude API
      │     System:  CLAUDE.md schema
      │     User:    all wiki pages (up to 90k chars) + question
      │     Returns: markdown answer with [source: path] citations
      └─ 4. Parse citation tags → unique list

Response → { answer, citations: [...] }
```

---

## Module reference

### `src/brain/files.js`

Pure filesystem helpers. No Claude calls.

| Export | Signature | Description |
|--------|-----------|-------------|
| `domainPath` | `(domain) → string` | Absolute path to `domains/<domain>/` |
| `wikiPath` | `(domain) → string` | Absolute path to `domains/<domain>/wiki/` |
| `rawPath` | `(domain) → string` | Absolute path to `domains/<domain>/raw/` |
| `listDomains` | `() → Promise<string[]>` | Names of all domain directories |
| `readSchema` | `(domain) → Promise<string>` | Contents of `CLAUDE.md` |
| `readWikiPages` | `(domain) → Promise<{path, content}[]>` | All markdown files under `wiki/` |
| `writePage` | `(domain, relativePath, content) → Promise` | Write a wiki page, creating dirs as needed |
| `appendLog` | `(domain, entry) → Promise` | Append a string to `log.md` |
| `readIndex` | `(domain) → Promise<string>` | Contents of `index.md` |
| `writeIndex` | `(domain, content) → Promise` | Overwrite `index.md` |

### `src/brain/ingest.js`

```js
ingestFile(domain, filePath, originalName)
  → Promise<{ title: string, pagesWritten: string[] }>
```

Orchestrates the full ingest pipeline. Calls Claude once, writes all resulting pages, updates index and log.

**Claude prompt structure:**
- System: domain `CLAUDE.md`
- User: today's date + current index + source text (capped at 80,000 chars) + JSON schema instructions
- Expected response: `{ title, pages: [{path, content}], index }`

### `src/brain/query.js`

```js
queryDomain(domain, question)
  → Promise<{ answer: string, citations: string[] }>
```

Loads all wiki pages and asks Claude to synthesise an answer. Wiki context is capped at 90,000 chars. Citations are extracted from `[source: path/to/page.md]` patterns in Claude's response.

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@anthropic-ai/sdk` | ^0.39 | Claude API client |
| `express` | ^4 | HTTP server and routing |
| `multer` | ^2 | Multipart file upload handling |
| `pdf-parse` | ^1 | Extract text from PDF files |
| `fs-extra` | ^11 | Extended filesystem utilities |
| `dotenv` | ^16 | Load `.env` into `process.env` |

**No Axios.** All HTTP is handled by the Express server or Node's native `fetch`. If Axios is added in future (e.g. for URL ingestion), avoid compromised versions `1.14.1` and `0.30.4`; use a pinned safe version such as `1.7.9`.

---

## Design decisions

**Why markdown files instead of a vector database?**
A vector DB optimises for approximate semantic similarity across large corpora. At the scale of a focused domain wiki (tens to low hundreds of pages), Claude can read the entire wiki in a single context window and reason across all of it precisely. Markdown files are also human-readable, portable, and can be opened in Obsidian or any editor.

**Why one CLAUDE.md per domain instead of one global schema?**
Domain context shapes how Claude categorises and cross-references knowledge. An AI/Tech wiki names its entity pages differently from a Personal Growth wiki and uses different concept hierarchies. Keeping schemas separate means each domain gets a specialist, not a generalist.

**Why vanilla JS instead of React/Vue?**
The UI has three tabs and a handful of fetch calls. A framework would add build complexity and bundle size for no meaningful gain in a local personal tool.
