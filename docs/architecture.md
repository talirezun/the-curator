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
│  /api/domains      /api/ingest      │
│  /api/chat         /api/wiki/:domain│
│  /api/sync         /api/config      │
│  /api/health       /api/mcp         │
│  /api/compile      /api/sharedbrain │ ← v3.0.0-beta+ (gated by flag)
│  /api/restart      /api/version     │
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

### Shared Brain layer (v3.0.0-beta+, opt-in)

When the `sharedBrainEnabled` feature flag is on, an additional layer becomes active. Routes under `/api/sharedbrain/*` orchestrate push/pull/synthesize/revoke against a pluggable storage backend:

```
┌─────────────────────────────────────────┐
│         brain/sharedbrain.js             │
│   pushDomain  pullCollective             │
│   ensureSharedDomainExists               │
└───────┬─────────────────────────────────┘
        │
        │   SharedBrainStorageAdapter (abstract)
        │   src/brain/sharedbrain-storage.js
        ▼
┌─────────────────────────────────────────┐
│  createStorageAdapter(connection)        │
│  src/brain/sharedbrain-storage-factory   │
└───────┬─────────────────────────────────┘
        │ dispatched by connection.storage_type
        ├──────────────────┬───────────────────┐
        ▼                  ▼                   ▼
 ┌────────────┐    ┌─────────────────┐  ┌──────────────────┐
 │ Local      │    │ GitHub          │  │ Cloudflare R2    │
 │ Folder     │    │ Storage         │  │ (Phase v3.1 ⏳)  │
 │ Adapter    │    │ Adapter (v3.0)  │  │                  │
 │            │    │ REST + PAT      │  │ Worker + R2      │
 │ (battle    │    │ + SHA           │  │ (jurisdiction:eu)│
 │ testing)   │    │ concurrency     │  │                  │
 └────────────┘    └─────────────────┘  └──────────────────┘
```

Synthesis (`brain/sharedbrain-synthesis.js`) and revoke (`brain/sharedbrain-revoke.js`) operate against the same adapter interface — backend-agnostic. See [`docs/shared-brain.md`](shared-brain.md) for the concept, architecture, and engineering decisions; [`docs/shared-brain-user-guide.md`](shared-brain-user-guide.md) for the step-by-step user-facing flows.

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
│   │   ├── health.js           GET/POST /api/health[/:domain][/fix|/fix-all|/dismiss|/undismiss|/dismissed]
│   │   ├── compile.js          POST /api/compile/conversation (v2.5.0)
│   │   └── config.js           GET/POST /api/config (settings, API keys, updates)
│   ├── brain/
│   │   ├── llm.js              LLM abstraction (Gemini + Claude)
│   │   ├── files.js            Filesystem helpers (wiki + conversations)
│   │   ├── ingest.js           Ingest pipeline (single-pass + multi-phase)
│   │   ├── chat.js             Chat pipeline (multi-turn, persistent)
│   │   ├── compile.js          Conversation → wiki pages (v2.5.0)
│   │   ├── health.js           Wiki health scanner + auto-fix logic
│   │   ├── health-ai.js        AI suggestions for broken links (v2.4.3+), orphans (v2.4.4+), semantic duplicates (v2.4.5+) — READ-ONLY
│   │   ├── health-dismissed.js Persistent skip-store for Health issues (v2.5.1+) — wiki/.health-dismissed.jsonl
│   │   └── config.js           Persistent config (API keys, domains path)
│   └── public/
│       ├── index.html          Single-page UI shell
│       ├── app.js              Vanilla JS frontend (includes Settings tab + onboarding wizard)
│       └── styles.css          Dark-theme styles
├── mcp/                        My Curator MCP — read+write surface to the wiki for Claude Desktop / any MCP client
│   ├── server.js               stdio entry point (spawned as child process by the MCP client)
│   ├── graph.js                Wiki parser: frontmatter, [[wikilinks]], backlinks, tag inventory (cached)
│   ├── util.js                 Slug + domain validators, resolveDomainArg shared helper
│   ├── storage/local.js        Filesystem adapter (resolveInsideBase chokepoint, audit-log writer)
│   └── tools/                  Tool modules (10 read + 7 write = 17 tools as of v2.5.2)
│       ├── index.js            Registration hub + response-size guard (400 KB)
│       ├── domains.js, index-tool.js, search.js, nodes.js, connected.js,
│       │                       Read tools (10): list_domains, get_index, search_wiki, get_node, get_connected_nodes,
│       │                       get_summary, search_cross_domain, get_graph_overview, get_tags, get_backlinks
│       ├── compile.js          Write tool (v2.5.2): compile_to_wiki — research → wiki pages
│       ├── health.js           Write tools (v2.5.2): scan_wiki_health, fix_wiki_issue, scan_semantic_duplicates
│       └── dismissed.js        Write tools (v2.5.2): get_health_dismissed, dismiss_wiki_issue, undismiss_wiki_issue
├── domains/
│   └── <domain>/
│       ├── CLAUDE.md           Domain schema (system prompt for the LLM)
│       ├── raw/                Immutable uploaded source files (gitignored)
│       ├── .mcp-write-log.jsonl Per-domain MCP audit log (v2.5.2+, gitignored, machine-local)
│       ├── wiki/
│       │   ├── index.md        Content catalog
│       │   ├── log.md          Chronological ingest + compile log
│       │   ├── entities/       People, tools, companies, datasets
│       │   ├── concepts/       Ideas, techniques, frameworks
│       │   ├── summaries/      One page per ingested source or compiled conversation
│       │   └── .health-dismissed.jsonl  Persistent Health-issue dismissals (v2.5.1+); git-tracked, syncs across machines
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

