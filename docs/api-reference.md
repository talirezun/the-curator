# API Reference

The server exposes a REST API at `http://localhost:3333/api`. All endpoints return JSON.

---

## GET /api/domains

List all available domains.

**Response**

```json
{
  "domains": ["ai-tech", "business-finance", "personal-growth", "shared-cohort"],
  "readonlyDomains": ["shared-cohort"]
}
```

`readonlyDomains` (v3.0.2+, additive) lists domains whose `CLAUDE.md`
declares `readonly: true` — Shared Brain mirror domains. The UI excludes them
from write-target dropdowns (Ingest); write endpoints refuse them server-side.

---

## GET /api/domains/:domain/stats

Return statistics for a single domain.

**Path parameter**

| Parameter | Description |
|-----------|-------------|
| `domain` | Domain slug (e.g. `ai-tech`) |

**Example (curl)**

```bash
curl http://localhost:3333/api/domains/ai-tech/stats
```

**Success response** `200 OK`

```json
{
  "slug": "ai-tech",
  "displayName": "AI / Tech",
  "pageCount": 317,
  "conversationCount": 3,
  "lastIngestDate": "2026-04-08"
}
```

`lastIngestDate` is `null` if no sources have been ingested yet.

**Error responses**

| Status | Condition |
|--------|-----------|
| `404` | Unknown domain |
| `500` | Filesystem read error |

---

## POST /api/domains

Create a new domain with a complete directory scaffold and an auto-generated CLAUDE.md schema.

**Request body** `Content-Type: application/json`

