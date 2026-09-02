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

**The new display name can slugify to the SAME folder name as the old one** — e.g. changing only capitalization or punctuation, or changing the display name back to what it was. This is not an error: the server derives `newSlug` from `displayName` and explicitly excludes the domain's own current slug from its collision check, so this is a normal, successful **display-name-only rename**. The folder is never touched (no `fs.rename` call at all in that branch) and the response looks like:

```json
{
  "oldSlug": "health-and-fitness",
  "newSlug": "health-and-fitness",
  "displayName": "Health and Fitness",
  "syncWarning": false
}
```

`syncWarning` is always `false` on this branch — nothing moved for GitHub sync to see as a delete + add. A caller should always read `newSlug` from the response rather than assume it differs from `oldSlug`; treating a display-name-only rename as a slug change will 404 on every subsequent call for a domain that in fact still exists under its old name.

**Concurrency:** refuses with `409` while this domain has an active write (per-domain `isDomainActive` check). Renaming mid-ingest is silently dangerous rather than loudly broken — an in-flight ingest resolves its own wiki paths per page from the slug it captured at request time, so it keeps writing under the OLD (now-renamed-away) directory name, which `writePage`'s `mkdir(recursive: true)` happily recreates; those pages become invisible to every UI surface (the v2.3.4 ghost-domain filter hides any directory with no `CLAUDE.md`) until the ingest finally dies at the logging step. The guard covers a display-name-only rename too, since that still rewrites `log.md`'s header and races `appendLog`.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `displayName` |
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

## GET /api/ingest/activity

What the server currently knows about **single-file** ingests (`POST /api/ingest`), so a view that was not watching while one ran can still show its progress and its outcome.

The Ingest view deliberately never aborts its SSE fetch on navigate-away, so before v3.24.0 the `progress` and `done` events still *arrived* and were then dropped by a mount-token gate — and a reload or a second tab had no fetch to keep alive at all. This endpoint is the server remembering instead. See [src/brain/ingest-activity.js](../src/brain/ingest-activity.js) for the full rationale.

**Read-only and in-memory.** It takes no lock, touches no filesystem and mutates nothing, so it is deliberately *not* registered as a write and *not* behind `guardConcurrent`: a 409 here would fire precisely while an ingest is running, which is exactly the moment the caller is asking whether their file got in.

**Request** — no parameters.

```bash
curl http://localhost:3333/api/ingest/activity
```

**Success response** `200 OK`

```json
{
  "ok": true,
  "serverNow": 1756512000000,
  "activity": [
    {
      "id": "a1b2c3d4e5f6",
      "domain": "articles",
      "filename": "attention-is-all-you-need.pdf",
      "status": "done",
      "pct": 100,
      "message": "Ingest complete",
      "waiting": false,
      "startedAt": 1756511940000,
      "phaseStartedAt": 1756511995000,
      "finishedAt": 1756511999000,
      "error": null,
      "result": {
        "title": "Attention Is All You Need",
        "changes": [
          {
            "canonPath": "concepts/transformer.md",
            "status": "updated",
            "bytesBefore": 1840,
            "bytesAfter": 2210,
            "sectionsChanged": ["Key Facts", "Related"],
            "bulletsAdded": 4
          }
        ],
        "changesTotal": 22,
        "pagesWritten": ["summaries/attention-is-all-you-need.md"],
        "pagesWrittenTotal": 22,
        "warnings": [],
        "warningsTotal": 0,
        "truncated": false,
        "wasOverwrite": false,
        "tokenUsage": {
          "provider": "gemini",
          "model": "gemini-2.5-flash-lite",
          "calls": 6,
          "inputTokens": 148320,
          "outputTokens": 9114,
          "cachedReadTokens": 0,
          "cacheWriteTokens": 0
        }
      }
    }
  ]
}
```

**Fields**

| Field | Type | Notes |
|-------|------|-------|
| `serverNow` | number | The server's own epoch-ms clock, sent alongside so a client derives elapsed time by **subtraction only** (`serverNow - phaseStartedAt`) and never has to reason about clock skew between the two machines |
| `activity[].status` | string | `running`, `done` or `error`. `done` and `error` are terminal |
| `activity[].waiting` | boolean | The ingest is blocked behind another write in the same domain |
| `activity[].error` | string \| null | Present on `error`. Absolute paths are scrubbed before it reaches the wire |
| `activity[].result` | object \| null | Non-null only once the ingest has settled successfully |
| `…Total` fields | number | The **true** count. The `changes`, `pagesWritten` and `warnings` arrays are capped (500 / 500 / 200), so a client compares each array's length against its `…Total` rather than under-reporting silently |
| `result.truncated` | boolean | The ingest itself truncated the source at the 80,000-character cap — unrelated to the array caps above |

**Retention.** Records are in-memory only and do not survive a server restart. A **settled** record is swept 30 minutes after it finished; a `running` record **never expires**, because an ingest is legitimately allowed to take an hour. At most 200 domains are tracked.

**Error responses.** There are none by design: a read whose whole job is telling the user what happened must not fail. Any internal error degrades to `{ "ok": true, "serverNow": <n>, "activity": [] }` — the pre-v3.24.0 behaviour — rather than a 500.

**Coverage note.** `scripts/test-route-write-guards.js` audits `config.js`, `sync.js`, `domains.js` and `health.js` from a hardcoded list and does not classify `src/routes/ingest.js` at all, so its class invariants do not reach this route. That is a gap in that suite, not a licence: a **mutating** route added to this router still needs `registerWrite` and a file lock, the way `POST /api/ingest` has them.

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

## Compile to Wiki (`/api/compile`)

Turns a saved chat conversation into wiki pages, through the same
`writePage → syncSummaryEntities → appendLog` pipeline ingest uses.

Two endpoints, and the split is deliberate: **`GET /estimate` is free and
answers "what would this cost"; `POST /conversation` is the one that spends.**

---

### GET /api/compile/estimate

**Free. Makes no LLM call and no network request of any kind.** Added in
v3.27.0, when Compile to Wiki was the last paid action in the app that spent
money with no estimate and no confirm.

It builds the **real** prompt the compile would send — the same
`buildCompilePrompt` over the same conversation, the same domain schema and the
same entity/concept filename inventory — and measures it, so the estimate
reflects how big this wiki already is rather than a flat per-conversation rate.
The only I/O is reading the conversation, the schema and two directory
listings.

It is a **read** route: it registers no write, takes no file lock, and is not
refused while an app update is in flight. A `409` here would fire exactly when
a user is asking what the next compile costs.

**Query parameters**

| Name | Required | Description |
|---|---|---|
| `domain` | yes | Destination domain slug. Must be on the real domain list. |
| `conversationId` | yes | Server-generated UUID; regex-validated before it reaches the filesystem. |

**Response** `200 OK` — compilable

```json
{
  "ok": true,
  "compilable": true,
  "refusal": null,
  "provider": "gemini",
  "model": "gemini-2.5-flash-lite",
  "conversation": {
    "title": "RAG vs fine-tuning",
    "userTurns": 4, "messageCount": 8, "transcriptChars": 3219,
    "summaryPath": "summaries/rag-vs-fine-tuning-2026-08-30-e2ce.md"
  },
  "domainContext": { "entityPages": 120, "conceptPages": 60, "promptChars": 12431 },
  "estimate": {
    "inputTokensLow": 2993, "inputTokensHigh": 4050,
    "outputTokensLow": 361, "outputTokensHigh": 6125,
    "usdLow": 0.000444, "usdHigh": 0.002855,
    "priceKnown": true,
    "costUnknown": null,
    "tokenizerFactor": 1,
    "basis": "Estimated for Gemini \"gemini-2.5-flash-lite\" compiling a 4-turn conversation … THE OUTPUT HALF CANNOT BE KNOWN IN ADVANCE …"
  },
  "warnings": []
}
```

**Response** `200 OK` — not compilable

A conversation the compile would refuse comes back `compilable: false` with the
**exact** `refusal` string `POST /conversation` would have emitted, and **no
cost fields at all**. `ok` stays `true` — a refusal is an answer, not an error:

```json
{
  "ok": true,
  "compilable": false,
  "refusal": "Conversation too short to compile (need at least 1 user messages, got 0)",
  "provider": null, "model": null,
  "conversation": null, "domainContext": null, "estimate": null,
  "warnings": []
}
```

Both sides run one shared `precheckCompile`, so the estimate can never quote a
price for something that is about to be refused for free. The four refusal
strings, verbatim:

| Condition | `refusal` |
|---|---|
| No such conversation | `Conversation not found` |
| Fewer than `MIN_USER_MESSAGES` (**1**) user turns | `Conversation too short to compile (need at least 1 user messages, got N)` |
| Already compiled at the deterministic summary slug | `Already compiled to <path>. Send another message in this conversation to extend it, or delete that file in your wiki to start over.` |
| Destination is a read-only Shared Brain mirror | `Domain "<d>" is a read-only Shared Brain mirror. Compile into your personal opted-in domain instead, then push contributions from the Sync tab.` |

The mirror case is reported as a `refusal` rather than an HTTP error because
this endpoint is a question rather than an attempt; the POST answers `400` for
it, with a **byte-identical** message. A malformed conversation file with no
`messages` array does not throw — `messages` normalises to `[]` and it falls
through to the "too short" refusal.

**The range is a range, not a price.**

`inputTokens*` is the real prompt measured character by character, divided by
the shared `CHARS_PER_TOKEN` (3.53, the same constant the batch-ingest
estimator uses) and widened by a band measured across seven real compiles.
`outputTokens*` **cannot be known before the call**: the low end is the
measured `summary-only` rung of the compile's `full → concise → summary-only`
ladder, the high end scales with transcript length and saturates. Three
byte-identical replicate compiles produced 2,456 / 2,145 / 1,977 output tokens
— about ±11% around their own mean — which is why a single figure is not
offered. If the ladder escalates, each retry re-sends the input, so a compile
that escalates can cost roughly two to three times the input half of the
quoted range. **Both ends are estimates rather than limits.**

**When the cost is unknown, `usdLow`/`usdHigh` are `null` — never `0`.**
`costUnknown` names which of three distinct facts applies:

| `costUnknown` | Meaning |
|---|---|
| `null` | A price is on file; `usdLow`/`usdHigh` are real numbers and `priceKnown` is `true`. |
| `"no-provider"` | No API key is configured. Token counts are still returned — the work is describable even when the price is not. |
| `"free-model"` | The resolved model is free. The compile will cost nothing; that is a different statement from "we cannot tell you". |
| `"no-price"` | The resolved model has no price resolvable through `getModelPrice` — neither the static `MODEL_PRICES_USD_PER_MTOK` table nor the synced OpenRouter catalogue. Your provider will still bill it. |

Exactly one of these three also produces exactly one sentence in the top-level
`warnings[]`; on the priced path and on every refusal, `warnings` is `[]`.

`tokenizerFactor` is the model's published input-token premium, read at runtime
from the offerable-models catalogue and **already applied** to
`inputTokensLow`/`High`. It is **1.329** for `claude-sonnet-5`,
`claude-opus-5` and `claude-opus-4-8`, and **1** for every other shipped model
— note that `claude-opus-4-5` is **not** in the premium set, so "the Opus tier"
is the wrong way to describe it. An OpenRouter catalogue entry may carry its
own factor (`defineOfferableModel` requires `>= 1`); a configured model that is
not in `listOfferableModels(provider)` degrades to `1` rather than throwing.

> The same wrong model list appears in a code comment in
> `src/brain/compile-estimate.js`. Correcting it needs a code change.

**Errors**

| Status | Condition |
|---|---|
| `400` | Missing `domain`; missing `conversationId`; `conversationId` is not a UUID; unknown domain. Validated in that order, deliberately identical to `POST /conversation`'s. |
| `500` | `{ "error": "Failed to estimate compile cost." }` — a fixed string; the underlying error goes to `console.error` only. The frontend still shows its confirm dialog in this case, saying the cost is unknown — a broken read route must neither silently spend nor disable a working feature. |

---

### POST /api/compile/conversation

**Spends money.** Streams Server-Sent Events (same primitive as
`POST /api/ingest`). The `/next` frontend reaches this only after
`GET /estimate` and a confirm dialog naming the cost. **That gate is in the
client, not the server** — through v3.40.0 the frozen legacy frontend at `/old`
POSTed here directly with no estimate and no confirm; that frontend was deleted
in v3.41.0, so `/next` is now the only client.

**Request body**

```json
{ "domain": "ai-tech", "conversationId": "8f14e45f-ceea-467a-9d64-1f7f1b06a3e7" }
```

**Stream events**

| `type` | Payload |
|---|---|
| `progress` | `{ pct, message }` — the **only** progress-shaped event this route emits |
| `done` | `{ title, pagesWritten, changes, warnings }` — `warnings` is always an array, never absent |
| `refused` | `{ reason }` — a **normal** outcome (too short, already compiled), not an error |
| `error` | `{ message }` |

`warnings` is non-empty when the `full → concise → summary-only` ladder had to
degrade — the compile succeeded, but with fewer pages than a full extraction
would have written.

> **There is no `wait` event on this stream.** `wait` is an **ingest**-stream
> event (`src/brain/ingest.js` passes a third `'wait'` argument to its progress
> callback); the compile path's callback takes `{ pct, message }` only. Both
> frontends handle `wait` defensively, which is why the mistaken row survived
> in this document until v3.27.0's doc sweep. The route's own docblock in
> `src/routes/compile.js` still carries the same error and needs a code change
> to agree with this page.

**Errors** (plain JSON, before the SSE headers are sent)

| Status | Condition |
|---|---|
| `400` | Missing `domain`/`conversationId`; non-UUID `conversationId`; unknown domain; the domain is a read-only Shared Brain mirror. |
| `409` | An app update is in progress. `conflictResponse('compile a conversation')` — `{ error, conflict: "write_in_progress", active: [{domain, count, ops[]}], updateInProgress: true }`. |

**The `409` fires on `isUpdateInProgress()` only, not on active writes** —
unlike `POST /api/config/update`, which 409s on `hasActiveWrites()`. Ordinary
write contention on this route surfaces as an in-stream `error` event instead:

> `Another process is already writing to "<domain>" (file lock held). If this seems stuck, manually delete <domains>/<domain>/.write-lock and retry.`

A file-lock failure arrives that way rather than as an HTTP status because the
SSE headers have already been flushed by that point.

---

## Chat (`/api/chat`)

Multi-turn conversation against a domain's wiki. Distinct from `POST /api/query`
below, which is single-shot and stateless.

Every route in this group validates `:domain` against the real domain list
(`assertKnownDomain`, imported from `src/brain/files.js` — the same function
`routes/health.js` uses, so the two cannot drift) **before** anything derived
from it is built. An unknown domain is a `404`. Conversation ids are
server-generated UUIDs and are regex-validated before reaching the filesystem.

---

### POST /api/chat/:domain

Send a message. Creates the conversation when `conversationId` is omitted.

**This route is content-negotiated.** Without `stream: true` in the body it
answers with a single JSON object exactly as it always has. With it, it answers
with a Server-Sent-Event stream. See [chat-streaming.md](chat-streaming.md) for
the full contract.

**Request body** `Content-Type: application/json`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | The user's message. Missing/empty → `400`. |
| `conversationId` | string (UUID) | No | Omit to start a new conversation. |
| `responseStyle` | `concise` \| `balanced` \| `comprehensive` | No | Answer length/detail. Anything unrecognised normalises to `balanced`. Also selects the output-token budget — see `RESPONSE_STYLES` in `src/brain/chat.js`. |
| `provider` | `gemini` \| `anthropic` \| `openrouter` | No | Per-chat provider override. Honoured **only** if that provider has a key saved in Settings; otherwise the global active provider answers. |
| `model` | string | No | Per-chat model override. Allow-listed inside `getProviderInfo()`; anything not offerable on the resolved provider falls back to that provider's default rather than erroring. |
| `stream` | boolean | No | **`=== true` and nothing looser.** A string `"true"`, a `1`, or a truthy object takes the JSON path. |

None of `responseStyle` / `provider` / `model` is validated at the route,
deliberately: the model allow-list is applied at `getProviderInfo()`, the single
producer of the string every SDK receives. A second check here would leave the
other `generateText` entry points open and create a second hand-maintained copy
of the guard.

**Success response (JSON path)** `200 OK`

```json
{
  "conversationId": "…uuid…",
  "isNew": false,
  "title": "First message truncated to 60 chars…",
  "answer": "…markdown with [source: concepts/rag.md] citation tags…",
  "citations": ["concepts/rag.md", "summaries/rag-survey.md"],
  "responseStyle": "balanced",
  "persisted": true,
  "provider": null,
  "model": "claude-haiku-4-5",
  "usage": {
    "inputTokens": 998,
    "outputTokens": 247,
    "cachedReadTokens": 0,
    "cacheWriteTokens": 0
  }
}
```

- `persisted` (v3.43.0+) says whether the turn was written to
  `conversations/<uuid>.json` on disk. It is **`false` on a read-only Shared
  Brain mirror**, which declares `readonly: true` in its own `CLAUDE.md`. Chat
  was the last write surface not honouring that flag — it wrote a real
  conversation file into the mirror on the first message, which the v3.42.0
  live run found sitting in the admin instance's own mirror. Answering is still
  allowed, because asking the collective a question is what a mirror is FOR;
  only the WRITE is withheld. The transcript is kept in the server's memory
  instead, so multi-turn context is unchanged — the thread simply does not
  survive a restart, and this field says so rather than leaving the user to
  discover it. It is `true` everywhere else.
- `provider` is what was **asked for** — `null` means "the global active
  provider was used".
- `model` is the model that **answered**, read out of the provider's own usage
  payload, not an echo of the request. It differs from `model` in the request
  whenever the allow-list refused it or a fallback rung served the call. `null`
  means "we could not tell", never "it was the default".
- `usage` carries the served model's four token counts, or `null`. A **partial**
  usage payload is refused rather than part-filled — three of four numbers
  priced as if they were four is a confident wrong answer about money. These are
  deliberately tokens, not a dollar figure: price is a property of the catalogue
  and of the date, so the arithmetic belongs where the catalogue is.

**Success response (streaming path)** `200 OK`, `Content-Type:
text/event-stream`

Bare `data:` frames, **no `event:` lines**, discriminated by a `type` key:

```
data: {"type":"reasoning","text":"…"}

data: {"type":"content","text":"…"}

data: {"type":"done","conversationId":"…","isNew":false,"title":"…","answer":"…","citations":[…],"responseStyle":"balanced","persisted":true,"provider":null,"model":"…","usage":{…}}

data: {"type":"error","message":"…"}
```

The `done` frame carries the **entire** JSON-path result object, spread
alongside `type` — so the two surfaces cannot disagree about what a turn
produced.

> **`done.answer` is authoritative and complete. The `content` deltas are a
> preview of it.** A consumer **replaces** its rendered draft with `done.answer`
> and never appends. Appending doubles every answer and loses the truncation
> note, which exists only in the final result. See
> [chat-streaming.md](chat-streaming.md#5-the-authoritative-return-rule).

`reasoning` frames carry the model's scratchpad and are **never** part of the
answer. In practice only OpenRouter emits them today; see
[chat-streaming.md](chat-streaming.md#8-reasoning-is-never-spliced-into-the-answer).

An unknown `type` must be **ignored**, not treated as an error, so an additive
server change does not become an outage.

**Errors**

Every refusal happens **before** the response headers are flushed, so a `400` or
`404` reaches the client as a real status code with a JSON body on **both**
paths. There is no in-band way to report a validation refusal.

| Status | Condition |
|--------|-----------|
| `400` | `message` missing or empty; invalid `conversationId` shape. |
| `404` | Unknown domain. |
| `500` | LLM provider error, or a filesystem failure. Messages are path-scrubbed. |

On the streaming path an error that occurs **after** the headers flush — a
provider failure mid-answer, or a user cancel — is delivered as an in-band
`{"type":"error","message":"…"}` frame with the status already fixed at `200`.
Its message is scrubbed with the same `scrubPaths` the JSON path uses.

**Cancellation.** Aborting the request from the client is what stops the turn. A
cancel is honoured before the retry ladder, before the 429/503 backoff (the
sleep is itself abortable) and before the fallback-chain walk, so it stops
spending immediately. A *cancelled* turn persists nothing; a turn whose client
merely stopped watching still runs to completion and **is** persisted.

---

### GET /api/chat/:domain

List a domain's conversations, newest first.

| Query param | Type | Description |
|---|---|---|
| `q` | string | Optional case-insensitive filter, matched against each conversation's title **and every message body**. Server-side because titles are just the first user message truncated, so a title-only search cannot find a phrase from a later turn. Length-bounded inside `listConversations`. Repeated `?q=a&q=b` (which Express delivers as an array) is ignored rather than erroring. |

**Response** `200 OK`

```json
{
  "conversations": [
    { "id": "…uuid…", "title": "…", "createdAt": "2026-08-30T10:00:00.000Z", "messageCount": 6 }
  ]
}
```

`messageCount` is read before any filtering decision, so the number shown is the
conversation's real length rather than the count of matching messages.

---

### GET /api/chat/:domain/:id

The full conversation, including every message.

**Response** `200 OK` — the conversation JSON (see
[architecture.md → Conversation persistence](architecture.md#conversation-persistence)).

**Errors** — `400` invalid id shape · `404` unknown domain or conversation not found.

---

### DELETE /api/chat/:domain/:id

**Response** `200 OK` — `{ "success": true }`

**Errors** — `400` invalid id shape · `404` unknown domain.

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

`backlinks` uses **exactly** the same "does this `[[link]]` point at that page" rule `health.js`'s `scanWiki()` uses to decide whether a link is broken, so the reader can never disagree with the Wiki health panel about whether a link resolves — a bare `[[slug]]` resolves only against `entities/`/`concepts/` (never `summaries/`, which always needs its prefix), and `[[folder/slug]]` needs an exact folder+slug match.

`resolvableTarget` is `false` for a page nested below the canonical folder's first level (e.g. `entities/companies/nested-corp.md` — `writePage` never produces these, but a hand-edited or migrated wiki can have them). Such a page is still readable and its `backlinks` array is truthfully empty: *nothing in this wiki can resolve a link to it*, not merely "nothing does".

`readonly` mirrors the domain's Shared Brain mirror status (`isDomainReadonly`), additive to what `getWikiPage()` itself returns.

**Error responses**

| Status | Condition |
|--------|-----------|
| `404` | Unknown domain, or the page doesn't exist on disk |
| `400` | Missing/invalid `path`, path outside `entities/`/`concepts/`/`summaries/`, or the path is a symlink (or sits under a symlinked folder) that escapes the wiki folder (`code: "WIKI_PATH_ESCAPES"`) |

---

## GET /api/wiki/:domain/list

A cheap, **readdir-only** inventory of every page in the domain's wiki — the third sibling next to `GET /:domain` above (full content of every page — 14 MB on the real `articles` domain, the wrong shape for "what pages exist") and `GET /:domain/page` (open exactly one already-known page, the wrong shape for "list what I could open"). This endpoint reads no file content at all — it does not open a single page body, only directory listings — so its cost scales with page *count*, not wiki size. On a real domain with 3,363 pages it returns roughly 462 KB in about 25 ms cold / 8 ms warm, versus the multi-megabyte, multi-hundred-millisecond cost of reading every page's content.

Built on `listWikiInventory()` in `src/brain/wiki-read.js`, which itself is built on `health.js`'s gated `listMd()` — the same directory listing `scanWiki()` uses — rather than a second, independently-written `readdir`. This matters because a naive readdir can surface entries `GET /:domain/page` would then refuse to open (a directory literally named `x.md`, a symlink escaping the wiki, a dangling symlinked leaf); reusing `listMd` means this endpoint can never list a page the page-reader can't actually open — the same class of drift the v3.2.0 audit fixed elsewhere in this file's sibling routes.

Reads are allowed on read-only Shared Brain mirror domains, matching `/page` — this route never writes.

**Path parameter**

| Parameter | Description |
|-----------|-------------|
| `domain` | Domain slug |

**Success response** `200 OK`

```json
{
  "domain": "ai-tech",
  "entries": [
    { "slug": "tali-rezun", "folder": "entities", "path": "entities/tali-rezun.md", "title": "Tali Rezun" },
    { "slug": "rag", "folder": "concepts", "path": "concepts/rag.md", "title": "Rag" },
    { "slug": "attention-paper", "folder": "summaries", "path": "summaries/attention-paper.md", "title": "Attention Paper" }
  ],
  "count": 3,
  "total": 3,
  "truncated": false
}
```

Entries are sorted by `path` and drawn only from the three canonical folders (`entities/`, `concepts/`, `summaries/`). `path` is the exact string `GET /:domain/page`'s `path` query parameter expects.

**`title` is derived from the slug alone (`tali-rezun` → `Tali Rezun`), never from frontmatter or file content.** This is a deliberate trade-off, not an oversight: reading each file for its real title (an explicit `title:` in frontmatter, or the first `# Heading`) would mean opening every page body — reinstating the exact 14 MB read this endpoint exists to avoid. A page whose real title differs from its slug (e.g. an acronym, or a title that doesn't match its filename) shows the slug-derived label here; its real title is correct the instant it's opened via `GET /:domain/page`, which does read the file.

Capped at 20,000 entries (`truncated: true` beyond that; `count` is the number actually returned). `total` always reports the real, uncapped count — it costs nothing extra, since every filename is enumerated before the cap is applied.

**Error responses**

| Status | Condition |
|--------|-----------|
| `404` | Unknown domain |
| `500` | Filesystem read error |

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

Run the **free, local** self-diagnostics behind the Settings → General → System check panel (v3.0.1-beta.23+). No network call, no API cost; never touches wiki content (the folder-writable probe writes a self-deleting temp file).

**Success response** `200 OK`

```json
{
  "checks": [
    { "id": "version",      "label": "Installed version",            "status": "info", "detail": "The Curator v3.25.0" },
    { "id": "install-mode", "label": "Install mode",                 "status": "info", "detail": "Source install (git checkout) (repo). Updates in place from GitHub." },
    { "id": "provider",     "label": "AI provider key",              "status": "ok",   "detail": "Configured: gemini · gemini-2.5-flash-lite" },
    { "id": "domains",      "label": "Knowledge folder",             "status": "ok",   "detail": "Readable and writable: /…/domains" },
    { "id": "credentials",  "label": "Credential file permissions",  "status": "ok",   "detail": "All 4 credential file(s) are owner-only (0600)." },
    { "id": "git",          "label": "Git",                          "status": "ok",   "detail": "git version 2.48.1" },
    { "id": "sync",         "label": "GitHub sync",                  "status": "ok",   "detail": "Configured: github.com/you/your-brain" }
  ],
  "summary": { "ok": 5, "warn": 0, "fail": 0, "info": 2 }
}
```

`status` is one of `ok` | `warn` | `fail` | `info`. Both frontends iterate the array, so a new row needs no frontend change.

The `install-mode` row is always `info` — neither mode is an error, and the row exists so a support conversation starts from the right mental model. The `git` row runs a local `git --version` (free, no network); it reports `fail` when git is absent, because **both** Personal Sync and the updater need it, and it is skipped entirely on a build whose capabilities need neither.

---

## GET /api/version

Which version is running, which is on disk, and what this install is allowed to do to itself.

**Success response** `200 OK`

```json
{
  "version": "3.27.0",
  "onDiskVersion": "3.27.0",
  "restartRequired": false,
  "installMode": "repo",
  "installModeLabel": "Source install (git checkout)",
  "capabilities": {
    "canSelfUpdateViaGit": true,
    "canRunNpmInstall": true,
    "canRebuildAppleScriptApp": true,
    "canWriteBesideCode": true,
    "mcpLaunchStyle": "node-script",
    "restartStyle": "respawn-node"
  }
}
```

`restartRequired` is true when `package.json` on disk is newer than the version the running process booted with — files updated, process not restarted. The `installMode` / `capabilities` fields are **additive**; the three original fields are unchanged. See [architecture § Install modes](architecture.md#install-modes-srcbraininstall-modejs).

---

## GET /api/write-status

Is it safe to quit right now? Reads the in-memory write registry that has guarded conflicting routes since v3.0.1-beta.8, which until now could only be *consulted by a refusal* and never asked directly.

Deliberately a **read** route, and deliberately **not** behind `guardConcurrent`: a 409 would fire precisely when a write is in progress, which is exactly when someone is asking whether a write is in progress. It also registers no write of its own, which would make it report itself.

**Success response** `200 OK`

```json
{
  "ok": true,
  "safeToQuit": false,
  "activeWrites": true,
  "updateInProgress": false,
  "operations": [
    { "domain": "articles", "count": 1, "ops": ["ingest"] }
  ],
  "operationsTotal": 1
}
```

| Field | Meaning |
|---|---|
| `safeToQuit` | `!activeWrites && !updateInProgress`. An update in flight is mid `git reset --hard` + `npm install`, which is at least as bad to interrupt as an ingest. |
| `operations` | Capped at `MAX_LISTED_OPERATIONS` (**50**) entries, each an explicit `{domain, count, ops}` allow-list — never a spread of registry internals. `domain` is a string (`''` if the registry held a non-string), `count` a number (`0` if non-finite), `ops` an array of strings. Every string is capped at `MAX_WIRE_STRING` (2000 chars). |
| `operationsTotal` | The **true** total, measured **before** the 50-cap is applied, so a cap is never mistaken for a measurement. |

> **A second, inner cap has no true total beside it.** Each entry's `ops` array
> is sliced to **20**. Unlike `operations`, nothing reports how many were
> dropped, so `operationsTotal`'s guarantee does not extend to it. Stated
> because assuming otherwise is the easy mistake.

`ops` values come from a fixed internal vocabulary — enumerable from the
`registerWrite` call sites, currently `ingest`, `batch-ingest`, `compile`,
`health-fix`, `health-fix-all`, `health-fix-all-safe`, `broken-links-apply`,
`orphan-rescue-apply`, `semantic-dupes-merge-batch`, `sharedbrain-push`,
`sharedbrain-pull`, `sharedbrain-synthesize`, `sharedbrain-revoke`, plus the
default `write`. Shared Brain synthesis and revoke register against a
`shared-<slug>` domain.

If the registry itself throws, the endpoint answers `200` with **exactly three
keys** — `{ "ok": false, "safeToQuit": null, "error": "…" }`, no
`activeWrites`, `updateInProgress`, `operations` or `operationsTotal` — rather
than a 500. A quit handler that cannot get an answer should be told so
explicitly, not handed an exception it will read as "busy".

Only `GET` is exposed. **Nothing in repo mode consumes this endpoint yet**: it
exists for the packaged build's `before-quit` handler, which is the reason it
was built one release ahead of its caller.

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
- Semantic near-duplicates are **not** handled here. They shipped in v2.4.5 as their own opt-in, cost-gated flow — see the `/semantic-dupes/estimate`, `/scan`, `/preview` and `/merge-batch` endpoints documented below.

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

**SSE events**: `start { actions }`, `progress { done, total }`, `done { retargeted, stripped, downgraded, filesChanged, occurrencesReplaced, totalActions }`, `error { error }`.

Retargets preserve alias text (`[[X|Label]]` → `[[target|Label]]`); strips keep the readable text (`[[X|Label]]` → `Label`, `[[X]]` → `X`). Git-tracked, so recoverable — but via git on the command line, **not** from the Sync view: there is no revert or discard endpoint (`src/routes/sync.js` exposes status/remote-status/preflight/setup/push/pull/sync/disconnect only — enumerate its `router.<verb>` calls rather than trusting this list). See [ai-health.md § How to actually undo a Health fix](ai-health.md#how-to-actually-undo-a-health-fix).

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

Because the whole wiki is git-tracked, a regretted batch is recoverable with git — there is no in-app revert. See [ai-health.md § How to actually undo a Health fix](ai-health.md#how-to-actually-undo-a-health-fix).

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

## Personal Sync endpoints (`/api/sync`)

Mounted at `/api/sync/` (`src/routes/sync.js`). Eight routes, and **that is the whole
surface** — there is deliberately no revert, discard or history endpoint. Every mutating
route sits behind `guardConcurrent`, so a wiki write in flight yields a `409`
`conflictResponse` rather than letting a git command race it.

| Route | Guarded | Writes the work tree? |
|---|---|---|
| `GET /status` | no | no |
| `GET /remote-status` | no | no (network; 5-minute server-side TTL cache) |
| `POST /preflight` | yes | **no — measures only** |
| `POST /setup` | yes | depends on `mode`; see below |
| `POST /push` | yes | commits + pushes |
| `POST /pull` | yes | merges (`-X theirs`) |
| `POST /sync` | yes | pull then push |
| `DELETE /disconnect` | yes | no — removes this install's credential file only |

### GET /api/sync/status

Cheap enough to sit on the 60-second badge path: a `git status --porcelain` line count
and two `stat` calls, no subprocess beyond git, no network.

```json
{
  "configured": true,
  "changesCount": 33,
  "lastSync": "2026-08-31 14:02:11 +0200",
  "repoUrl": "https://github.com/you/your-brain.git",
  "splitSyncRepo": false,
  "adoptedSyncRepo": false
}
```

Unconfigured installs get `{"configured": false}`; a failure gets
`{"configured": true, "error": "…"}`. `repoUrl` always has the token stripped.

**`splitSyncRepo` and `adoptedSyncRepo` are new in v3.32.0** and are additive — every
field above them keeps its name, type and meaning.

- `adoptedSyncRepo` — this install is driving a sync repository it **adopted** rather
  than one it created (see `POST /setup` below).
- `splitSyncRepo` — a *second* sync repository exists beside the domains folder and this
  install is not using it, i.e. two independent histories over one set of files. It is
  deliberately only two `existsSync` calls: it reports **that a foreign repo is
  present**, *not* that it points at the same remote, because confirming the remote
  needs a subprocess and this field is on the badge's hot path. The split is **not**
  self-healed — the Sync view renders the two-click remedy (Disconnect, then Connect)
  instead, because silently switching a working install onto a different repository
  would orphan its commits.

The **path** of an adopted git dir is not returned here. It is returned exactly once, by
`POST /setup`'s adopt branch.

### POST /api/sync/preflight

**v3.32.0.** Measure what connecting would do, before anything is written. This is the
endpoint that exists because a refusal which leaves only the destructive path open is
worse than no refusal.

**Request** — `{ "repoUrl": "…", "token": "…" }`. Both required; a missing one is a
`400`. It is a `POST` rather than a `GET` **because it carries a PAT**, which has no
business in a URL.

**Response** `200 OK`

```json
{
  "ok": true,
  "remoteHasMain": true,
  "localHasContent": true,
  "overwriteCount": 4,
  "overwriteSample": ["articles/wiki/index.md", "articles/state/main/…/current.md"],
  "createCount": 812,
  "foreignSyncRepo": { "originUrl": "https://github.com/you/your-brain.git", "matchesRequestedRepo": true },
  "recommendedMode": "adopt"
}
```

| Field | Meaning |
|---|---|
| `remoteHasMain` | The repository has a `main` branch. `false` means empty — not an error |
| `localHasContent` | The domains folder holds at least one domain |
| `overwriteCount` / `overwriteSample` | Files that exist **on both sides with different content**, i.e. what a checkout would replace. Sample is the first 10, sorted |
| `createCount` | Files the checkout would merely create |
| `foreignSyncRepo` | Another install's sync repository governing this same folder, or `null`. `originUrl` has credentials stripped |
| `recommendedMode` | `adopt` \| `push` \| `merge` \| `pull` — a **UI hint**. Note `adopt` is *not* a valid `mode` for `POST /setup`; adoption is detected there, not requested |

**It writes nothing outside a temporary directory.** The remote is fetched into a
throwaway probe git dir under `os.tmpdir()`, and the comparison runs against a scratch
index (`GIT_INDEX_FILE`) — the work tree is read and never written, and is fingerprinted
and asserted unchanged by the suite. `getSyncGitDir()` is deliberately **not** created,
so a previewed-then-cancelled connect leaves `isConfigured()` false.

**Disclosed cost:** the fetch is a real network round trip that downloads the remote's
objects into that tempdir and then discards them, so a connect that proceeds pays the
download twice.

`500` `{ok: false, error}` on failure.

### POST /api/sync/setup

**Request** — `{ repoUrl, token, mode, confirmOverwrite? }`.

`mode` is one of **`push`**, **`merge`**, **`pull`**. Anything else is refused with
`invalid-mode`.

| `mode` | What it does to the folder on this machine |
|---|---|
| `push` | **Nothing.** Commits and pushes the folder up. Refuses with `remote-not-empty` if the repository already holds a wiki |
| `merge` (v3.32.0) | **Commits the local folder FIRST**, then merges the remote in with `--allow-unrelated-histories -X ours`. That ordering is the entire recoverability property: the pre-merge bytes stay reachable from the merge commit's first parent |
| `pull` | **Replaces** files that differ. See the confirmation gate below |

**`confirmOverwrite` gates the only destructive path**, and is compared with strict
`=== true` at both gates — never coerced, because `Boolean('false')` is `true`. Omit it
and `pull` refuses with `pull-would-overwrite`, carrying the count and the file list.
The consequence is deliberate: a curl script, or any older client that does not
send the field, **cannot** reach the overwriting path (this protected the pre-redesign
shell at `/old` too, before that shell was deleted in v3.41.0).

There are **two** distinct `pull-would-overwrite` refusals, tagged by
`details.source`: `measured` (the preflight assessment said so) and `checkout-refused`
(git itself refused the checkout). Before v3.32.0 the second of those was swallowed by
the catch-ladder and escalated to `git reset --hard` — the defect that destroyed a
morning's working state. There is now **no silent escalation**: only
`confirmOverwrite === true` reaches the reset.

**Repo adoption.** Before doing anything, `setup()` looks for a sibling sync repository
at `dirname(domainsDir)/.knowledge-git` — the layout a pre-app install necessarily has,
because in repo mode the user-data dir *is* the checkout. If one is there:

- **Same remote** → it is **adopted**. The path is stored as `gitDir` in
  `.sync-config.json` (the field is *omitted*, not null, when there is no adoption, so a
  non-adopted config is byte-identical to pre-v3.32.0), its `config` file is chmod'd to
  `0600`, and **not one byte of the work tree is written** — no checkout, no reset, no
  merge. Response carries `{adopted: true, gitDir}`.
- **Different remote** → refused by name with `foreign-sync-repo`, rather than creating
  two independent histories over one folder.

The candidate path is deliberately **singular**. A relocated `domainsPath` is not
covered — stated as a limit rather than papered over with a directory walk. And
`disconnect` never deletes an adopted git dir; it removes only this install's own
credential file.

**Refusals** are `409` with a `code` and a `details` object:
`invalid-mode`, `foreign-sync-repo`, `remote-not-empty`, `remote-empty`,
`pull-would-overwrite`.

> **A policy that applies to every one of these strings:** they name an **action and a
> screen**, never a button label. Naming *"Merge — keep both"* would have reproduced the
> v3.32.0 defect on `/old` (which, through v3.40.0, was frozen and had no merge control;
> that shell was deleted in v3.41.0).

### POST /api/sync/push · /pull · /sync · DELETE /disconnect

Unchanged behaviour. `pull()` resolves with `git pull --no-rebase -X theirs` — the
steady-state rule, where origin is shared truth and this machine is expected to have
pushed already. That is **not** the same as `merge`'s `-X ours` on a first connect,
where the local side has by construction never been pushed anywhere, so preferring
origin would prefer a revision that provably lacks the user's newest work.
`pull()` was not touched by v3.32.0.

---

## Shared Brain endpoints (`v3.0.0-beta+`)

Mounted at `/api/sharedbrain/`. All routes except `/feature-flag` and `/enable-flag` require `sharedBrainEnabled: true` in `.curator-config.json`; otherwise they return **404** with `error: "Shared Brain is not enabled..."`. The flag is `false` by default for v2.x-installed users; flipping it requires an explicit POST to `/enable-flag` or clicking the "Enable Shared Brain (beta)" button in the **Shared Brain** rail view (through v3.40.0 it lived in Settings in the pre-redesign `/old` frontend, where it had moved from the Sync tab in v3.0.2; that frontend was deleted in v3.41.0).

Endpoints marked **SSE** stream `text/event-stream` progress events (`{type, message, ...meta}`) ending in `{type: "done", result: {...}}` or `{type: "error", message}`.

### Feature flag

| Path | Description |
|---|---|
| `GET /api/sharedbrain/feature-flag` | `{enabled: boolean}`. Unauthenticated, ungated. |
| `POST /api/sharedbrain/enable-flag` | Flips the flag to `true`. Idempotent. |

### Connection management

| Path | Description |
|---|---|
| `GET /api/sharedbrain/list` | `{connections: [...]}` with tokens masked. v3.43.0+: each connection also carries an explicit boolean `has_admin_token` — true exactly for the connections `/admin-token/rotate` will not refuse with `no_admin_token`. It exists because `admin_token` is MASKED in this listing, and a client deciding whether to offer the admin affordances must not have to reason about how a credential happens to be redacted. v3.0.4+: each connection carries an additive `pending_pages` count — pages changed since `last_push_at` (∪ `pending_retry`, minus `permanent_skip`) across its contributing domains; cheap mtime scan only. Read-only connections always report 0. Powers the navbar pending badge. |
| `POST /api/sharedbrain/save` | Body: `{connection: {...}}`. Validated server-side. UUIDs assigned if missing. Rejects with 400 if `github_pat` looks like a masked display value (defense against round-trip overwrites). v3.0.4+: optional boolean `read_only` field (defaults `false`) — set by the wizard when the PAT verdict is valid-but-no-write-access; read-only connections may have zero `local_domains`. v3.0.5+: optional `admin_token` (single-line string 16-200 chars or null; masked-ellipsis values refused) and `data_handling_terms` (`contributor_retains` \| `organisational`, persisted for invite re-display). |
| `DELETE /api/sharedbrain/:id` | Removes the connection from this machine. The remote shared repo is unaffected. |
| `POST /api/sharedbrain/:id/unskip` | v3.0.4+. Body: `{pages?: string[]}` — clears the listed pages from `permanent_skip` (omit `pages` to clear all) and resets their `pending_retry` strike counters, so they're re-attempted on the next push. Paths not actually skipped are ignored. Returns `{ok, unskipped, permanent_skip}`. Local config change only; not SSE. |
| `GET /api/sharedbrain/:id/members` | v3.0.5+. Member directory: everyone who has ever contributed to this brain. Returns `{members: [{fellow_id, short_id, submissions, pages, first_contributed_at, last_contributed_at, display_name}], self_fellow_id}`. Identity is storage-path-derived (same trust rule as synthesis); display names are informational. Reads every contribution payload — fine at cohort scale. Powers the revoke UI's fellow picker. |
| `POST /api/sharedbrain/:id/admin-token/rotate` | v3.0.5+. **v3.43.0 — PROOF OF POSSESSION IS NOW REQUIRED.** Body: `{admin_token}` — the connection's CURRENT `sbat_…` token, compared constant-time through the same gate the revoke route uses. On success it generates a fresh token, stores it (single audited credential write path) and returns it **once**: `{ok, admin_token, rotated}`. Three **403** shapes, each carrying a machine-readable `code` beside the prose `error`: `no_admin_token` (this connection stores none — it is a plain contributor's, and this route will never mint one), `admin_token_required` (no usable token in the body), `admin_token_mismatch` (a token was supplied and it is the wrong one). **Until v3.43.0 this route took NO body and authenticated nothing**, so any connection on the machine could mint an admin token — and with it read every `fellow_id` from `/:id/members` and pass `/:id/revoke`, letting a plain contributor GDPR-erase the cohort admin. The provisioning use this row used to describe ("used to provision pre-v3.0.5 connections") is therefore **gone and cannot come back**: nothing on this machine can tell a legacy admin from a contributor. Such an admin re-runs the brain-setup wizard, whose `/generate-invite` returns a fresh `admin_token` that `/save` persists. |

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

These back the **Settings → MCP bridge** wizard. They inspect and help assemble the Claude Desktop
config; **none of them writes `claude_desktop_config.json`** — the user always pastes the snippet
themselves. `CLAUDE_CONFIG_PATH` is a module constant in `src/routes/mcp.js` with no override seam.

The config entry these endpoints describe is always:

```json
{ "mcpServers": { "my-curator": { "command": "<process.execPath>",
                                  "args": ["<app>/mcp/server.js", "--domains-path", "<domainsDir>"] } } }
```

⚠️ **`--domains-path` governs MCP writes as well as reads only from v3.17.0.** Reads have honoured
it since v3.1.0 (`mcp/storage/local.js` ranks it second in its own resolver), but writes go through
`writePage`/`domainPath` in `src/brain/files.js`, which resolve via `getDomainsDir()` — and that
function had **no rung for the argument at all**. One MCP process could therefore resolve two
different trees: measured before the fix, `compile_to_wiki` returned `ok: true` with a
`summary_path`, wrote the page under one tree, wrote `.mcp-write-log.jsonl` under another (the
audit log goes through the read adapter), and a follow-up `get_node` on the path just returned
reported **not found** — a success report over a write the next call could not see.
`mcp/server.js` now calls `setCliDomainsDir(domainsPath)` before building the adapter, which
installs the argument into `getDomainsDir()` directly below the test seams and directly above the
stored setting — byte-for-byte where the read adapter already puts it. The web app never imports
that setter, so its own resolution is unchanged. See
[architecture.md § Precedence](architecture.md#precedence-getdomainsdir-srcbrainconfigjs).

| Path | Description |
|---|---|
| `GET /api/mcp/config` | Install status. `{ok, mcp_server_path, mcp_server_exists, mcp_server_name, domains_dir, domains_dir_exists, node_binary, claude_config_path, claude_config_exists, claude_config_parse_error, installed, stale}`. `ok` is `mcp_server_exists && domains_dir_exists`. `installed` is true when the config already has an `mcpServers["my-curator"]` entry; `stale` is true when that entry's `command`/`args` differ from what this install would generate (the usual cause is a moved domains folder). Both are forced `false` when `claude_config_parse_error` is true — an unreadable file cannot be inspected. |
| `GET /api/mcp/claude-config` | The entry-only snippet, nothing else. Always valid, in every state. |
| `GET /api/mcp/claude-full-config` | Snippet **plus** a merged preview. `{claude_config_path, entry, was_empty, parse_error, merge_available, merged, merge_error}`. Three input states → three outputs: file **absent** → `merged` = the snippet; file **readable** → `merged` = the existing config with our entry added; file **corrupt** → **`merged: null`**, `merge_available: false`, and `merge_error` explaining why. ⚠️ **Callers must branch on `merge_available` (or `merged !== null`), not assume `merged` is an object.** Before v3.6.1 the corrupt branch returned a config containing *only* our server — a valid-looking payload that, if pasted, would delete every other MCP server the user had. `null` is structurally unpasteable, which is the point. Note `was_empty` is a legacy field that stays `true` in the corrupt case (its only shipped consumer dereferences `merged` on the `false` branch); use `parse_error` / `merge_available` to distinguish "absent" from "corrupt". |
| `POST /api/mcp/self-test` | Spawns `mcp/server.js` locally over stdio — since v3.6.1 with **the same `--domains-path` the wizard prescribes**, so a wrong domains folder can no longer produce a green pass — and runs `initialize` → `tools/list` → `tools/call list_domains`. ⚠️ **This endpoint never returns a non-200 status. Branch on `data.ok`, not `res.ok`** — every failure path, including a spawn error, is delivered as a 200 with `ok: false`. |
| `POST /api/mcp/write-config` | **The wizard's "do it for me" step — the only endpoint in this app that writes ANOTHER application's config file.** Rewrites only `mcpServers["my-curator"]` in `claude_desktop_config.json`, leaving every other server byte-identical, and keeps a `.bak` holding the **original bytes** rather than a re-serialisation. Three input states: **absent** → creates the file with just our entry (no `.bak`, nothing to back up); **readable** → merges, response names the servers it preserved; **corrupt** → **409** `{refused: 'claude_config_parse_error'}` and the file is left byte-identical. ⚠️ It is **POST-only on purpose** — a GET is what a prefetch or a poll would issue, and this must never fire without a click. Nothing calls it automatically: `stale` on `GET /api/mcp/config` is what tells the user to return to the wizard. **Known gap:** newer Claude Desktop versions edit that file themselves, so a write landing between our read and our write is lost, mitigated only by the `.bak`. |
| `GET /api/mcp/config` *(three additive fields, v3.30.0)* | `mcp_launch_style` (`'node-script'` in a source install, `'launcher-script'` in a packaged app), `launcher_path` and `launcher_exists`. They let the app tell whether the live Claude Desktop entry is its own flavour — a source install and a packaged app write structurally different entries, not merely different paths. |
| `POST /api/mcp/reveal-config` | Opens `claude_desktop_config.json` in Finder (or its parent directory when the file does not exist yet). macOS only; uses `execFile('open', …)` with no shell. Returns `{ok, revealed}`, or **500** `{ok: false, error}` if `open` fails — the one endpoint here that does use a non-200. |

### `POST /api/mcp/self-test` response

```json
{
  "ok": true,
  "server_info": { "name": "my-curator", "version": "…" },
  "tool_count": 20,
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

## Working state — Agent memory (`/api/memory`)

Working state (`domains/<project>/state/`, v3.17.0) is the store behind the `/next` shell's
**Agent memory** view: a standing project brief, a per-`(scope, machine)` handoff, and an
append-only journal of saves. Two endpoints, both GET, neither of which writes a byte. Served from
`src/routes/memory.js` over `src/brain/working-state.js`.

**There is no write route, and that is a design decision rather than an unfinished path.** The
store has exactly one writer — an agent, through the MCP's `save_working_state` — and that
single-writer property is what makes the per-machine layout safe: two machines never write the
same file, so Personal Sync's `git pull --no-rebase -X theirs` never has a conflicting hunk to
resolve away silently. A browser write path would make the app a *second* writer to the same
files. It would also arrive wearing the last agent's harness/model provenance line, and what a
handoff is worth rests on recording what an *agent* observed. A human editing the brief by hand
opens `state/project.md` in Obsidian; that is the answer, not a gap.

Consequences, all deliberate: neither route carries `guardConcurrent` and neither registers a
write (there is nothing to refuse), and **reads are allowed on read-only `shared-*` Shared Brain
mirrors**, exactly as `GET /api/wiki/:domain/page` is. The detail read echoes `readonly` so a
caller can say so out loud — inside a mirror the state can have been written by another *person*
(see the THREAT MODEL block in `working-state.js`).

### Reading the counts: `scopeCount` means two different things

**`scopeCount` is the number of distinct work-streams on `GET /api/memory` and the number of
`(scope, machine)` pairs on `GET /api/memory/:project`.** One field name, two quantities, inside
one API. Seeded with 2 distinct scopes across 3 pairs, the two routes answer `2` and `3` to the
same field name.

This is not an asymmetry with a reason behind it — unlike the journal limits below, where an
agent pays a context tax per byte and a browser does not, this one is a plain naming collision
with no upside. It is also pre-existing, and it is **not** fixed by redefining either route: the
list route's meaning is pinned by `test-next-memory-view.js` (which asserts
`scopeCount !== savedCopies` there) and the store's meaning, which the detail route spreads
verbatim, is pinned by `test-mcp-working-state.js` §D7. Changing either breaks a guard that is
load-bearing somewhere else.

So **both routes now carry two names that mean one thing each, on either route**:

| Field | Meaning | Where |
|---|---|---|
| `savedCopies` | `(scope, machine)` **pairs** | both routes |
| `distinctScopeCount` | distinct **work-streams** | both routes |
| `scopeCount` | *ambiguous* — pairs or work-streams depending on the route | both routes, **legacy** |

Read `savedCopies` and `distinctScopeCount` and it stops mattering which route answered.
`scopeCount` is kept for compatibility and is the name to stop reading.

**A "showing N of M" note must compare against `savedCopies`.** The index cap and
`scopesTruncated` apply to pairs, so pitting a shown pair count against a work-stream count can
render as *"showing 3 of 2"*.

Both counts are taken **before** the cap, from the store's uncapped pair list, so either may
legitimately exceed `MAX_INDEX_ENTRIES`. Deriving a distinct count from the returned rows
instead reports the *cap* as though it were a measurement — a project with 65 scopes rendering
as `60`, with no truncation marker on that number and five work-streams a picker built from it
could not reach. Truncation describes the **list**; it never describes a count.

Every byte is capped at the source rather than re-capped here: `readWorkingState` reads
`current.md` through `MAX_STATE_BYTES` (48 KB), the brief through `MAX_BRIEF_BYTES` (32 KB), and
the journal through `MAX_JOURNAL_TAIL_BYTES` with an entry cap of `MAX_JOURNAL_ENTRIES` (50);
`listWorkingScopes` caps at `MAX_INDEX_ENTRIES` (60) pairs. This route adds exactly one bound of
its own — `MAX_PROJECTS` on the index — because a second set of limits maintained here would
drift from the store's.

### GET /api/memory

"Which of my projects have agent memory, and how fresh is it?" No parameters.

A row is returned for **every** domain, not only the ones that have state. A project with nothing
saved is a real answer — it is what a user sees before their first agent session — so
`scopeCount: 0` says that plainly instead of the project being hidden and the view looking broken.

**Success response** `200 OK`

```json
{
  "ok": true,
  "projects": [
    {
      "project": "second-brain",
      "hasBrief": true,
      "briefUpdatedAt": "2026-08-20T09:12:44.000Z",
      "scopeCount": 2,
      "distinctScopeCount": 2,
      "savedCopies": 3,
      "scopesTruncated": false,
      "unlistedEntries": 0,
      "unlistedReason": null,
      "lastWriteAt": "2026-08-27T18:03:11.000Z",
      "ageSeconds": 5421,
      "headline": "Docs pass — nine false claims corrected, tests green",
      "newestScope": "main",
      "newestMachine": "alices-macbook-pro-9f3c1a20"
    }
  ],
  "total": 6,
  "truncated": false
}
```

**On this route `scopeCount` counts distinct work-streams**, so it equals `distinctScopeCount`
and differs from `savedCopies` whenever a scope is saved on more than one machine — one
work-stream synced from a laptop and a build box is one work-stream and two copies. It means
something else on the detail route: see
[Reading the counts](#reading-the-counts-scopecount-means-two-different-things) above, and
prefer `savedCopies`/`distinctScopeCount`. (The route keeps a fallback that derives the
distinct count from the returned rows if the store field is absent; it degrades to the old
undercount rather than to a crash.)

`unlistedEntries` counts directory entries under `state/` whose **names** the store cannot
address (see [working-state.md § 3](working-state.md#what-the-read-discloses-about-itself) for
the rule), and `unlistedReason` is the actionable sentence naming the fix, `null` when there is
nothing to report. Without them a screen can say *"nothing saved for this project yet"* over a
real handoff sitting on disk unread, and the advice that follows a false negative is to save,
which writes to the slugged path and orphans the original. `0` means "we looked and every entry
here is addressable" — never "we did not look".

`newestScope`/`newestMachine` exist so a caller can open the freshest handoff in one further
request instead of a round-trip to discover the scope and a second to read it.

`lastWriteAt`, `ageSeconds` and `headline` are **`null` when nothing has ever been saved** — never
`0` and never an epoch date. A fact and its absence stay distinguishable.

Capped at `MAX_PROJECTS` (200) rows; `total` reports the real domain count and `truncated` says
whether the cap bit.

**Error responses**

| Status | Condition |
|--------|-----------|
| `500` | Domain listing or filesystem read error (`{ok: false, error}`) |

### GET /api/memory/:project

One project's working state. The response is the store's `readWorkingState` result verbatim, plus
an added `readonly` — deliberately 1:1 with the store rather than reshaped here, because a second
shape maintained in the route would drift from the one the MCP tools return, and then the app and
the agent would describe the same file differently.

**Path / query parameters**

| Parameter | Description |
|-----------|-------------|
| `project` | Domain slug (path parameter). Resolved against `listDomains()` **before** any filesystem access, so an unknown name never reaches path resolution |
| `scope` | Optional work-stream (`main`, `auth-refactor`, …). Omit it to get the scope index instead of a handoff |
| `machine` | Optional. With `scope` set and no `machine`, the **most recently written** machine wins — that is what makes cross-machine handoff work — and the response names the machine it chose |
| `journalLimit` | Optional. Passed to the store **un-clamped on purpose**: the store clamps to `[1, MAX_JOURNAL_ENTRIES]` (50, default 10) itself, and clamping a second time here is the two-copies-of-a-bound shape. A non-numeric value is not passed at all, so the store's default applies |

> The MCP's `get_working_state` clamps the journal harder — 8 by default, 20 at most. That
> asymmetry is deliberate, not drift: every byte an MCP response returns is charged against a
> model's context window on the turn it asks, and a browser response pays no such tax.

**Success response — without `scope`** `200 OK` (the brief plus "what exists?")

```json
{
  "ok": true,
  "project": "second-brain",
  "brief": {
    "present": true,
    "text": "## Brief\n…",
    "bytes": 4120,
    "truncated": false,
    "updatedAt": "2026-08-20T09:12:44.000Z",
    "sanitisedOnRead": false,
    "sanitisedOnReadNote": null,
    "duplicateHeadings": [],
    "headingsSuspect": false
  },
  "scope": null,
  "scopes": [
    { "scope": "main", "machine": "alices-macbook-pro-9f3c1a20", "lastWriteAt": "2026-08-27T18:03:11.000Z", "bytes": 3598, "ageSeconds": 5421, "headline": "Docs pass — nine false claims corrected" }
  ],
  "scopeCount": 3,
  "distinctScopeCount": 2,
  "savedCopies": 3,
  "scopesTruncated": false,
  "unlistedEntries": 0,
  "unlistedReason": null,
  "readonly": false
}
```

**On this route `scopeCount` is the `(scope, machine)` pair count** — the opposite of what the
same name means on `GET /api/memory`, because this route spreads the store's shape verbatim.
Read `savedCopies` (pairs) and `distinctScopeCount` (work-streams) instead; see
[Reading the counts](#reading-the-counts-scopecount-means-two-different-things) above.

`savedCopies` and `distinctScopeCount` appear only on this **scope-less** form. A
scope-targeted read reports `machineCount` instead and has no project-wide pair total to
alias — the fields below replace them.

`unlistedEntries`/`unlistedReason` carry the same meaning as on the index route above:
directory entries the store will not address, counted rather than silently skipped.

**Success response — with `scope`** `200 OK` (the brief plus that scope's handoff and journal)

```json
{
  "ok": true,
  "project": "second-brain",
  "brief": { "present": true, "…": "…" },
  "scope": "main",
  "machines": [
    { "machine": "alices-macbook-pro-9f3c1a20", "lastWriteAt": "2026-08-27T18:03:11.000Z", "ageSeconds": 5421 }
  ],
  "machineCount": 1,
  "machinesTruncated": false,
  "unlistedMachines": 0,
  "installIdAvailable": true,
  "installIdUnavailableReason": null,
  "machine": "alices-macbook-pro-9f3c1a20",
  "machineIsThisMachine": true,
  "machineIsThisHost": true,
  "current": {
    "present": true,
    "text": "## Current state\n…",
    "bytes": 3598,
    "truncated": false,
    "savedAt": "2026-08-27T18:03:11.000Z",
    "sanitisedOnRead": false,
    "sanitisedOnReadNote": null,
    "duplicateHeadings": [],
    "headingsSuspect": false,
    "headingsSuspectNote": null
  },
  "journal": {
    "entries": [
      { "at": "2026-08-27T18:03:11.000Z", "harness": "claude-code", "model": "claude-opus-5", "headline": "Docs pass — nine false claims corrected", "rejections": [] }
    ],
    "returned": 1,
    "total": 14,
    "totalUnknown": false,
    "totalUnknownReason": null
  },
  "readonly": false
}
```

Journal entries come back **newest first**.

`machineIsThisMachine` is identity; `machineIsThisHost` is a *separate* fact, because a folder can
share this host's name and belong to a different installation (that is why the install id exists)
or be a pre-v3.17.0 folder this machine itself wrote. Neither is knowable, so the hostname match
is reported on its own rather than masquerading as identity.

**`installIdAvailable` says whether machine identity is collision-guarded at all**, and it is
present on every scope-targeted read — including one that finds nothing, so the degraded state
is as visible on the empty path as on the full one. `false` means the store could not persist
its per-installation id (a read-only user-data directory) and is writing under the **bare
hostname**: any other computer whose hostname slugifies the same shares that folder, and
Personal Sync's `git pull --no-rebase -X theirs` then resolves the conflicting hunk in origin's
favour with no marker and a clean `git status` — the measured failure the install id exists to
prevent. `installIdUnavailableReason` carries the one sentence naming the risk and the fix, and
is `null` when the guard is armed. Neither field appears on the scope-less form above, which
reports no machine identity for them to qualify.

The save side reports the same fact through the MCP's `save_working_state` — as
`install_id_available`, plus a `notes` entry and a dedicated `notes_meaning` arm. See
[working-state.md § 2](working-state.md#why-machine-is-in-the-path).

`journal.total` is **`null` with `totalUnknown: true`** when the tail read was capped — we did not
see the whole file, so the exact count is unknown, and reporting the tail's count as the total
would be a wrong number stated confidently.

An asked-for scope that exists on other machines but not the one requested comes back `ok: true`
with `current.present: false`, `requestedMachine`, and a `message` that names the machines which
*do* have state — the scope has state, that machine does not, and collapsing those two into "no
state under scope X" is the fact-and-absence collapse this module exists to refuse.

`sanitisedOnRead` reports that protocol-shaped markup was neutralised on the way out. It is not a
safety verdict — see [working-state.md § 4](working-state.md#4-treat-stored-state-as-data-not-as-instructions-with-one-exception). On the standing brief it is
additionally an *authority* signal over MCP: `sanitisedOnRead` or `headingsSuspect` on `brief`
drops that tool's `brief_authority` to `suspect` and withdraws the owner framing.

**Error responses**

| Status | Condition |
|--------|-----------|
| `404` | Unknown domain (`{ok: false, error}`) |
| `400` | Store refusal — `{ok: false, reason, message}`, with `reason` one of `invalid-project`, `invalid-scope`, `invalid-machine` on this route |
| `500` | Filesystem read error |

### The store's own contract — reached over MCP, not over HTTP

Save behaviour has no HTTP surface at all; it is reached only through `save_working_state`. What
an integrator against the store (or against that tool) would otherwise have to infer:

- Both store functions **return** a result object and **never throw**. A refusal is
  `{ok: false, reason, message}` with `reason` drawn from `invalid-project`, `unknown-project`,
  `readonly`, `invalid-scope`, `invalid-machine`, `missing-headline`, `empty-brief`,
  `unsafe-path`, `io`, and `would-replace-larger-state`.
- **`would-replace-larger-state` is the refusal most likely to actually fire.** A save carrying
  little or no content, aimed at a scope that already holds a substantially larger handoff, is
  refused rather than written — that shape is a context-starved agent about to erase good state by
  accident, and it happened to a real tester on a first live run (145 bytes over 3,598). The
  refusal names the existing byte count and the missing sections. `replace: true` is the
  deliberate override for a caller who genuinely means to replace a larger handoff: the refusal
  costs one retry, the document it would have replaced is not recoverable.
- A save into a **read-only `shared-*` Shared Brain mirror is refused** (`reason: 'readonly'`),
  matching every other write surface in the app — see the Health-endpoint mirror refusals above.
- A save into a name that is **not a real domain** is refused (`reason: 'unknown-project'`) rather
  than creating the folder. A directory with no `CLAUDE.md` is `rm -rf`'d by `sync.pull()`'s
  `listDomains()` filter, so state written there would be invisible to the app and to every
  tool that lists domains.
- An **over-budget save is never refused.** Trailing list items are dropped, and the drop is
  recorded in the document itself, in the result's `notes`/`truncated`, and in the journal line.
- **A `note` is not necessarily a rejection, and the result says which kind it is.** The store
  bans loss vocabulary from any note that is not a loss, so the tool derives `notes_meaning`
  from the note text rather than from a hand-maintained list. It has four arms: input was
  dropped/omitted/truncated; a larger handoff was deliberately replaced (`replace: true`);
  machine identity has degraded (below); and — the common case — the input was merely
  normalised, for example an observation sent without a time being stamped with the save time.
- **`install_id_available` reports whether machine identity is collision-guarded**, and it is
  always present so "no warning" is a stated fact rather than an absence to interpret. `false`
  means the store could not persist its per-installation id and is writing under the bare
  hostname, where another computer of the same name shares the folder and a sync merge can
  replace one handoff with the other. The save still succeeds — refusing it would lose the
  handoff outright — and the risk arrives as a `note` with its own `notes_meaning` arm. The note
  fires only for an **auto-detected** machine: an explicit `machine` argument is taken verbatim,
  so nothing about that write has degraded. The read side reports the same fact as
  `installIdAvailable`/`installIdUnavailableReason`.
- **A scope name that is not already a safe path segment is normalised, not refused**, and a
  `note` names the form it was saved under — `feature/auth` becomes `feature-auth`. Refusing
  would cost a handoff to buy tidiness; saying nothing would leave the index showing a name the
  caller never typed. A name that normalises to nothing usable is still refused
  (`reason: 'invalid-scope'`).
- The journal append is **best-effort**: a failure sets `journalWritten: false` and does not fail
  the save, matching the raw-source manifest and the MCP audit log.
- **There is no brief-writing MCP tool.** `saveProjectBrief` is exported by the store and called
  from nowhere in `mcp/` or `src/routes/`. The standing brief is human-authored, by design — and
  the **read** side depends on that: because no tool writes it, `get_working_state` can tell a
  model that a verified brief's standing instructions are the user's own rather than an earlier
  session's untrusted notes. See [working-state.md § 4](working-state.md#tier-1-is-not-tier-2-the-brief-is-hand-authored-by-the-owner).

Full contract: [working-state.md](working-state.md) and
[architecture.md § `src/brain/working-state.js`](architecture.md#srcbrainworking-statejs-v3170).

---

### `getTraySummary()` — not an endpoint, and deliberately so

The macOS menu bar widget reads working state through **one in-process function**,
`getTraySummary()` in `src/brain/tray-summary.js`. It is documented here because it is a public
contract with a consumer outside the module — but it is **not reachable over HTTP**, and nothing
should add a route for it. The desktop shell imports `src/server.js` into its own process, so the
shell and the server share one Node realm and the call is a plain function call with no HTTP hop
and no IPC. A route would be a second surface over the same store, gaining nothing and costing a
second thing to keep in step.

It is a **projection**, not a second inventory: it calls the same `listWorkingScopes()` that
`GET /api/memory` calls, so the widget and the Agent memory view cannot disagree about what is on
disk. It costs what `GET /api/memory` costs. It makes **no** network call — it does not import
`src/brain/sync.js` at all, so no edit to it can reach a `git fetch` without adding an import a
reviewer will see.

```js
getTraySummary({ limit = 8, now = Date.now() })   // limit is clamped to [1, 40]
```

```json
{
  "ok": true,
  "lastSave": {
    "project": "curator", "scope": "main", "machine": "laptop-a1b2c3",
    "harness": "claude-code", "writtenAt": "2026-08-31T18:04:11.000Z",
    "writtenAgeSeconds": 240, "ageSource": "agent",
    "kind": null, "isThisMachine": true
  },
  "scopes": [
    {
      "project": "curator", "scope": "main", "machine": "laptop-a1b2c3",
      "harness": "claude-code", "headline": "wired the remote observation",
      "kind": null, "bytes": 14208,
      "harnessShared": false, "harnesses": ["claude-code"],
      "agentWrittenAt": "2026-08-31T18:04:11.000Z", "agentWrittenAgeSeconds": 240,
      "fileChangedAt": "2026-08-31T18:04:11.000Z", "fileChangedAgeSeconds": 240,
      "writtenAt": "2026-08-31T18:04:11.000Z", "writtenAgeSeconds": 240,
      "ageSource": "agent",
      "isThisMachine": true, "machineMatch": "exact", "isThisHost": true
    }
  ],
  "total": 12,
  "pairsOnDisk": 12,
  "truncated": true,
  "pulse": {
    "windowSeconds": 604800, "bucketSeconds": 21600,
    "buckets": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 5, 1, 0, 3, 4, 0, 0, 6, 2, 0, 1, 4, 7, 3],
    "events": 41, "eventsOutsideWindow": 0,
    "pairsCounted": 11, "pairsTruncated": 0,
    "clock": "agent", "oldestEventAt": "2026-08-28T23:41:02.000Z",
    "coversWholeWindow": false, "firstKnownBucket": 13
  },
  "brief": { "project": "curator", "updatedAt": "2026-08-19T09:22:00.000Z", "ageSeconds": 1067531 },
  "remote": { "ok": true, "behindFiles": 14, "behindCommits": 2, "checkedAt": "2026-08-31T18:00:02.000Z" },
  "warnings": [
    { "code": "scopes-truncated", "message": "Showing the 8 most recent of 12 saved work-streams.",
      "shown": 8, "total": 12, "pairsOnDisk": 12 }
  ]
}
```

| Field | Meaning |
|---|---|
| `ok` | Always `true`. **The function never throws** — a store that cannot be read yields empty arrays and a warning, because a menu bar panel that renders an exception is one a user reads as "the app is broken" |
| `lastSave` | `scopes[0]` re-projected **from the same object**, so the headline and the first row can never name different saves. `null` when there are no rows |
| `scopes[]` | **Arrives ordered, newest first, on the chosen clock. A consumer must not re-sort it.** A row with no usable clock sorts **last**, never first — putting an unknown at the top asserts it is the newest |
| `total` | How many rows `scopes` was sliced **from** — counted before the slice |
| `pairsOnDisk` | Every `(scope, machine)` pair the store saw, including pairs past a project's own `MAX_INDEX_ENTRIES`. `>= total`, and the gap is truncation inside the store rather than here. Two different facts, two names; neither derived from the other |
| `truncated` | `total > scopes.length` |
| `pulse` | The save heartbeat — see below. `null` only when **no journal was read at all**; a store that has journals but no usable timestamps in them is a real, drawable state and arrives as `clock: 'none'` |
| `brief` | The standing brief's age for the project of the **newest** save — one `stat`, never a read. `null` when there is no brief, which is the normal case rather than an error. No `ageSource`: a brief has no journal, so mtime is the only clock and there is nothing to be honest between. Rendered as a `· Brief · 6 weeks ago` clause on the **tray icon's hover tooltip** (`trayToolTip()` in `desktop/lib/tray-menu.js`) — the Tier-C ranking keeps it out of a *menu row*, and the tooltip is the one surface in the widget with no scarcity |
| `remote` | See below. `null` means **nobody has checked** |
| `warnings[]` | `{code, message, …}`. Codes: `domains-unreadable` · `projects-truncated` · `scopes-truncated` · `harness-collision` · `harness-collisions-truncated` · `unlisted-entries` |

**Per-row fields worth reading carefully**

| Field | Meaning |
|---|---|
| `ageSource` | `'agent'` or `'file'`. `writtenAt`/`writtenAgeSeconds` carry whichever clock was chosen, and this says which. **`'file'` is `st.mtime`, which git rewrites on checkout** — so a handoff that arrived over Personal Sync carries the moment of the *pull*, not the moment of the save. A renderer must qualify a `'file'` age in words (*"changed 4 min ago"*) rather than present it as a written time |
| `agentWrittenAt` / `fileChangedAt` (+ their `…AgeSeconds`) | Both raw clocks, always emitted under names that can only mean one thing, so a consumer wanting *"written 3 hr ago · arrived just now"* re-derives nothing |
| `isThisMachine` | Whether this row was written by **this installation**. True on an exact match of the whole `<hostname-slug>-<install-id>` segment, **and** on a match of the trailing installation id alone — macOS re-derives the hostname from DHCP, so one laptop can own two `<machine>` folders, and comparing the whole string classified half of a real store as a remote machine. The hostname half is **never** compared, so `buildbox-a1b2c3` cannot claim to be this machine unless it carries this installation's id, and two absent ids never compare equal. **Read it strictly**: anything but `true` should be treated as remote |
| `machineMatch` | `'exact'` · `'install-id'` · `'none'` — **how** `isThisMachine` was decided. A diagnostic, so a derived answer is not one nobody can debug; it is deliberately never displayed, and a renderer that branched on it would put a second identity opinion beside `isThisMachine` |
| *(consumer-side)* `machineIdentityKey` | Not a field. The tray menu needs a **different** question — *are these two rows one computer* — and answers it in `desktop/lib/tray-model.js` by comparing the **trailing installation id** and never the raw `<machine>` folder string, so `alices-macbook-pro-9f3c1a` and `mac-9f3c1a` both key to `id:9f3c1a`. It falls back to `isThisMachine === true`, then to the folder name, only when no id parses. Noted here because it is the rule that keeps a DHCP hostname flap from rendering as a phantom second computer, and because it is **not** `machineMatch` |
| `isThisHost` | The weaker fact: the folder shares this host's *name*. A folder can share a hostname and belong to a different installation, which is the entire reason the installation id exists |
| `harness` / `harnessShared` / `harnesses[]` | Which agent tool wrote last, whether **two** tools are alternating in this one folder, and which ones. A collision silently overwrites handoffs; the remedy — a separate scope per tool — is the user's |
| `kind` | The store's own verdict on the last save (`lastSaveKind`), e.g. `trimmed`. **`null` means there is no journal line, so we do not know — not "complete"** |
| `bytes` | Size of the handoff, against the store's 48 KB cap |

**`pulse` costs no file I/O, and that is why it exists at all.** `listWorkingScopes()` already read
and parsed every journal in full on every call, and the index then discarded every timestamp except
the newest — 54 of 65 entries on the maintainer's own store, parsed and thrown away. The pulse is
those numbers kept. `saveTimes` is a **strict opt-in** (`opts.withSaveTimes === true`), and
`getTraySummary()` is its only caller, so the MCP's `get_working_state` payload — which lives under
a 400 KB budget — is byte-identical.

| Field | Meaning |
|---|---|
| `windowSeconds` · `bucketSeconds` | `604800` (7 days) and `21600` (6 hours). 28 buckets, derived rather than typed twice |
| `buckets[]` | Saves per bucket, **oldest first**. Anchored on `now`, not on midnight, so the last cell always contains this instant. Cell `i` covers `(now − (28−i)·bucket, now − (27−i)·bucket]` — open at the older edge, closed at the newer — so an event on an internal boundary belongs to the **older** cell and every event lands in exactly one |
| `events` | Saves counted **inside** the window. Counted during the walk, **before** the display slice, so `limit: 1` does not move it |
| `eventsOutsideWindow` | Saves older than the window. Ordinary history, not a reason to distrust the drawing |
| `pairsCounted` / `pairsTruncated` | How many `(scope, machine)` pairs fed the strip, and how many of those hit the 16 KB journal-tail cap. **`pairsTruncated > 0` makes `events` a floor**, which a renderer must say in words (*"at least 65 saves"*) rather than quietly present as a count |
| `clock` | `'agent'` or `'none'`. **There is no `'file'` and no `'mixed'`, deliberately.** Only a journal line's own `at` is ever counted; an mtime fallback would draw a second machine's pulled history as a spike at the moment of the pull, because git rewrites mtime on checkout |
| `oldestEventAt` | ISO time of the oldest save **inside** the window, or `null` |
| `coversWholeWindow` | `true` only when something was saved at or before the window opened — i.e. the store demonstrably existed for the whole span |
| `firstKnownBucket` | Cells **before** this index are *unknown*, not *empty*. `0` when the window is covered; `28` (one past the last cell) when nothing was counted, which is the honest answer and still an integer |

`coversWholeWindow` and `firstKnownBucket` are the fact-versus-absence rule applied to a chart: a
brand-new store and a dormant one draw the same 28 empty cells and mean opposite things. On a
3.5-day-old store against the 7-day window, **13 of 28 cells are unknown** — the common case, not an
edge one.

> **28 is the PRODUCER's resolution and not the drawn one.** `desktop/lib/pulse-strip.js` folds these
> buckets two-to-one at draw time (`mergeCells(cells, mergeFactor(28))`), so the menu bar strip draws
> **14 cells of 12 hours** in 55 × 14 points. Nothing here changes: `windowSeconds`, `bucketSeconds`
> and `buckets[]` are the contract, and a consumer is free to draw them at full resolution. A
> renderer's legend must quote `drawnBucketSeconds()` rather than `bucketSeconds`, because a legend
> has to describe the picture in front of the reader. The 13-of-28 store above folds to **6 of 14**
> unknown cells — still half the strip.

> **`TRAY_DEFAULT_LIMIT` is 8; the tray shell asks for 5.** The default is what a caller gets when it
> expresses no opinion. `desktop/main.js` sets `TRAY_ROW_LIMIT = MAX_ROWS` (5, imported from
> `tray-model.js`) so it asks for exactly what it can display, and `buildTrayModel()` caps again at
> `MAX_ROWS` independently. Because `total` and `pairsOnDisk` are both counted **before** the slice,
> neither cap can be reported as a measurement at any limit.

A save stamped in the **future** — a machine with a skewed clock, which sync makes reachable — is
clamped into the newest cell and counted, the same direction the store already clamps a negative age
to 0. A real save is not made unreal by a bad clock.

**`remote` is an OBSERVATION, not a live check.** `getTraySummary()` never fetches. `brain/sync.js`
exposes no non-fetching accessor — `getRemoteStatus()` is *cache hit ? return : `git fetch`*, and
`maxAgeMs: 0` does not help because the TTL returns 0 for a successful payload — and a second fetch
site is the recorded v3.9.1 incident where the user's own pull aborted in 11 runs out of 12 over a
ref lock. So `noteRemoteStatus(payload)` records whatever a completed check last reported;
[`GET /api/sync/remote-status`](#personal-sync-endpoints-apisync) calls it with no fetch of its own.

- An **unconfigured** install records nothing. That is not an observation of "0 waiting".
- A **failed** check carries `ok: false` and keeps `behindFiles: null` — *"we could not ask"* and
  *"there is nothing waiting"* are different facts. **`ok` is the third state, and without it the
  first two collapse**: the renderer branches on `remote.ok === false`, and while the store emitted
  no `ok` at all a failed check reached the menu as `{behindFiles: null}`, took the no-number exit,
  and rendered byte-identically to never having checked. The distinction survived the store and died
  at the model.
- An observation older than **5 minutes** is dropped, not shown with an age: a line reading
  *"2 waiting"* is read as current and there is no room beside it to say it is not.
- **`null` still means nobody has checked, and it is never rendered as "up to date".** There are two
  feeders: `GET /api/sync/remote-status`, which the sync badge polls and which keeps the observation
  warm for free while the window is open; and the desktop shell's `maybeCheckRemote()`
  (`desktop/lib/tray-remote.js`), on a tray **menu open** — never on hover, never on a timer. The
  second exists because the first declines to fetch while `document.hidden`, and a hidden window is
  the tray's normal state, so the multi-machine signal was previously inert exactly where it was
  needed.

---

## GET /api/config

The app's own configuration — where the knowledge folder is, how that was decided, the default
domain for MCP writes, the resolved release channel, and the resolved menu bar mode. No body, no
side effects.

**Success response** `200 OK`

```json
{
  "domainsPath": "/Users/you/the-curator/domains",
  "domainsPathSource": "ui",
  "defaultDomain": "articles",
  "releaseChannel": "stable",
  "backgroundMode": "window",
  "backgroundModes": ["window", "tray", "tray-only"]
}
```

| Field | Meaning |
|---|---|
| `domainsPath` | The **resolved** absolute path, never the raw config value |
| `domainsPathSource` | Which rung of the resolution ladder won: `cli` · `ui` · `env` · `default` |
| `defaultDomain` | The domain MCP write tools use when the user says "my wiki" without naming one. `null` if unset |
| `releaseChannel` | The **resolved** channel name (v3.29.0). Always `stable` in this build |
| `backgroundMode` | The **resolved** menu bar mode: `window` (no menu bar icon — the default) · `tray` · `tray-only`. Absent or unrecognised in the config file reads as `window` |
| `backgroundModes` | Every mode name **this build** understands, in order. Shipped beside the value so a client renders what the server would accept rather than a hardcoded triple |

`backgroundMode` is resolved for the same reason `releaseChannel` is: an absent or unrecognised key
reads as `window` here exactly as it does in the desktop shell, so this endpoint cannot tell the
Settings screen one thing while the app does another. It is written by
[`POST /api/config/background-mode`](#post-apiconfigbackground-mode).

`backgroundModes` exists so adding a mode is one edit in one file and can never leave a control
offering an option the server would refuse. A client should render an unknown id under its own
name rather than dropping it — a newer server must not be able to make an option silently
disappear from a picker.

`domainsPathSource` mirrors `getDomainsDir()`'s rungs in the same order, so this endpoint can never
report a source that disagrees with the folder reported beside it. The `cli` arm is unreachable in
the app — only the MCP child process installs that override — and exists so the two cannot drift.

`releaseChannel` is the **resolved** name, never the raw file value: an absent or unrecognised key
reads as `stable` here exactly as it does in the update paths, so this endpoint can never disagree
with the ref those actually use. There is no endpoint that writes it.

---

## POST /api/config/background-mode

Sets the app's menu bar mode. Mac-app only in effect — a browser install has no menu bar presence,
and the field is stored and returned identically there.

**Request**

```json
{ "backgroundMode": "tray" }
```

| Value | Meaning |
|---|---|
| `window` | No menu bar icon. The Dock icon and the window behave exactly as they did before the field existed. **The default.** |
| `tray` | A menu bar icon alongside the Dock icon |
| `tray-only` | Menu bar icon, Dock icon hidden — **accepted and recorded, but the Dock icon is not actually hidden today.** The shell treats it as `tray` and reports the hedge; see [the roadmap's §0a](roadmap-menubar-widget.md#0a-status--what-shipped-what-deviated-what-is-still-a-plan) |

**Success response** `200 OK`

```json
{ "ok": true, "backgroundMode": "tray", "backgroundModes": ["window", "tray", "tray-only"] }
```

**Refusal** `400 Bad Request` — an unrecognised value is **refused, never coerced**. Coercing would
let a client report *"tray-only saved"* while the file holds `window`.

```json
{
  "error": "Unknown background mode. Expected one of: window, tray, tray-only.",
  "reason": "invalid_value",
  "backgroundMode": "window",
  "backgroundModes": ["window", "tray", "tray-only"]
}
```

`backgroundMode` in a refusal is **the mode still in force**, not the one that was asked for, so a
client that renders the response shows the truth even if it ignores the status code.

**Not behind `guardConcurrent`, and not registered as a write.** Nothing on any write path reads
this field — its only consumer is the desktop shell, which reads it before it creates the tray or
the window and again when the user flips it. A 409 here would fire precisely while a long ingest
was running, i.e. it would refuse to let someone turn off a menu bar icon because the app is busy
doing something the icon has no bearing on. What bounds the write instead is the allow-list: the
value lands in `.curator-config.json`, which holds the user's API keys, so exactly three literal
strings are accepted and everything else is refused. Mutating requests also pass the server's
cross-origin guard.

---

## GET /api/config/ui-state

Durable UI state (v3.28.0) — the handful of `/next` fields whose loss is a **correctness or trust
failure** rather than a per-device inconvenience, so they live in `.curator-config.json` instead of
browser storage. No body.

**Success response** `200 OK`

```json
{
  "ok": true,
  "ui": {
    "aiHealthDisclosureSeen": "yes",
    "onboardingDismissed": null,
    "cutoverNoticeDismissed": "1",
    "installOrigin": "pre"
  }
}
```

**Every field is always present.** `null` means *not recorded* — and a field and its absence are
different facts that must not collapse into one value. For `installOrigin`, `null` ("nobody has
decided yet, decide now") is a completely different instruction from `"post"`.

Anything unrecognised on disk — a value from a future version, a half-written string, a key some
other tool squatted on — reads as `null` rather than being trusted.

**This endpoint never returns a non-200 status.** A read error comes back as
`200 {"ok": false, "error": "..."}` with no `ui` key, so every consumer falls back to its own
documented fail-safe direction. Answering `500` to a read the client uses to decide whether to
re-ask for a consent would be the wrong failure.

---

## POST /api/config/ui-state

Record durable UI state. Body is a **partial** map of `{ field: value }`.

| Field | Accepted values | Rule |
|---|---|---|
| `aiHealthDisclosureSeen` | `"yes"` | monotonic — cannot be un-set |
| `onboardingDismissed` | `"1"`, or `null` to clear | clearable |
| `cutoverNoticeDismissed` | `"1"` | monotonic |
| `installOrigin` | `"pre"` \| `"post"` | write-once |

**Success response** `200 OK`

```json
{
  "ok": true,
  "ui": { "onboardingDismissed": "1", "aiHealthDisclosureSeen": "yes", "cutoverNoticeDismissed": null, "installOrigin": "pre" },
  "refused": [{ "field": "aiHealthDisclosureSeen", "reason": "not_clearable" }]
}
```

`refused` names **every field that was asked for and not written**, with a reason:
`unknown_field` · `not_clearable` · `invalid_value` · `already_recorded` · `monotonic`. A refusal
that is merely un-written is invisible to the caller, and this project has a specific record of that
shape, so it is reported instead.

Values are stored as the same strings the browser held (`'yes'`, `'1'`, `'pre'`), not as booleans —
which makes the client adapter an identity map, with no encoding to get wrong.

⚠️ **Only `onboardingDismissed` is clearable, and that is a real distinction rather than a
relaxation.** An un-*dismiss* is a thing the product offers (Settings → "Show setup guide"); an
un-*consent* is not. A `null` aimed at a consent field is refused **by name** rather than silently
no-op'd.

> Both `ui-state` routes are deliberately **not** behind `guardConcurrent` and are **not** registered
> with the write registry. Nothing on any write path reads these fields — they exist only so the app
> can remember what the user has already been told. A `409` here would fire precisely when the user
> is mid-ingest and the app is trying to record that they dismissed a panel, re-creating the "the
> app forgot me" symptom the endpoint exists to prevent.

---

## POST /api/config/domains-path

Point The Curator at a different knowledge folder. This is what makes an existing wiki appear in a
fresh install — the wiki is plain markdown on disk, so naming the folder *is* the migration.

**Body**

| Parameter | Description |
|---|---|
| `path` | Absolute path to an **existing** folder. Required, non-empty |

**Success response** `200 OK`

```json
{ "ok": true, "domainsPath": "/Users/you/Documents/curator-domains" }
```

**Error response** `400` — `{"error": "path is required"}`, or
`{"error": "Folder does not exist: /nope"}`. The folder must already exist; this route does not
create one.

**Refusal response** `409` — behind `guardConcurrent('change the knowledge folder')`, so it refuses
while an ingest, sync or update is in flight. Moving the knowledge folder out from under a running
write is exactly the case that guard exists for.

---

## POST /api/config/pick-folder

Open the native macOS folder picker (`osascript`) and, if the user chooses a folder, persist it.
**macOS only** — on Windows and Linux use [`POST /api/config/domains-path`](#post-apiconfigdomains-path)
with a path you obtained some other way. No body.

**Success response** `200 OK` — a folder was chosen

```json
{ "ok": true, "path": "/Users/you/Documents/curator-domains" }
```

**Success response** `200 OK` — the user pressed Cancel

```json
{ "cancelled": true }
```

**Error response** `400` — `{"error": "Folder does not exist: ..."}` ·
**Refusal response** `409` — an in-flight write.

⚠️ **This route is a mutation, not a path-returning helper.** It calls `setDomainsDir()` itself; it
does not hand a path back for the client to submit to `/domains-path`.

⚠️ **Integration hazard — check `cancelled` before `res.ok`.** The dialog blocks for up to 60
seconds, so `hasActiveWrites()` is re-checked **after** it closes: the middleware only proved the
state at the moment the dialog opened, which is long enough for the batch queue to start its next
item. That means a `409` refusal is possible on a request that was accepted at entry — and because
the shipping frontend tests `data.cancelled` before `res.ok`, a refusal must never carry that field.
The two outcomes are deliberately kept distinct.

---

## GET /api/config/api-keys

Returns masked API key status, the active provider, and the model-picker catalogue. No body.

```json
{
  "geminiApiKey": "••••••••ab12",
  "anthropicApiKey": "",
  "openrouterApiKey": "",
  "hasGeminiKey": true,
  "hasAnthropicKey": false,
  "hasOpenrouterKey": false,
  "activeProvider": "gemini",
  "activeModel": "gemini-2.5-flash-lite",
  "models": {
    "gemini": "gemini-2.5-flash-lite",
    "anthropic": "claude-haiku-4-5",
    "openrouter": "upstage/solar-pro4"
  },
  "selectedModels": {
    "gemini": null,
    "anthropic": null,
    "openrouter": null
  },
  "fallback": null,
  "offerable": {
    "gemini": [
      {
        "id": "gemini-2.5-flash-lite",
        "provider": "gemini",
        "label": "Flash Lite 2.5",
        "maxOutput": 65536,
        "thinks": false,
        "jsonRaw": true,
        "tokenizerFactor": 1.0,
        "suitability": "general",
        "note": "The default, and the cheapest model on either provider. Measured 3/3 clean raw JSON …",
        "standardInput": 0.10,
        "standardOutput": 0.40,
        "promotionUntilIso": null,
        "standardPriceFromIso": null,
        "dominated": false,
        "input": 0.10,
        "output": 0.40
      }
    ],
    "anthropic": [],
    "openrouter": []
  },
  "openrouterCatalogue": { "syncedAt": "2026-08-28T09:14:02.117Z", "source": "network", "count": 189 },
  "qualifications": [
    {
      "modelId": "moonshotai/kimi-k2.6",
      "domain": "articles",
      "measuredAt": "2026-08-28T10:31:44.902Z",
      "sourceName": "the-energy-and-water-footprint.pdf",
      "runsCompleted": 9,
      "counts": { "raw": 9, "repaired": 0, "unrepairable": 0, "unusable": 0, "notMeasured": 0, "failed": 0 },
      "pages": { "median": 25, "min": 18, "max": 33, "n": 9 },
      "latencyMs": { "mean": 41200, "min": 33100, "max": 58800, "n": 9 },
      "spendUsd": 0.005, "spendComplete": true, "spendIsLowerBound": false,
      "outcome": "NO_DEFECT_FOUND",
      "qualifies": true,
      "stillOffered": true
    }
  ],
  "minRunsToQualify": 9
}
```

- `geminiApiKey` / `anthropicApiKey` / `openrouterApiKey` — masked (`••••••••` + last 4 chars), or
  `""` if unset. The raw key is never sent back over this endpoint.
- `hasGeminiKey` / `hasAnthropicKey` / `hasOpenrouterKey` — **config-scoped only** (from
  `getApiKeys()` / `.curator-config.json`, never `.env`/`getEffectiveKey()`). A key that exists only
  in `.env` reports `false` here — this is deliberate (v3.0.13): the per-chat model selector and the
  onboarding first-run check both key off these fields, and a provider the user has **Disconnected**
  in Settings must not read as configured just because a developer `.env` fallback still has a key.
- `activeProvider` / `activeModel` — the provider/model an LLM call would actually use right now
  (`null` if no usable key at all). Can differ from `hasXKey` when a key is `.env`-only.
- `models` — **stays a map of plain STRINGS (or `null`), one per provider.** This is
  load-bearing, not incidental: through v3.40.0 the pre-redesign shell's chat model-selector
  dropdown (`src/public/app.js`, deleted in v3.41.0) rendered `escHtml(models[p] || '')`, and
  `escHtml` begins with `String(str)` — so if a value here were ever an object or array instead
  of a string, that dropdown would have rendered the literal text `[object Object]` for every
  user still on the pre-cutover UI. `/next`'s own consumers (`views/chat.js`, `views/settings.js`)
  index `models[provider]` the same way, so the string-only contract still stands even with `/old`
  gone. Do not fold `offerable` into this field or otherwise change its shape; add new
  data as a new key instead (which is exactly what `offerable` below does).
  - **A `null` value is legitimate** and means *this provider has no resolvable default model*.
    **No provider is `null` in the shipping configuration** — `openrouter` resolved to `null` until
    a model was measured for its build lane, and since this release it carries
    `upstage/solar-pro4`. The `null` case is documented because it is still reachable for any
    provider wired up before its models are measured, and because consumers must keep handling it.
    Through v3.40.0 this was safe for `/old` in both directions, and both halves were checked rather
    than assumed: `/old` never enumerated this map (it built its own provider list from the two
    original `hasXKey` fields and only indexed `models[p]` for those), and the `|| ''` rendered a
    `null` as empty rather than as `[object Object]`. The invariant this protects is *never an
    object or array* — not *never null*. **`/old` therefore never offered OpenRouter at all**,
    which was the documented limit for that shell before it was deleted in v3.41.0.
- `selectedModels` — the user's **explicit stored pick** per provider, or `null` where they have
  chosen nothing. Deliberately separate from `models`: `models` is what the app will actually *use*
  (and already reflects a stored pick), while this distinguishes *the user chose the default* from
  *the user chose nothing* — which a picker needs in order to render a selected state honestly.
  Strings or `null` only; same shape discipline as `models`. Gated config-only, exactly like
  `offerable` and the `hasXKey` fields: a Disconnected provider reports `null` here because the
  engine will not honour its stored selection either. **The UI must never show a selection the
  engine has stopped obeying.**
- `fallback` — `null` when the primary model is working; populated when the model-lifecycle
  fallback chain kicked in (see `docs/model-lifecycle.md`).
- `offerable` — the full pickable-model catalogue per provider, driving the model picker. Each
  array is ordered **cheapest-first** by standard `input` price. Sourced from
  `listOfferableModels(provider)` in `src/brain/llm.js` — **not** the frozen `OFFERABLE_MODELS`
  table directly, which for a provider whose catalogue is fetched at runtime is only a partial
  view. Gated the *same config-scoped way* as the `hasXKey` fields: a provider with no **saved
  Settings key** reports `offerable.<provider>: []`, even if `.env` has a key for it — a
  Disconnected provider must not appear pickable. `offerable.<provider>` is always an array
  (possibly empty); the endpoint never throws or omits the field if a provider has no entries.
  - **`offerable.openrouter` grows after a catalogue sync.** It holds the three hand-measured entries
    until [`POST /api/config/openrouter/sync`](#post-apiconfigopenroutersync) has run, and those plus
    every admitted catalogue entry afterwards (189 on one measured run). Every fetched entry is
    `suitability: "chat-only"` with `jsonRaw: null` — *never measured here* — and the merged array is
    re-sorted cheapest-first, because concatenating two ordered lists does not produce an ordered one.
  - `id` / `label` — model id and a short display label.
  - `input` / `output` — current USD price per 1M tokens (reflects an active promotion if any).
  - `standardInput` / `standardOutput` — the price once any promotion ends (equal to `input`/
    `output` when there is no promotion); `promotionUntilIso` / `standardPriceFromIso` carry the
    promotion window as ISO dates, or `null`.
  - `maxOutput` — hard output-token ceiling for this model.
  - `thinks` — measured: whether the model spends hidden reasoning tokens (billed as output).
  - `jsonRaw` — measured: whether the ingest outline's JSON parses raw, without the `jsonrepair`
    fallback. **`null` on a `chat-only` entry**, meaning *not measured* — it describes JSON-mode
    ingest behaviour and is meaningless for chat, which is text mode. It is never `false` in that
    case, which would read as *measured bad*.
  - `tokenizerFactor` — measured input-token multiplier vs. that provider's baseline tokenizer.
  - `suitability` — `'general' | 'chat-only' | 'caution'`. **`'chat-only'` is enforced**, not
    decorative: such a model is refused by `POST /api/config/api-keys/model` and is not honoured
    as a build model even if already stored. See that endpoint below.
  - `note` — the measured reason behind `suitability`, written to be shown to the user verbatim.
  - `dominated` — `true` when a same-priced sibling measured strictly better.

Every provider key in these three maps (`models`, `selectedModels`, `offerable`) is present for
each provider the app knows how to talk to. Adding a provider **appends** a key; it never
re-orders or removes one.

- `openrouterCatalogue` — provenance for the OpenRouter half of `offerable`: `{syncedAt, source,
  count}`, or `null`. **Additive** (through v3.40.0, `/old` read `models` and the `hasXKey`
  booleans and ignored unknown fields; that shell was deleted in v3.41.0). Key-gated exactly like
  `offerable`, so it is `null` without a saved OpenRouter
  key. `source` is `"network"` after a sync in this process, `"disk"` after a boot restore, and
  `null` when nothing has been loaded; `syncedAt` may be `null` on a restore from a file written
  without one. It answers *how fresh is that list* and nothing else — the models themselves stay in
  `offerable`. See [POST /api/config/openrouter/sync](#post-apiconfigopenroutersync).

- `qualifications` — the user's **own** measurements (the record shown above is illustrative), from
  [POST /api/config/openrouter/qualify](#post-apiconfigopenrouterqualify), keyed by model id so the
  picker can join them onto `offerable` without a second request. **A separate field, never a
  mutation of `offerable`**: a locally-qualified model keeps reporting `suitability: "chat-only"` on
  the wire, so a UI can badge *you measured this* apart from *we measured this*. Folding it into
  `suitability` would collapse two different epistemic claims into one badge.
  - `qualifies` — whether this record **currently** grants the build lane. Computed **server-side**
    from the same predicate the pin route enforces, and recomputed on every read rather than stored,
    because it depends on the live catalogue: a model that leaves the eligible list stops qualifying
    the instant it leaves. A client-side re-derivation from the counts would be a second copy of a
    money-relevant rule and could offer a button guaranteed to `400`.
  - `stillOffered` — whether the id is still in the catalogue. A record whose model has gone is
    **kept and shown as void**, not deleted: the measurement cost real money and up to an hour.
  - Key-gated exactly like `offerable` (`[]` without a saved OpenRouter key) and **additive**.
- `minRunsToQualify` — the floor for promotion (**9**). Fewer completed runs are measured and stored
  honestly, with the run count, and qualify nothing.

## POST /api/config/api-keys

Save API keys (partial update — only overwrites provided fields). Saving a non-empty key normally
also makes that provider active ("last-saved-wins").

```json
// Request
{ "geminiApiKey": "AIza…", "anthropicApiKey": "" }
```

```json
// Response
{
  "ok": true,
  "activeProvider": "gemini",
  "activeModel": "gemini-2.5-flash-lite",
  "skippedActivation": []
}
```

- `skippedActivation` — an array of `{ provider, reason }`. An entry means the key
  **was saved** but that provider did **not** become active, because it has no model available for
  the build lane (`reason: "no_build_model"`). The save genuinely succeeded, so this is not an
  error — it is the signal a UI needs in order to explain why the active provider did not move.
  Without it the user sees a successful save and an unchanged active provider with no reason given,
  which reads as the app ignoring the click.
  - ⚠ **It is empty for every provider that ships today.** All three — `gemini`, `anthropic` and
    `openrouter` — now have a build-lane model, so saving any of their keys **activates** that
    provider under ordinary last-saved-wins. `openrouter` produced an entry here until its build
    lane was measured; it no longer does. Treat this array as a channel that may legitimately
    never carry anything, and **do not** rely on it to warn a user that saving a key changed their
    active provider — saving a key changing the active provider is the *normal* path, and the
    honest signal for it is `activeProvider` in the same response.

  This is the one documented exception to last-saved-wins, and it exists because activating a
  provider that cannot build silently breaks ingest, Health and Compile. See
  [model-lifecycle.md → OpenRouter](model-lifecycle.md#the-state-of-the-build-lane-in-this-release).

## POST /api/config/api-keys/disconnect

Clear one provider's stored key. Body: `{ "provider": "<provider>" }`. If the cleared key was
active, active moves to the first remaining provider **in provider order** that still holds a saved
key, or to `null` when none does. Config keys only — a lingering `.env` key does not hold a
provider active after the user disconnected it (the v3.0.13 rule).

## POST /api/config/api-keys/active

Switch the active provider **without** re-saving its key. Body: `{ "provider": "<provider>" }`.

Refuses with `400` in two cases:

| Condition | Response |
|---|---|
| The provider has no stored key | `{ "error": "No <provider> key is configured — …" }` |
| The provider has no build-lane model | `{ "error": "…cannot be made active — ingest, Health and Compile would stop working. Your current provider is unchanged.", "reason": "no_build_model" }` |

The second refusal is **loud on purpose**. Succeeding here would leave ingest, Health and Compile
throwing on the next call with nothing on screen saying so; a silent no-op would look like a broken
control. The storage layer refuses this independently as a backstop for any other caller.

**No provider currently triggers that second refusal.** All three have a build-lane model as of
this release, so `Set active` succeeds for any of them that has a stored key. The branch is
documented because it stays reachable for a provider wired up before its models are measured, and
because the storage-layer backstop still enforces it for every caller.

## POST /api/config/api-keys/build-model

**The atomic build-model write.** Sets the provider **and** the model together, so a choice can
never land inert. This is what the single cross-provider model list in Settings posts to.

`POST /api/config/api-keys/model` (below) still exists and is still the **only** way to *clear* a
selection — this route has no clearing arm by design, because "build with nothing" is not a state.

```json
// Request — both fields required; there is no clearing arm
{ "provider": "openrouter", "model": "upstage/solar-pro4" }
```

Refused with `400` when: the provider is unknown; `model` is not a non-empty string; the provider's
key is **not saved in Settings** (config-scoped — a key living only in `.env` does not count, the
v3.0.13 rule); the model is not offerable; or the model is not build-lane eligible
(`reason: "not_build_lane"`).

Writes are ordered **model first, then provider**. A crash between them leaves the pre-existing
inert-pin state rather than silently moving the user onto a different provider's default.

Response carries `ok`, `provider`, `selectedModel`, `effectiveModel`, `activeProvider`,
`activeModel`, `providerSwitched`, `inert`, and `inertReason`
(`'provider-not-active' | 'model-overridden' | null`).

> **Known gap, recorded rather than implied away:** no shipping surface reads `inertReason` yet —
> the `/next` Settings view branches on `inert` alone, so its message attributes the cause to the
> provider even when the real cause is an `LLM_MODEL` environment override.

Guarded by `guardConcurrent`, so it refuses with `409` while a write to the wiki is in flight.

---

## POST /api/config/api-keys/model

Persist the user's model choice for one provider, **without** changing which provider is active.
This pins the **build model** — the one that runs ingest, Health and Compile.

> Prefer [`POST /api/config/api-keys/build-model`](#post-apiconfigapi-keysbuild-model) for *setting*
> a model: it sets provider and model atomically. This route remains the way to **clear** a
> selection, and it is how the "follow the app default" control works. Because it does not touch
> `activeProvider`, it is also the route that can still produce a pin under a non-active provider —
> a state Settings now surfaces explicitly rather than hiding.

```json
// Request — an empty/null/absent model CLEARS the selection (back to the provider default)
{ "provider": "anthropic", "model": "claude-sonnet-5" }
```

```json
// Response
{
  "ok": true,
  "provider": "anthropic",
  "selectedModel": "claude-sonnet-5",
  "effectiveModel": "claude-sonnet-5",
  "activeProvider": "gemini",
  "activeModel": "gemini-2.5-flash-lite"
}
```

- `selectedModel` — what is now stored (`null` after a clear).
- `effectiveModel` — what the app will **actually use** for that provider now, so a UI renders the
  resolved truth rather than assuming the write took effect verbatim.
- `activeProvider` / `activeModel` — unchanged by this call; returned for convenience. Note they
  can name a *different* provider: a pin is per provider, and only the active provider's pin is live.

Refuses with `400`:

| Condition | Note |
|---|---|
| Unknown provider | — |
| `model` present but not a string | — |
| The provider has no key **saved in Settings** | Config-scoped (`getApiKeys()`), never `.env`. Both ends of the contract agree — you can only store a selection for a provider you have connected, and it is only honoured while that key stays connected, so a Disconnect cannot leave a live orphaned selection. |
| The model is not in that provider's catalogue | The refusal deliberately **does not echo the submitted string** — this repo has a recorded log-forgery finding from echoing an attacker-controlled value into a user-facing message. |
| The model is not allowed in the build lane | Refused as a build model, naming the model and stating that it remains selectable per-conversation in chat. Safe to name here because this branch is only reached after the id has been confirmed to be one of our own catalogue ids. For an OpenRouter model with **no** local record, the message also names the way out — measure it on your own wiki — because without that sentence the refusal reads as a dead end on the exact screen the user opened in order to change their model. |
| — | The gate is `isBuildLaneModel`, which has **two** independent clauses: hand-measured (`suitability !== 'chat-only'`) **or** [locally qualified](#post-apiconfigopenrouterqualify). So a `chat-only` model the user has measured on their own wiki is accepted here, and one they have not is refused. |

Also returns **`409`** while any write is in progress (`guardConcurrent`). That is not symmetry with
its `/active` sibling — the stored selection is consulted **fresh on every LLM call**, and a
multi-phase ingest makes 20+ calls over several minutes, so an unguarded click mid-ingest would plan
the outline on one model and write later batches on another, invalidate Anthropic's prompt cache
(a different model is a different cache namespace, so every cached read becomes a write at 1.25×),
and make the queue's per-item spend arithmetic wrong.

Write-time validation exists to give the user an actionable `400`. It is deliberately **not** the
only gate: the model layer re-checks on read, because a stored id can stop being offerable — or be
re-classified `chat-only` — *after* it was validly written.

## POST /api/config/openrouter/sync

Refresh the live OpenRouter **chat** catalogue: fetch the provider's public model list, run it
through the eligibility filter, admit what survives, persist it, and report the funnel that explains
every loss. No body.

This is the only route that populates the chat-lane overlay. Until it is called, an OpenRouter user
is offered the three hand-measured models and nothing else.

**Requires an OpenRouter key saved in Settings.** The gate is config-scoped (`getApiKeys()`, never
`getEffectiveKey()`), so a key that exists only in `.env` does not satisfy it — the v3.0.13 rule.
The key is read for **truthiness only and is never sent anywhere**: OpenRouter's `/models` endpoint
is public and unauthenticated, so no credential enters this code path at all.

**Carries `guardConcurrent`**, so it returns **409** while any write is running (an ingest, a Wiki
Health fix, a compile). That refusal is correct rather than defensive: a successful sync replaces the
catalogue and rebuilds the dynamic price and free registries, which mid-run changes what
`getProviderInfo` resolves for the next call and what the batch queue prices the last one at.

### Success — 200

```json
{
  "ok": true,
  "syncedAt": "2026-08-28T09:14:02.117Z",
  "total": 387,
  "eligible": 193,
  "admitted": 189,
  "refused": 2,
  "superseded": 2,
  "persisted": true,
  "funnel": [
    { "rule": "json_mode",        "before": 387, "after": 329 },
    { "rule": "knowable_price",   "before": 329, "after": 327 },
    { "rule": "not_moving_alias", "before": 327, "after": 314 },
    { "rule": "output_ceiling",   "before": 314, "after": 253 },
    { "rule": "context_window",   "before": 253, "after": 194 },
    { "rule": "not_expiring",     "before": 194, "after": 193 },
    { "rule": "text_output",      "before": 193, "after": 193 }
  ]
}
```

The figures above are **one measured run (28 August 2026)**, not a fixed shape to assert against:
OpenRouter's catalogue moved by seven records inside five hours on the day it was recorded.

- `total` — records OpenRouter listed.
- `eligible` — records where **nothing in the published metadata disqualifies the model**. It does
  **not** mean the model works; metadata can say a model *accepts* structured output and cannot say
  the output *parses*. Every admitted entry is `suitability: "chat-only"` for exactly this reason.
- `admitted` — entries that became offers, i.e. what `offerable.openrouter` gained.
- `refused` — of the models that passed eligibility, how many failed to become an offer, at the
  mapper or at admission. Losses attributed to a rule are already in `funnel` and are deliberately
  **not** double-counted here.
- `superseded` — models the provider lists that The Curator has already hand-measured, so the
  fetched copy was dropped in favour of the measured one. Not a refusal and not a loss.
- `persisted` — `false` means the sync succeeded over the network but could not be written to disk:
  the models work for this session and are lost on restart. Absent is treated as `true`.
- `funnel` — `{rule, before, after}` per rule, in the fixed evaluation order. Each rejected model is
  attributed to the **first** rule it fails, so the cascade is reproducible.

### Errors

| Status | When | Body |
|---|---|---|
| **400** | No OpenRouter key saved in Settings | `{ "error": "No OpenRouter key is saved in Settings — connect one before syncing the model list." }` |
| **409** | A write is in progress (`guardConcurrent`) | The standard concurrency refusal |
| **502** | `OPENROUTER_EMPTY_CATALOGUE`, `OPENROUTER_NO_ELIGIBILITY`, or an upstream HTTP failure | `{ error, unchanged: true, catalogue }` |
| **500** | The sync export is missing from the build, or config could not be read | `{ error }` |

**Every failure leaves the previous catalogue intact**, and the error body says so:
`unchanged: true`, plus `catalogue` carrying the `{syncedAt, source, count}` still loaded — so a
client never has to guess whether a failed refresh cost the user their models. `setOpenRouterCatalogue`
is reached only after fetch *and* build have both succeeded.

Two failure modes are worth naming because they look like successes:

- **Zero records is refused, not accepted.** The fetcher returns `[]` rather than throwing when the
  response body is not the shape it expects. An empty array flowing into admission would wipe a
  working catalogue on an HTTP 200 with a changed body shape, with every layer reporting success.
- **An unevaluated expiry check is refused.** The eligibility module is pure and cannot read a clock;
  the route injects one and then verifies the module reports it *landed*. If it did not, nothing is
  changed — *"we could not check"* must never be served as *"we checked"*.

---

## GET /api/config/openrouter/qualify/estimate

What a qualification run would cost, **before anything is spent**. Free: no network, no LLM call.
It assembles the real ingest outline prompt from the user's own wiki, read-only, and reports the
time and money a run would take.

**Query parameters**

| Parameter | Required | Description |
|---|---|---|
| `model` | yes | The OpenRouter model id to measure. |
| `domain` | no | Which wiki to measure against. Omitted, the server picks the domain with the **largest `index.md`** — the cheapest proxy for *most realistic prompt*. Deliberately **not** the MCP default domain, which answers a different question and is often a small scratch domain. |

```json
{
  "ok": true,
  "modelId": "moonshotai/kimi-k2.6",
  "domain": "articles",
  "runs": 9,
  "minRunsToQualify": 9,
  "promptChars": 341005,
  "inputTokensPerRun": 85251,
  "totalInputTokens": 767259,
  "cost": { "kind": "priced", "usd": 0.383, "note": "Input only. Output is what we are measuring …" },
  "time": { "fastestSeconds": 342, "slowestSeconds": 3438, "note": "We cannot predict how slow …" },
  "sourceName": "the-energy-and-water-footprint.pdf",
  "indexChars": 127666,
  "entityCount": 607,
  "conceptCount": 2685,
  "existing": null
}
```

Figures above are illustrative: every one of them is derived from the caller's own wiki and the
model's own published price, so no two installs see the same payload.

- `cost.kind` is **tri-state and never coerced**: `"free"` (`usd: 0` — the one case where zero is the
  truth), `"priced"` (a real figure, **input only**, explicitly a floor because output tokens are
  what the run is measuring), or `"unknown"` (`usd: null` — no published price; **never** rendered as
  `$0.00`). Freeness is asked *before* price, because `getModelPrice()` returns `null` for a free
  model by design and reading them in the other order reports every free model as *cost unknown*.
- `time` leads the confirm deliberately: measured per-call latency across candidates ranged from
  **38 s to 382 s**, so nine runs is roughly 6 minutes to an hour, at well under a dollar a run. It is a
  **range across models already measured** (`QUALIFY_OBSERVED_CALL_SECONDS`), not a prediction for
  this one — later measurement recorded a single call at 491 s, above the top of the frozen range.
- `existing` — the record this run would **replace**, or `null`, so a confirm can say *you already
  measured this on 28 Aug* rather than letting a user pay twice.
- **Not** `guardConcurrent`-guarded, deliberately: it is read-only, and refusing it mid-ingest would
  deny the user the one screen that says what a run would cost.

Refuses with `400`: no `model`; no OpenRouter key **saved in Settings** (config-scoped, never
`.env`); the model is not currently offerable; the model is already a build-lane model (nothing to
measure); no domains exist; `QUALIFY_NO_SOURCE` (no readable source document in the domain's
`raw/`); or `QUALIFY_DOMAIN_TOO_THIN` (the assembled prompt is below the realistic-prompt floor).
The last two are **refusals by design** — they are how the module keeps its promise that the probe
uses a real prompt — and carry a `code` alongside the message. Unknown domain returns `404`.

---

## POST /api/config/openrouter/qualify

Measure one OpenRouter model against the user's own wiki, `runs` times, and store the result.
Server-Sent Events.

```json
// Request
{ "model": "moonshotai/kimi-k2.6", "domain": "articles", "runs": 9 }
```

`domain` and `runs` are optional; `runs` is clamped to 1–9 and defaults to 9. **Fewer than 9
completed runs is measured and stored honestly but qualifies nothing** — `minRunsToQualify` is the
floor, not a suggestion.

**Events**

| Event | Payload |
|---|---|
| `start` | `{modelId, domain, runs, promptChars, sourceName, minRunsToQualify}` |
| `run` | `{run, of, outcome, parseClass, usable, pageCount, latencyMs, budgetBurn, errorClass, etaMs}` — `etaMs` is a **real projection from real measurements**, replacing the pre-run range as soon as there is anything to project from. |
| `done` | `{record, qualifies}` |
| `stored` | `{record, stored, qualifies}` — `qualifies` is recomputed through the **same predicate the pin route uses**, so the button the user sees next cannot disagree with the server. |
| `error` | `{error, code}` |

**The record**

- `outcome` — `NO_DEFECT_FOUND` | `DEFECT_OBSERVED` | `NOT_MEASURED` | `CANCELLED`. The vocabulary is
  deliberate: **`NO_DEFECT_FOUND` is the strongest thing that may be emitted, and it is weaker than
  "passed"**. By the rule of three, 9 clean runs are consistent with a true failure rate up to ~33%
  at 95% confidence. The word *verified* is never used.
- `counts` — `{raw, repaired, unrepairable, unusable, notMeasured, failed}`. **`repaired` is not a
  defect** (`claude-haiku-4-5`, the shipping Anthropic default, fences its JSON 3 of 3 and depends
  entirely on the repair path); `unrepairable` and `unusable` are, and they are kept apart because
  they are different failures with different causes.
- `pages` / `latencyMs` — `{median|mean, min, max, n}`. **Latency is recorded and shown, never
  auto-rejected**: a transient upstream slowdown must not permanently disqualify a good model, but a
  user pinning a model that takes minutes per call should see that first.
- `spendUsd` with `spendComplete` and `spendIsLowerBound` — the same tri-state discipline as
  everywhere else. Identical prompts across runs can hit an upstream cache a real ingest will not, so
  measured spend is flagged as a floor rather than quoted as the cost of ingesting.
- `domain`, `sourceName`, `promptSha256`, `measuredAt` — **which wiki, which document, and when**. An
  aggregator id routes over upstream hosts that change, so a record is a statement about a moment,
  never a global claim about a model.
- A **rate-limited** run is `NOT_MEASURED` — neither a defect nor a pass.

**Cancellation is closing the connection.** There is no cancel endpoint and no run id: `req.on('close')`
aborts the in-flight call. A cancelled run settles as `CANCELLED` and is **not stored**, so it can
never overwrite an earlier real measurement with a stub, and it is never recorded as a model defect.

**Guarded by `guardConcurrent`** (`409` while any write is in progress), because a completed run can
change what the build lane resolves for every subsequent ingest, Health scan and Compile. It does
**not** `registerWrite`: it writes no wiki page, and holding the process-wide write gate for up to an
hour would block Sync, Update and Delete. The named consequence is that a
[catalogue refresh](#post-apiconfigopenroutersync) started *during* a running qualification is not
refused.

Refusals are the same set as the estimate endpoint above, with the same status codes.

---

## POST /api/config/api-keys/validate

Check a provider key **without spending anything**. Body:
`{ "provider": "openrouter", "apiKey": "<key>" }`.

Omit or empty `apiKey` to validate the key already resolved for that provider (config, then
`.env`), which doubles as an *is my saved key still good?* probe. Supplying one lets a caller verify
a key **before** saving it: the key travels browser → localhost → provider once and is never
persisted by this route. Length is bounded to 20–400 characters — a format check would reject
legitimate future keys, since the upstream endpoint is the format authority; the bound exists only
to stop a megabyte of junk becoming an outbound header.

> **Note on the shipping UI:** the Settings key-test control sends `{ provider }` only, i.e. it
> checks the **already-saved** key. The pre-save form of this route is supported and tested but is
> not currently used by the frontend.

**Only OpenRouter is supported**, and the asymmetry is deliberate rather than an omission: OpenRouter
publishes an authenticated endpoint that reports a key's own tier, limit and usage and **costs zero
tokens**. Gemini and Anthropic have no equivalent, which is why those are verified instead by
[System Check](system-check.md)'s explicitly cost-confirmed one-call test. The other providers are
refused **by name**, pointing at that surface, rather than silently doing nothing.

```json
// Response — a working key
{
  "ok": true, "provider": "openrouter", "valid": true,
  "isFreeTier": false, "limit": null, "limitRemaining": null, "usage": 0
}
```

- **The verdict is a `200` body, not an HTTP error.** A rejected key means this route *worked* and
  the answer is *no*. Returning `401` would be a lie about our own API and would land in the
  frontend's generic network-error path, where the actionable detail is discarded.
- **`valid` is tri-state: `true` / `false` / `null`.** `null` means *we could not find out*
  (rate-limited, upstream broken, unreachable, unreadable) — a different fact from *this key is
  bad*, and it must not be rendered as one.
- **A `402` reports `valid: true` with a warning.** The key authenticated; the *account* is out of
  credit. Telling the user their key is wrong would send them to regenerate a perfectly good one.
  Worth knowing: a negative balance produces errors **including on free models**.
- `limit` / `limitRemaining` / `usage` / `isFreeTier` — passed through **in the provider's own
  units, with no conversion applied by this app**, and normalised to **`null`, never `0`**, when
  absent or unreadable. Upstream reports `limit: null` to mean *no cap on this key*, and rendering
  that as `0` would tell the user their key is exhausted. Reported or absent, never inferred.
- **No key bytes and no upstream text can reach the response.** Every message is a fixed literal
  chosen by HTTP status; the upstream error body is never read, let alone echoed. Classification is
  structural (on the numeric status) and never a substring match on a message.
- **Deliberately not `guardConcurrent`'d** — do not "fix" this by symmetry with its siblings. That
  guard exists to stop a *config mutation* landing mid-write; this route mutates nothing. Guarding
  it would be actively harmful, since a `409` would fire precisely when a long ingest is running,
  i.e. exactly when a user is asking *is my key the problem?* `POST` (not `GET`) is still
  load-bearing: the server's cross-origin guard only inspects mutating verbs.

---

## GET /api/config/update-check

Ask whether a newer version exists. Network read only; changes nothing.

**Forked on `updateStyle` first, then on `canSelfUpdateViaGit`** — see
[architecture § Install modes](architecture.md#install-modes-srcbraininstall-modejs). The two forks
answer different questions and are checked in that order:

| `updateStyle` | `canSelfUpdateViaGit` | Arm |
|---|---|---|
| `git-pull` (a checkout) | `true` | reads `package.json` on the tracked branch + the branch head SHA — **unchanged, byte for byte, from every prior version** |
| `download-installer` (a packaged app) | `false` | reads GitHub's public **release list** and reports the newest release carrying an installer |
| anything else | `false` | `501` — this build has no update route at all |

`updateStyle` is checked first because it is the question that has an answer for every install form;
`canSelfUpdateViaGit` only says what one of them cannot do. **No field was added to the git arm's
response**, so an absent `updateStyle` on the wire means the git flow — which is what every existing
client already assumes. The install's real capability is separately observable on
[`GET /api/version`](#get-apiversion) as `capabilities.updateStyle`.

### Arm 1 — `git-pull`

**Success response** `200 OK` (a build that can self-update)

```json
{
  "current": "3.27.0",
  "latest": "3.28.0",
  "localCommit": "a1b2c3d",
  "remoteCommit": "e4f5a6b",
  "updateAvailable": true,
  "localAhead": false,
  "channel": "stable",
  "branch": "main"
}
```

`channel` and `branch` (v3.29.0) are **additive** — every field above them keeps its name, type and
meaning, so a client written before that release reads the payload it always did. They report the
**resolved** release channel and the git ref this install tracks, so the channel is inspectable
rather than inferred: given a support report, seeing the resolved value beside the raw config file
is the only way to tell *"resolved to `stable` because the key is absent"* from *"resolved to
`stable` because the key holds something this build has never heard of"*.

`stable` is the only channel this build defines, and `branch` is therefore always `main`. There is
deliberately no control that writes the channel, and adding a second one is not a config change —
see [`GET /api/config`](#get-apiconfig) and
[desktop-app-decisions.md § D10](desktop-app-decisions.md#d10--releasechannel-ships-with-stable-as-its-only-valid-value)
for the measurement that stops it.

`updateAvailable` is **not** a plain version inequality. It used to be — `latest !== current`, which is
true in *both* directions, so a checkout whose local version was **ahead** of the published one (a
release committed but not yet pushed) reported an update whose button runs `git reset --hard
origin/main`: a downgrade, offered as an update. The verdict is now:

| Local vs remote version | `commitsDiffer` | `updateAvailable` |
|---|---|---|
| remote newer | any | `true` |
| identical strings | yes | `true` — the legitimate "new commits on main" case, unchanged |
| identical strings | no | `false` |
| not comparable (e.g. one side unparseable, or cores equal but strings differ) | any | falls back to the **original string inequality**, i.e. `true` — unchanged |
| **local ahead** | any | **`false`**, and `localAhead: true` |

The commit comparison is subordinated rather than dropped: a local-ahead checkout has differing
commits *by construction*, so leaving `|| commitsDiffer` unconditional would have left the defect
fully intact in the exact state that triggers it.

The uncomparable row is not a detail. A first draft treated *equal* and *uncomparable* alike (both
are `0` from the comparator), and a 24-cell A/B against the pre-change expression showed **12** cells
moving instead of the intended 6: `nightly` vs `3.25.0`, and `3.0.1-beta.27` vs `3.0.1`, with
matching or unknown commits, went from *update offered* to *no update* — hiding a real update behind
a version string the comparator could not parse. With the string fallback in place the A/B changes
**exactly the six local-ahead cells and nothing else**, and `scripts/test-install-mode.js` §7b runs
that comparison every time rather than leaving it as a claim.

**Effect on the two frontends (historical — `/old` was deleted in v3.41.0).** `/next` computes its
own local-ahead guard in `classifyUpdate()` *before* it reads `updateAvailable`, so its rendering is
unchanged in every case. Through v3.40.0, `/old` (`src/public/app.js`) read `data.updateAvailable`
with no guard at all — so in the local-ahead state it previously showed "Update available" with a
button that would downgrade the checkout, and after this fix correctly showed nothing. That was the
one user-visible difference in this endpoint between the two frontends while both existed; `/next`
is now the only client.

`localAhead` is returned because `updateAvailable: false` now covers two different situations —
*you are current* and *you are ahead of what is published* — and a client that cannot tell them
apart would report the second as the first.

**Error response** `500` — `{ "error": "…" }`. Reachable on the common failure
(`Could not reach GitHub`) and on an unparseable local `package.json`.

### Arm 2 — `download-installer`

One unauthenticated `GET https://api.github.com/repos/talirezun/the-curator/releases?per_page=30`,
with a fixed `User-Agent` and an 8-second `AbortSignal.timeout`. **No credential, no query parameter
other than the page size, and nothing derived from the user or the machine ever leaves the process.**
No subprocess runs on this arm — `git` is never invoked.

The packaged app cannot replace its own files *from source*, so this arm reads GitHub's release list
rather than a git branch. **Since v3.33.0 its verdict is no longer the end of the road:** the client
can hand it to [`POST /api/config/update`'s installer arm](#arm-2--the-in-app-updater-updatestyle-download-installer),
which downloads, verifies and stages that same release. The link this arm carries
(`releaseUrl` / `releasesPageUrl`) remains the fallback for a build with no updater engine attached.
See [`docs/mac-app.md` § Updating the packaged app](mac-app.md#updating-the-packaged-app).

**Success response** `200 OK`

```json
{
  "current": "3.30.0",
  "latest": "3.31.0",
  "updateAvailable": true,
  "localAhead": false,
  "comparable": true,
  "noInstallableRelease": false,
  "updateStyle": "download-installer",
  "channel": "stable",
  "releaseUrl": "https://github.com/talirezun/the-curator/releases/tag/v3.31.0",
  "releasesPageUrl": "https://github.com/talirezun/the-curator/releases",
  "releaseName": "v3.31.0 — …",
  "releaseTag": "v3.31.0",
  "prerelease": true,
  "publishedAt": "2026-09-14T08:45:24Z",
  "localCommit": null,
  "remoteCommit": null
}
```

**Which release is `latest`.** Not `/releases/latest` — that endpoint means *newest non-draft,
non-pre-release*, and measured against this repository on 2026-08-31 it answers `v3.9.0`, whose asset
list is **empty**, while the only release carrying a `.dmg` is `v3.30.0`, flagged `prerelease: true`.
Filtering pre-releases out would therefore have reported every packaged user as *ahead of the
published version*, permanently. The rule is **the newest non-draft release carrying an installer
asset** (`.dmg` today), selected by semver over the page rather than by trusting its order, with
`prerelease` reported so the UI can disclose it.

**The four non-update outcomes, which never share wording.** `updateAvailable: false` alone is
ambiguous, so each carries its own flag:

| Situation | Fields |
|---|---|
| you are on the newest installable build | `updateAvailable: false`, `localAhead: false`, `comparable: true` |
| you are newer than anything published | `localAhead: true` |
| the published tag is not a comparable version | `comparable: false`, `latest` = the raw tag |
| nothing installable has been published at all | `noInstallableRelease: true`, `latest: null` |

**Failure responses** `502 Bad Gateway` — an upstream problem, never a local one. Every failure body
carries an `error` string and a `reason` code, and **carries no `updateAvailable` field at all**, so
nothing downstream can read a failed check as a reassuring "you are up to date".

| `reason` | Cause |
|---|---|
| `unreachable` | the fetch threw or timed out. The raw transport error is never echoed. |
| `rate-limited` | `403`/`429` **with** `x-ratelimit-remaining: 0`. The header is what separates it from an ordinary refusal. |
| `http-error` | any other non-`2xx` |
| `unexpected-response` | the body was not a JSON array |

`500` with `reason: "local-version-unreadable"` is the one local failure: this install's own
`package.json` could not be read.

### Arm 3 — refusal

`501 Not Implemented`, for a build that has neither update route.

```json
{
  "error": "Cannot check for updates in this build of The Curator (Packaged app). This install does not have the \"canSelfUpdateViaGit\" capability.",
  "refused": "capability_unavailable",
  "capability": "canSelfUpdateViaGit",
  "installMode": "bundle",
  "updateAvailable": false,
  "hint": "Packaged builds update through the app's own updater, not this checkout-only git flow."
}
```

Note this is **no longer what a packaged macOS build answers** — it takes arm 2. Until this release
it was, and a user who installed the DMG saw that `error` string rendered as a red *"Couldn't check
for updates"* box naming an internal capability identifier. The arm survives for an install form that
is neither: a git-less tarball drop, a package-manager cask.

---

## POST /api/config/update

**Forked on `updateStyle`**, exactly as `GET /update-check` is. Arm 1 (`git-pull`, every browser
install and every git checkout) is documented immediately below and is unchanged. Arm 2
(`download-installer`) is the in-app updater and is documented further down.

### Arm 1 — `git-pull`

Fetch the latest code, hard-sync to `origin/main`, install dependencies, rebuild the `.app`. The
frontend follows a success with `POST /api/restart`.

Refused with `409` (via the shared `conflictResponse`) while any wiki write is in flight — the
update ends in a process restart, which can truncate an in-flight write.

**Forked on `canSelfUpdateViaGit`.** The repo arm runs, in order:

1. `git --version` — a preflight added so a machine with no git gets a message naming
   `xcode-select --install` rather than the shell's own `git: command not found`. (The same class was
   worse in Personal Sync, where `friendlyError`'s bare `not found` substring rendered it as
   *"Repository not found. Check the URL"* — a confidently wrong diagnosis, fixed at source.)
2. `git fetch origin main`
3. `git rev-parse HEAD`
4. `git reset --hard origin/main`
5. `git rev-parse HEAD`
6. `npm install --silent --no-audit --no-fund`
7. `bash scripts/build-app.sh` (non-fatal)

Steps 2–7 are unchanged from every prior version; step 1 is the one addition.
`scripts/test-install-mode.js` §6 pins all seven as literals transcribed into the suite.

```json
{ "ok": true, "restarting": true, "from": "a1b2c3d", "to": "e4f5a6b" }
```

`partial: true` plus a `warning` means git succeeded and `npm install` did not — restart anyway.
It fires **only** for the `npm: command not found` / `npm: not found` case; every other `npm`
failure throws into the `500` arm.

```json
{
  "ok": true, "restarting": true, "partial": true,
  "from": "a1b2c3d", "to": "e4f5a6b",
  "warning": "Files updated a1b2c3d → e4f5a6b. npm couldn't be found under the running app's PATH — …"
}
```

**Refusal response** `501 Not Implemented` (a build that cannot self-update via git). **Zero
subprocesses run**: every step above is impossible or actively destructive in a signed bundle, and
`scripts/build-app.sh` ends in an ad-hoc `codesign --force --deep --sign -` that would destroy a
Developer ID signature.

```json
{
  "error": "Cannot update the app in this build of The Curator (Packaged app). This install does not have the \"canSelfUpdateViaGit\" capability.",
  "refused": "capability_unavailable",
  "capability": "canSelfUpdateViaGit",
  "installMode": "bundle",
  "hint": "Packaged builds are replaced by the installer, not by pulling this checkout."
}
```

Note the two differences from `GET /update-check`'s 501: this body carries **no
`updateAvailable` field**, and the `hint` string is different. Note also the
**order**: the capability check runs **before** the `409` write-registry check,
so a packaged build answers `501` even while a write is in flight — *this build
cannot do that at all* beats *not right now*.

**Other error responses**

| Status | Body |
|---|---|
| `409` | `conflictResponse('update the app')` — fires on `hasActiveWrites()` (unlike `POST /api/compile/conversation`, which 409s only on an update in progress). |
| `500` | `{ error, from, to }` — `from`/`to` are the short SHAs, **or `null`** depending on how far the sequence got. `error` may be a classified, actionable `npm` message rather than the raw one, or the git-missing message from step 1. |

---

### Arm 2 — the in-app updater (`updateStyle: 'download-installer'`)

**Server-Sent Events.** Downloads the newest installable build, verifies it, and stages it beside
the running app. It does **not** replace anything — [`POST /api/config/update/apply`](#post-apiconfigupdateapply)
is the step that does.

This replaces v3.31.0's check-and-tell behaviour, which found the newest release carrying an
installer and opened its download page. That path is still the fallback and is still reachable: see
the `no-updater` refusal below.

**The work is not done here.** Download, verification, staging, the bundle swap and the relaunch all
live in the desktop shell and reach this process through the hook registry in
`src/brain/desktop-host.js`:

| Hook | Shape |
|---|---|
| `prepareUpdate({onProgress, signal})` | Resolves, downloads, verifies, stages. Replaces nothing. Resolves `{ok:true, token, version, current, bytes, verifiedDigest, prerelease, warning}` or `{ok:false, reason, message}`. **A failure is a resolved value, not a rejection** — a rejection is still handled, as a contract violation rather than an expected outcome. |
| `installUpdate({token, onProgress})` | Swaps the staged bundle in and relaunches. Not expected to return. |

**`installUpdate` takes an opaque token and never a path, and that is a security property.** This
route's caller is a renderer; a hook accepting `{stagedPath, targetPath}` would be a
*replace-any-directory-with-any-other* primitive reachable from a page. The token is stored on the
job, passed straight back unread, and is **absent from `GET /update-progress`'s allow-list**. No
filesystem path is constructed, logged or rendered on any of these paths.

`signal` is a real `AbortSignal` and **this route never fires it** — see the no-cancel note below. It
is passed so the engine's own guards see a well-formed object, not as a half-wired cancel.

The route owns the capability fork, the refusals, and the translation of the engine's progress into a
stream. It does **not** own the engine's copy: `prepareUpdate` carries **36** named reasons and a
user-facing `message` for each, and that sentence is **relayed verbatim**. A second sentence per
reason here would be a second copy of one fact, free to drift.

**Events** — this table is exhaustive in both directions; `scripts/test-update-in-app.js` §4 drives
the real route and compares the events it emitted against this table, and this table against them.

| Event | Payload |
|---|---|
| `progress` | `{type, phase, receivedBytes, totalBytes, percent}` — `phase` is one of `resolving`, `downloading`, `verifying`, `staging`, `installing`. `percent` is **derived from the two byte counts** when both are present, and is **`null`** when the total is unknown (no `content-length`) — never `0`, which would render as a bar stuck at the far left, i.e. indistinguishable from a hang. |
| `staged` | `{type, version, prerelease, warning}` — downloaded, verified and staged. **Nothing has been replaced.** Carries **no token, no path and no digest**: the client has no use for any of them and each is a handle it should not hold. `warning` is `string\|null` on the wire — a sentence when the app is not running from `/Applications`, otherwise `null`. See the note below. |
| `error` | `{type, reason, error, hint}` — `error` is the engine's own `message` when there is one. `reason` is a short slug **for branching and for logs only**; the Settings UI deliberately does not render it, because an internal identifier shown to a person is the v3.31.0 defect this release undoes. |

**There is no `done` event, deliberately.** "Staged" is not "done": the bundle is sitting beside the
running app and the swap has not happened. Calling it `done` would collapse two different facts into
one word.

> **`warning` carries the not-in-Applications case, and its sentence is the engine's own.** When the
> running app is somewhere other than `/Applications` — still in `~/Downloads`, or App-Translocated —
> `staged.warning` carries a sentence saying so. It is written by `updateWarning()` in
> `desktop/lib/update-plan.js`, the same shape as `updateFailure()`, and the route relays it verbatim
> rather than composing its own: one fact, one sentence, one place.
>
> **It did not always work, and the reason is worth keeping.** Until v3.34.0 the engine returned an
> object where the route accepted only a string, so `warning` was unconditionally `null`. Neither
> suite saw it — one fed the route a string, the other asserted the object, and nothing drove the
> seam between them. The fix went into the ENGINE rather than the route, and that choice matters:
> the object's `message` was `classifyLaunchOrigin`'s sentence, written for the MCP shim, which
> talks about the Claude Desktop launcher. Relaying it would have replaced `null` with something
> false in front of someone updating an app. The two features share a *reason*; each says its own
> consequence.

**No raw exception text ever reaches the wire.** A `{ok:false, message}` is the engine's own
user-facing sentence and is relayed. A **rejection** is different: `reasonFromError()` reads
`err.reason` and never `err.message`, because a rejection can be an ordinary `TypeError` whose
message carries an absolute path. An unnamed rejection is reported as `reason: "unknown"` with a
generic-but-actionable sentence, never as the raw text.

**A result that is not `{ok:true}` is a failure.** Checked for `ok === true`, not for truthiness: an
engine resolving `undefined`, `{}` or `{version}` is a contract violation, and reporting a staged
update that does not exist would send the user to a swap of nothing.

**What is verified is INTEGRITY, not Apple's blessing.** The engine checks sha256 against the
`digest` GitHub publishes for the asset, plus byte length, the staged bundle's version, and
`codesign --verify`. Authenticity rests on that digest and on TLS to GitHub. Nothing in the UI claims
Apple vouched for the build.

**The route's own failure table holds two entries**, not 34: `no-updater` and `nothing-staged` — the
refusals the engine never reached. Everything else is the engine's. The mapper is **total**: an
unrecognised slug is echoed back and still produces a usable sentence.

**Closing the connection does NOT cancel the download**, and this is the opposite position from
[`POST /api/config/openrouter/qualify`](#post-apiconfigopenrouterqualify), which treats a hang-up as
the cancel. There the run costs money per call and produces nothing until it finishes; here the
bytes are already paid for and the user asked for them. The stream is a **view** of the job, not the
job — navigating away or reloading the page leaves it running, and
[`GET /api/config/update-progress`](#get-apiconfigupdate-progress) is how a client finds it again.
The consequence is stated rather than hidden: **there is no cancel.**

**Refusals** — all plain JSON, all sent **before any SSE header**, so the status code is still
meaningful and a refusal can never arrive inside a stream the client has already accepted.

| Status | Body | When |
|---|---|---|
| `409` | `conflictResponse('update the app')` + `reason: "write-in-flight"` | a wiki write is in flight |
| `409` | `conflictResponse('update the app')` + `reason: "already-running"` | an update is already in progress |
| `501` | `{error, hint, reason: "no-updater", refused: "updater_unavailable", releasesPageUrl}` | **no updater engine is attached** — this is every build whose shell registered no `prepareUpdate` hook, and every git checkout is unaffected because it never reaches this arm. The hint points at the release page: v3.31.0's behaviour, kept as the way out. |

While the stream is open the update flag is set (`beginUpdate()`), so `POST /api/ingest` and the
batch queue refuse with a clear `409` rather than starting work against a process about to be
replaced. It is cleared on every exit path.

---

## GET /api/config/update-progress

What the in-app updater is doing. **Read-only, in-memory, no lock, no filesystem, no network.**
Deliberately **not** guarded — a `409` here would fire precisely when a write is in progress, which
is exactly the moment someone is asking whether their update is still going. No body.

```json
{
  "ok": true,
  "updaterAttached": true,
  "job": {
    "state": "downloading-or-staged-etc",
    "phase": "downloading",
    "receivedBytes": 61000000,
    "totalBytes": 143165576,
    "percent": 42.6,
    "version": "3.33.0",
    "prerelease": false,
    "warning": null,
    "startedAt": 1756600000000,
    "reason": null,
    "error": null,
    "hint": null
  }
}
```

`job` is **`null`** when nothing has run — an absence, not an empty object. `state` is one of
`running`, `staged`, `applying`, `failed`. The shape is an explicit allow-list, never a spread — and
**the opaque token `prepareUpdate` returned is not in it.** Do not add it: its absence is what keeps
a handle on the staged bundle out of reach of a page.

`updaterAttached` is not decoration: it is the only way the Settings UI can know whether to offer a
button that installs or the link that opens the download page. Without it the app would have to show
a button, POST, and learn from a `501` that this build has no engine — advertising an action it
cannot perform. It reports a boolean and never the hook itself, and it is derived live, because a
shell may register after the server has started.

The job is **process-local and never persisted.** A staged bundle that survived a restart would be
a claim this route cannot verify.

---

## POST /api/config/update/apply

Swap the staged bundle in and relaunch. No body.

**Why this is a second request.** The download takes minutes; an ingest started *during* it would be
truncated by a relaunch authorised before it began. `hasActiveWrites()` is therefore re-checked
**here**, against the state that exists at the moment of the swap — the same reasoning
`POST /api/config/pick-folder` records for re-checking after its 60-second dialog. It is also why
the engine contract splits staging from swapping at all.

**Why it does not respond first.** `POST /api/restart` can answer before acting, because respawning
a Node process cannot really fail in a way the user needs told about. Replacing an application
bundle can — a read-only volume, a translocated copy, a revoked permission. So the hook is
**awaited**. On success it does not return: the process is gone and the client's `fetch` rejects,
which the restart poller already treats as normal. On failure there **is** a response, and the old
app is still running.

**Success response** `200 OK` — only reached if the shell chose not to end the process.

```json
{ "ok": true, "relaunching": true, "version": "3.33.0" }
```

| Status | Body | When |
|---|---|---|
| `501` | `capabilityRefusal('updateStyle', …)` with a hint naming **Check for updates** | a git checkout, which finishes an update through `POST /api/restart` and always has |
| `409` | `conflictResponse('restart to finish the update')` | a wiki write is in flight — `guardConcurrent` on the registration *and* a re-check inside the handler |
| `412` | `{error, reason: "nothing-staged"}` | there is no staged update. **`412` and not `409`**: every `409` in this app means *somebody else is using this, try later*, and waiting will never make this one true. It carries no `conflict` field, so it cannot be mistaken for a queue to wait in. |
| `501` | `{error, hint, reason: "no-updater", refused: "updater_unavailable"}` | no `installUpdate` hook is attached |
| `500` | `{error, hint, reason, releasesPageUrl}` | the swap failed. The job goes back to **`staged`**, not `failed` — the verified bundle is still on disk, so *downloaded, not yet installed* is the true state and the finish button is still the right offer. |

---


## Static files

The server serves the web UI from `src/public/` via `express.static(..., { index: false })`, plus
a small number of explicit routes in `src/server.js`.

| Path | Description |
|------|-------------|
| `GET /` | Single-page app (`src/public/next/index.html`) — served by the catch-all, not the static mount, because `index: false` stops `express.static` from answering `/` itself |
| `GET /next`, `GET /next/` | Same shell as `/`, kept as an alias |
| `GET /old`, `GET /old/` | 302-redirects to `/` (v3.41.0) — the pre-redesign shell that used to live here (`index.html`, `app.js`, `styles.css`, `markdown.js`) was deleted |
| `GET /next/app.js` | Frontend JavaScript (the shell) |
| `GET /next/shell.css`, `GET /next/tokens/*`, `GET /next/views/*.css` | Stylesheets |
| `GET /*` | Falls back to `src/public/next/index.html` for client-side routing |

---

## Notes

- The server binds to `127.0.0.1` (loopback) only (v3.0.1-beta.20+), so endpoints are not reachable from the LAN. A cross-origin guard rejects mutating requests (POST/PUT/DELETE/PATCH) carrying a non-loopback `Origin` header (CSRF defense); requests with no `Origin` (curl, scripts) and all GETs pass through. Additionally (v3.0.2+), a Host-header guard rejects any request whose `Host` is not a loopback form (`localhost:PORT` / `127.0.0.1:PORT` / `[::1]:PORT`) with 403 — this closes DNS-rebinding read access, where a rebound hostname made same-origin GETs readable by an attacker page. There is no per-request authentication — it remains a single-user local app.
- The ingest endpoint blocks until the configured LLM provider (Gemini by default; whichever provider the user made active in Settings) returns a response. For large PDFs (50k+ words) this may take 60+ seconds. The 50MB file size limit is a rough guard — what actually matters is the text length extracted from the file (capped at 80,000 characters sent to the model).
- `POST /api/query` (above) is a simple, single-shot Q&A endpoint — separate from the Chat tab's `POST /api/chat/:domain` — and it still sends up to 90,000 characters of concatenated wiki content to the LLM in one call, in arbitrary file order (`src/brain/query.js`). On a wiki bigger than ~90 KB of raw page content, later pages are silently left out of that request. **The Curator's own web UI never calls this endpoint** — there is no reference to it anywhere in `src/public/`, so the only way to reach it is a direct HTTP call to the loopback server (curl, a script, another tool). The Chat tab does **not** have this limitation: since v3.0.1-beta.11 it uses query-driven page selection (score pages by relevance to the question, load up to ~60 KB of full content plus a ~12 KB slug catalogue — see [docs/ingestion-pipeline.md §10b](ingestion-pipeline.md#10b-the-chat-read-side-v301-beta11-refined-in-v301-beta13)), so it scales to much larger wikis. If you're calling `/api/query` directly against a large wiki (150+ pages), prefer `/api/chat/:domain` instead, or expect its answers to reflect only whatever page content the alphabetical/readdir order happened to include.
- **Known limitation — `POST /api/ingest-queue` and a filename containing a raw double-quote character.** The multipart parser (upstream of the batch-ingest queue's own code, in `busboy`) mis-parses a `Content-Disposition` header whose filename contains an unescaped `"`: the request still returns `200`/`ok: true`, but that one file is silently absent from `items` — no `rejected` entry, no warning of any kind. A NUL byte in a filename fails the parse outright instead, and is reported as a plain `400`. Neither is reachable from a browser — the WHATWG form-serialisation spec escapes `"` to `%22` before the request is ever built, and NUL is not a legal filename byte on any mainstream filesystem — but a hand-built multipart request from a script or another tool can trigger the quote case silently. If you are integrating against this endpoint programmatically, avoid unescaped `"` in filenames sent this way.
- **Known limitation — a domain missing `wiki/log.md` fails a completed ingest at the very last step.** This affects both `POST /api/ingest` and `POST /api/ingest-queue` identically (both funnel through the same `appendLog` in `src/brain/files.js`, which has no existence check on `log.md`, unlike the equivalent `readIndex` two lines below it). If it's missing, the ingest still runs to completion — pages are written to disk, real AI spend has happened — and only the final logging step throws `ENOENT`, which surfaces as a `failed` item with a cryptic error. Not reachable through any documented path (`createDomain()` always writes `log.md`, and [docs/domains.md](domains.md) tells manual-setup users to create it too), so it takes a hand-built domain folder to hit. Recovery: the pages are correct and unaffected — create an empty `wiki/log.md` and re-ingest the same source (safe; see the idempotency notes above).