> **For the comprehensive technical deep dive** on the ingestion pipeline — every safeguard, every failure mode the code defends against, the full quality contract, Mermaid flowcharts, and the deep-test harness — see [docs/ingestion-pipeline.md](ingestion-pipeline.md). The summary below is the entry-point overview.

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
      ├─ 0. Compute deterministic summary slug from the source filename     (v3.0.1+)
      │     computeSummarySlugFromSource('report.pdf') → 'report'
      │     summaryPath = 'summaries/report.md'
      │     This slug is FORCED into the LLM prompt, so re-ingesting the
      │     same source always lands on the same summary page → merges via
      │     mergeWikiPage instead of creating a duplicate file.
      ├─ 1. Copy file → domains/<domain>/raw/<filename>
      ├─ 2. Extract text (.txt/.md → readFile, .pdf → pdf-parse)
      │     If fullText.length > 80,000: truncate + push warning into the
      │     result.warnings array + emit a progress message + log it (v3.0.1+).
      ├─ 3. Load domains/<domain>/CLAUDE.md  (system prompt)
      ├─ 4. Load domains/<domain>/wiki/index.md  (current wiki state)
      ├─ 5. Call LLM via llm.js  (JSON mode, 65,536 max output tokens;
      │     Anthropic clamps to 64,000 + streams — see model-lifecycle.md)
      │     System:  domain CLAUDE.md schema
      │     User:    date + index + source text (≤80,000 chars) + REQUIRED
      │              COVERAGE checklist (v3.0.1+): forced summary path,
      │              originator entity rule, every-name-mentioned rule,
      │              every-key-concept rule, parent-over-children consolidation.
      │     Returns: { title, pages: [{path, content, summary?}] }
      │              (no `index` field — app maintains the index itself, v3.0.1+)
      │
      │     Two paths converge here:
      │     ── Single-pass (input ≤ 15,000 chars) ──
      │        One LLM call returns both pages and content.
      │     ── Multi-phase (input > 15,000 chars OR single-pass parse fails) ──
      │        Phase 1 outline → validated → Phase 2 batched content (BATCH=4).
      │        No Phase 3 — index merge moved out of the LLM (v3.0.1+).
      │        On batch parse failure: page-by-page retry; absolute last
      │        resort writes a clearly-marked Stub page that surfaces in
      │        Health and in the warnings panel.
      │
      ├─ 5a. validateOutline() — programmatic safety net                       (v3.0.1+)
      │      Runs on BOTH single-pass and multi-phase results.
      │      Invariants enforced:
      │        - exactly one summary page at summaryPath; inject if missing,
      │          redirect if path drifted, drop extras if > 1.
      │        - originator entity present: if extractAuthorHints() detected
      │          an author byline / YAML `author:` / "Author: X" and the
      │          outline omitted that entity, inject it at the FRONT of the
      │          pages list. If the outline contains a variant slug
      │          ("dr-tali-rezun.md" vs canonical "tali-rezun.md"), redirect
      │          it in place — uses the same Pass A + Pass B normalisation
      │          that writePage applies at write time, so the slug Phase 2
      │          generates content for matches the slug used in [[wikilinks]].
      │      Each patch emits a user-visible warning in result.warnings.
      │      Concept coverage is requested by the prompt; not
      │      machine-validated (would require a second LLM call).
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
      │     writeRecords[i] is kept aligned 1:1 with result.pages[i] for the
      │     index-merge step below (v3.0.1+).
      ├─ 7. Post-write reconciliation via syncSummaryEntities()
      │     The LLM reliably under-lists entities in "Entities Mentioned"
      │     (writes 5–7 while creating 20–30 entity pages). This step:
      │       a. Derives the full entity + concept list from actual pagesWritten paths
      │       b. Injects all missing [[slug]] bullets into the summary's
      │          "Entities Mentioned" section (dedup-safe + deduplicateBulletSections)
      │       c. Re-fires injectSummaryBacklinks() with the complete list so
      │          every entity/concept page receives [[summaries/<slug>]] — not just
      │          the few the LLM remembered to mention
      ├─ 8. Programmatic index merge via mergeIntoIndex() (shared with compile, v3.0.1+)
      │     Reads existing wikilinks in index.md → skips any slug already there.
      │     Appends rows for newly CREATED pages (not updated/unchanged), pairing
      │     LLM-supplied summaries with canonical post-write paths so cross-folder
      │     dedup redirects keep the correct type column. No LLM call. Sanitises
      │     pipe + newline characters from summary text before insertion.
      └─ 9. Append timestamped entry to log.md (warnings section included if any)