```json
{
  "displayName": "Health & Fitness",
  "description": "Nutrition, exercise, recovery, and wellness.",
  "template": "generic"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `displayName` | string | Yes | Human-readable name (e.g. `Health & Fitness`) |
| `description` | string | No | 1–2 sentence scope description written into CLAUDE.md |
| `template` | string | No | `tech`, `business`, `personal`, or `generic` (default: `generic`) |

The folder slug is derived automatically from `displayName` (lowercased, special chars replaced, max 32 chars). If a slug collision exists, a suffix (`-2` … `-9`) is appended.

**Success response** `201 Created`

```json
{
  "slug": "health-and-fitness",
  "displayName": "Health & Fitness"
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `displayName`; invalid template; domain already exists |
| `500` | Filesystem write error |

---

## PUT /api/domains/:domain

Rename a domain — changes the folder name and updates all internal references.

**Request body** `Content-Type: application/json`

```json
{
  "displayName": "Health & Wellness"
}
```

**What changes:**
- Folder is renamed on disk (`fs.rename` — atomic on the same filesystem)
- `# Domain:` header in `CLAUDE.md` is updated
- `# Wiki Index —` header in `wiki/index.md` is updated
- `# Ingest Log —` header in `wiki/log.md` is updated
- `domain` field in every `conversations/*.json` is updated

**Success response** `200 OK`

```json
{
  "oldSlug": "health-and-fitness",
  "newSlug": "health-and-wellness",
  "displayName": "Health & Wellness",
  "syncWarning": true
}
```

`syncWarning` is `true` when GitHub sync is configured — the rename appears as a delete + add on GitHub, so the user should sync promptly.

**Concurrency:** refuses with `409` while this domain has an active write (per-domain `isDomainActive` check). Renaming mid-ingest is silently dangerous rather than loudly broken — an in-flight ingest resolves its own wiki paths per page from the slug it captured at request time, so it keeps writing under the OLD (now-renamed-away) directory name, which `writePage`'s `mkdir(recursive: true)` happily recreates; those pages become invisible to every UI surface (the v2.3.4 ghost-domain filter hides any directory with no `CLAUDE.md`) until the ingest finally dies at the logging step. The guard covers a display-name-only rename too, since that still rewrites `log.md`'s header and races `appendLog`.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `displayName`; new slug identical to old slug |
| `404` | Domain not found |
| `409` | This domain has an active write (ingest, batch item, Sync, Shared Brain pull, etc.) in progress |
| `500` | Filesystem error |

---

## DELETE /api/domains/:domain

Permanently delete a domain and all its contents (wiki pages, conversations, source files).

**Concurrency:** refuses with `409` while this domain has an active write (same per-domain `isDomainActive` check as the rename above) — deleting the folder mid-write would race the ingest's own `writePage` calls.

**Example (curl)**

```bash
curl -X DELETE http://localhost:3333/api/domains/health-and-wellness
```

**Success response** `200 OK`

```json
{
  "deleted": true,
  "syncWarning": true
}
```

`syncWarning` is `true` when sync is configured — the deletion will propagate to GitHub on the next sync.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | Invalid slug (path traversal attempt) |
| `404` | Domain not found |
| `409` | This domain has an active write (ingest, batch item, Sync, Shared Brain pull, etc.) in progress |
| `500` | Filesystem error |

---

## POST /api/ingest

Ingest a file into a domain. Sends a `multipart/form-data` request.

**Request fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | Yes | Domain slug (must match a directory under `domains/`) |
| `file` | file | Yes | File to ingest (`.txt`, `.md`, `.pdf`; max 50MB) |

**Example (curl)**

```bash
curl -X POST http://localhost:3333/api/ingest \
  -F "domain=ai-tech" \
  -F "file=@/path/to/paper.pdf"
```

**Success response** `200 OK`

```json
{
  "success": true,
  "title": "Attention Is All You Need",
  "pagesWritten": [
    "summaries/attention-is-all-you-need.md",
    "concepts/transformer.md",
    "concepts/self-attention.md",
    "entities/vaswani-et-al.md",
    "entities/google-brain.md"
  ]
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `domain` or `file`; unknown domain; unsupported file type |
| `500` | LLM provider error; PDF parsing failure; filesystem write error |

```json
{ "error": "Unsupported file type: .docx. Allowed: .txt, .md, .pdf" }
```

---

## Batch ingest queue (`/api/ingest-queue`, Track 3)

A server-owned, disk-persisted, strictly sequential job for ingesting many files into one domain as a single resumable operation. See [docs/ingestion-pipeline.md](ingestion-pipeline.md) for the full design rationale (why sequential, why duplicates are decided at creation, why a crash never auto-resumes spend). All endpoints are mounted under `/api/ingest-queue`.

### The job object

Every endpoint below returns (or streams) a **job**. `toWire()` is the single chokepoint every job passes through before it can reach HTTP — it is an explicit allow-list of named fields, not a generic spread, so a future internal field never leaks by accident. Two things every string field goes through: **path-scrubbing** and **length-capping**. `stagedPath` (an absolute server-side path to each item's staged upload) is dropped entirely — there is no way to obtain it from this API. Any *other* string that could carry an absolute filesystem path — `item.error`, `job.pausedMessage`, `job.failReason` — has that path reduced to its basename (e.g. a raw `ENOENT: ... open '/Users/alice/Google Drive/domains/ai-tech/wiki/log.md'` becomes `ENOENT: ... open '.../log.md'`) before it ever reaches the response, so a bug report a user pastes in doesn't hand out their home directory or cloud-storage folder layout. Every string is also length-capped (long ones truncate with `… (truncated)`).

```json
{
  "jobId": "b6b5a1b0-2f3e-4b1a-9c3d-1a2b3c4d5e6f",
  "version": 1,
  "domain": "ai-tech",
  "createdAt": "2026-08-23T10:00:00.000Z",
  "updatedAt": "2026-08-23T10:04:12.000Z",
  "status": "running",
  "pausedReason": null,
  "pausedMessage": null,
  "failReason": null,
  "overwrite": false,
  "budgetUsd": 5,
  "spentUsd": 1.234567,
  "spendIsEstimated": false,
  "order": "largest-first",
  "estimate": { "usdLow": 2.1, "usdHigh": 4.3, "basis": "..." },
  "currentIndex": 2,
  "consecutiveFailures": 0,
  "cancelRequested": false,
  "pauseRequested": false,
  "itemCount": 4,
  "itemsTruncated": false,
  "health": null,
  "items": [
    {
      "idx": 0,
      "name": "big-report.pdf",
      "bytes": 812345,
      "status": "done",
      "startedAt": "2026-08-23T10:00:01.000Z",
      "finishedAt": "2026-08-23T10:01:40.000Z",
      "attempts": 1,
      "error": null,
      "result": { "title": "...", "pagesWritten": 6, "warningCount": 0, "changeCounts": { "created": 4, "updated": 2, "unchanged": 0 } },
      "tokenUsage": { "provider": "gemini", "model": "gemini-2.5-flash-lite", "inputTokens": 180000, "outputTokens": 9000 }
    }
  ]
}
```

`itemCount` is the true total number of items in the batch; `items` itself is capped (500 entries — never reached by a normal batch, which tops out at 100 files) and `itemsTruncated` is `true` if the cap trimmed anything. `spentUsd` is tracked to 6 decimal places (not 4), so a long run of very small per-file charges can't silently round down to zero.

`cancelRequested`/`pauseRequested` are `true` only in the brief window between a `/pause` or `/cancel` call landing and the job actually settling — they are read live off in-process state at serialisation time, never persisted to the manifest, and always `false` for a job recovered after a restart (a stop request from a previous process run must never silently apply to a later one). A GET or SSE frame taken mid-cancel will show `status: "running"` with `cancelRequested: true` for that brief window; poll again (or just wait for the next SSE frame) and it resolves to `status: "cancelled"`.

**`job.status`** — one of `pending` (created, not yet started) · `running` · `paused` · `done` · `cancelled` · `failed` (a terminal state used only when the domain itself becomes unusable on start/resume — deleted, renamed, or turned into a read-only Shared Brain mirror; see `failReason`). `done` / `cancelled` / `failed` are terminal — none of the control endpoints act on a job in those states.

**`job.pausedReason`** (only meaningful when `status === 'paused'`) — one of:

| Value | Meaning |
|---|---|
| `rate_limit` | The AI provider rate-limited a request; already retried with backoff. |
| `service_unavailable` | The AI provider was temporarily unavailable; already retried with backoff. |
| `budget` | `job.spentUsd` reached `job.budgetUsd`. |
| `consecutive_failures` | 3 items in a row failed (any reason). |
| `interrupted` | The app restarted mid-batch; recovered on boot. |
| `locked` | Another process (update/sync/MCP) holds the domain's write lock. |
| `user` | A client called `/pause`, or cancelled a not-yet-started job. |

**`item.status`** — one of `pending` · `running` · `done` · `failed` · `skipped` (decided once, at creation — see `POST /` below) · `cancelled` (terminal — the file that was actively being ingested when a `/cancel` request interrupted it; see `POST /:jobId/cancel` below).

**Every item always ends up in exactly one bucket.** The job is guaranteed to never report `done` while any item is still non-terminal (`pending`/`running`) — if that would ever happen (it shouldn't, but the guarantee is enforced at the one place every exit from `running` passes through, not assumed), the job settles as `paused` instead, with a message naming exactly which file(s) are unaccounted for, rather than silently reporting success over a dropped file.

---

### POST /api/ingest-queue/estimate

Free. Reads no file bytes — `files` is metadata only (`{name, size}`). Runs the real prompt-assembly functions against the domain's actual current entity/concept inventory and index, so the estimate reflects the domain's real current size, not a flat per-file rate. It also runs the same files through the same estimator against a *simulated empty* domain, purely in memory (no extra I/O), and uses the two numbers to compute a `sizeMultiplier` — how much more this specific batch costs against this domain than it would against a fresh one. That ratio is folded into `estimate.basis` as prose; it is **not** a fixed number. It depends heavily on document size relative to the fixed per-call overhead (the existing page inventory, re-sent on every call) — small documents are affected far more than large ones. Do not assume any single multiplier (e.g. "2x") generalizes across batches.

**Request body**

```json
{ "domain": "ai-tech", "files": [{ "name": "report.pdf", "size": 812345 }] }
```

**Response** `200 OK`

```json
{
  "ok": true,
  "provider": "gemini",
  "model": "gemini-2.5-flash-lite",
  "files": {
    "count": 1,
    "totalBytes": 812345,
    "accepted": ["report.pdf"],
    "rejected": [{ "name": "notes.docx", "reason": "Unsupported file type: .docx — The Curator can ingest .txt, .md and .pdf files." }]
  },
  "estimate": {
    "inputTokensLow": 180000, "inputTokensHigh": 180000,
    "outputTokensLow": 9000, "outputTokensHigh": 9000,
    "usdLow": 1.9, "usdHigh": 2.4,
    "basis": "Estimated for Gemini \"gemini-2.5-flash-lite\" against the \"ai-tech\" domain, currently 40 entities, 90 concepts, 12 KB index. Cost depends heavily on how large this wiki ALREADY is, not just on the files being ingested: every AI call re-sends the existing page list so the model can link to (not duplicate) what is already there. For THIS batch, that existing content works out to about 3.1x the input tokens the same files would cost against an empty domain. ... Both ends are estimates rather than limits — actual spend can land above the range, and on a measured real batch it did."
  },
  "domainContext": { "pageCount": 140, "indexBytes": 12288 },
  "warnings": []
}
```

`usdLow` assumes prompt caching applies (multi-call documents only); `usdHigh` assumes it does not. Both are `null` (with a `warnings[]` entry) if no AI provider is configured, or if the configured model has no published price on file — `files`/token counts are still returned in that case. **`usdHigh` is an estimate, not a ceiling** — it is the no-caching end of a range, and on a real measured live batch (see [docs/ingestion-pipeline.md §10g.8](ingestion-pipeline.md#10g8--how-the-cost-estimate-is-derived)) actual spend came in at 103.1% of `usdHigh`. Do not treat it as a spending guarantee.

A file whose size is missing or not a valid non-negative number is placed in `rejected` (not silently priced at $0) with a reason naming the problem.

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | Missing `domain`; unknown domain; `files` not an array; more than 100 files in one estimate request (split it and estimate each part). |

---

### POST /api/ingest-queue

Creates a batch job from a `multipart/form-data` upload. Files are staged into the queue's own durable storage (outside the domains folder — see ingestion-pipeline.md) before this call returns.

**Request fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | Yes | Domain slug. |
| `files` | file[] | Yes | 1–100 files, `.txt`/`.md`/`.pdf`, 50MB each, 2GB total per batch. |
| `overwrite` | `'true'`/`'false'` | No | Re-ingest files already present in `raw/` instead of skipping them. Default `false`. |
| `budgetUsd` | number | No | Optional spend cap for the whole batch. Default no cap. |

Files are reordered **largest-first** internally regardless of upload order; `job.items[]`'s array order *is* the processing order.

At creation, any file whose name already exists in the domain's `raw/` folder is immediately marked `skipped` (with an explanatory `item.error`) and never staged or uploaded to the LLM — this decision is made exactly once, at creation, against the pre-batch `raw/` state; it is never re-checked at run time (re-checking at run time would misclassify a crash-interrupted item as a duplicate — see ingestion-pipeline.md).

**Two files in the same batch sharing a name** (a case the `raw/`-based check above cannot catch, since neither exists in `raw/` yet) is handled separately: the first is staged normally; the second is marked `skipped` with an explanatory `item.error`, regardless of `overwrite`. Both would deterministically land on the same summary slug and silently merge into one page, so only the first is ingested.

A file that fails to stage for a reason specific to that one file (an OS-rejected filename, a read error) is marked `failed` and does **not** abort the rest of the batch — every other file in the request is still created, staged, and queued normally.

Creating a job also prunes old finished batches: only the most recent 20 terminal (`done`/`cancelled`/`failed`) job directories — and their staged files — are kept on disk; older ones are deleted automatically. `GET /` (below) is separately capped at showing 20.

**Success response** `200 OK`

```json
{ "ok": true, "jobId": "b6b5a1b0-...", "job": { "...": "the job object above, status: pending" } }
```

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | Missing `domain`; no files; unknown domain. |
| `400` | Read-only Shared Brain mirror domain — same refusal text as `POST /api/ingest`. |
| `400` | A `budgetUsd` was supplied but the active AI provider/model has no published price on file, so the cap could not be enforced (it would run the whole batch while reporting $0.00 spent). Retry the same request without `budgetUsd`, or switch to a priced model in Settings first. |
| `409` | Another batch is already active (any non-terminal status) in this process. Body includes `activeJobId`. |
| `409` | Another `POST /` is already being processed (create requests are serialised). Retry. |
| `413` | One file over 50MB; more than 100 files; or the batch's total size exceeds 2GB. |

A batch job created but never started (`status: pending`) does not spend anything and does not count toward the "only one batch at a time" limit being exceeded by itself — but it IS the active job, so a second `POST /` while it exists still 409s.

---

### GET /api/ingest-queue

Lists recent jobs (most recently updated first, capped at 20). Finished (terminal) job directories beyond the most recent 20 are actually deleted from disk automatically (see `POST /` above), so this list rarely needs to truncate in practice.

**Response** `200 OK`

```json
{ "ok": true, "jobs": [ "...job objects..." ] }
```

---

### GET /api/ingest-queue/active

Returns the one job that is not in a terminal state (`pending`/`running`/`paused`), if any — `null` otherwise. Cheap; safe to poll on app load or Ingest-tab entry to resume showing an in-progress batch.

**Response** `200 OK`

```json
{ "ok": true, "job": null }
```

---

### GET /api/ingest-queue/:jobId

**Response** `200 OK` — `{ "ok": true, "job": { "..." } }`

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | `jobId` is not a valid UUID. |
| `404` | Job not found. |

---

### GET /api/ingest-queue/:jobId/stream

Server-Sent Events. Supports multiple concurrent listeners on the same job. On connect, sends one full job snapshot immediately, then streams events as they happen. The client is expected to always render from the latest full snapshot rather than deriving state incrementally.

Each event is a line `data: <json>\n\n` where the JSON has a `type`:

| `type` | Shape | Meaning |
|---|---|---|
| `job` | `{ type: 'job', job }` | A full job snapshot — sent after every state transition. |
| `item-progress` | `{ type: 'item-progress', idx, pct, message }` | Fine-grained progress for the currently-running item only (mirrors the single-file ingest's own progress event). Not a full job snapshot. |
| `done` | `{ type: 'done', job }` | The job reached a terminal state (`done`/`cancelled`/`failed`) or settled into `paused`. The stream ends after this event. |

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | `jobId` is not a valid UUID. |
| `404` | Job not found. |

---

### POST /api/ingest-queue/:jobId/start

Starts a `pending` job or resumes a `paused` one. Idempotent — calling it again while the same job is already running just returns the current state, including when several `/start` requests for the **same** job land at once (a double-clicked Resume, two open tabs, a reload mid-request): exactly one worker loop is ever running for a given job, guaranteed by a synchronous claim taken before anything else happens, not by a check-then-act sequence that a second near-simultaneous request could slip through. Re-validates the domain (unknown/deleted/renamed/now-read-only) on every call, not only at creation; a domain that has become unusable while the job sat paused moves the job to `failed` with `failReason` set, rather than starting.

**Response** `200 OK` — `{ "ok": true, "job": { "...", "status": "running" } }`

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | Invalid `jobId`. |
| `404` | Job not found. |
| `409` | A *different* job is currently running in this process. |

---

### POST /api/ingest-queue/:jobId/pause

Requests a pause. If an item is currently mid-ingest, the pause takes effect once that item finishes (never mid-item); a `pending`/never-started job pauses immediately. No-op (returns the job as-is) if already in a terminal state.

**Response** `200 OK` — `{ "ok": true, "job": { "..." } }`

---

### POST /api/ingest-queue/:jobId/cancel

Requests a cancellation. **Unlike pause, cancel also aborts the item currently in flight** — it does not wait for the current file to finish. An `AbortSignal` reaches the running `ingestFile()` call and, through it, the active LLM call and provider SDK request; the ingest is interrupted at the next call boundary rather than allowed to run to completion. Measured on a real multi-phase ingest: **74ms from cancel to fully stopped, zero further LLM calls issued** (a continuation of that same run to completion would otherwise have taken 334 seconds and made 17 more provider calls).

The item that was interrupted is marked `cancelled` (terminal), with `item.error` carrying an honest, deliberately conservative message: *"Stopped partway through — some pages may already have been written. Re-ingest this file to complete it."* In practice a mid-ingest cancel usually interrupts before any page has been written at all — `writePage()` only runs after the AI has finished generating content for that file — but the message doesn't promise that, because it can't guarantee it for every timing. **Nothing is deleted or rolled back.** Because the file is already recorded in `raw/`, completing it requires re-ingesting with `overwrite: true` (the same pre-existing duplicate-file rule that applies to any deliberate re-run — see `POST /` above).

Staged files for every item still `pending` at cancel time are deleted; items already `done` stay in the wiki — cancelling never undoes completed work. `pauseRequested`/`cancelRequested` on the job object (above) reflect the brief in-flight window between the request landing and the job actually settling to `cancelled`.

**Response** `200 OK` — `{ "ok": true, "job": { "...", "status": "cancelled" } }`

---

### DELETE /api/ingest-queue/:jobId

Deletes a job's on-disk record and any remaining staged files entirely. Works by validated job-directory path rather than by first parsing the manifest, so a job whose `manifest.json` has somehow become corrupt (and is therefore invisible to `GET /` and `GET /active`, which both skip unreadable manifests) can still be deleted and its disk space reclaimed — that is precisely the case where deleting matters most.

**Response** `200 OK` — `{ "ok": true }`

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | Invalid `jobId`. |
| `404` | Job not found. |
| `409` | The job is currently `running` — pause or cancel it first. |

---

## POST /api/query

Ask a question against a domain's wiki.

**Request body** `Content-Type: application/json`

```json
{
  "domain": "ai-tech",
  "question": "What is retrieval-augmented generation and why does it matter?"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | Yes | Domain slug |
| `question` | string | Yes | Natural language question |

**Example (curl)**

```bash
curl -X POST http://localhost:3333/api/query \
  -H "Content-Type: application/json" \
  -d '{"domain":"ai-tech","question":"What is RAG?"}'
```

**Success response** `200 OK`

```json
{
  "answer": "Retrieval-Augmented Generation (RAG) is a technique that combines a retrieval step with a language model generation step [source: concepts/rag.md]. Rather than relying solely on the model's parametric knowledge, RAG fetches relevant documents from an external store first and conditions the generation on them [source: summaries/rag-survey.md].\n\n## Sources\n- concepts/rag.md\n- summaries/rag-survey.md",
  "citations": [
    "concepts/rag.md",
    "summaries/rag-survey.md"
  ]
}
```

If the wiki is empty:

```json
{
  "answer": "This domain's wiki is empty. Ingest some sources first.",
  "citations": []
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `domain` or `question`; unknown domain |
| `500` | LLM provider error |

---

## GET /api/wiki/:domain

Return all wiki pages for a domain.

**Path parameter**

| Parameter | Description |
|-----------|-------------|
| `domain` | Domain slug |

**Example (curl)**

```bash
curl http://localhost:3333/api/wiki/ai-tech
```

**Success response** `200 OK`

```json
{
  "domain": "ai-tech",
  "pages": [
    {
      "path": "index.md",
      "content": "# Wiki Index — AI / Tech\n..."
    },
    {
      "path": "concepts/rag.md",
      "content": "# RAG\n..."
    },
    {
      "path": "summaries/attention-paper.md",
      "content": "# Attention Is All You Need\n..."
    }
  ]
}
```

Pages are returned in filesystem traversal order (depth-first). The `path` field is relative to `domains/<domain>/wiki/`.

**Error responses**

| Status | Condition |
|--------|-----------|
| `404` | Unknown domain |
| `500` | Filesystem read error |

---

## GET /api/wiki/:domain/page

Return exactly **one** page — frontmatter, title, type, raw body — plus every page in the domain that links to it (backlinks). Built for the citation-chip reader panel, which needs to open a single page without paying for the whole domain the way `GET /api/wiki/:domain` above does (14 MB on the real `articles` domain). Reads are served from `src/brain/wiki-read.js`, independent of `mcp/graph.js` (the MCP server is a stdio child process; see that module's docblock for why the two readers are deliberately not coupled).

Reads are allowed on read-only Shared Brain mirror domains — this route never writes.

**Path / query parameters**

| Parameter | Description |
|-----------|-------------|
| `domain` | Domain slug (path parameter) |
| `path` | Page path relative to `domains/<domain>/wiki/`, e.g. `entities/tali-rezun.md` (query parameter; the same string used elsewhere in the app — chat citations, `readWikiPages()`'s `path` field) |

**Success response** `200 OK`

```json
{
  "domain": "ai-tech",
  "path": "entities/tali-rezun.md",
  "folder": "entities",
  "slug": "tali-rezun",
  "title": "Tali Rezun",
  "type": "entity",
  "frontmatter": { "tags": ["type/entity"], "...": "..." },
  "body": "## Summary\n...",
  "backlinks": [
    { "path": "summaries/attention-paper.md", "folder": "summaries", "slug": "attention-paper", "title": "Attention Is All You Need", "readable": true }
  ],
  "resolvableTarget": true,
  "readonly": false
}
```

`backlinks` uses **exactly** the same "does this `[[link]]` point at that page" rule `health.js`'s `scanWiki()` uses to decide whether a link is broken, so the reader can never disagree with the Health tab about whether a link resolves — a bare `[[slug]]` resolves only against `entities/`/`concepts/` (never `summaries/`, which always needs its prefix), and `[[folder/slug]]` needs an exact folder+slug match.

`resolvableTarget` is `false` for a page nested below the canonical folder's first level (e.g. `entities/companies/nested-corp.md` — `writePage` never produces these, but a hand-edited or migrated wiki can have them). Such a page is still readable and its `backlinks` array is truthfully empty: *nothing in this wiki can resolve a link to it*, not merely "nothing does".

`readonly` mirrors the domain's Shared Brain mirror status (`isDomainReadonly`), additive to what `getWikiPage()` itself returns.

**Error responses**

| Status | Condition |
|--------|-----------|
| `404` | Unknown domain, or the page doesn't exist on disk |
| `400` | Missing/invalid `path`, path outside `entities/`/`concepts/`/`summaries/`, or the path is a symlink (or sits under a symlinked folder) that escapes the wiki folder (`code: "WIKI_PATH_ESCAPES"`) |

---

## GET /api/wiki/:domain/source

Track 7 Part II. "Which original document was this summary built from, and is it still on this machine?" Every resolution goes through `resolveRawSource()` in `src/brain/raw-store.js` — the single chokepoint for turning an untrusted `source:` frontmatter value into a path on disk; see [docs/ingestion-pipeline.md](ingestion-pipeline.md) for the full security design.

**Query parameters**

| Parameter | Required | Description |
|-----------|----------|--------------|
| `path` | Yes | Summary page path, e.g. `summaries/attention-paper.md`. |
| `hash` | No | `1` or `true` to also compute and return a `sha256` of the file (streamed; can take seconds on a very large PDF). Omit for a fast response — hashing never runs by default. |

**`found: true` response** `200 OK`

```json
{
  "ok": true,
  "found": true,
  "page": "summaries/attention-paper.md",
  "filename": "attention-is-all-you-need.pdf",
  "bytes": 2411520,
  "mtime": "2026-03-12T09:14:02.000Z",
  "sha256": null
}
```

**`found: false` response** `200 OK` — this is the NORMAL response on any machine that only pulled the wiki via sync, and is not an error. `raw/` is gitignored and never syncs, so most summaries on a second machine report `reason: "missing"`.

```json
{ "ok": true, "found": false, "page": "summaries/attention-paper.md", "reason": "missing", "declaredSource": "attention-is-all-you-need.pdf", "manifest": { "filename": "attention-is-all-you-need.pdf", "bytes": 2411520, "sha256": "...", "ingestedAt": "2026-03-12T09:14:02.000Z" }, "message": "..." }
```

`reason` is one of:

| `reason` | Meaning |
|---|---|
| `missing` | Recorded, but the file isn't in this domain's `raw/` folder on this machine. `manifest` is populated when a synced `.raw-manifest.jsonl` record exists for it (filename, size, sha256, ingest date) — `null` otherwise. |
| `external-source` | The summary's `source:` names a web page (e.g. `medium.com/@author`), not a local file. `url`/`declaredSource` carry the value verbatim. **Never fetched** — see the security note below. |
| `unsafe` | The recorded value isn't resolvable to a real file The Curator will open — an untrusted or malformed name, or a path that resolves outside `raw/` (a symlink escape, most likely from a synced or restored wiki). |
| `not-a-file` | The name exists in `raw/` but isn't a regular file — a directory, or (deliberately, even if it resolves back inside `raw/`) any symlink. |
| `not-a-summary` | The requested page is an entity or concept, not a summary — those are synthesised from many sources and never have a single original. |
| `no-source-recorded` | A summary with no `source:` field — written before the field existed, or compiled from a chat conversation rather than ingested from a file. |

**Never returns an absolute filesystem path** — only a filename, byte count, and timestamp. The response never contains anything the client could use to reconstruct a path on the server.

**Security note on `external-source`:** the value is classified, never fetched. `source:` is LLM-written, lives in a file the user can hand-edit, and arrives over Personal Sync and Shared Brain mirror pulls — from other machines and other people. Turning that string into an outbound HTTP request would make it an SSRF primitive. Neither this route nor `raw-store.js` imports any HTTP client.

**Errors**

| Status | Condition |
|--------|-----------|
| `404` | Unknown domain, or (propagated from the page reader) an unknown page path. |
| `400` | Malformed `path`. |

---

## POST /api/wiki/:domain/source/reveal

Track 7 Part II. Opens the original document's location in Finder (`open -R`, revealing and highlighting the file). **macOS only.**

**Request body**

```json
{ "path": "summaries/attention-paper.md" }
```

**Success response** `200 OK` — `{ "ok": true, "filename": "attention-is-all-you-need.pdf" }`

**Errors**

| Status | Condition |
|--------|-----------|
| `404` | Unknown domain; or the source could not be found/resolved (body carries `{ ok: false, reason, error }` using the same `reason` values as `GET .../source` above). |
| `501` | Not macOS. `error` explains that revealing in a file manager is macOS-only and suggests opening the domain's `raw/` folder manually. |

Why `POST`, not `GET`: this endpoint has a side effect on the user's desktop (it opens Finder), so it must be behind the app's cross-origin guard — a `<img src>` or bare link on a malicious page cannot trigger a `GET`-only side effect, and this route deliberately isn't one. The server resolves the path itself via `resolveRawSource()`, then hands it to `execFile('open', ['-R', absPath])` — never a shell — so no filename, however unusual, can be word-split or reinterpreted. If containment can't be proven, the route refuses outright; it never falls back to opening a parent directory.

---

## GET /api/health

Server ping. Used by the UI to detect whether the server is running.

**Success response** `200 OK`

```json
{ "ok": true, "version": "2.2.0" }
```

---

## GET /api/health/:domain

Scan a domain's wiki for structural issues. Pure — no writes.

**Path parameter**

| Parameter | Description |
|-----------|-------------|
| `domain` | Domain slug |

**Example (curl)**

```bash
curl http://localhost:3333/api/health/ai-tech
```

**Success response** `200 OK`

```json
{
  "domain": "ai-tech",
  "scannedAt": "2026-04-20T11:03:13.937Z",
  "counts": { "entities": 42, "concepts": 28, "summaries": 15 },
  "brokenLinks": [
    { "sourceFile": "summaries/foo.md", "linkText": "missing-page", "suggestedTarget": null }
  ],
  "orphans": [
    { "path": "concepts/orphan.md", "type": "concept", "slug": "orphan" }
  ],
  "folderPrefixLinks": [
    { "sourceFile": "summaries/foo.md", "linkText": "concepts/rag" }
  ],
  "crossFolderDupes": [
    { "keep": "entities/google.md", "remove": "concepts/google.md" }
  ],
  "hyphenVariants": [
    { "files": ["tali-rezun", "talirezun"], "suggestedSlug": "tali-rezun" }
  ],
  "missingBacklinks": [
    { "summary": "summaries/foo.md", "entity": "entities/bar.md", "summarySlug": "foo" }
  ]
}
```

**Issue types**

| Type | Auto-fixable | Description |
|------|:-:|-------------|
| `brokenLinks` | ✓¹ | `[[wikilink]]` that points to a non-existent page. Includes a `suggestedTarget` when a prefix-tolerant match exists. |
| `orphans` | — | Entity or concept pages with zero incoming links. |
| `folderPrefixLinks` | ✓ | Links like `[[concepts/rag]]` that should be `[[rag]]`. |
| `crossFolderDupes` | ✓ | Same page exists in both `entities/` and `concepts/`. |
| `hyphenVariants` | ✓ | Entity files differing only in hyphenation (e.g. `tali-rezun` + `talirezun`). |
| `missingBacklinks` | ✓ | Summary mentions an entity under "Entities Mentioned" but the entity's Related section doesn't link back. |

¹ `brokenLinks` are auto-fixable **only when `suggestedTarget` is non-null** — the fix rewrites the link in the source file to point at the suggestion. Broken links without a suggestion are review-only; `fix-all` silently skips them and `total` reflects the count of fixable (suggested) issues, not the total broken-link count.

**Error responses**

| Status | Condition |
|--------|-----------|
| `404` | Unknown domain |
| `500` | Filesystem read error |

---

## POST /api/health/:domain/fix

Apply a single fix for a specific issue.

**Request body** `Content-Type: application/json`

```json
{
  "type": "crossFolderDupes",
  "issue": { "keep": "entities/google.md", "remove": "concepts/google.md" }
}
```

`type` must be one of the auto-fixable types. `issue` must be an exact issue object returned by `GET /api/health/:domain`.

**Read-only mirrors (v3.0.2+):** every mutating Health endpoint returns **400** when `:domain` is a read-only Shared Brain mirror (`readonly: true` in the domain's `CLAUDE.md`) — a write to a mirror would be overwritten on the next Pull. The full list is `/fix`, `/fix-all`, `/fix-all-safe`, `/broken-links/apply`, `/orphans/apply`, `/semantic-dupes/merge-batch`, and `/dismiss` and `/undismiss`.

Those last two were missing the refusal until v3.6.2, while their MCP twins (`dismiss_wiki_issue`, `undismiss_wiki_issue`) had carried it since v3.0.0-beta.1. The store they write, `<domain>/wiki/.health-dismissed.jsonl`, lives *inside* the git-tracked `wiki/` folder and therefore syncs, so a dismissal recorded on a mirror was silently discarded by the next Pull exactly like a "fix" would be.

Scanning (`GET /api/health/:domain`), reading dismissals (`GET /api/health/:domain/dismissed`), and the read-only planning endpoints (`/ai-suggest`, `/semantic-dupes/scan`, `/semantic-dupes/preview`, `/broken-links/plan`, `/orphans/plan`) all still work on mirrors — reads are deliberately allowed so users can inspect a mirror and spot conflict markers.

This list is enumerated mechanically rather than maintained by hand: `scripts/test-route-write-guards.js` derives the writability class from `src/routes/health.js` itself and fails if any route in it lacks the guard, if the behavioural sweep leaves one undriven, or if a new mutating route appears without being classified.

**Success response** `200 OK`

```json
{ "ok": true, "fixed": 1, "total": 1 }
```

**Concurrency:** registered as a write-op with a per-domain file lock (this branch — it used to be unguarded on the theory that a single fix is sub-second, which turned out to be wrong: an omitted `issue` runs the same bulk path as `/fix-all` below, and even the single-issue `semanticDupe` path walks every file in the domain). A concurrent sync/update/delete, or an update already in progress, is refused with `409`.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `type`; type is review-only (`orphans`), or `brokenLinks` issue has no `suggestedTarget` |
| `404` | Unknown domain |
| `409` | A write/update is already in progress for this domain (write-registry conflict), or the per-domain file lock is held by another process |

---

## POST /api/health/:domain/fix-all

Apply every fix of a given type in one call. Re-scans the wiki, then applies each fix in turn. Registered as a write-op with a per-domain file lock; a concurrent sync/update/delete, or an update already in progress, is refused with `409`.

**Request body** `Content-Type: application/json`

```json
{ "type": "missingBacklinks" }
```

**Success response** `200 OK`

```json
{ "ok": true, "fixed": 7, "total": 7 }
```

`fixed` may be less than `total` if any individual fix fails (each failure is logged to the server console but does not abort the batch).

**Error responses** — same as `/fix`, including `409`.

---

## GET /api/health/ai-available

Probe for whether the **✨ Ask AI** feature (v2.4.3+) is available — i.e. whether a usable LLM API key is configured. The frontend calls this on each Health scan to decide whether to render the Ask AI button.

**Success response** `200 OK` — key configured

```json
{ "available": true, "provider": "gemini", "model": "gemini-2.5-flash-lite" }
```

**Success response** `200 OK` — no key configured

```json
{ "available": false, "reason": "No LLM API key found. Add one in Settings, or set GEMINI_API_KEY / ANTHROPIC_API_KEY in .env." }
```

This endpoint never returns a non-200 status — availability is a soft signal, not an error.

---

## GET /api/diagnostics/quick

Run the **free, local** self-diagnostics behind the Settings → System Check panel (v3.0.1-beta.23+). No network call, no API cost; never touches wiki content (the folder-writable probe writes a self-deleting temp file).

**Success response** `200 OK`

```json
{
  "checks": [
    { "id": "version",     "label": "Installed version",            "status": "info", "detail": "The Curator v3.0.1-beta.23" },
    { "id": "provider",    "label": "AI provider key",              "status": "ok",   "detail": "Configured: gemini · gemini-2.5-flash-lite" },
    { "id": "domains",     "label": "Knowledge folder",             "status": "ok",   "detail": "Readable and writable: /…/domains" },
    { "id": "credentials", "label": "Credential file permissions",  "status": "ok",   "detail": "All 4 credential file(s) are owner-only (0600)." },
    { "id": "sync",        "label": "GitHub sync",                  "status": "ok",   "detail": "Configured: github.com/you/your-brain" }
  ],
  "summary": { "ok": 4, "warn": 0, "fail": 0, "info": 1 }
}
```

`status` is one of `ok` | `warn` | `fail` | `info`.

---

## POST /api/diagnostics/live

**Opt-in** AI connectivity test. Makes ONE tiny LLM call (a few tokens, ≈ $0.0001) to confirm the configured key works and the provider is responding. POST so the cross-origin guard applies and the frontend can gate it behind an explicit cost confirmation. Never throws — failures return `ok: false` with the error.

**Success response** `200 OK` — provider responded

```json
{ "ok": true, "provider": "gemini", "model": "gemini-2.5-flash-lite", "latencyMs": 773, "sample": "OK", "fallback": null }
```

**Success response** `200 OK` — call failed (still HTTP 200; check `ok`)

```json
{ "ok": false, "provider": "gemini", "model": "gemini-2.5-flash-lite", "latencyMs": 41203, "error": "⚠ Gemini infrastructure is temporarily overloaded (HTTP 503). …" }
```

---

## POST /api/health/:domain/ai-suggest

Ask the LLM to propose a target for an issue that the algorithmic scanner could not resolve. **Read-only — does not modify the wiki.** To apply the suggestion, call `POST /api/health/:domain/fix` with the returned target patched into `issue.suggestedTarget`.

**Supported types:**

- `type: 'brokenLinks'` (v2.4.3+) — propose a target for a broken wikilink.
- `type: 'orphans'` (v2.4.4+) — propose up to 5 pages that should link to an orphan.
- Phase 3 (semantic near-duplicates) planned for v2.4.5.

### Broken-link suggestion

**Request body** `Content-Type: application/json`

```json
{
  "type": "brokenLinks",
  "issue": {
    "sourceFile": "concepts/aerospace-and-ai.md",
    "linkText": "transportation",
    "suggestedTarget": null
  }
}
```

**Success response** `200 OK`

```json
{
  "ok": true,
  "target": "ai-in-transportation-systems",
  "rationale": "The source page discusses AI in aerospace, which is a sub-field of transportation.",
  "confidence": "medium"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `target` | string \| null | A slug that exists on disk, or `null` if no suitable target was found. Hallucinated slugs are rejected server-side (coerced to `null`). For summary targets the value is prefixed, e.g. `"summaries/the-paper-title"`. |
| `rationale` | string | One-sentence explanation of why this target was chosen (or why none fits). |
| `confidence` | string | `"high"`, `"medium"`, or `"low"`. The frontend hides **Apply** when `target` is `null` or `confidence` is `"low"`. |

### Orphan rescue suggestion

**Request body** `Content-Type: application/json`

```json
{
  "type": "orphans",
  "issue": {
    "path": "entities/acl-findings.md",
    "type": "entity",
    "slug": "acl-findings"
  }
}
```

**Success response** `200 OK`

```json
{
  "ok": true,
  "candidates": [
    {
      "target": "artificial-intelligence-research",
      "description": "ACL Findings is a venue publishing AI research.",
      "confidence": "high",
      "rationale": "ACL Findings is a benchmark specifically for AI research."
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `candidates` | array | Up to 5 validated candidates. May be empty if nothing plausible was found. |
| `candidates[].target` | string | A slug that exists on disk in `entities/` or `concepts/`. Never a summary. |
| `candidates[].description` | string | AI-written bullet text (trimmed to 140 chars). |
| `candidates[].confidence` | string | `"high"`, `"medium"`, or `"low"`. Frontend shows the Apply button only when confidence ≥ medium. |
| `candidates[].rationale` | string | One-sentence explanation of why this target was chosen. |

To apply a candidate, call `POST /api/health/:domain/fix` with `type: 'orphanLink'` (see below).

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `type`/`issue`, unsupported `type`, or no API key configured. |
| `404` | Unknown domain. |
| `500` | LLM call failed after the fallback chain was exhausted, or the response could not be parsed as JSON. |

Privacy note: this endpoint sends up to ~4 KB of the source/orphan page content plus the relevant slug inventory to the configured LLM provider. See [ai-health.md](ai-health.md) for the full disclosure.

---

## POST /api/health/:domain/fix — `orphanLink` variant

The existing `/fix` endpoint gains a new pseudo-type `orphanLink` in v2.4.4 to apply an AI orphan-rescue suggestion. This type is **never emitted by the scanner**; it exists only as a routing key so AI-driven orphan applies go through the same `fixIssue()` chokepoint as every other write.

**Request body**

```json
{
  "type": "orphanLink",
  "issue": {
    "orphanSlug": "acl-findings",
    "targetSlug": "artificial-intelligence-research",
    "description": "ACL Findings is a venue publishing AI research."
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `orphanSlug` | string | Bare slug (no folder prefix) of the orphan entity or concept. |
| `targetSlug` | string | Bare slug of the entity or concept to link from. Summaries are rejected. |
| `description` | string | Prose after the em-dash in the bullet. May be empty; in that case a bare `- [[orphanSlug]]` is written. |

**Success response** `200 OK`

```json
{ "ok": true, "fixed": 1, "total": 1 }
```

`fixed: 0` indicates a defence rejected the request (unknown slug, bad format, self-link, or summary target). No error status is returned in this case — it is a silent no-op to keep client code simple.

Writes `- [[orphanSlug]] — description` into the target's `## Related` section. Dedup-safe: a bullet with the same link target is not duplicated.

**`fix-all` is a no-op for `orphanLink`** — since the scanner never emits it, there is nothing to batch.

---

## GET /api/health/ai-settings

Returns the user's AI Health limits. Persisted in `.curator-config.json` under the `aiHealth` key.

**Response** `200 OK`

```json
{ "costCeilingTokens": 50000, "semanticDupeMaxPairs": 500 }
```

## POST /api/health/ai-settings

Partial update of the same fields. Non-numeric or non-positive values are ignored server-side.

**Request body**

```json
{ "costCeilingTokens": 200000, "semanticDupeMaxPairs": 1000 }
```

**Response** — echoes the effective settings after the update (same shape as GET).

---

## GET /api/health/:domain/semantic-dupes/estimate

Phase 3 (v2.4.5+). Runs the local candidate-pair pre-filter only. Makes **no LLM calls**. The UI uses this to render the confirm dialog before the real scan.

**Response** `200 OK`

```json
{
  "ok": true,
  "pageCount": 2434,
  "candidatePairs": 500,
  "totalCandidates": 18152,
  "truncated": true,
  "estimatedTokens": 200000,
  "estimatedUsd": 0.033,
  "provider": "gemini",
  "model": "gemini-2.5-flash-lite",
  "costCeilingTokens": 50000
}
```

Set `candidatePairs` is the top N after ranking; `totalCandidates` is the unbounded count (what `candidatePairs` was capped from). `truncated: true` means the pre-filter found more pairs than your cap allowed.

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | No API key configured; or `code: 'DOMAIN_TOO_LARGE'` if the domain exceeds 20,000 pages. |
| `404` | Unknown domain. |

---

## POST /api/health/:domain/semantic-dupes/scan

Phase 3. Streams the real scan over **Server-Sent Events (SSE)**.

Each event is emitted as `event: <type>\ndata: <json>\n\n`.

| Event | Shape | Meaning |
|-------|-------|---------|
| `start` | `{candidatePairs, batches}` | Scan is starting. |
| `progress` | `{processed, total, found}` | After each batch. |
| `pair` | `{pair: {keepSlug, keepFolder, removeSlug, removeFolder, confidence, rationale}}` | One accepted duplicate. |
| `batch-error` | `{batch, error}` | One batch failed (scan continues). |
| `done` | `{pairs, cost: {provider, model, inputTokens, outputTokens, estimatedUsd}}` | Final summary. |
| `error` | `{error, code?}` | Unrecoverable error — e.g. `code: 'OVER_COST_CEILING'`. |

The request body is empty (the scan uses the user's persisted settings).

---

## POST /api/health/:domain/semantic-dupes/preview

Phase 3. READ-ONLY. Returns a structured preview of what a specific merge would do. Called before the **Merge** button is enabled.

**Request body**

```json
{
  "issue": {
    "keepSlug": "email",
    "keepFolder": "concepts",
    "removeSlug": "e-mail",
    "removeFolder": "concepts"
  }
}
```

**Response** `200 OK`

```json
{
  "ok": true,
  "keepPath": "concepts/email.md",
  "removePath": "concepts/e-mail.md",
  "mergedPreview": "...",
  "mergedLength": 1836,
  "affectedFiles": [
    { "path": "concepts/cryptographic-algorithms.md", "linkCount": 1 },
    { "path": "summaries/beyond-encryption-block-labs-occ-tech.md", "linkCount": 1 }
  ],
  "affectedCount": 3,
  "totalLinksRewritten": 3
}
```

`affectedFiles` is capped at 50 entries; `affectedCount` is the full count.

---

## GET /api/health/:domain/broken-links/estimate

v3.0.1-beta.16. No LLM calls. Returns the breakdown used by the bulk-fix confirm dialog.

**Response** `200 OK`

```json
{
  "ok": true,
  "totalOccurrences": 1033,
  "uniqueTargets": 620,
  "resolveFree": 115,
  "needAi": 505,
  "inventorySize": 3308,
  "estimatedTokens": 149388,
  "estimatedUsd": 0.0162,
  "provider": "gemini",
  "model": "gemini-2.5-flash-lite"
}
```

---

## POST /api/health/:domain/broken-links/plan

v3.0.1-beta.16. READ-ONLY (makes LLM calls, writes nothing). SSE stream. Runs the deterministic pre-pass then the batched AI pass, gated by the lexical-variant check, and returns the full plan.

**SSE events**

| Event | Payload |
|---|---|
| `start` | `{ uniqueTargets, needAi, batches }` |
| `progress` | `{ processed, total }` |
| `batch-error` | `{ batch, error }` (one batch failed; planning continues) |
| `done` | `{ plan, summary, cost }` |
| `error` | `{ error, code }` |

Each `plan` entry: `{ linkText, action: 'retarget'|'strip', target: slug|null, occurrences, sourceFiles, confidence, source: 'deterministic'|'ai' }`. `summary` carries `{ retarget, strip, retargetOccurrences, stripOccurrences, deterministic, ai }`.

---

## POST /api/health/:domain/broken-links/apply

v3.0.1-beta.16. DESTRUCTIVE. SSE stream. Applies a plan (from `/plan`) to disk. Write-op + per-domain file lock; a concurrent sync/update/delete is refused with `409`. Every retarget target is re-validated against the on-disk inventory; `index.md`/`log.md` are skipped (matching the scanner). Capped at 20000 plan entries.

**Request body**

```json
{ "plan": [ { "linkText": "rezun-tali", "action": "retarget", "target": "tali-rezun" }, { "linkText": "transportation", "action": "strip" } ] }
```

**SSE events**: `start { actions }`, `progress { done, total }`, `done { retargeted, stripped, filesChanged, occurrencesReplaced, totalActions }`, `error { error }`.

Retargets preserve alias text (`[[X|Label]]` → `[[target|Label]]`); strips keep the readable text (`[[X|Label]]` → `Label`, `[[X]]` → `X`). Git-tracked, so revertable from the Sync tab.

---

## GET /api/health/:domain/orphans/estimate

v3.0.1-beta.17. No LLM. Returns `{ ok, orphanCount, inventorySize, estimatedTokens, estimatedUsd, provider, model }` for the orphan-rescue confirm dialog.

---

## POST /api/health/:domain/orphans/plan

v3.0.1-beta.17. READ-ONLY (LLM calls, no writes). SSE stream. For each orphan the AI picks the best existing "home" page to link from.

**SSE events**: `start { orphans, batches }`, `progress { processed, total }`, `batch-error { batch, error }`, `done { plan, summary, cost }`, `error`. Each plan entry: `{ orphanSlug, orphanPath, orphanType, target, description, confidence }`. `summary` = `{ rescuable, noHome, orphans }`. Orphans with no confident home are omitted from the plan.

---

## POST /api/health/:domain/orphans/apply

v3.0.1-beta.17. DESTRUCTIVE (additive). SSE stream. Injects `- [[orphanSlug]] — description` into each plan entry's target *Related* section. Write-op + file lock (409 on conflict). **Every entry is re-validated**: `orphanSlug` and `target` must both exist on disk and pass the slug regex; the description is stripped of `[[ ]]`; self-links and duplicates are skipped.

**Request body**: `{ "plan": [ { "orphanSlug": "backpropagation", "target": "gradient-descent", "description": "..." } ] }`

**SSE events**: `start { actions }`, `progress { done, total }`, `done { rescued, skipped, total }`, `error`.

---

## POST /api/health/:domain/fix-all-safe

v3.0.1-beta.17. DESTRUCTIVE. Runs every deterministic auto-fix type (`crossFolderDupes`, `hyphenVariants`, `folderPrefixLinks`, `missingBacklinks`, `brokenLinks` with a suggested target) in a single locked pass. No LLM, no body. Domain is validated before the lock is acquired.

**Response** `200 OK`: `{ ok: true, fixed, total, byType: { <type>: { fixed, total } } }`. `409` if a write/update is already in progress.

---

## POST /api/health/:domain/semantic-dupes/merge-batch

v3.0.1-beta.15. DESTRUCTIVE. SSE stream. Merges a caller-supplied list of semantic-duplicate pairs in one pass — powers the **Merge all high-confidence** button. Each pair runs through the same `fixSemanticDuplicate` path as the single `/fix` endpoint (slug-regex + folder allowlist + existence checks), sequentially (never parallel). Registered as a write-op with a per-domain file lock; a concurrent sync/update/delete is refused with `409`.

**Request body**

```json
{
  "pairs": [
    { "keepSlug": "opacity-objection", "keepFolder": "concepts", "removeSlug": "opacity-objection-ai", "removeFolder": "concepts" }
  ]
}
```

`pairs` is required and capped at 2000 entries. The frontend sends only the high-confidence pairs from the current scan.

**SSE events**

| Event | Payload |
|---|---|
| `start` | `{ total }` |
| `progress` | `{ done, total, pair, status }` — `status` ∈ `merged` \| `skipped` \| `error`. A pair whose file was already consumed by an earlier merge in the same batch is `skipped`. |
| `done` | `{ merged, skipped, errors, total, results }` — `results` is `[{keepSlug, removeSlug, status}]`. |
| `error` | `{ error }` |

Because the whole wiki is git-tracked, a regretted batch is revertable from the Sync tab.

---

## POST /api/health/:domain/fix — `semanticDupe` variant

The existing `/fix` endpoint accepts a new pseudo-type `semanticDupe` in v2.4.5. DESTRUCTIVE: merges two pages, rewrites every link to the removed slug across the domain, then deletes the removed file.

**Request body**

```json
{
  "type": "semanticDupe",
  "issue": {
    "keepSlug": "email",
    "keepFolder": "concepts",
    "removeSlug": "e-mail",
    "removeFolder": "concepts"
  }
}
```

**Response** `200 OK`

```json
{ "ok": true, "fixed": 1, "total": 1 }
```

`fixed: 0` indicates a defence rejected the request (slug regex, same-slug-same-folder, summary folder, missing file). No error status is returned — it is a silent no-op.

**Defences applied (all return `fixed: 0` on failure):**
- `keepSlug` and `removeSlug` must match `/^[a-z0-9][a-z0-9.-]*$/i`.
- `keepFolder` and `removeFolder` must be `entities` or `concepts` (never `summaries`).
- Both files must exist on disk.
- The pair must not be `{same slug, same folder}`.

**`fix-all` is a no-op for `semanticDupe`** — per-pair only, deliberately.

---

## Shared Brain endpoints (`v3.0.0-beta+`)

Mounted at `/api/sharedbrain/`. All routes except `/feature-flag` and `/enable-flag` require `sharedBrainEnabled: true` in `.curator-config.json`; otherwise they return **404** with `error: "Shared Brain is not enabled..."`. The flag is `false` by default for v2.x-installed users; flipping it requires an explicit POST to `/enable-flag` or clicking the "Enable Shared Brain (beta)" button in **Settings → Shared Brain (beta)** (moved there from the Sync tab in v3.0.2).

Endpoints marked **SSE** stream `text/event-stream` progress events (`{type, message, ...meta}`) ending in `{type: "done", result: {...}}` or `{type: "error", message}`.

### Feature flag

| Path | Description |
|---|---|
| `GET /api/sharedbrain/feature-flag` | `{enabled: boolean}`. Unauthenticated, ungated. |
| `POST /api/sharedbrain/enable-flag` | Flips the flag to `true`. Idempotent. |

### Connection management

| Path | Description |
|---|---|
| `GET /api/sharedbrain/list` | `{connections: [...]}` with tokens masked. v3.0.4+: each connection carries an additive `pending_pages` count — pages changed since `last_push_at` (∪ `pending_retry`, minus `permanent_skip`) across its contributing domains; cheap mtime scan only. Read-only connections always report 0. Powers the navbar pending badge. |
| `POST /api/sharedbrain/save` | Body: `{connection: {...}}`. Validated server-side. UUIDs assigned if missing. Rejects with 400 if `github_pat` looks like a masked display value (defense against round-trip overwrites). v3.0.4+: optional boolean `read_only` field (defaults `false`) — set by the wizard when the PAT verdict is valid-but-no-write-access; read-only connections may have zero `local_domains`. v3.0.5+: optional `admin_token` (single-line string 16-200 chars or null; masked-ellipsis values refused) and `data_handling_terms` (`contributor_retains` \| `organisational`, persisted for invite re-display). |
| `DELETE /api/sharedbrain/:id` | Removes the connection from this machine. The remote shared repo is unaffected. |
| `POST /api/sharedbrain/:id/unskip` | v3.0.4+. Body: `{pages?: string[]}` — clears the listed pages from `permanent_skip` (omit `pages` to clear all) and resets their `pending_retry` strike counters, so they're re-attempted on the next push. Paths not actually skipped are ignored. Returns `{ok, unskipped, permanent_skip}`. Local config change only; not SSE. |
| `GET /api/sharedbrain/:id/members` | v3.0.5+. Member directory: everyone who has ever contributed to this brain. Returns `{members: [{fellow_id, short_id, submissions, pages, first_contributed_at, last_contributed_at, display_name}], self_fellow_id}`. Identity is storage-path-derived (same trust rule as synthesis); display names are informational. Reads every contribution payload — fine at cohort scale. Powers the revoke UI's fellow picker. |
| `POST /api/sharedbrain/:id/admin-token/rotate` | v3.0.5+. Generates a fresh `sbat_…` admin token for this connection, stores it (single audited credential write path), and returns it **once**: `{ok, admin_token, rotated}` (`rotated: true` when a previous token existed and is now invalid). Used to provision pre-v3.0.5 connections and to rotate after a suspected leak. |

### Push, pull, synthesize, revoke (SSE)

| Path | Description |
|---|---|
| `POST /api/sharedbrain/:id/push` | Body: `{local_domain?: string}`. With `local_domain` set, pushes just that domain; without it, pushes **every** domain in `connection.local_domains` sequentially (v3.0.2+ — previously only `local_domains[0]`). For each domain: finds pages changed since `last_push_at`, runs local-LLM Delta synthesis, uploads contribution payloads. Per-domain `ok:false` results are emitted as `error` events; a final `done` event carries an aggregate `message` + `results[]`. v3.0.4+: returns **400** for `read_only: true` connections; GitHub rate-limit pressure is emitted as a `warn` event in the stream. SSE. |
| `POST /api/sharedbrain/:id/pull` | Pulls the synthesised collective wiki into the local `domains/shared-<slug>/` mirror via the existing `writePage` pipeline. Registers in the write-registry and takes the mirror domain's `.write-lock` (v3.0.2+), so update/restart/sync/ingest return 409 while it runs. v3.0.3+: replace semantics — the union merge is bypassed for mirrors and pages deleted from the collective are pruned locally (result gains a `pruned` count; pruning is skipped when any page failed to process, to be safe). v3.0.4+: also reads `state.last-synthesis` and returns/persists `last_synthesis_at` (shown on the connection card), and surfaces rate-limit `warn` events. SSE. |
| `POST /api/sharedbrain/:id/synthesize` | Runs the synthesis pipeline locally (admin operation). Aggregates contributions since the last synthesis, applies merge rules 1-5 from the design doc, writes synthesised pages back to shared storage. A malformed contribution now degrades to a per-page warning (`pages_failed` in the result) instead of aborting the run (v3.0.2+). v3.0.4+: returns **400** for `read_only: true` connections; the result gains an additive `conflict_pages: string[]` naming pages with unresolved-contradiction markers this run. Registers in the write-registry. SSE. |
| `POST /api/sharedbrain/:id/revoke` | Admin-only — GDPR Article 17. Body: `{admin_token, fellow_id, confirmation: "REVOKE-<fellow_id>"}`. Deletes the fellow's contributions + digest, scrubs Provenance-tainted collective pages (exact-token matching, v3.0.3), re-runs synthesis from scratch, appends to `state/revocations.jsonl`. v3.0.3+: writes a `state/revocation-in-progress` marker (ordinary synthesis refuses while it's active) and returns `ok:false, partial:true` with recovery guidance if the rebuild synthesis fails — re-running the revoke is idempotent and completes it. Admin-token comparison is constant-time. v3.0.5+: driven by the connection card's **Revoke a contributor…** panel (member picker + typed confirmation); the API contract is unchanged. SSE. |

### Invite-token utilities (no credentials)

| Path | Description |
|---|---|
| `POST /api/sharedbrain/parse-invite` | Body: `{token: "sbi_..."}`. Decodes and validates the invite token (no network calls). |
| `POST /api/sharedbrain/generate-invite` | Body: `{repo, name, shared_domain, branch?, storage_type?, data_handling_terms?}`. **`storage_type` must be `"github"` or omitted** — since v3.6.1 the codec refuses to MINT (400) or PARSE any other value, because a non-GitHub brain cannot be joined by the invite flow at all (it works by accepting a repo invitation and creating a PAT). Previously such a token minted and parsed fine, and the contributor was only refused at save — after creating a real PAT. Encodes metadata into an `sbi_...` token (deterministic — same metadata reproduces the same token, which is how the card's "Show invite token" works). v3.0.5+: the response also carries a freshly generated `admin_token` for the admin wizard; it is NOT embedded in the invite token, is not persisted by this call, and should be ignored by non-wizard callers. |

### Live PAT validator (server-proxy)

| Path | Description |
|---|---|
| `POST /api/sharedbrain/validate-pat` | Body: `{repo: "owner/name", pat: "github_pat_..."}`. Curator backend makes one GitHub API call with the supplied PAT, returns `{valid, hasWriteAccess, repoFullName, isPrivate, defaultBranch, message}`. The PAT never leaves the user's machine via the browser. PAT length capped at 400 chars (DoS defense). v3.0.4+: a `valid: true, hasWriteAccess: false` verdict is no longer a dead end — the wizard lets the user continue as a read-only member; 401/403/404 error copy explicitly points at the unaccepted-collaborator-invitation case. |

---

## My Curator MCP endpoints (`/api/mcp`)

These back the **Settings → My Curator** wizard. They inspect and help assemble the Claude Desktop
config; **none of them writes `claude_desktop_config.json`** — the user always pastes the snippet
themselves. `CLAUDE_CONFIG_PATH` is a module constant in `src/routes/mcp.js` with no override seam.

The config entry these endpoints describe is always:

```json
{ "mcpServers": { "my-curator": { "command": "<process.execPath>",
                                  "args": ["<app>/mcp/server.js", "--domains-path", "<domainsDir>"] } } }
```

| Path | Description |
|---|---|
| `GET /api/mcp/config` | Install status. `{ok, mcp_server_path, mcp_server_exists, mcp_server_name, domains_dir, domains_dir_exists, node_binary, claude_config_path, claude_config_exists, claude_config_parse_error, installed, stale}`. `ok` is `mcp_server_exists && domains_dir_exists`. `installed` is true when the config already has an `mcpServers["my-curator"]` entry; `stale` is true when that entry's `command`/`args` differ from what this install would generate (the usual cause is a moved domains folder). Both are forced `false` when `claude_config_parse_error` is true — an unreadable file cannot be inspected. |
| `GET /api/mcp/claude-config` | The entry-only snippet, nothing else. Always valid, in every state. |
| `GET /api/mcp/claude-full-config` | Snippet **plus** a merged preview. `{claude_config_path, entry, was_empty, parse_error, merge_available, merged, merge_error}`. Three input states → three outputs: file **absent** → `merged` = the snippet; file **readable** → `merged` = the existing config with our entry added; file **corrupt** → **`merged: null`**, `merge_available: false`, and `merge_error` explaining why. ⚠️ **Callers must branch on `merge_available` (or `merged !== null`), not assume `merged` is an object.** Before v3.6.1 the corrupt branch returned a config containing *only* our server — a valid-looking payload that, if pasted, would delete every other MCP server the user had. `null` is structurally unpasteable, which is the point. Note `was_empty` is a legacy field that stays `true` in the corrupt case (its only shipped consumer dereferences `merged` on the `false` branch); use `parse_error` / `merge_available` to distinguish "absent" from "corrupt". |
| `POST /api/mcp/self-test` | Spawns `mcp/server.js` locally over stdio — since v3.6.1 with **the same `--domains-path` the wizard prescribes**, so a wrong domains folder can no longer produce a green pass — and runs `initialize` → `tools/list` → `tools/call list_domains`. ⚠️ **This endpoint never returns a non-200 status. Branch on `data.ok`, not `res.ok`** — every failure path, including a spawn error, is delivered as a 200 with `ok: false`. |
| `POST /api/mcp/reveal-config` | Opens `claude_desktop_config.json` in Finder (or its parent directory when the file does not exist yet). macOS only; uses `execFile('open', …)` with no shell. Returns `{ok, revealed}`, or **500** `{ok: false, error}` if `open` fails — the one endpoint here that does use a non-200. |

### `POST /api/mcp/self-test` response

```json
{
  "ok": true,
  "server_info": { "name": "my-curator", "version": "…" },
  "tool_count": 18,
  "tool_names": ["list_domains", "get_index", "…"],
  "domains": ["articles", "business"],
  "domains_status": "ok",
  "domains_message": null,
  "domains_error": null,
  "domains_dir": "/Users/you/second-brain/domains",
  "domains_dir_exists": true,
  "spawn_command": "/usr/local/bin/node",
  "spawn_args": ["/…/mcp/server.js", "--domains-path", "/…/domains"],
  "stderr": null
}
```

**`ok` means "the bridge speaks MCP"** — `initialize` and `tools/list` both returned a result. It
deliberately does **not** include the `list_domains` outcome: a brand-new user with zero domains is
a healthy install, and failing them would be as harmful as the false green being fixed.

The `list_domains` outcome is reported separately and honestly in `domains_status` (v3.6.1+):

| `domains_status` | Meaning |
|---|---|
| `ok` | Domains found; `domains` is a non-empty array. |
| `empty` | The folder exists and is genuinely empty. Normal for a new install. |
| `missing_folder` | The configured domains folder **does not exist**. Decided by the parent's own `existsSync`, not by matching the child's wording — trustworthy only because the child is now spawned with the same `--domains-path`. Previously this collapsed into a cheerful "no domains yet". |
| `error` | `list_domains` returned a JSON-RPC error or a tool error; see `domains_error`. |
| `unreadable` | A response arrived but no usable text/array could be read from it. |
| `no_response` | The child never answered (also the value on every failure path). |

`domains` keeps its original meaning and type — an array, or `null` when no list could be read — so
pre-v3.6.1 consumers are unaffected. `domains_message` carries the child's own sentence (truncated
at 500 chars) when it sent one.

---

## Static files

The server also serves the web UI from `src/public/` at the root path.

| Path | Description |
|------|-------------|
| `GET /` | Single-page app (`index.html`) |
| `GET /app.js` | Frontend JavaScript |
| `GET /styles.css` | Stylesheet |
| `GET /*` | Falls back to `index.html` for client-side routing |

---

## Notes

- The server binds to `127.0.0.1` (loopback) only (v3.0.1-beta.20+), so endpoints are not reachable from the LAN. A cross-origin guard rejects mutating requests (POST/PUT/DELETE/PATCH) carrying a non-loopback `Origin` header (CSRF defense); requests with no `Origin` (curl, scripts) and all GETs pass through. Additionally (v3.0.2+), a Host-header guard rejects any request whose `Host` is not a loopback form (`localhost:PORT` / `127.0.0.1:PORT` / `[::1]:PORT`) with 403 — this closes DNS-rebinding read access, where a rebound hostname made same-origin GETs readable by an attacker page. There is no per-request authentication — it remains a single-user local app.
- The ingest endpoint blocks until the configured LLM provider (Gemini by default; Anthropic Claude if the user configured it in Settings) returns a response. For large PDFs (50k+ words) this may take 60+ seconds. The 50MB file size limit is a rough guard — what actually matters is the text length extracted from the file (capped at 80,000 characters sent to the model).
- `POST /api/query` (above) is a simple, single-shot Q&A endpoint — separate from the Chat tab's `POST /api/chat/:domain` — and it still sends up to 90,000 characters of concatenated wiki content to the LLM in one call, in arbitrary file order (`src/brain/query.js`). On a wiki bigger than ~90 KB of raw page content, later pages are silently left out of that request. **The Curator's own web UI never calls this endpoint** — there is no reference to it anywhere in `src/public/`, so the only way to reach it is a direct HTTP call to the loopback server (curl, a script, another tool). The Chat tab does **not** have this limitation: since v3.0.1-beta.11 it uses query-driven page selection (score pages by relevance to the question, load up to ~60 KB of full content plus a ~12 KB slug catalogue — see [docs/ingestion-pipeline.md §10b](ingestion-pipeline.md#10b-the-chat-read-side-v301-beta11-refined-in-v301-beta13)), so it scales to much larger wikis. If you're calling `/api/query` directly against a large wiki (150+ pages), prefer `/api/chat/:domain` instead, or expect its answers to reflect only whatever page content the alphabetical/readdir order happened to include.
- **Known limitation — `POST /api/ingest-queue` and a filename containing a raw double-quote character.** The multipart parser (upstream of the batch-ingest queue's own code, in `busboy`) mis-parses a `Content-Disposition` header whose filename contains an unescaped `"`: the request still returns `200`/`ok: true`, but that one file is silently absent from `items` — no `rejected` entry, no warning of any kind. A NUL byte in a filename fails the parse outright instead, and is reported as a plain `400`. Neither is reachable from a browser — the WHATWG form-serialisation spec escapes `"` to `%22` before the request is ever built, and NUL is not a legal filename byte on any mainstream filesystem — but a hand-built multipart request from a script or another tool can trigger the quote case silently. If you are integrating against this endpoint programmatically, avoid unescaped `"` in filenames sent this way.
- **Known limitation — a domain missing `wiki/log.md` fails a completed ingest at the very last step.** This affects both `POST /api/ingest` and `POST /api/ingest-queue` identically (both funnel through the same `appendLog` in `src/brain/files.js`, which has no existence check on `log.md`, unlike the equivalent `readIndex` two lines below it). If it's missing, the ingest still runs to completion — pages are written to disk, real AI spend has happened — and only the final logging step throws `ENOENT`, which surfaces as a `failed` item with a cryptic error. Not reachable through any documented path (`createDomain()` always writes `log.md`, and [docs/domains.md](domains.md) tells manual-setup users to create it too), so it takes a hand-built domain folder to hit. Recovery: the pages are correct and unaffected — create an empty `wiki/log.md` and re-ingest the same source (safe; see the idempotency notes above).