HTTP response → { type: 'done', title, pagesWritten, changes,
                  warnings: [...], truncated: bool, wasOverwrite: bool }
                  (SSE event; warnings + truncated added in v3.0.1+)
```

### Idempotency guarantees on re-ingest (v3.0.1+)

Re-ingesting the same source file produces no duplicates anywhere in the
wiki. The chain that makes this work, in order of where it kicks in:

| Layer | Mechanism | Outcome |
|---|---|---|
| **Summary file** | Deterministic slug from source filename (`computeSummarySlugFromSource`) | Same input file → same `summaries/<slug>.md` → `mergeWikiPage` union-merges bullets. No second summary file possible. |
| **Entity / concept files** | Existing-files list passed to LLM + `writePage` dedup passes (title-prefix, hyphen-norm, cross-folder) | Same entity = same slug = bullets merge. |
| **Bullet sections** (Key Facts, Related, Entities Mentioned) | `mergeWikiPage` union + `deduplicateBulletSections` safety net | Bullets with the same link target collapsed to one. |
| **Summary "Entities Mentioned"** | `syncSummaryEntities` always rebuilds from the ground-truth `pagesWritten` list | List always matches the actual pages written this run. |
| **Backlinks** | `injectSummaryBacklinks` is dedup-safe (`dedupKey()`) | Same `[[summaries/<slug>]]` bullet is never added twice. |
| **`index.md` rows** | `mergeIntoIndex` scans existing wikilinks → skips any slug already mentioned | Re-ingest never adds a duplicate row. Only newly CREATED pages get rows. |

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
prompt the user to sync.
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
         semanticDupe      → fixSemanticDuplicate() (v2.4.5+): DESTRUCTIVE
                             merges two pages, rewrites all [[removeSlug]]
                             links across the domain, deletes the duplicate
                             — pseudo-type, never emitted by scanWiki;
                             gated by mandatory Preview-diff in the UI

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

Persistent dismissals (v2.5.1+):

POST /api/health/:domain/dismiss      body: { type, issue }
POST /api/health/:domain/undismiss    body: { type, issue }
GET  /api/health/:domain/dismissed    → { records: [...] }
      │
      ▼
src/brain/health-dismissed.js
      ├─ keyForIssue(type, issue)
      │   Canonical, deterministic key per issue type. Order-insensitive
      │   identities (semantic-dupe pairs, hyphen-variant groups) are
      │   alphabetised so {a,b} and {b,a} produce one key.
      ├─ loadDismissed(domain)
      │   Reads <wiki>/.health-dismissed.jsonl, parses every line,
      │   silently prunes records whose referenced files/slugs no longer
      │   exist, returns { records, keys: Set<string> }.
      ├─ addDismissal / removeDismissal — append-or-rewrite the JSONL.
      └─ filterDismissed(issues, type, keys)
          O(N) Set-based filter; surfaces dismissed-count for the UI.

scanWiki and findSemanticCandidatePairs filter their results through
filterDismissed before returning. counts.dismissed is exposed in the
scan response so the UI can show "N dismissed" alongside live issues.

The JSONL file lives INSIDE wiki/ so it's already git-tracked by the
existing sync — dismissals propagate across machines automatically.
Line-oriented format makes concurrent dismissals on different machines
merge cleanly through git's standard 3-way merge.
```

---

## Data flow: My Curator MCP

The MCP server is a **standalone** Node process spawned by the MCP client
(Claude Desktop or any other) via stdio. It does NOT require the Curator
HTTP server to be running. From v2.5.2+, it is a full read+write surface
to the wiki — the same code path the in-app Compile and Health tabs use.

```
Claude Desktop launches
      │
      ▼
spawn(node, [mcp/server.js, --domains-path <abs>])
      │
      ▼
mcp/server.js
      ├─ createStorageAdapter({ domainsPath })   storage/local.js
      ├─ registerTools(server, storage)          tools/index.js
      └─ StdioServerTransport.connect()

Tool call (any of 17 tools):
      │
      ▼
tools/index.js — CallToolRequestSchema handler
      ├─ Look up tool by name → invoke handler(args, storage)
      ├─ Stringify result → enforceSizeLimit (400 KB cap; trims heavy arrays)
      └─ Return { content: [{ type: 'text', text }] }

Read tools (v2.3.0+, 10 tools)
      └─ Walk markdown via storage.listWikiFiles / readFile
         Cached per-process graph (mcp/graph.js, 10-min TTL)

Write tools (v2.5.2+, 7 tools)
      ├─ resolveDomainArg(args, storage, getDefaultDomain)
      │     Explicit domain → user's defaultDomain → error
      │     Validated via isValidDomain + storage.listDomains()
      ├─ Per-tool guards (caps, slug regex, REFUSED_FILES, preview gate)
      │
      └─ compile_to_wiki:
         │   importsFromBrain: writePage, syncSummaryEntities, appendLog
         │   ├─ Deterministic summary slug = slugify(title)+date+sha4(corpus)
         │   ├─ existsSync(summaryFullPath) → refused (idempotency)
         │   ├─ Per-page 50 KB cap, per-call 10-page cap
         │   ├─ writePage for summary + each additional_page
         │   ├─ syncSummaryEntities (entity backlinks)
         │   ├─ mergeIntoIndex (programmatic — no LLM call)
         │   ├─ appendLog
         │   └─ storage.appendToWriteAudit (machine-private)
         │
         scan_wiki_health, fix_wiki_issue, scan_semantic_duplicates:
         │   importsFromBrain: scanWiki, fixIssue, AUTO_FIXABLE,
         │     previewSemanticDuplicateMerge, scanSemanticDuplicates
         │   ├─ Persistent dismissals (loadDismissed) filter scan results
         │   ├─ semanticDupe REQUIRES preview:true on first call
         │   │     Per-domain in-memory token Set; a successful preview
         │   │     enables the next preview:false call, then is consumed.
         │   └─ fixIssue handlers all gated by resolveInsideWiki (v2.5.2+)
         │     Defense-in-depth path-traversal check on every issue field
         │     so an LLM-crafted issue cannot rm() outside the wiki folder.
         │
         dismiss_wiki_issue / undismiss_wiki_issue / get_health_dismissed:
             importsFromBrain: addDismissal, removeDismissal, listDismissed
             Same JSONL file shared with the in-app Health tab.

Audit log (v2.5.2+, write tools only):
      domains/<d>/.mcp-write-log.jsonl
      Sibling to wiki/ — gitignored via */.mcp-write-log.jsonl rule.
      Local only by design: write history is private to the machine that
      produced it; you don't want it spilling to GitHub.

Default domain (v2.5.2+):
      .curator-config.json → defaultDomain
      Set/cleared via /api/config/default-domain (Settings tab dropdown).
      MCP write tools fall back to it when domain is omitted.
```

The MCP and the Curator app are **equally-capable clients** to the same
wiki data. The Curator app provides the install + wizard + manual UI;
the MCP provides conversational read+write from any LLM client. Same
write pipeline (writePage, syncSummaryEntities, fixIssue), same
dismissal store (.health-dismissed.jsonl), same idempotency guards.

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
| `writePage(domain, relativePath, content)` | Full write pipeline: underscore→hyphen slug fix, dedup passes A+B on filename, cross-folder dedup (step 3b), `injectFrontmatter()`, `mergeWikiPage()`, `stripBlanksInBulletSections()`, `deduplicateBulletSections()`, folder-prefix cleanup, step 5c variant-link normalization (Pass A+B+C across all wiki folders, prefix-tolerant), **atomic write to disk** via `writeFileAtomic()` (v3.0.1-beta.8+), `injectSummaryBacklinks()` for summary pages; **returns the canonical path** so callers use redirected slugs |
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

### `src/brain/atomic-write.js` (v3.0.1-beta.8+)

Single chokepoint for all wiki + config writes. Replaces `fs.writeFile` and `fs.writeFileSync` with a temp-file + rename pattern so a process kill mid-write leaves either the OLD file or the NEW file intact — never a zero-byte truncated file. POSIX `rename(2)` is atomic per-file within a single filesystem.

| Export | Description |
|--------|-------------|
| `writeFileAtomic(targetPath, content, encoding?)` | Async atomic write: writes content to `<dir>/.tmp-<base>-<pid>-<counter>`, then `rename`s into place. Refuses to write through a symlink (`lstat` pre-check). Cleans up the orphan tempfile if rename fails. |
| `writeFileAtomicSync(targetPath, content, encoding?)` | Sync variant for `.curator-config.json` writes that happen before the async runtime is fully online. |

Used by `files.js` (every wiki + log + index + conversation write), `health.js` (destructive Health fixes), `config.js` (sync writes to `.curator-config.json`), `health-dismissed.js` (JSONL rewrite), `sharedbrain-local-adapter.js` (`_writeFile` chokepoint), and `ingest.js` (raw source save). **NOT used by append-only JSONL audit logs** (MCP write log, sharedbrain audit JSONL) — `appendFile` is already crash-safe at line granularity on local filesystems.

### `src/brain/write-registry.js` (v3.0.1-beta.8+)

In-memory + file-based coordination layer that prevents destructive operations (app update, restart, git sync, domain delete) from racing in-flight writes (ingest, compile-to-wiki, health-fix-all). Same in-process module shared between the web server and (via the file-lock half) the MCP child process spawned by Claude Desktop.

| Export | Description |
|--------|-------------|
| `registerWrite(domain, op)` | Long-running write registers on entry; returns a `release()` token the caller MUST invoke in `finally`. Uses `Map<domain, refcount>` so two ingests on the same domain coexist correctly. |
| `hasActiveWrites()`, `isDomainActive(domain)` | Fast checks used by conflicting endpoints to decide whether to refuse with 409. |
| `conflictResponse(attemptedOp)` | Builds the standard `{ status: 409, body: {...} }` payload — names the active domain + ops, mentions whether an update is in progress. |
| `beginUpdate()` / `endUpdate()` / `isUpdateInProgress()` | Domain-global flag for the `/api/update` flow (git reset + npm install + restart). Ingest + compile routes check this in addition to the per-domain registry to close the millisecond race window. |
| `acquireFileLock(domainDir, opts)` | Cross-process advisory lock at `<domain>/.write-lock` (JSON: pid, op, startedAt). Returns a `release()` function on success, `null` if another process holds a fresh lock. 30-minute stale-lock TTL + `process.kill(pid, 0)` liveness probe; stale or unparseable locks are silently cleared on the next acquire. |
| `isFileLocked(domainDir)` | Non-acquiring check — used by MCP write tools to refuse fast without trying to take the lock themselves. |

The file lock is what lets the MCP server (separate child process spawned by Claude Desktop) coordinate with the Curator web server. The in-memory registry is faster and authoritative for the web server's own routes; the file lock is the cross-process boundary.

### `src/brain/ingest.js`

```js
ingestFile(domain, filePath, originalName, isOverwrite?, onProgress?)
  → Promise<{
      title: string,
      pagesWritten: string[],
      changes: ChangeRecord[],   // v2.5.0+: per-file {canonPath, status, bytesBefore, bytesAfter, sectionsChanged, bulletsAdded}
      warnings: string[],        // v3.0.1+: truncation, validator patches, stub pages
      truncated: boolean,        // v3.0.1+: was the source > 80k chars?
    }>

computeSummarySlugFromSource(originalName)  → string                    // v3.0.1+
extractAuthorHints(text)  → string[]   // YAML/byline/"Author:" scan    // v3.0.1+
slugifyName(name)  → string            // honorific-stripped slug       // v3.0.1+
validateOutline(outline, summaryPath, originalName, originatorHints?)
  → { outline, warnings: string[] }                                     // v3.0.1+
parseJSON(raw)  → object   // shared with compile.js
```

Single-pass for small/medium documents (input ≤ 15,000 chars). Falls back to
a two-phase pipeline (outline → batched content) for larger inputs or after
a single-pass parse failure. The index is merged programmatically by
`mergeIntoIndex` (imported from `compile.js`) — no LLM call (v3.0.1+).
A REQUIRED COVERAGE checklist is injected into both prompts (single-pass and
multi-phase outline) so the LLM always produces a summary at the canonical
slug, an originator entity for the source's author/speaker, and applies the
parent-over-children consolidation rule.

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
