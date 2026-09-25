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
  "lastIngestDate": "2026-04-08",
  "lastIngestKind": "ingest",
  "lastIngestTitle": "The Energy and Water Footprint of Generative AI"
}
```

The three `lastIngest*` fields all describe the **same** entry — the newest
`## [YYYY-MM-DD] <kind> | <title>` heading in that domain's `wiki/log.md` — and
they are read once, together, from one cached parse, so they cannot disagree
with each other.

| Field | Meaning |
|---|---|
| `lastIngestDate` | `YYYY-MM-DD`, or `null` if nothing has been written yet. DAY resolution only: the heading carries no time of day, and `log.md`'s mtime is rewritten by Personal Sync, so there is no truthful clock finer than this. |
| `lastIngestKind` | `"ingest"`, `"compile"` or `null`. `appendLog` is called by conversation **compile** as well as by ingest, so "the last write" is not always an ingest. A kind the server does not recognise is reported as `null` rather than passed through — a client turns this into a user-facing verb, and inventing one for an unknown word would be a fabrication. |
| `lastIngestTitle` | The entry's title, or `null` when the heading carried none. Sanitised before it reaches the wire: control characters, `\|`, `<` and `>` are stripped and the string is capped at 120 characters with a trailing `…`. It originates in a file an LLM helped write, so treat it as text and escape it again at render. |

All three are `null` together when the domain has no log entry. A `null` means
**not known** — render it as such, never as an empty string, and never guess a
verb from the date merely existing.

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

## GET /api/domains/:domain/delete-preview

**New in v3.73.0.** What a delete of this domain would take, read fresh — the Delete confirm calls it when it opens so every figure it quotes is the one on disk at that moment. Not polled, and deliberately not folded into `/stats`: the raw-source walk and the project scan are paid once per confirm.

**Success response** `200 OK`

```json
{
  "slug": "projects",
  "displayName": "Projects",
  "readonly": false,
  "pageCount": 412,
  "conversationCount": 23,
  "rawSources": 58,
  "projects": 6,
  "trashDir": "/path/to/user-data/.curator-trash",
  "syncConfigured": true
}
```

`rawSources` counts the files under `raw/` recursively (dot-files skipped) — the one part of a domain GitHub Sync never carries. `projects` is the working-state store's own project total (`listProjects`). A figure that could not be read is `null`, never `0`. `404` for an unknown domain.

---

## DELETE /api/domains/:domain

Delete a domain and everything in it (wiki pages, projects' working state, conversations, raw sources) — **with a typed confirmation, and recoverably** (both since v3.73.0).

**Request body** `Content-Type: application/json` — **required**

```json
{ "confirm": "health-and-wellness" }
```

`confirm` must equal the domain's **slug** (its folder name) exactly — case-sensitive, untrimmed, a string. Not the display name: the slug is the folder that is removed, it is unique where display names need not be, and it carries no case/whitespace/Unicode ambiguity. The confirmation is enforced **at the route** (and again in `deleteDomain()` itself), not only in the view: a confirmation that lives only in a view is a confirmation any other client skips. A request without it changes nothing on disk.

**Recoverable.** The folder is **moved**, never erased, to `<user data>/.curator-trash/domains/<slug>--<UTC stamp>/` (e.g. `health-and-wellness--2026-09-25T14-03-22Z`; a second delete in the same second gets `-2`). The trash lives outside the domains folder, so Personal Sync never sees it and `GET /api/domains` never lists it. Nothing empties it automatically. There is no Restore endpoint in this release — **to restore, move the folder back into the domains folder and rename it to the slug** (if that slug is taken meanwhile, rename the live one first, or restore under another name and use Rename). If the domains folder is on another volume, the move is a copy followed by removal of the original, only once the copy completed.

**Concurrency:** refuses with `409` (`conflict: "write_in_progress"`) while this domain has an active write in this process (per-domain `isDomainActive`), and with `409` (`conflict: "file_lock"`) while another process — the MCP — holds the domain's file lock. The lock taken for the move does not travel into the trash.

**Example (curl)**

```bash
curl -X DELETE http://localhost:3333/api/domains/health-and-wellness \
  -H 'Content-Type: application/json' -d '{"confirm":"health-and-wellness"}'
```

**Success response** `200 OK`

```json
{
  "deleted": true,
  "trashPath": "/path/to/user-data/.curator-trash/domains/health-and-wellness--2026-09-25T14-03-22Z",
  "syncWarning": true
}
```

`syncWarning` is `true` when sync is configured — the deletion still propagates to GitHub on the next Sync, and from there to your other computers. The trash copy exists only on the computer where the delete happened.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | `{ ok: false, reason: "confirm_required" }` — `confirm` missing, not a string, or not exactly the slug |
| `400` | Invalid slug (path traversal attempt) |
| `404` | Domain not found |
| `409` | This domain has an active write (`write_in_progress`), or another process holds its file lock (`file_lock`) |
| `500` | Filesystem error — the original folder is left where it was |

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

**SSE error frame — `MODEL_GONE` (pre-spend refusal)**

```
data: {"type":"error","code":"MODEL_GONE","message":"OpenRouter no longer offers `minimax/minimax-m3:free` — pick another model in Settings."}
```

Emitted **before the first paid call** when the provider no longer lists the model
this install is pinned to. `code` is **additive** beside the `message` every
existing client already renders, and it exists so a client can offer *"refresh the
model list"* rather than a generic retry.

The frame arrives on the **SSE stream**, not as a JSON body, because by this point
the stream is already open and a streaming client would never read a body. No
`done` frame follows, so nothing renders a success panel.

Only a **positive** absence verdict refuses. An unchecked provider answers
`null` and the ingest proceeds normally — *"we could not check"* may never block
work. The batch queue applies the same gate per item, marking it `failed` with
`errorCode: "MODEL_GONE"` and charging nothing; the error is deliberately **not**
classified as transient, so it fails one item instead of pausing the job for ever.

See [docs/model-lifecycle.md § When a provider removes a model](model-lifecycle.md#when-a-provider-removes-a-model)
and [`POST /api/config/models/check`](#post-apiconfigmodelscheck).

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
        },
        "spent": { "provider": "gemini", "model": "gemini-2.5-flash-lite", "usd": 0.021, "estimated": true }
      }
    }
  ]
}
```

`result.spent` (**new in v3.72.1**, additive) is the same `spent` shape described under "AI runs
— `runsOn` and `spent`" above, carried through so a panel restored after a reload or a second tab
shows the identical run line a client watching live would have seen — not just the raw
`tokenUsage`. `null` when the run finished without a `spent` event.

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

## AI runs — `runsOn` and `spent` (v3.67.0)

Every AI action in the app shares one estimate shape and one actual-cost shape, built by
`src/brain/ai-run.js` (see [architecture.md](architecture.md)) and rendered by the shared frontend
run line. Both ride on top of whichever route they belong to — they are not a route of their own.

**`runsOn`** — the estimate, present on the resting state of an AI action and on every 200 body of
its estimate route, including refusals (where it carries only the model and key state):

```
{
  job, jobLabel,               // which AI_JOBS entry this is
  needsKey,                    // true when no provider key is saved — the ONLY field present then
  provider, providerLabel, model, modelLabel,
  inputTokens,                 // a point estimate, when the route can give one
  inputTokensLow, inputTokensHigh, outputTokensLow, outputTokensHigh,
  usdLow, usdHigh,             // a free model: usdLow = usdHigh = 0
  priceKnown,                  // false → no usd fields at all; costNote: 'price-not-published'
  free, costNote, medianLatencyMs,
  perCallLatencyMs, plannedCalls   // batch ingest only, v3.72.1 — see below
}
```

A figure the app does not have is **omitted, never sent as 0** — the caller must not mistake "we
don't know" for "this costs nothing."

On the batch-ingest estimate's `runsOn` specifically, `medianLatencyMs` is the **whole planned
run's** wait — the per-call median (measured for one outline call) times `estimate.calls`, the
batch's own planned call count — not one call's latency mistaken for the run's. `perCallLatencyMs`
carries the un-multiplied per-call figure and `plannedCalls` the count it was scaled by, so a
client can show both. When there is no call count to scale by, `medianLatencyMs` is dropped
entirely rather than shown as if it covered the whole run.

**`spent`** — carried on every AI run's completion event, once it actually finished:

```
{
  provider, providerLabel, model, modelLabel,   // the model that ACTUALLY billed
  inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens, calls,
  usd,          // null when the billing model's price is not published
  estimated,    // true when usd is derived rather than provider-reported
  fallbackFrom  // set when a fallback-chain walk billed a different model than requested
}
```

`model`/`provider` on `spent` can differ from `runsOn`'s when a fallback chain walked to a
different model mid-run — `fallbackFrom` names what was originally requested.

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
  "spendUnknown": false,
  "consecutiveFailureLimit": 3,
  "order": "largest-first",
  "estimate": { "usdLow": 2.1, "usdHigh": 4.3, "basis": "...", "calls": 6 },
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
      "tokenUsage": { "provider": "gemini", "model": "gemini-2.5-flash-lite", "inputTokens": 180000, "outputTokens": 9000 },
      "ranOn": { "provider": "gemini", "providerLabel": "Gemini", "model": "gemini-2.5-flash-lite", "modelLabel": "Gemini 2.5 Flash Lite", "fallbackFrom": null }
    }
  ]
}
```

`itemCount` is the true total number of items in the batch; `items` itself is capped (500 entries — never reached by a normal batch, which tops out at 100 files) and `itemsTruncated` is `true` if the cap trimmed anything. `spentUsd` is tracked to 6 decimal places (not 4), so a long run of very small per-file charges can't silently round down to zero.

**New in v3.72.1, all additive:**

- `spendUnknown` (job-level, boolean) — `true` once any billed item ran on a model with
  **no published price to charge at all** (not a free model — one The Curator simply
  can't price). When `true`, `spentUsd` is a floor, not the true total; the view reads
  "at least $X (some files ran on a model with no published price)" rather than
  understating the real spend as a dollar figure.
- `consecutiveFailureLimit` — the same number the `consecutive_failures` pause reason
  above compares against (currently 3), so a client can build the pause message instead
  of hardcoding it.
- `estimate.calls` — the total planned AI-call count across the batch (sum of each
  file's `totalCalls`), present alongside `usdLow`/`usdHigh` so a free or unpriced-model
  estimate can still show "N in / M out · K AI calls" when there is no dollar figure to
  show.
- `item.ranOn` — the model that **actually** billed this item, once it is `done` or
  `failed` (`null` before then). Differs from the job's configured model when a
  fallback chain walked to a different model mid-run, in which case `fallbackFrom`
  names what was originally requested.

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
    "basis": "Estimated for Gemini \"gemini-2.5-flash-lite\" against the \"ai-tech\" domain, currently 40 entities, 90 concepts, 12 KB index. Cost depends heavily on how large this wiki ALREADY is, not just on the files being ingested: every AI call re-sends the existing page list so the model can link to (not duplicate) what is already there. For THIS batch, that existing content works out to about 3.1x the input tokens the same files would cost against an empty domain. ... Both ends are estimates rather than limits — actual spend can land above the range, and on a measured real batch it did.",
    "basisLede": "Sized against this wiki's real page list — about 3.1x an empty domain. Actual spend can land above the range."
  },
  "domainContext": { "pageCount": 140, "indexBytes": 12288 },
  "warnings": []
}
```

`usdLow` assumes prompt caching applies (multi-call documents only); `usdHigh` assumes it does not. Both are `null` (with a `warnings[]` entry) if no AI provider is configured, or if the configured model has no published price on file — `files`/token counts are still returned in that case. **`usdHigh` is an estimate, not a ceiling** — it is the no-caching end of a range, and on a real measured live batch (see [docs/ingestion-pipeline.md §10g.8](ingestion-pipeline.md#10g8--how-the-cost-estimate-is-derived)) actual spend came in at 103.1% of `usdHigh`. Do not treat it as a spending guarantee.

`basisLede` is the **short** form of `basis` — at most 20 visible words, carrying the per-batch multiple (when one was computed) and, always, the sentence that actual spend can land above the range. The two describe the same estimate and always quote the same multiple: `basis` is the full account, `basisLede` is the one line that has to stay on screen. The Ingest confirm gate renders `basisLede` as the cost readout's provenance and puts `basis` behind an ⓘ; a client that shows only one of the two should show `basisLede`, never `basis` alone truncated. When the domain is small enough that the multiple would be noise (under 1.05x), both strings drop it rather than quoting "about 1.0x". Both fields also appear on a job's `estimate` object (`GET /api/ingest-queue/:id`).

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

Returns the one job that is not in a terminal state (`pending`/`running`/`paused`), if any — `null` otherwise. Cheap; safe to poll on app load, or when the ingest panel mounts, to resume showing an in-progress batch.

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
    "basis": "Estimated for Gemini \"gemini-2.5-flash-lite\" compiling a 4-turn conversation … THE OUTPUT HALF CANNOT BE KNOWN IN ADVANCE … If gemini-2.5-flash-lite is unavailable, The Curator may fall back to gemini-2.5-flash, priced $0.30 / $2.50 per 1M input / output tokens.",
    "fallback": {
      "provider": "gemini", "model": "gemini-2.5-flash", "free": false,
      "priceKnown": true, "inPerM": 0.3, "outPerM": 2.5, "rungs": 1
    }
  },
  "warnings": []
}
```

**`estimate.fallback` names the next rung the build model would escalate to
if it is unavailable when the compile actually runs** (v3.72.0) — the same
chain `llm.js`'s `fallbackRungsFor` would walk, not a guess. It is `null`
when there is no further rung to name. A **free** head model never names a
paid rung as its fallback — the chain only ever escalates FORWARD in time,
and a free model's own rung is the end of the line for this field. `inPerM`
and `outPerM` are `null` (never `0`) when the named rung is itself free or
has no published price, so a `0` never sits where a real price belongs.
`basis` gains one added sentence naming the rung and its `$in` / `$out`
prices; the client-facing copy for the confirm dialog is built in the
Chat view, not read verbatim from `basis`.

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
| Destination is a read-only Shared Brain mirror | `Domain "<d>" is a read-only Shared Brain mirror. Compile into your personal opted-in domain instead, then push contributions from the Shared Brain view.` |

The mirror case is reported as a `refusal` rather than an HTTP error because
this endpoint is a question rather than an attempt; the POST answers `400` for
it, with a **byte-identical** message. A malformed conversation file with no
`messages` array does not throw — `messages` normalises to `[]` and it falls
through to the "too short" refusal.

**The range is a range, not a price.**

**Characters are exact; input tokens are estimated (±15%), not counted.**
`inputTokens*` is the real prompt measured character by character — that
measurement is exact — divided by the shared `CHARS_PER_TOKEN` (3.53, the same
constant the batch-ingest estimator uses) and widened by a band measured
across seven real compiles. The division is where the estimate enters: no
provider tokenizer is run, so the token figure itself carries the same ±15%
band ingest's own estimator does, not the certainty of the character count it
is built from.
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
| `project` | string | No | **New in v3.64.0.** A project in this domain whose standing brief, latest handoff, journal and read-first canonical documents are added to the answer's context, within a **separate 40 KB budget** (`PROJECT_CONTEXT_BUDGET_CHARS`). An unusable name is `400 invalid_project`, a reserved name `400 reserved_project`, and a project this domain does not have `400 project_not_found` — all refused **before the response stream opens**, never a silently wiki-only answer. |
| `scope` | string | No | **New in v3.64.0.** The work-stream within that project. Ignored without `project`, and passed to the store **verbatim** — the store is the only thing that knows what `latest` means, and resolving it twice is what was deleted rather than fixed twice. |

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
  "citationTitles": {
    "concepts/rag.md": "Retrieval-Augmented Generation",
    "summaries/rag-survey.md": "A Survey of Retrieval-Augmented Generation"
  },
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
- `citationTitles` (v3.46.0+) is `{ "<citation path>": "<page title>" }` — the
  display name of each cited page, so a chip can read *Retrieval-Augmented
  Generation* instead of `concepts/rag.md`. Titles come from the page's own
  frontmatter `title:` or its first `# Heading`, via the same `deriveTitle` that
  `GET /api/wiki/:domain/page` uses, resolved from the wiki `sendMessage` has
  already read — no extra file access. **It is a partial map, deliberately:** a
  cited path with no page behind it (a slug the model invented, a page since
  deleted) is **omitted** rather than guessed at, and the client humanises the
  basename for it — the label every chip had before this field existed. The
  whole field is `null` when nothing resolved; it is never `{}`. It is also
  **persisted on the assistant message**, appended after `usage`, so a reopened
  thread labels the same chip the same way; assistant messages written before
  v3.46.0 do not carry it and are not migrated. Since v3.76.0 a comma-joined
  capture of page paths is titled per path.
- `citedPages` (v3.76.0+) is the list of cited strings that ARE pages of this
  wiki — each `[source: …]` capture split by `citationParts()` (a comma splits
  it only when every part looks like a path: it names a folder or ends in
  `.md`; *"CLAUDE.md rows v3.69.0, v3.68.1"* stays one mention), and a part
  kept only when it is the exact path of a page in the wiki the turn read. The
  app's **Sources · N pages** counts only these; every other capture is shown
  apart as an *unverified mention*, never numbered or opened. `[]` is a record
  ("nothing cited was a page"). It is persisted on the assistant message,
  appended last. A message written before v3.76.0 has no key; for those,
  `GET /api/chat/:domain/:id` adds **`citedPagesNow`** on the response — its
  citations checked against the wiki on disk at read time (an existing file in
  `entities/`, `concepts/` or `summaries/`, contained by `resolveInsideWiki`;
  existence checks only) — and never writes it back into the file. Only when a
  server sends neither does the renderer fall back to shape: titled by
  `citationTitles`, or a `.md` name with no whitespace.
- `projectContext` (v3.64.0) is what the pinned project actually contributed to
  **that turn**, or `null` when no project was pinned:
  `{project, domain, scope, chars, briefPresent, briefAuthority, handoffPresent,
  journalEntries, documents, budgetChars, extraStoreCalls, notes}`. `notes` names
  everything that was omitted — a document dropped at the budget, a refused
  request, a journal slice — so the surface above can say what was left out
  rather than implying nothing was. It rides the same `done` frame on the
  streaming path.
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
- `project` (v3.72.0) is the pinned project's name, or `null` meaning "no
  project on this turn". It is recorded on the assistant message going
  forward only — a message written before v3.72.0 has no `project` key at
  all, and nothing back-fills one.
- `priced` (v3.72.0) is the answer's own price, fixed at answer time, so a
  later catalogue change can never rewrite what an old answer is shown to
  have cost. It is **omitted** when nothing true can be recorded (an
  unpriced model, no usage payload, or the zero-usage sentinel) — never a
  `0` standing in for "unknown". Two shapes:
  - a priced model: `{"free": false, "inPerM": 0.1, "outPerM": 0.4, "costUsd": 0.000123, "at": "2026-09-25T10:00:00.000Z"}`;
  - a free model: `{"free": true, "costUsd": 0, "at": "…"}` — no rates are
    stored for a free model, so a `0` never sits where a price belongs.
  - `costUsd` is computed by `ai-run.js`'s `spentFromUsage`, which includes
    the served provider's own cache rates.
- `updatedAt` (v3.72.0, ISO string) is also written to the conversation file
  on every **completed** turn — a cancelled or failed turn leaves the file
  byte-identical. It is returned in the same JSON object and the same `done`
  frame as the fields above, and is what the conversation list (below) sorts
  and ages by.

**Success response (streaming path)** `200 OK`, `Content-Type:
text/event-stream`

Bare `data:` frames, **no `event:` lines**, discriminated by a `type` key:

```
data: {"type":"reasoning","text":"…"}

data: {"type":"content","text":"…"}

data: {"type":"done","conversationId":"…","isNew":false,"title":"…","answer":"…","citations":[…],"citationTitles":{…},"responseStyle":"balanced","persisted":true,"provider":null,"model":"…","usage":{…}}

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
    { "id": "…uuid…", "title": "…", "createdAt": "2026-08-30T10:00:00.000Z", "messageCount": 6,
      "domain": "articles", "updatedAt": "2026-09-25T10:00:00.000Z", "lastProject": "curator" }
  ]
}
```

`messageCount` is read before any filtering decision, so the number shown is the
conversation's real length rather than the count of matching messages.

**Row fields added in v3.72.0** (present on this route and on `GET /api/chat`
below; a row is otherwise unchanged):

- `domain` is read from the **storage path** — the folder the file was found
  in — never from the conversation file's own `domain` key, which a synced
  or hand-edited file could disagree with.
- `updatedAt` is present only when it was recorded and parses as a valid
  date. A file written before v3.72.0 has none, and the client is expected
  to render "started … ago" from `createdAt` for that row rather than
  treat it as recently used.
- `lastProject` is read from the **last assistant message only**: a string
  means that project was pinned when it answered; `null` means "recorded:
  no project"; the key being **absent** means the message predates v3.72.0
  and nothing is shown. A name over 64 characters, or a non-string value,
  is dropped the same way.
- **Sort order**: newest first by `updatedAt ?? createdAt`, ties broken by
  `id`.

---

### GET /api/chat

**New in v3.72.0.** Lists conversations across **every** domain in one call —
what the Chat view's single, all-domains conversation list reads.

| Query param | Type | Description |
|---|---|---|
| `q` | string | Same search as `GET /api/chat/:domain`'s `q` — title and body, case-insensitive. An array value (repeated `?q=`) is treated as no filter. |
| `limit` | integer | Default `200`, clamped to a maximum of `500`. A malformed value (non-integer, negative) is refused with `400`, never silently clamped. |
| `offset` | integer | Default `0`. Same refusal rule as `limit`. |

**Response** `200 OK`

```json
{
  "conversations": [ /* rows shaped as above, one per conversation, across domains */ ],
  "total": 143,
  "offset": 0,
  "limit": 200,
  "unreadable": []
}
```

- Covers every domain **except** those flagged `readonly: true` (Shared
  Brain mirrors) — the same predicate `isDomainReadonly` uses elsewhere, so
  this route can never disagree with the rest of the app about which
  domains are mirrors.
- A row whose `id` is not a UUID shape is dropped before counting.
  `total` is the true count of openable rows after filtering — not the
  length of the page returned, and not a raw file count.
- `unreadable` names the domains whose `conversations/` folder could not be
  read, so the view can say so rather than silently showing them as empty.
- The per-domain route above keeps its own, older envelope
  (`{conversations}`, no `total`/`offset`/`limit`/`unreadable`) — this is an
  **additional** route, not a replacement.

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

**Query parameter**

| Parameter | Description |
|-----------|-------------|
| `include` | Comma-separated. The recognised value is `memory` (v3.50.0), which since v3.64.0 also carries the projects' **foundations** in the same inventory. Anything else is ignored. |

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

### `?include=memory` — the domain's memory pages (v3.50.0; foundations since v3.64.0)

A domain's `state/` tree is markdown too: each project's **standing brief** and each work-stream's **handoff** (`current.md`). With `?include=memory` the response gains four additive fields:

```json
{
  "domain": "ai-tech",
  "entries": [ … ],
  "count": 3, "total": 3, "truncated": false,

  "memory": [
    { "kind": "brief",   "project": "ai-tech", "isDefaultProject": true,  "scope": null,
      "machine": null,   "path": "state/project.md",
      "title": "ai-tech · Standing brief", "savedAt": "2026-09-08T11:02:00.000Z", "bytes": 4180 },
    { "kind": "handoff", "project": "lumina", "isDefaultProject": false, "scope": "design",
      "machine": "studio-9f2a1c",           "path": "state/lumina/design/studio-9f2a1c/current.md",
      "title": "lumina · design · studio-9f2a1c", "savedAt": "2026-09-09T18:41:00.000Z", "bytes": 9022 },
    { "kind": "foundation", "project": "lumina", "isDefaultProject": false, "scope": null,
      "machine": null,   "slug": "architecture.md", "role": "architecture",
      "path": "state/lumina/foundations/architecture.md",
      "title": "lumina · Architecture", "savedAt": "2026-09-19T08:12:00.000Z", "bytes": 14203,
      "freshness": "fresh", "skeleton": false }
  ],
  "memoryCount": 2,
  "memoryTotal": 2,
  "memoryTruncated": false
}
```

**It is a separate array, never folded into `entries`, and `count`/`total` keep meaning wiki pages.** The Domains view renders a fifth **Memory** facet from it beside Entities / Concepts / Summaries, and the "All" facet keeps counting wiki pages only — a facet that disagreed with the PAGES figure directly above it would be a self-contradicting readout.

**Since v3.64.0 the same array also carries each project's FOUNDATIONS** — its canonical documents
— beside its standing brief and its work-stream handoffs. A foundation row carries
the nine fields a brief or a handoff carries plus four of its own — `kind: "foundation"`, its
`slug`, its `role`, and the `freshness` and `skeleton` readings the store computed. **The wire
shape is an allow-list, not a spread**: the store's tier-0 rows also carry `sha256`, `authoredBy`,
`commit` and `source`, and none of it belongs in a page listing. `memoryCount` / `memoryTotal` count them; the wiki `count` and `total` are **unchanged**,
so the figure above the page list cannot contradict it — the same rule the `memory` array has
followed since v3.50.0.

**A foundation's `path` is not openable through `GET /:domain/page`.** It is read through
`GET /api/memory/:domain/:project/foundations/:slug`, addressed **by slug**, not by path. That is
the one row in this array whose `path` is a location rather than a handle, and a caller that treats
every row alike will 404 on it.

**One row per `(scope, machine)` pair.** The `<machine>` segment is load-bearing in the working-state store (two machines saving under one work-stream are two files, and Personal Sync keeps them apart precisely so no hunk ever conflicts), so collapsing them would hide a file that is on disk.

**The domain's own project lives at the state root**, so its brief is `state/project.md` and its handoffs are `state/<scope>/<machine>/current.md` — never `state/<domain>/…`. Named projects sit one level deeper.

**No file bodies, ever**, and the wire shape is an allow-list of exactly the fields above — nine for a brief or a handoff, thirteen for a foundation. The store's rows also carry journal-derived facts — the headline an agent wrote, the harness and model that wrote it — and none of them reach this listing. To read a memory page's content, use `GET /api/memory/:domain/:project` (add `?scope=&machine=` for a handoff); `GET /api/wiki/:domain/page` **cannot** open one and answers `400` — it gates on the three canonical wiki folders, and `state/` is `wiki/`'s sibling.

**Why it is opt-in.** The wiki half is one `readdir` per canonical folder. The memory half walks the project list and reads one journal tail per `(scope, machine)` pair — bounded, but not free. Without the flag the response is byte-for-byte what it always was, so nothing that does not want memory pages pays for them. `memory` is capped at 2,000 entries with `memoryTruncated` saying so; a domain with no `state/` folder gets `"memory": []` and `memoryCount: 0`, which is an answer rather than an error.

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
  ],
  "dismissedRecords": 6
}
```

`dismissedRecords` is **new in v3.72.1**: the number of dismissal records on disk for this
domain, including semantic-duplicate-pair Skips — not just the issues currently hidden by
one. It is additive and omitted (rather than sent as `0`) if the dismissal file can't be
read.

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
{
  "costCeilingTokens": 200000,
  "semanticDupeMaxPairs": 500,
  "defaults": { "costCeilingTokens": 200000, "semanticDupeMaxPairs": 500 },
  "defaultRunsOn": { "provider": "gemini", "model": "gemini-2.5-flash-lite", "estimatedUsd": 0.03 }
}
```

The **default** cost ceiling is **200,000 tokens** (raised from 50,000 in v3.72.1) — enough
for a full scan at the default 500-pair cap, so the two defaults no longer contradict each
other. `defaults` and `defaultRunsOn` are **new in v3.72.1** and additive:

- `defaults` — the built-in defaults (`DEFAULT_AI_HEALTH`), regardless of what the user has
  saved.
- `defaultRunsOn` — what a scan at the default ceiling is priced to cost, on the model that
  builds the wiki (`null` if pricing can't be determined). Settings shows this next to the
  "Cost ceiling per scan" field so the hint's dollar figure is never a stale literal.

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
  "costCeilingTokens": 200000,
  "maxPairs": 500
}
```

Set `candidatePairs` is the top N after ranking; `totalCandidates` is the unbounded count (what `candidatePairs` was capped from). `truncated: true` means the pre-filter found more pairs than your cap allowed. `maxPairs` (**new in v3.72.1**, additive) echoes the user's own candidate-pair cap, so the confirm dialog can name it without a second lookup. If `estimatedTokens` would exceed `costCeilingTokens`, the scan is refused before it starts (see `POST /api/health/:domain/semantic-dupes/scan` below) — nothing is spent.

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
  "mergedPreviewCap": 4000,
  "affectedFiles": [
    { "path": "concepts/cryptographic-algorithms.md", "linkCount": 1 },
    { "path": "summaries/beyond-encryption-block-labs-occ-tech.md", "linkCount": 1 }
  ],
  "affectedCount": 3,
  "totalLinksRewritten": 3
}
```

`affectedFiles` is capped at 50 entries; `affectedCount` is the full count. `mergedPreview` is
truncated to the first `mergedPreviewCap` characters (**field is new in v3.72.1**;
`mergedPreview` itself is unchanged — 4,000 characters, unrounded by multibyte content) when
`mergedLength` is greater than `mergedPreview.length`.

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

Cheap enough to sit on the 60-second badge path: a handful of local `git` calls
(no subprocess beyond git, no network).

```json
{
  "configured": true,
  "changesCount": 33,
  "uncommittedCount": 30,
  "unpushedCommits": 1,
  "lastSync": "2026-08-31T12:02:11.000Z",
  "repoUrl": "https://github.com/you/your-brain.git",
  "splitSyncRepo": false,
  "adoptedSyncRepo": false
}
```

Unconfigured installs get `{"configured": false}`; a failure gets
`{"configured": true, "error": "…"}`. `repoUrl` always has the token stripped.

- `changesCount` — files whose current version has not reached GitHub: the union of
  uncommitted files and the files of any commits made here that `origin/main` (as last
  fetched — this path never fetches) does not have. This is the number the rail badge
  and the Sync view show, and it is the same figure `POST /setup`'s push reports.
- `uncommittedCount` — of `changesCount`, the files that are uncommitted (not yet in a
  local commit at all).
- `unpushedCommits` — commits made here that `origin/main` does not have; `null` when
  there is no `origin/main` yet (never synced).
- `lastSync` — **v3.72.1.** An ISO timestamp, or `null`. This is the time this install
  last **recorded** a successful exchange with GitHub — a push that reached it, a pull,
  or a connect that completed — not the newest commit's date. It used to be read from
  `git log`'s commit date, which was wrong after a fast-forward pull (that is the OTHER
  machine's commit time) or a failed push (a commit that never reached GitHub). `null`
  means no sync has been recorded yet; an install connected before v3.72.1 shows `null`
  until its next sync and is never back-filled from a commit date.

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

Mounted at `/api/sharedbrain/`. All routes except `/feature-flag` and `/enable-flag` require `sharedBrainEnabled: true` in `.curator-config.json`; otherwise they return **404** with `error: "Shared Brain is not enabled..."`. The flag is `false` by default for v2.x-installed users; flipping it requires an explicit POST to `/enable-flag` or clicking the "Enable Shared Brain (beta)" button in the **Shared Brain** view, reached since v3.64.0 from the SHARED BRAIN section of any domain's page rather than from a rail entry of its own (through v3.40.0 it lived in Settings in the pre-redesign `/old` frontend, where it had moved from the Sync tab in v3.0.2; that frontend was deleted in v3.41.0).

Endpoints marked **SSE** stream `text/event-stream` progress events (`{type, message, ...meta}`) ending in `{type: "done", result: {...}}` or `{type: "error", message}`.

### Feature flag

| Path | Description |
|---|---|
| `GET /api/sharedbrain/feature-flag` | `{enabled: boolean}`. Unauthenticated, ungated. |
| `POST /api/sharedbrain/enable-flag` | Flips the flag to `true`. Idempotent. |

### Connection management

| Path | Description |
|---|---|
| `GET /api/sharedbrain/list` | `{connections: [...]}` with tokens masked. v3.43.0+: each connection also carries an explicit boolean `has_admin_token` — true exactly for the connections `/admin-token/rotate` will not refuse with `no_admin_token`. It exists because `admin_token` is MASKED in this listing, and a client deciding whether to offer the admin affordances must not have to reason about how a credential happens to be redacted. v3.0.4+: each connection carries an additive `pending_pages` count — pages changed since `last_push_at` (∪ `pending_retry`, minus `permanent_skip`) across its contributing domains; cheap mtime scan only. Read-only connections always report 0. `pending_pages` and `pending_retry_pages` are each `null` (not `0`) when they could not be counted (an unreadable watermark or a domain scan that threw) — a client should read that as "unknown", never as "nothing pending". `pending_retry_pages` (**new in v3.72.1**, additive) is how many of `pending_pages` are automatic retries of a page that failed a previous push and still exists locally. It is read by the Shared Brain panel; the shell's Sync badge deliberately does NOT fold it in (`src/public/next/app.js`), and the navbar that once carried it went with the old shell in v3.41.0. `last_contribution_at` (**new in v3.72.1**) is set only once a push has actually sent a contribution — a push that finds nothing to send never moves it; a connection whose only recorded time predates v3.72.1 shows that older watermark instead, labelled as such by the client. |
| `POST /api/sharedbrain/save` | Body: `{connection: {...}}`. Validated server-side. UUIDs assigned if missing. Rejects with 400 if `github_pat` looks like a masked display value (defense against round-trip overwrites). v3.0.4+: optional boolean `read_only` field (defaults `false`) — set by the wizard when the PAT verdict is valid-but-no-write-access; read-only connections may have zero `local_domains`. v3.0.5+: optional `admin_token` (single-line string 16-200 chars or null; masked-ellipsis values refused) and `data_handling_terms` (`contributor_retains` \| `organisational`, persisted for invite re-display). |
| `DELETE /api/sharedbrain/:id` | Removes the connection from this machine. The remote shared repo is unaffected. |
| `POST /api/sharedbrain/:id/unskip` | v3.0.4+. Body: `{pages?: string[]}` — clears the listed pages from `permanent_skip` (omit `pages` to clear all) and resets their `pending_retry` strike counters, so they're re-attempted on the next push. Paths not actually skipped are ignored. Returns `{ok, unskipped, permanent_skip}`. Local config change only; not SSE. |
| `GET /api/sharedbrain/:id/members` | v3.0.5+. Member directory: everyone who has ever contributed to this brain. Returns `{members: [{fellow_id, short_id, submissions, pages, page_updates, first_contributed_at, last_contributed_at, display_name}], self_fellow_id}`. Identity is storage-path-derived (same trust rule as synthesis); display names are informational. Reads every contribution payload — fine at cohort scale. Powers the revoke UI's fellow picker. `pages` (**meaning fixed in v3.72.1**) is the count of **distinct** page paths this fellow has ever sent a delta for — it used to sum every delta, over-counting a page touched by several submissions; that raw sum is now the separate `page_updates` field. `last_contributed_at` is the contributor's own app's clock, not a server- or GitHub-observed time — shown as "as reported". |
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
| `GET /api/mcp/config` *(two additive fields, v3.64.0)* | `bridge_processes: {checked, reason, running, stale: [{pid, startedAt, ageMs}], codeChangedAt, serverPath}` and `bridge_stale_remedy`. A **read-only** reading, taken from `ps` over a fixed argv with no shell: it lists processes running *this install's own* `mcp/server.js` and calls one **stale** when it started before the code on disk last changed. An MCP client keeps its bridge alive until the client itself is restarted, so a bridge launched before an update carries on serving the tools it was launched with — measured on one machine as two days and five updates, offering 22 tools while the files on disk offered 24. **`checked: false` means the reading was not taken** (not macOS, `ps` unavailable, an error) and carries `reason`; it must never be rendered as "no stale bridge". `bridge_stale_remedy` names the act and the actor — restart the app that launched it, usually Claude Desktop — and deliberately does not name The Curator, because restarting The Curator is exactly what does not help. |
| `GET /api/mcp/config` *(three additive fields, v3.30.0)* | `mcp_launch_style` (`'node-script'` in a source install, `'launcher-script'` in a packaged app), `launcher_path` and `launcher_exists`. They let the app tell whether the live Claude Desktop entry is its own flavour — a source install and a packaged app write structurally different entries, not merely different paths. |
| `POST /api/mcp/reveal-config` | Opens `claude_desktop_config.json` in Finder (or its parent directory when the file does not exist yet). macOS only; uses `execFile('open', …)` with no shell. Returns `{ok, revealed}`, or **500** `{ok: false, error}` if `open` fails — the one endpoint here that does use a non-200. |
| `GET /api/mcp/usage` *(v3.60.0)* | Backs **Settings → MCP bridge → The tool map**. Reads the local, content-free call log at `getMcpUsageLogPath()` (`<user-data>/.mcp-usage.jsonl`, never under `domains/`) and returns per-tool aggregates plus two session-level readings. Cheap by construction — the log is capped at ~1 MB before it rotates, so a full parse on every call stays inexpensive; the route additionally caches its result by the log file's mtime + size. See the response shape below. |

| `POST /api/mcp/exercise` *(v3.61.0)* | Backs the **Test all N tools** button on the tool map. Runs `exerciseAllTools()` (`src/brain/mcp-exercise.js`): seeds a throwaway fixture domain under an OS temp dir, starts `mcp/server.js` through the SAME launch-line builder `POST /self-test` uses, calls every tool in `mcp/tools/catalogue.js` once in a fixed order with deterministic arguments, and removes the fixture in `finally`. The child is pinned to the fixture (`--domains-path` for reads, `CURATOR_TEST_DOMAINS_DIR` for writes), so the user's `domains/` is neither read nor written; provider and GitHub credentials are stripped from its environment. Lines land in the **real** `getMcpUsageLogPath()` with `via: "self-test"`. No tool is driven on an arm that makes an LLM or network call, so a run costs nothing and needs no key. **At most one run at a time** — a concurrent request is refused `409 {ok:false, reason:"busy"}` — and a 60 s route wall clock over the driver's own 50 s answers `504 {reason:"timeout"}`. Guarded by the global cross-origin middleware like every mutating route. |

### `GET /api/mcp/usage` response

```json
{
  "present": true,
  "logStartedAt": "2026-08-30T09:12:04.000Z",
  "logBytes": 184320,
  "tools": [
    {
      "name": "get_project_context",
      "group": "read",
      "mutates": false,
      "purpose": "One-call session bootstrap: brief, handoff, foundations",
      "lastUsedAt": "2026-09-18T07:41:02.000Z",
      "lastOk": true,
      "count7d": 12,
      "countTotal": 41,
      "refusedTotal": 0,
      "lastVia": null,
      "selfTestTotal": 0,
      "count7dAgent": 11
    },
    {
      "name": "save_working_state",
      "group": "write",
      "mutates": true,
      "purpose": "Write this session's handoff so the next one can resume",
      "lastUsedAt": "2026-09-18T08:03:47.000Z",
      "lastOk": true,
      "count7d": 9,
      "countTotal": 30,
      "refusedTotal": 1,
      "lastVia": "self-test",
      "selfTestTotal": 1
    }
  ],
  "sessions": {
    "lastBootstrapAt": "2026-09-18T07:41:02.000Z",
    "lastSaveAt": "2026-09-18T08:03:47.000Z"
  }
}
```

`present: false` (with `logStartedAt: null`, `logBytes: 0`, every `tools[].lastUsedAt` etc. `null`
and `sessions` both fields `null`) is not an error — it is the honest answer for an install whose
bridge has never been called, and it is what the empty-state copy in the block reads off. `tools`
always lists **every** tool the bridge exposes, in the same order `tools/list` returns them
(`mcp/tools/catalogue.js` is the one place `name`/`group`/`mutates`/`purpose` are defined, and its
`name`s are asserted to match `mcp/tools/index.js`'s `tools` array in order) — a tool with no
calls at all still appears, with every count field `0` and `lastUsedAt: null`, which is what the
app's "not used since this log began" tile reads. `sessions.lastBootstrapAt` is the newest
timestamp across every logged `get_project_context` **or** `get_working_state` call;
`sessions.lastSaveAt` is the newest logged `save_working_state` call — neither is a promise that
the two calls belonged to the same session, only the most recent instance of each.

**`count7dAgent` (v3.66.0).** Calls in the same 7-day window as `count7d`, with the app's own "Test
all tools" lines (`via: "self-test"`) excluded — the figure a "busiest tools this week" comparison
draws its bars from. `count7d` itself is unchanged, and still includes self-test calls.

**`?include=projects` (v3.66.0; window facts and per-tool breakdown added v3.74.0).** Add the query
parameter to also receive `byProject`, `byProjectWindow` and `savePulse`, built by `acrossProjects()`
in `src/routes/mcp.js`:

```json
{
  "byProject": [
    { "domain": "projects", "project": "curator", "projectLabel": "Curator",
      "inStore": true, "sessions": 6, "sessionsRead": 4, "sessionsSaved": 4,
      "lastSessionAt": "2026-09-24T11:03:00.000Z", "domainMismatch": false, "sharedName": false }
  ],
  "byProjectWindow": {
    "since": "2026-08-26T09:00:00.000Z",
    "windowDays": 30,
    "logStartsAt": "2026-08-15T04:12:00.000Z",
    "windowStartsAt": "2026-08-26T09:00:00.000Z",
    "windowDaysCovered": 30,
    "windowCovered": true,
    "unit": "mcp-bridge-process",
    "logPresent": true,
    "logFiles": 1,
    "busiestSaved": 6,
    "totals": { "sessions": 22, "sessionsSaved": 15 },
    "legacyLines": 0,
    "selfTestLines": 24,
    "storeProjects": 9,
    "storeTruncated": false,
    "error": null
  },
  "savePulse": {
    "events": 41,
    "windowSeconds": 604800,
    "lowerBound": false,
    "coversWholeWindow": true,
    "oldestEventAt": "2026-09-18T02:00:00.000Z",
    "byTool": [
      { "id": "claude-code", "label": "Claude Code", "events": 30, "lastSeenAt": "2026-09-24T11:03:00.000Z" },
      { "id": "claude-desktop", "label": "Claude Desktop", "events": 9, "lastSeenAt": "2026-09-22T08:40:00.000Z" }
    ],
    "byToolFloor": false,
    "byToolNote": null,
    "eventsWithoutTool": 2
  }
}
```

`byProject[]` is one row per project — every project the **store** knows about, joined against the
**union of every usage log on this machine** (a checkout and the installed app can each keep their
own — see [working-state.md](working-state.md)), plus a trailing row for any project the log names
that the store does not hold (deleted, renamed, or living on another machine's store, `inStore:
false`). `sessions`/`sessionsRead`/`sessionsSaved`/`lastSessionAt` are counted over the window named
in `byProjectWindow` (30 days by default). `sessionsSaved` is `null` when there is no usage log at
all, and a measured `0` when there is a log and genuinely no session — the same "no log" vs "a
measured zero" distinction the menubar widget and the Context capture meter both make.
`domainMismatch` and `sharedName` flag a project name the log cannot uniquely attribute (the log is
keyed by project name, so two store projects that share a name share one reading).

**`byProjectWindow`** carries the reading's own facts. `since`/`windowDays` are the window **asked**
for (30 days); `logStartsAt`/`windowStartsAt`/`windowDaysCovered`/`windowCovered` are the window the
log **actually** covers — the same `captureWindowFacts()` derivation the per-project capture route
and the menubar widget use (see [`GET …/capture`](#get-apimemorydomainprojectcapture) above for what
each of those four means), so all three never disagree about how far back the log goes. `unit` is
always the literal `"mcp-bridge-process"`, naming what a counted "session" is. `busiestSaved` is the
denominator every project row's depth bar is measured against — `null` when no log was read, since a
denominator of an untaken reading is not `0`. `totals` is `{sessions, sessionsSaved}` summed across
every project in the window, or `null` without a log. `storeProjects`/`storeTruncated` report how many
store projects were walked and whether that walk was capped; `error` carries a short message when the
usage log itself could not be read, `null` otherwise.

**`savePulse`** is the widget pulse strip's own facts — saves in the last 7 days (`windowSeconds`
`604800`), `null` when nothing could be read. `lowerBound` is `true` when any work-stream's journal
was read only from its tail, meaning `events` (and every `byTool[].events`) is a floor, not an exact
count. `coversWholeWindow` is `true` only when something was saved at or before the window opened —
i.e. the store demonstrably existed for the whole 7 days. `oldestEventAt` (v3.72.1) is where the
record begins, so a store younger than the window can say so instead of reading as a whole observed
week. **`byTool[]`** (v3.74.0) is the same per-tool pulse the menubar widget's "Saves by tool" strip
draws and the per-project capture route's `savesByTool.tools[]` uses — newest-seen first, each entry
`{id, label, events, lastSeenAt}` exactly as documented under
[`GET …/capture`](#get-apimemorydomainprojectcapture) above. `byToolFloor` is `lowerBound` restated
for the per-tool breakdown specifically, and `byToolNote` is the data layer's own sentence for why,
when it applies (`null` otherwise). `eventsWithoutTool` counts saves in the window that named no tool
at all. The parameter is opt-in because this half walks the whole working-state store, which the
plain per-tool aggregation above does not need to do.

**`lastVia` and `selfTestTotal` (v3.61.0).** `lastVia` is `"self-test"` when the tool's **newest**
logged call was written by `POST /api/mcp/exercise`, and `null` otherwise. Null means *an MCP
client* and nothing more specific — the log cannot tell which client called, so no other value
exists. `selfTestTotal` counts how many of that tool's logged calls carry the marker.
`sessions.lastBootstrapAt` / `lastSaveAt` **ignore marked lines entirely**: a self-test is not a
session start and wrote nobody's handoff, so a run against a fresh log leaves both `null` while
every `tools[]` row has a real `lastUsedAt`. The app paints `lastVia` (as the word `self-test`
before a tile's age) and does **not** paint `selfTestTotal`, which is carried for consumers.

### `POST /api/mcp/exercise` response *(v3.61.0)*

```json
{
  "ok": true,
  "ranAt": "2026-09-18T14:53:10.400Z",
  "durationMs": 344,
  "results": [
    { "tool": "list_domains", "ok": true, "refused": false, "ms": 2, "note": null },
    { "tool": "scan_semantic_duplicates", "ok": false, "refused": true, "ms": 1,
      "note": "Estimate failed: No LLM API key found." }
  ],
  "covered": ["list_domains", "get_index", "…"],
  "missing": [],
  "error": null
}
```

`results` carries exactly one row per catalogue tool, in the order the driver called them, and
exactly the five fields shown. `ok` on a ROW means the tool answered; `refused: true` means it
answered with the `{ok:false, error}` envelope, which is a legitimate answer — the tool ran its
guard and wrote its log line (the ten older read tools answer a bad argument with a plain string
instead, so a string-shaped refusal is recorded as `ok`, the same named limit the usage log has).
`note` is a short, bounded reason on anything that did not plainly answer, and `null` otherwise.

`missing` is the driver's honesty field: catalogue tools it has no case for. It must be empty,
and `scripts/test-mcp-all-tools.js` pins it — a 25th tool reds that suite until a case exists. The
envelope-level `ok` is `true` only when there was no fatal, `missing` is empty, and every row
answered. `error` is a sentence when the bridge could not be started at all (the same outcome
`POST /self-test` gives on a machine with no usable Node on `PATH`), `null` otherwise.

The response deliberately carries **no** launch line and no transport diagnostics: the child's
stdout/stderr are the child's, and `scripts/test-mcp-all-tools.js` reads those from the driver's
return value rather than from the route.

### `POST /api/mcp/self-test` response

```json
{
  "ok": true,
  "server_info": { "name": "my-curator", "version": "…" },
  "tool_count": 24,
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

## Working state — Project context (`/api/memory`)

Working state (`domains/<domain>/state/`, v3.17.0; **projects inside a domain since v3.48.0**) is
the store behind the `/next` shell's **Project context** view (called *Agent memory* through
v3.61.1 — the view's visible name changed in v3.62.0, **the path did not**) and the Domains view's
**Projects** sub-section: a standing brief per project, a per-`(work-stream, machine)` handoff, and an
append-only journal of saves. Served from `src/routes/memory.js` over
`src/brain/working-state.js`.

**A DOMAIN is where knowledge lives (the wiki). A PROJECT is a thing you build.** A project lives
in exactly one domain; a domain can host many. Until v3.48.0 this route used the word "project"
for what was actually a domain — `GET /api/memory` returned one row per domain and called it a
project — which is why the deprecated alias below exists and why index rows now carry **both** a
`domain` and a `project`.

### The route table, and why its order is a correctness property

**The order below is the router's actual registration order** — read it top to bottom rather than
by HTTP verb or resource grouping, because that order is what decides which literal wins a
collision (see below the table).

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/memory` | Every project in every domain, newest first |
| `GET` | `/api/memory/repo-scan?root=<abs>` | **New in v3.61.0**, candidates gain `modifiedAt` **in v3.61.1**. Read-only candidate scan of a checkout — `scanRepoForFoundations` over HTTP; see below. **`?source=remote` (v3.65.0)** scans a GitHub repository instead, with no checkout on this machine. **`?all=1` (v3.68.0)** lists **every** `.md`/`.txt` file found — capped at 200 rows, 4 levels deep, sorted by path — instead of the four-canonical-role heuristic; the two doors' checklist panel always asks for `all=1`, so what you see to tick is everything, not a guess at what matters |
| `GET` | `/api/memory/:domain/projects` | One domain's projects — **unless `?as=project`** (v3.62.0), which makes this handler decline so the detail route below can answer about a project literally called `projects` |
| `POST` | `/api/memory/:domain/projects` | Create a project — `{project, brief?}` |
| `PATCH` | `/api/memory/:domain/projects/:project` | Rename and/or replace the brief — `{rename?, brief?}` |
| `DELETE` | `/api/memory/:domain/projects/:project` | Delete a project — `{confirm}` |
| `GET` | `/api/memory/:domain/:project/scopes/:scope/delete-preview` | **New in v3.75.0.** What deleting one work-stream would take — every machine's saved copy, read fresh. Read-only |
| `DELETE` | `/api/memory/:domain/:project/scopes/:scope` | **New in v3.75.0.** Delete one work-stream (every machine's saved copy) to the trash — `{confirm}` |
| `PATCH` | `/api/memory/:domain/:project/knowledge/domains` | **New in v3.65.0.** Which wikis this project's knowledge lives in — `{knowledgeDomains}`, a list or `null` |
| `GET` | `/api/memory/:domain/:project/foundations/:slug` | One canonical document, verbatim (v3.59.0; gains `?raw=1` in v3.61.0) |
| `PUT` | `/api/memory/:domain/:project/foundations/:slug` | **New in v3.61.0.** Create or replace one kept (written/copied) document, whole — refused **per document** on a mirrored slug (`ownership-mismatch`, naming the mirror's source) **since v3.69.0**, rather than per project; a new slug always succeeds. Gains an optional, **tri-state** `readFirst` in v3.62.0 |
| `PATCH` | `/api/memory/:domain/:project/foundations/:slug` | **New in v3.62.0.** The reading plan and nothing else — `{readFirst}` — on **any** document, kept or mirrored |
| `DELETE` | `/api/memory/:domain/:project/foundations/:slug` | **New in v3.61.0**, works on any document **since v3.61.1**. Remove one document, behind a name confirmation — on a mirror this stops mirroring it, the source file untouched; **since v3.69.0** also reports `group`/`groupRemoved` (below) |
| `POST` | `/api/memory/:domain/:project/foundations/init` | **New in v3.61.0.** Sets a project's **first** foundations manifest, optionally seeding or mirroring in the same call — this governs only a project's initial write, not a lasting restriction (**since v3.69.0** more sources can be added afterward through `add-local`/`add-remote`/`source`). **v3.65.0** adds a `remote`/`tokenSource` arm — a mirror born from GitHub with no checkout on this machine — and makes the body strict. **v3.68.0** adds `rechooseEmpty: true` — lets the Add from GitHub door re-choose the source of a project whose manifest already lists 0 documents, but only when the folder (if any) holds no unlisted document either |
| `POST` | `/api/memory/:domain/:project/foundations/add-local` | **New in v3.68.0**, `mode` added **v3.69.0**. *"Add from this computer"* — `{root, files, mode?: 'copy'\|'mirror'}`. `addFoundationsFromFolder` copies (`mode: 'copy'`) or mirrors (`mode: 'mirror'`) the ticked `.md`/`.txt` files, appended to what is already there; `mode` defaults to `mirror` when the folder is already inside an existing folder source, else `copy`. Refused `too-many-sources` past `MAX_SOURCES_PER_PROJECT = 8` |
| `POST` | `/api/memory/:domain/:project/foundations/add-remote` | **New in v3.69.0.** *"Add from GitHub"* — `{remote, ref?, tokenSource?, files}`. `addFoundationsFromRemote` mirrors the ticked files, joining an existing GitHub source with the same owner/repo and ref, or opening a new one. Response below |
| `POST` | `/api/memory/:domain/:project/foundations/refresh` | Re-mirror from a checkout (v3.59.0; gains a `files` body in v3.61.0) — **or, in v3.63.0, from the GitHub repository itself** when the checkout is not on this machine. **v3.69.0**: `{group}` refreshes one source, `{}` refreshes every source under one lock (a failing one named and left untouched); body and response below |
| `POST` | `/api/memory/:domain/:project/foundations/source` | **New in v3.65.1**, semantics changed **v3.69.0**. Adds or points a GitHub source: joins an existing GitHub source with the same owner/repo and ref, or opens a new one — it no longer clears a project's only folder source, since a project can hold both. Takes `group` once a project has 2+ sources |
| `GET` | `/api/memory/:domain/:project/capture` | **New in v3.63.0.** The honesty meter, shown on screen as **Agent sessions** since v3.70.0 (the route and the store's `captureFacts` keep the old name) — how many bridge sessions ran for this project, how many read, how many saved |
| `GET` | `/api/memory/:domain/:project` | One project's brief plus its state |
| `GET` | `/api/memory/:project` | **Deprecated** alias for that domain's default project |

A domain slug and a project slug are drawn from the same alphabet, so `/api/memory/lumina` is
genuinely ambiguous on its face. Express matches by **segment count**, which is what makes the
disambiguation structural rather than a heuristic. Two literals collide with a legal project slug:
`projects` itself, which would shadow `GET /:domain/:project` for a project of that name, and — new
in v3.61.0 — `repo-scan`, which has the same one-segment-past-`/api/memory/` shape as the deprecated
`GET /:project` alias. **Both are refused as a project name by this router's own
`RESERVED_PROJECT_NAMES`** (`projects`, `repo-scan`, `project.md`, `journal.jsonl`, `foundations`)
— a set this file, not the store, maintains, precisely because `projects` and `repo-scan` are
collisions this ROUTER's URL shape creates and the store has no reason to know about. **The store
keeps its own, narrower set** (`project.md`, `journal.jsonl`, `current.md`, `foundations`, and —
new in v3.65.0 — `project.json`: the names of its own on-disk entries), so a project directory literally named `repo-scan` created out
of band (by an agent writing state directly, say) is refused by the router's create/rename routes
but not by the store's `initFoundations` — it would still be listed and still readable by every MCP
tool. Since v3.62.0 its detail URL is reachable too: `repo-scan` has always had a two-segment detail
URL that the one-segment alias never shadowed, and `projects` is now reachable through `?as=project`
(below). What reserving the name still buys is that this app never *mints* such a project.

#### `?as=project` — one path, two resources, and the caller names which (v3.62.0)

The second segment `projects` is genuinely ambiguous, and reserving a name could never fix the one
case that mattered. A domain's **own** project is not minted — it exists because the domain does,
and its slug **is the domain name** — so a domain called `projects` has a project called `projects`,
and `/api/memory/projects/projects` is one URL naming two live resources: the Domains view needs the
list, the Project-context view needs the detail. v3.57.0 recorded it and v3.61.0 recorded it again,
each time imprecisely as *"a project literally named after its domain is unreachable on the
2-segment read"*. **That was wider than the truth.** `/alpha/alpha` has always resolved, because the
literal in the route is `projects`, not `alpha`; the unreachable set was exactly *any project named
`projects`* — which, for the domain's own project, means the domain called `projects`, the
maintainer's own.

| Request | Answers |
|---|---|
| `GET /articles/projects` | the list — **unchanged** |
| `GET /projects/projects` | the list — **unchanged** |
| `GET /projects/projects?as=project` | the **detail read** of the project called `projects` |
| `GET /articles/projects?as=project` | the detail read of a project called `projects` in `articles`; **404 `project_not_found`** when there is none |
| `GET /articles/projects?as=list` | the list, said explicitly |
| `GET /articles/projects?as=projct` | **400 `invalid_as`** |

`as=project` makes the list handler call `next()` and Express continues to
`GET /:domain/:project`, which re-parses its own params. **The default is byte-identical to what
shipped**, on every domain, so no existing caller can now be answered differently; the only way to
reach the other resource is to ask for it by name.

**An unrecognised value is a 400 rather than an ignored field**, deliberately unlike `?open=newest`,
which this router *does* ignore when it does not recognise it. The difference is what a mistake
costs: `open` picks how much of one resource to send, while `as` picks **which resource** — so
silently serving the list to somebody who typed `as=projct` is the exact failure this parameter
exists to remove. The two accepted values are exported as `AS_LIST` / `AS_PROJECT`
(`src/routes/memory.js:1386`) so a suite pins the literal rather than re-typing it.

A new path (`…/project/…`) was refused instead: it would be a second public shape for a read that
already has one, on a router already carrying one deprecated alias it is trying to retire. `as` is
additive — no existing URL changes meaning.

### Which tiers the app may write

**Tiers 2 and 3 — the per-`(work-stream, machine)` `current.md` and its `journal.jsonl` — have
exactly one writer: an agent, through the MCP's `save_working_state`.** That single-writer
property is what makes the per-machine layout safe: two machines never write the same file, so
Personal Sync's `git pull --no-rebase -X theirs` never has a conflicting hunk to resolve away
silently. Nothing in this router writes them, and nothing here can — the store functions it calls
do not reach them. A handoff is worth something because an *agent* observed it, and a human edit
arriving under the last agent's harness/model provenance line would take that away.

**Tier 1 — `<project>/project.md`, the standing brief — is the human's, and always was.**
[working-state.md](working-state.md) has said since v3.17.0 that a human edits it by opening it in
Obsidian; editing it in the app is the same edit through a nicer door, stamped
`authoredBy.kind: 'human'`. So the write surface here is: create / rename / delete a project, and
replace a project's brief. Four operations, all tier 1.

**Tier 0's curator-owned documents joined the human's write surface in v3.61.0 — `init`, `PUT` and
`DELETE` under `…/foundations/`** — for exactly the same reason and under exactly the same stamp:
one ownership per project, enforced by the store before any write reaches disk (so an app edit is
*structurally* incapable of landing on a repo-owned mirror's *content*), and a write from here
always carries `authoredBy.kind: 'human'`, never an agent's harness and model. `PUT` still refuses
a mirror outright — editing its content would make two writers of one file, exactly the property
the ownership gate exists to protect.

**`DELETE` is the one asymmetry, since v3.61.1: it works on either ownership.** Removing a
manifest entry is not a claim about a document's content, it is the decision to stop mirroring or
keep it — a different thing from writing content, and the gate for it is the manifest existing at
all (`requireManifest`), not who owns it. `POST …/foundations/refresh` is the older exception and
stays one for the same reason: it is a **byte copy** driven by comparing sha256 against a file on a
named checkout, never a second author composing content, which is the distinction the read-only rule
everywhere else in this file protects — see
[working-state.md's human-edit-surface argument](working-state.md#the-human-edit-surface-a-second-reader-and-writer-and-why-it-is-still-one-writer-per-file)
for the full four-part statement of why none of this reopens a second writer.

**The one property this costs, stated rather than implied away:** `project.md` has no `<machine>`
segment, so it is the one file in the store where two machines *can* produce a conflicting hunk
under Personal Sync. That was already true before v3.48.0 (working-state.md § 2 carves it out);
a second, easier writer makes it easier to reach. Curator-owned foundations share the exact same
property, for the exact same reason (no `<machine>` segment either) — see
[sync.md](sync.md#foundations-and-the-no-machine-segment-bargain-again).

Consequences, all deliberate: the GET routes carry no `guardConcurrent` and register no write
(there is nothing to refuse), while a **rename or delete** — which moves or removes a directory —
is refused with `409` while that domain has a write in flight, using the same `isDomainActive`
predicate as `PUT /api/domains/:domain`. **Reads are allowed on read-only `shared-*` Shared Brain
mirrors**, exactly as `GET /api/wiki/:domain/page` is; every **write** on a mirror is refused with
`403`. The detail read echoes `readonly` so a caller can say so out loud — inside a mirror the
state can have been written by another *person* (see the THREAT MODEL block in
`working-state.js`).

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

"Which of my projects have context saved, and how fresh is it?" No parameters.

**One row per PROJECT, across every domain, newest first** (v3.48.0; it was one row per domain).

**A domain's own project is omitted when it has neither a standing brief nor a save.** That is the
store's decision, not this route's, and the route defers to it rather than keeping a second opinion:
one description of "which projects exist" is shared by this route, the Domains view's Projects list
and the menu-bar widget, and a row describing an empty tree is noise on a screen whose job is
"which project". A project someone *created* is always a row — `createProject` always writes a
`project.md`, so it always has a brief. Up to v3.47 this route emitted a row per domain
unconditionally; that changed in v3.48.0.

The cost is that an empty `projects` array is ambiguous — no domains, or domains with no working
state yet — so **`domainsScanned`** rides along and says how many domains were looked at. A view
that told a user with four domains they had none would send them to create a fifth.

Each row is an **allow-list**, not a spread of the store's object: a field the store grows next —
including anything a fellow's synced file put there — does not reach the wire until it is named
here. Absent facts come back as `null`/`0`/`[]` rather than `undefined`, so a caller can tell
"the store looked and there was nothing" from "this server does not have that field".

**Success response** `200 OK`

```json
{
  "ok": true,
  "projects": [
    {
      "domain": "second-brain",
      "project": "lumina",
      "isDefaultProject": false,
      "hasBrief": true,
      "briefBytes": 4120,
      "briefUpdatedAt": "2026-08-20T09:12:44.000Z",
      "briefWrittenAt": "2026-08-20T09:12:43.871Z",
      "briefAuthoredBy": { "kind": "human" },
      "layoutWarning": null,
      "scopeCount": 2,
      "distinctScopeCount": 2,
      "savedCopies": 3,
      "scopesTruncated": false,
      "unlistedEntries": 0,
      "unlistedReason": null,
      "lastWriteAt": "2026-08-27T18:03:11.000Z",
      "ageSeconds": 5421,
      "headline": "Docs pass — nine false claims corrected, tests green",
      "harness": "claude-code",
      "model": "claude-opus-5",
      "lastSaveKind": "complete",
      "newestScope": "main",
      "newestMachine": "alices-macbook-pro-9f3c1a20",
      "harnessId": "claude-code",
      "harnessLabel": "Claude Code",
      "tools": [
        {
          "id": "claude-code",
          "label": "Claude Code",
          "raw": "claude-code",
          "writtenAt": "2026-08-27T18:03:11.000Z",
          "writtenAgeSeconds": 5421,
          "lastWriteAt": "2026-08-27T18:03:11.000Z",
          "ageSeconds": 5421
        }
      ],
      "harnessShared": false,
      "harnessSharedScopes": [],
      "harnessScanned": 3
    }
  ],
  "total": 6,
  "truncated": false,
  "layoutWarning": null,
  "domainsScanned": 4
}
```

Elided from the sample for length, and on every row: `writtenAt` / `writtenAgeSeconds` (the
agent's own clock, `null` where the journal carries none — see below) and `lastSaveNotes`.

`harnessShared` / `harnessSharedScopes` / `harnessScanned` report **two different tools writing
into one `(scope, machine)` folder**, where each save overwrites the other's work. The store's
project row cannot see it — it reads one journal tail, the newest pair's, and this is a property
of a work-stream's whole journal — so this route pays for it with one work-stream index per
returned row. `harnessScanned` is the number of pairs that verdict actually opened, named
separately so a cap can never read as a census.

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
request instead of a round-trip to discover the scope and a second to read it. (`scope=latest` on
the detail route does the same job server-side.)

**`harnessId`/`harnessLabel`** (v3.74.0) sit beside `harness` — `harness` keeps the agent's own,
unnormalised spelling (whatever string it passed), while `harnessId`/`harnessLabel` are that same
speaker's tool run through `normaliseHarness()`, so `Claude Code` and `claude-code` collapse to one
id/label pair and `claude-desktop` stays a distinct tool from `claude-code`. Both are `null` when
the newest pair named no tool.

**`briefWrittenAt`** (v3.76.0) is the brief's **own** stamp — its provenance comment's `on=`, or
the structured door's `_Updated: <ISO>_` header line — and `null` for a brief typed by hand with
neither. `briefUpdatedAt` is unchanged: the **file's** mtime, which a hand edit, a `git pull` or a
restore all move. The Context view leads with `briefWrittenAt` and adds the file's time only when
the two differ by more than two minutes. The same fact is `brief.writtenAt` on the detail read
(`GET /api/memory/:domain/:project`), beside `brief.updatedAt`, and `briefWrittenAt` on the MCP's
`list_projects` rows.

**`tools[]`** (v3.74.0) is every NORMALISED tool that has saved into this project, newest first,
capped at 6 entries (`PROJECT_TOOLS_MAX`) — built by `toolsOf()` in `src/routes/memory.js` over the
same work-stream index `harnessShared`/`harnessScanned` already pay for, so it costs nothing extra.
A pair that named no tool is left out. **Since v3.76.0 it reads each pair's JOURNAL as well as its
current copy** (`listWorkingScopes(…, {withSaveTimes: true})` — the same tail, no extra read): a
handoff is one file per (scope, machine), so when a second tool saves into a pair the first tool's
copy is replaced, and a list built from current copies alone dropped that tool while it had saved
minutes earlier. Every journal save is offered with its own tool and its own `at`, so each tool's
entry carries its newest save anywhere in the project, and the Context sidebar's 24-hour Active
test reads those stamps. Each entry:

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | The normalised tool id (`normaliseHarness().id`) |
| `label` | string | The normalised display label |
| `raw` | string | The agent's own unnormalised spelling for this pair |
| `writtenAt` | string \| `null` | The agent's own declared save clock (ISO) |
| `writtenAgeSeconds` | number \| `null` | Age off that same clock |
| `lastWriteAt` | string \| `null` | The file's mtime clock (ISO), the fallback when `writtenAt` is absent |
| `ageSeconds` | number \| `null` | Age off the file's mtime clock |

Ordering picks the newest reading on a single clock per tool (the agent's stamp first, falling back
through `writtenAgeSeconds`, `lastWriteAt`, `ageSeconds` in that order) — never a mix of two tools
compared on two different clocks.

`lastWriteAt`, `ageSeconds` and `headline` are **`null` when nothing has ever been saved** — never
`0` and never an epoch date. A fact and its absence stay distinguishable.

`isDefaultProject` marks **the domain's own project**, whose slug *is* the domain name and whose
tree is the state root itself — `state/<scope>/<machine>/…`, with no project folder. That is where
it lives permanently, for a tree written today as much as for one written before v3.48.0: the
store's `projectPrefix` is a pure string comparison and no reader or writer probes the disk to
decide a layout, so there is no migration, no half-migrated window, and a legacy tree keeps working
with older app versions on other machines.

It is also **the one project that can be neither renamed nor deleted** — its directory holds every
named project too, so renaming it would move them all and deleting it would take them all. Both
refuse with `reason: "default-project"`, and the Domains view renders neither control on that row.

(The field was called `isLegacyDefault` on the route contract this shipped against. That name
asserted a migration that does not exist, and it was corrected before release — no shipped version
ever emitted it.)

`briefAuthoredBy` is `null` when the store cannot say who wrote the brief (every pre-v3.48.0
brief, which predates provenance entirely). It is **not** guessed as `owner`: not knowing and
knowing it is the owner's are two different facts.

Capped at `MAX_PROJECTS` (200) rows; `total` reports the real count and `truncated` says whether
the cap bit.

**Error responses**

| Status | Condition |
|--------|-----------|
| `500` | Domain listing or filesystem read error (`{ok: false, error}`) |

### GET /api/memory/:domain/projects

One domain's projects — the endpoint the Domains view's **Projects** sub-section renders from.
Rows are exactly the shape above, minus the redundant per-row `domain`.

**Success response** `200 OK`

```json
{
  "ok": true,
  "domain": "second-brain",
  "projects": [ "…as above…" ],
  "total": 3,
  "truncated": false,
  "unlistedEntries": 0,
  "layoutWarning": null,
  "readonly": false,
  "canWrite": true
}
```

**`canWrite` answers the question a view actually has** — *may I write here?* — in one field
rather than one the view would have to derive. Today it is `false` exactly when the domain is a
read-only Shared Brain mirror, whose write routes answer `403`; rendering a full set of controls
whose every button answers `403` is worse than rendering none. It is kept as its own field rather
than collapsed into `!readonly` at the view because it answers the view's question, and the two
stop being the same question the moment another refusal is added.

`total` is the **store's** count, taken before its own cap, so a truncated list still says how many
there are. `unlistedEntries` and `layoutWarning` describe what the store would not address in this
domain's `state/` tree, counted rather than silently skipped.

| Status | Condition |
|--------|-----------|
| `404` | Unknown domain (`{ok: false, reason: "unknown_domain"}`) |
| `500` | Filesystem read error |

### POST /api/memory/:domain/projects

Create a project. Body: `{ project, brief?, foundations? }`. Tier 1 only by default — it creates
the project's directory and, if a brief was supplied, its `project.md`. It never touches a
work-stream or a journal.

**Success response** `201 Created`

```json
{ "ok": true, "domain": "acme", "project": "lumina", "created": true,
  "markerLine": "acme/lumina",
  "foundations": { "…": "…the wire shape (`foundationsWire()`), or null…" },
  "refresh": { "…": "…the mirror step's own report (`refreshWire()`), or null…" },
  "foundationsError": null }
```

`markerLine` is what goes into a `.curator-project` file at the project's root folder so an agent
knows which project to resume — always present, even when `foundations` was never requested, and
composed by the store with a `"<domain>/<project>"` fallback so an older store can never make the
field absent. `foundations` is `null` unless the `foundations` body field was sent AND the tier-0
step succeeded; `refresh` is the mirror step's own report (only present when `foundations.files` was
non-empty on the `repo` arm), `null` otherwise; `foundationsError` is `{reason, message}` when the
tier-0 step was requested and failed — see below.

| Status | Condition |
|--------|-----------|
| `400` | `invalid_project` (fails the store's own `isSafeSegment`: lowercase letters, digits, `.` `_` `-`, up to 64 characters, no `..`), or `reserved_project`, or `brief_too_large` |
| `403` | `readonly` — a Shared Brain mirror |
| `404` | Unknown domain |
| `409` | The project already exists |

Every one of those refusals happens **before the store is called**. An omitted or empty `brief` is
sent as *absent*, not as an empty string — an empty string is a brief the user wrote nothing in.
The store then seeds `project.md` from a four-heading template that says it is not a schema, so a
new project is never invisible to its own store.

The write is stamped **`authoredBy.kind: "human"`** whether the brief was typed or seeded, which is
what the store's brief-authority reading looks for: a brief that reads as the owner's carries their
standing instructions, one an agent wrote reads as `commissioned`.

The store adds refusals of its own, forwarded with their `reason` intact and their prose on both
`message` (the store's key) and `error` (this router's, and the one the shell renders): a name that
is already a work-stream of the domain's own project, or the domain's own name, is
`reserved-project`; an existing name is `project-exists`; a write lock held by something else is
`locked` and answers `409`.

**New in v3.61.0: `foundations`** — `{ ownership, repoRoot?, files?, seed? }`, run **after** the
brief write succeeds. This is the start-a-project ownership choice ([user-guide.md](user-guide.md#start-a-project)),
folded into project creation as one gesture rather than a second request. **The project always
exists after this call, even when `foundations` fails** — a foundations-tier problem (an
unreachable checkout, say) is disclosed in `foundationsError: { reason, message }`, never a `5xx`
and never a rollback of the project that was just created; `foundations` is `null` in that case, and
both the project's brief and its existence are unaffected. When `foundations` is omitted entirely,
both response fields are `null` and nothing about tier 0 is touched — a caller that does not opt in
sees no new behaviour at all.

### GET /api/memory/repo-scan?root=`<abs>`

**New in v3.61.0.** Read-only. `scanRepoForFoundations(root)` over HTTP — proposes candidate
foundation documents from a checkout (or a plain folder; it does not need to be a git repository),
it never decides anything. Backs the **Find documents** picker on both the create form and an
existing project's Foundations block.

**Query parameters**

| Parameter | Description |
|-----------|-------------|
| `root` | Absolute path to the checkout or folder to scan. Resolved and validated **before** any directory is read — a relative path, or one that does not exist, is refused rather than resolved against the server's own working directory |
| `domain`, `project` | **New in v3.69.0, optional — both or neither** (`400 project_required` if only one is sent). When named, each candidate is annotated against that project's actual documents: `alreadyAdded`, `alreadyAs`, `landsAs` (below) |
| `mode` | **New in v3.69.0.** `copy` or `mirror` — required together with `domain`/`project` (`400 invalid_mode` otherwise); changes what "already added" and `landsAs` mean, since a copy and a mirror land differently |
| `all` | **v3.68.0.** `1` lists every `.md`/`.txt` file found (capped at 200, 4 levels deep, sorted by path) instead of the four-canonical-role heuristic; the checklist panel always sends it |

**Success response** `200 OK`

```json
{
  "ok": true,
  "root": "/Users/you/code/your-project",
  "candidates": [
    { "path": "docs/architecture.md", "bytes": 8120, "suggestedRole": "architecture",
      "suggestedSlug": "architecture.md", "tooLarge": false, "matchedBy": "docs-folder",
      "firstHeading": "Architecture", "modifiedAt": "2026-09-01T14:22:03.000Z" }
  ],
  "truncated": false,
  "cap": 200,
  "maxDepth": 4,
  "maxDocumentBytes": 524288
}
```

Candidates are found under three rules, unioned: **(a)** every `.md`/`.txt` under a `docs/` or
`doc/` folder, three levels deep; **(b)** every `.md`/`.txt` anywhere in the tree, four levels deep,
whose basename matches the same role words the suggestion heuristic uses; **(c)** every `.md`
inside a folder literally named `adr`, `adrs`, `decisions`, `architecture` or `rfcs`, four levels
deep. `.git`, `node_modules`, `vendor`, `dist`, `build`, `target` and dotfolders are skipped
throughout, symlinks are not followed **out of** the named root, and the list is capped at 200
entries (`truncated: true` beyond that) sorted by suggested-role rank then path. `path` is always
**relative to `root`**, forward-slash, never an absolute path a client could round-trip into
reading somewhere else. `firstHeading` is the file's first `# ` line (≤ 120 characters, read from
the first 4 KB only) so a picker can show a title beside a path; a file with no such line omits it
rather than inventing one. `tooLarge: true` marks a candidate over the 512 KB per-document cap —
still listed, so the person choosing sees *why* it is unavailable rather than wondering where it
went, but disabled at the picker.

**`modifiedAt` — new in v3.61.1.** The source file's own `mtime`, as an ISO string, read off the
same `stat` call the scan already makes for `bytes` — no second syscall. `null` when the timestamp
is missing or is not a real date, computed the same way whether or not the row is `tooLarge`, so the
field means one thing on every row rather than "absent = refused" on some and "absent = unknown" on
others. It answers the one question a size and a suggested role cannot: is this document still
maintained. The picker renders it as an age on the app's one freshness scale; it never reorders the
list — the sort stays role rank then path.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | `invalid_root` — `root` is missing, empty, not a string, contains a NUL byte, or is not an absolute path. `project_required` — `domain` sent without `project` or vice versa. `invalid_mode` — `mode` sent as something other than `copy`/`mirror` |
| `409` | `repo_unreachable` — the path does not exist, or is not readable, from this machine |

**With `domain`, `project` and `mode` named (v3.69.0)**, each candidate also carries `alreadyAdded`
(boolean — true if this exact path, under this mode, is already part of the project),
`alreadyAs` (the slug it is already added as, or `null`), and `landsAs` (the slug it would land
as if ticked now — a name already taken by another source gets a readable suffix, e.g.
`architecture-lumina.md`, rather than colliding). The top-level response also carries
`inGitCheckout` (boolean — whether `root` is itself inside a git checkout, which the app's local
Add panel uses to default the Keep in sync / Copy once radio) and `group` (`{id, label, created}`
— which source group this scan would land in, or a new one).

#### `?source=remote` — the same picker for a machine with no checkout

```
GET /api/memory/repo-scan?source=remote&remote=owner/repo[&ref=][&path=][&tokenSource=]
```

**New in v3.65.0.** The sibling arm of the same route — `scanRemoteForFoundations` over HTTP —
lists what a **GitHub repository** has that could become a foundation, for the machine that has no
checkout to point `?root=` at. It stays a `GET` because it writes nothing, and it costs exactly
**two requests to GitHub whatever the repository's size** (the ref, then one recursive tree) —
**no blob is fetched**, which is the whole reason this is offered at all rather than a form that
asks the owner to type paths by hand. It is still an action with a button, never a poll: it touches
a rate limit and a credential file, the same rule [`…/foundations/refresh`](#post-apimemorydomainprojectfoundationsrefresh)
states.

**Query parameters**

| Parameter | Description |
|-----------|-------------|
| `remote` | The repository, as `owner/repo`, or the `https://` or `git@` URL git prints for the remote |
| `ref` | Optional branch, tag or commit. Sent **beside** `remote`, never inside it — git prints neither a branch nor a folder in a remote URL, so a caller holding the repository as a string has nowhere else to put it |
| `path` | Optional folder inside the repository to scan, same reasoning as `ref` |
| `tokenSource` | `'config'` (default) or `'sync'` — **which file on this computer** to read the GitHub read token from. Never a token itself: no token crosses this route, exactly as on the init and refresh routes below |

**Success response** `200 OK`

```json
{
  "ok": true,
  "root": null,
  "source": "remote",
  "remote": { "owner": "you", "repo": "your-project", "ref": "main", "path": null },
  "commit": "9623343f…",
  "tokenSource": "config",
  "candidates": [
    { "path": "docs/architecture.md", "bytes": 8120, "suggestedRole": "architecture",
      "suggestedSlug": "architecture.md", "tooLarge": false, "matchedBy": "docs-folder",
      "firstHeading": null, "modifiedAt": null }
  ],
  "truncated": false,
  "cap": 200,
  "maxDepth": 4,
  "maxDocumentBytes": 524288,
  "requests": 2
}
```

`root` is always `null` on this arm — no folder on this computer was read. The same three rules
admit a candidate as the local scan (a `docs`/`doc` folder, a role-matching basename, an
`adr`/`adrs`/`decisions`/`architecture`/`rfcs` folder), applied to the path **below** `remote.path`,
so naming `docs/` as the folder does not make every file in the repository match the `docs-folder`
rule. `path` is repository-relative, exactly the shape the picker will send back in `files` to
[`…/foundations/init`](#post-apimemorydomainprojectfoundationsinit) or
[`…/foundations/refresh`](#post-apimemorydomainprojectfoundationsrefresh).

**`firstHeading` and `modifiedAt` are always `null` on this arm — deliberately, and this is "not
read", not "missing".** A git tree entry carries neither a heading preview nor a timestamp the way
a local file read does; reading either would cost a blob fetch per candidate, which is exactly the
per-file network cost this route exists to avoid. The local form (`?root=`) is **unchanged** and
still reports both.

**Error responses** — the same table [`…/foundations/refresh`](#post-apimemorydomainprojectfoundationsrefresh)
uses for its own remote arm, because one client reads both doors through one vocabulary: `403`
`unauthorised`, `404` `remote-not-found`, `409` `no-token`, `429` `rate-limited`, `502`
`remote-tree-truncated` / `remote-http` / `remote-unreachable` / `remote-too-large`, `500`
`remote-unavailable`, `400` `invalid-remote` — a `remote` that is not a usable owner/repo, URL, or
branch/folder pair.

### POST /api/memory/:domain/:project/foundations/init

**New in v3.61.0.** Sets a project's foundations **ownership**, once — `initFoundations` over HTTP.
The setter behind both halves of [Start a project](user-guide.md#start-a-project): the create
form's ownership choice, and the same choice re-offered from an existing, ownerless project's
Foundations block.

**Body**

```json
{ "ownership": "curator", "seed": true }
```
```json
{ "ownership": "repo", "repoRoot": "/Users/you/code/your-project", "files": [{ "path": "docs/architecture.md", "role": "architecture" }] }
```

**A mirror born remote — new in v3.65.0**, no checkout on this machine at all:

```json
{ "ownership": "repo", "remote": "owner/your-project", "files": [{ "path": "docs/architecture.md", "role": "architecture" }] }
```

| Field | Meaning |
|---|---|
| `ownership` | `'repo'` or `'curator'` — no third value, and no default: an omitted or unrecognised value is refused rather than guessed |
| `repoRoot` | **`repo` only**, and mutually exclusive with `remote`. The checkout (or plain folder) to mirror from. Refused on the `curator` arm — `root_not_allowed` — because a curator-owned project has no checkout to name |
| `files` | **`repo` only.** Candidates to mirror in the same call, typically the ticked rows from a `repo-scan` response — `[{ path, role? }]`. May be empty; the manifest is still written (see below) |
| `seed` | **`curator` only**, default `true`. `false` sets ownership without writing the four skeleton documents — an empty curator-owned project, ready for **Add from this computer**, **Write a document** or **Choose a file…** instead |
| `remote` | **New in v3.65.0. `repo` only**, and mutually exclusive with `repoRoot` — a mirror has one source, and choosing it is the decision this call records. Names a **GitHub repository with no checkout on this machine**: `{owner, repo, ref?, path?}`, or a string — `owner/repo`, an `https://` URL, or a `git@` URL. Refused on the `curator` arm (`remote_not_allowed`), and refused together with `repoRoot` (`root_and_remote`) |
| `tokenSource` | **New in v3.65.0.** `'config'` (default) or `'sync'` — **which file on this computer** to read the GitHub read token from, never the token itself: `'config'` is the read-only `githubReadToken` in Settings, `'sync'` is Personal Sync's own PAT, offered because a classic sync token can read every repository the user owns and was granted for something else. Anything else is `400 invalid_token_source` |
| `rechooseEmpty` | **New in v3.68.0.** Only the literal `true` is honoured; anything else is treated as omitted. Lets this call re-choose the source of a project whose manifest **already** lists 0 documents (the Add from GitHub door's `init` mode on an existing-but-empty project). Still refused `ownership_set` — the source stays whatever it already was — when the project's folder holds any document the manifest doesn't list yet (`hasUnlistedDocument`), so a rescan can't silently orphan a file |

**The body is strict, as of v3.65.0** — exactly `ownership, repoRoot, files, seed, remote,
tokenSource, rechooseEmpty` (v3.68.0) and nothing else; any other field is `400 unexpected_fields`, naming what was sent.
**A `token` field is refused by name, specifically**, rather than falling into the generic
`unexpected_fields` list unremarked: no token ever crosses this route, so a `token` key in the body
must never look accepted, and the refusal spells out that `tokenSource` names which file on this
computer to read it from instead.

**On the remote arm, with `files` named, the repository is read *before* anything is written.**
The ref and the full tree are fetched first; if that read fails outright — the wrong owner, repo or
branch, no usable token, a rate limit, a truncated tree — nothing is written at all, the project's
ownership is still unchosen, and you can correct the mistake and call again. Once the tree is in
hand, each named file is fetched and written **independently**: a file that doesn't resolve inside
the repository, isn't `.md`/`.txt`, or is over the size cap is skipped and reported in the mirror
step's own `refused[]` while every other named file is still written and the ownership is still
recorded. **With no `files` at all, the ownership is recorded with zero network calls** — the
manifest carries the remote and nothing else, and the first "Refresh from repo" then copies the
documents.

**Success response** `201 Created`

```json
{
  "ok": true, "domain": "acme", "project": "lumina",
  "ownership": "curator",
  "foundations": { "…": "…the wire shape…" },
  "remote": null,
  "tokenSource": null,
  "seeded": ["architecture.md", "decisions.md", "conventions.md", "roadmap.md"],
  "refresh": null,
  "notes": []
}
```

`ownership` echoes back the decision just recorded (`'repo'` or `'curator'`) — the one field a
caller needs to confirm without re-reading the index. `notes` is the store's own disclosure array
(for example, a budget already exceeded by the seeded skeletons) and is always an array, never
omitted.

**`remote` and `tokenSource` are new in v3.65.0.** `remote` is `{owner, repo, ref, path}` when this
project was born as a remote mirror, `null` on every other arm — **where it mirrors from**, never
a checkout path, since there may be none. `tokenSource` names **which file** the read token came
from, `null` when no token was needed. Neither ever carries a token.

`seeded` lists the skeleton slugs actually written (empty on the `repo` arm, or on `curator` with
`seed: false`). `refresh` carries the mirror step's own result (`{ refreshed, added, missing,
refused }`, the same shape `…/foundations/refresh` returns below) when `files` was non-empty on
either `repo` arm — local or remote — `null` otherwise. **A `repo`-ownership call always writes the
manifest, even with an empty `files` list** — naming a project repo-owned with nothing to mirror
yet still records the choice; the pre-v3.61.0 refresh route's "empty work list is a no-op"
behaviour is right for a *refresh* and would be wrong here, so `init` does not inherit it. **The one
exception is the remote arm with `files` empty**, where the manifest is written directly rather than
through the refresh step (there is nothing to fetch), and `refresh` stays `null`.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | `invalid_ownership` (missing or unrecognised value), `ownership_set` (a manifest already exists for this project — **even one with zero documents in it** — ownership is decided once; **unless `rechooseEmpty: true` (v3.68.0) and the project's manifest lists 0 documents AND its folder, if any, holds no unlisted document**), `root_not_allowed` (`repoRoot` supplied on the `curator` arm), `manifest_unreadable` (a manifest exists but this store cannot parse it — fix or remove `foundations/manifest.json` first), `remote_not_allowed` (`remote` supplied on the `curator` arm), `root_and_remote` (both `repoRoot` and `remote` named — one source, chosen once), `invalid_token_source`, `unexpected_fields` (a field outside `ownership, repoRoot, files, seed, remote, tokenSource, rechooseEmpty` was sent), and, from the remote arm's own read, `invalid-remote` (a repository/ref/path that is not a usable form) |
| `403` | `readonly` — a Shared Brain mirror; or, from the remote arm's own read, `unauthorised` — the stored credential cannot read that repository |
| `404` | Unknown domain or project, or — from the remote arm's own read, in the store's own hyphenated spelling, exactly as `…/foundations/refresh` reports it below — `remote-not-found` |
| `409` | `repo_unreachable` — neither `repoRoot` nor a reachable checkout can be read from this machine (the local arm); `no-token` — no token in the named file (the remote arm) |
| `429` | `rate-limited` — GitHub's own limit, not this app's |
| `502` | `remote-tree-truncated`, `remote-http`, `remote-unreachable`, `remote-too-large` — upstream conditions; nothing here is malformed and nothing is broken locally |
| `500` | `remote-unavailable` |

**The remote arm's own read refusals — `unauthorised`, `rate-limited`, `remote-tree-truncated`,
`remote-http`, `remote-unreachable`, `remote-too-large`, `remote-not-found`, `invalid-remote`,
`no-token`, `remote-unavailable` — cross the wire in the *store's own hyphenated spelling*, not this
route's underscored one**, and share the exact same status table
[`…/foundations/refresh`](#post-apimemorydomainprojectfoundationsrefresh) uses for its own remote
arm below — deliberately, so one client branch reads a refusal from either door alike. Only this
route's own three refusals (`remote_not_allowed`, `root_and_remote`, `invalid_token_source`) are
translated to underscored form, the same as every other tier-0 refusal this file documents.

### POST /api/memory/:domain/:project/foundations/add-local

**New in v3.68.0.** *"Add from this computer"* — the local door's commit, when it isn't better
served by `…/foundations/init` (an empty project) or `…/foundations/refresh` (adding more inside an
existing folder mirror by naming its recorded remote — the UI picks the right one via
`buildAddCommit()` in `shared/foundations-add.js`). `addFoundationsFromFolder`
over HTTP: copies the ticked files from a folder into an empty or curator-kept project (**appended,
never replacing** an existing document), or mirrors them into a folder mirror from **inside that
mirror's own folder only** — a path outside it is refused, never silently rebased.

**Body**

```json
{ "root": "/Users/you/notes", "files": [{ "path": "architecture.md" }, { "path": "decisions.md" }] }
```

The body is strict — exactly `root, files` — any other field is `400 unexpected_fields`. Every path
rule the store already enforces for a mirror applies here too: `root` must be absolute, resolved
through `realpath`; each file must resolve **inside** `root`, lexically and through symlinks; only
`.md`/`.txt`; a regular file; capped at 512 KB.

**Success response** `200 OK`

```json
{
  "ok": true, "domain": "acme", "project": "lumina",
  "mode": "copy",
  "added": ["architecture.md", "decisions.md"],
  "refused": [],
  "rechosen": false,
  "addedBytes": 4021, "totalBytes": 4021, "budgetBytes": 204800, "budgetExceeded": false,
  "documentCount": 2,
  "foundations": { "…": "…the wire shape…" },
  "notes": []
}
```

`mode` is `'copy'` (an empty or curator-kept project) or `'mirror'` (inside an existing folder
mirror). `refused` lists each ticked file that didn't make it, with a reason, `path`, and — over
the size cap — `bytes`/`cap`; a partial add still returns `200`, because *some* documents arrived.
`budgetExceeded` disclosed, never refused — the same "a rejected save loses the document outright"
rule every foundations write follows.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | `invalid_project`, `unexpected_fields` |
| `403` | `readonly` — a Shared Brain mirror |
| `404` | Unknown domain or project |
| `409` | `source-is-github` (this project mirrors a GitHub repository — this door is disabled for it), `outside-mirrored-folder` (a ticked file resolves outside the folder this project already mirrors), `orphans-present` |
| `422` | `nothing-added` — every ticked file was refused |

### PUT /api/memory/:domain/:project/foundations/:slug

**New in v3.61.0.** Create or replace **one kept (written or copied) document, whole** —
`saveFoundation` over HTTP, `authoredBy.kind: 'human'` always (never an agent's provenance; that is
what `save_foundation` over MCP is for). Backs the Foundations block's editor — **Edit** on an
existing row, or **Write a document** (empty editor or **Choose a file…**) for a new one. **As of
v3.69.0** the gate is checked **per document** (the slug's own `source.kind`), not once for the
whole project — a project that mirrors can still take a `PUT` for a **new** slug; only a save to an
**existing mirrored slug** is refused.

**Body**

```json
{ "text": "# Architecture\n…", "title": "Architecture", "role": "architecture", "readFirst": true }
```

**`readFirst` (v3.62.0) is optional and TRI-STATE, and the omitted case is the important one.**
Omit it and the document's current reading plan is left exactly where it is; send `true` or `false`
and it moves. A normalised `false` on every omitted field would silently un-route a document each
time its text was edited, and the owner would watch their reading plan empty itself one save at a
time with nothing to see — so the route allow-lists the field and forwards an absent key as an
absent key. Anything that is not a boolean is `400 invalid_read_first`. The response echoes
`readFirst` and `wasReadFirst`, because a save that *preserved* a flag and a save that *moved* one
are different facts. To change only the flag — including on a **mirror**, where this route is
refused — use [`PATCH`](#patch-apimemorydomainprojectfoundationsslug) below.

**`title` and `role` are both optional, on creation as well as on replacement** — the store
(`saveFoundation`) derives whatever is omitted rather than refusing, and it does so **unconditionally
from this call's own input, never from the manifest's existing row**: an omitted `title` is read
from the NEW text's first `# ` heading (falling back to the slug if there is none), and an omitted
`role` defaults to `'other'` regardless of what the document was previously filed under. Sending
either overrides the derived value. This is a consequence of the save being a whole-document
**replace**, not a partial update — there is no "existing value" the store reads back to fill a gap.
The route passes `replace: true` to the store — the store's own 10% destructive-shrink guard is waived
here for the same reason it is waived on the standing-brief route: the editor is seeded with the
document's current text, so a shrink is something a person did to text on their own screen, and the
guard's own remedy ("repeat the call with `replace: true`") is advice a person in a browser cannot
act on.

**Success response** `200 OK`

```json
{
  "ok": true, "domain": "acme", "project": "lumina", "created": false,
  "document": { "slug": "architecture.md", "role": "architecture", "title": "Architecture",
    "bytes": 41200, "sha256": "…", "skeleton": false, "…": "…" },
  "totalBytes": 148230, "budgetBytes": 200000, "budgetExceeded": false,
  "wasSkeleton": true, "readFirst": true, "wasReadFirst": false, "notes": []
}
```

Saving a document that was a skeleton **clears its `skeleton` mark** — reflected in `document`
above and in the very next `GET` of the same document or of the project's Foundations index; a
skeleton is only ever *filled*, never quietly re-marked. `wasSkeleton` is the one-shot fact this
save FILLED a skeleton (computed from the pre-write manifest, not from `document.skeleton` which is
already `false` by the time the response is built) — the field a banner needs to say "Architecture
is written now" rather than just "saved", and `false` on every ordinary re-save of an already-filled
document.

| Status | Condition |
|--------|-----------|
| `400` | `repo_owned` — checked **per document, since v3.69.0** (the slug's own `source.kind`, whatever else the project holds): *`"<slug>" is mirrored from <label> — edit it there and refresh. A mirror is a byte copy of a file whose author is the folder or repository it came from, so an edit made here would be overwritten by the next refresh. Nothing was written. A NEW document can still be written into this project under another name.`* — the response also carries `mirrored: {group, kind, label, path}` naming the source. `no_manifest` — no manifest exists yet ([init](#post-apimemorydomainprojectfoundationsinit) first). `manifest_unreadable` — a manifest exists but this store cannot parse it. `too_large` — over the 512 KB per-document wall; both the document's size and the wall are named. `invalid_slug`, `invalid_role`, `empty` |
| `403` | `readonly` — a Shared Brain mirror |
| `404` | Unknown domain or project |
| `409` | `locked` — another write to this project's foundations is in flight (the cross-process `.write-lock`, the one tier-0 exception to "no lock is taken" — see [working-state.md § 2](working-state.md#concurrency-this-tier-is-the-one-exception-to-no-lock-is-taken)) |

### PATCH /api/memory/:domain/:project/foundations/:slug

**New in v3.62.0.** Flag one document **read first**, or unflag it — the reading plan and nothing
else. `setFoundationReadFirst` over HTTP. **Works on any document, kept or mirrored**, which is the
whole reason it is not an arm of the `PUT`.

**Body: `{ readFirst: boolean }`, and nothing else.**

```json
{ "readFirst": true }
```

**Why a separate route.** The `PUT` is refused `repo_owned` on a mirror — correctly, since an edit
there would be overwritten by the next refresh, because the folder is the author. A repo-owned
project routed only through the `PUT` would therefore have had **no way to flag anything from the
app at all**, and mirroring a checkout is the commonest way documents arrive.

**And why a flag on a mirror is not a second writer.** The property the single-writer rule protects
was never *"one process may write"*; it is **one writer per FILE, with provenance that matches**.
`readFirst` is curator metadata *about* a document, never part of it: this route writes
`foundations/manifest.json` and **nothing else**, so every mirrored `.md` stays byte-for-byte the
checkout's and `sha(stored) === sha(source)` — the claim the whole freshness reading rests on — is
untouched. The manifest is **already** a file this app writes on a mirror: `…/foundations/refresh`
rewrites it on every re-copy, and `DELETE` rewrites it to stop mirroring a document. This is that
same file, one boolean. Who reads what first is a decision a repository cannot make for its owner.

**A second body key is a `400`, not an ignored field.** That is not tidiness: this route is
reachable on a mirror, so a body that quietly ignored a `text` key would be a write path to a
mirrored document wearing the wrong method. Refusing the whole request is what keeps *"this route
writes the manifest and nothing else"* checkable from outside.

**Success response** `200 OK`

```json
{
  "ok": true, "domain": "acme", "project": "lumina", "slug": "decisions.md",
  "readFirst": true, "wasReadFirst": false, "changed": true,
  "readFirstCount": 2, "onRequestCount": 4,
  "readFirstBytes": 38400, "readFirstBudgetBytes": 122880,
  "readFirstBudgetExceeded": false
}
```

`changed: false` is a **success** — the document is already in the state you asked for, nothing was
written, and saying so is what lets a view avoid announcing a change nobody made.

The five readings are forwarded from the store rather than recomputed here, so the block's summary
line (*"N read first · M on request"*) can be patched in place without re-reading the project.
**`readFirstBudgetBytes` is not `budgetBytes`**: the first is the **bootstrap's** 120 KB reading
budget — what one session is actually handed — and the second is the **project's** 200 KB disk
budget. A project can sit comfortably under 200 KB and still flag more than a bootstrap will send,
so collapsing them would make a view say "within budget" about the wrong budget.
`readFirstBudgetExceeded` is a **disclosure, never a wall**.

| Status | Condition |
|--------|-----------|
| `400` | `invalid_read_first` — the body's `readFirst` is missing or is not a boolean. `unexpected_fields` — any key besides `readFirst`, with the offending names listed. `no_manifest` — no ownership has been set yet ([init](#post-apimemorydomainprojectfoundationsinit) first). `manifest_unreadable` — a manifest exists but this store cannot parse it, and rewriting one it cannot read could drop entries for documents it cannot see. `invalid_slug`, `invalid_project`, `unsafe_path` |
| `403` | `readonly` — a Shared Brain mirror |
| `404` | Unknown domain, or `foundation_not_found` — no document of that slug is listed in the manifest |
| `409` | `locked` — another write to this project's foundations is in flight |

The store's own gate is the only one applied — this route deliberately does **not** pre-read the
index with `requireManifest` / `requireCuratorOwned`, because that would be a second copy of the
same decision, taken outside the lock the store takes, and able to disagree with it.

### DELETE /api/memory/:domain/:project/foundations/:slug

**New in v3.61.0; works on a mirror too since v3.61.1.** Remove one document. **Body: `{ confirm }`,
and it must equal the document's slug exactly** — the same enforced-at-the-route rule
`DELETE …/projects/:project` already follows, so the confirmation cannot be skipped by a client
that does not render it.

**The gate is the manifest, not the ownership — the v3.61.1 correction.** v3.61.0 refused this
route with `repo_owned` on a mirror, on the reasoning that "a mirrored document is dropped by no
longer listing it on the next refresh, never by deleting the copy, which the next refresh would
simply put back." The second half is false: `refreshFoundationsFromRepo` builds its work list from
`manifest.documents`, so an entry that is gone **stays gone**. The route now uses a
`requireManifest` gate — everything `requireCuratorOwned` checks *except* the ownership refusal —
so **both ownerships can remove an entry**. `PUT` is unchanged and still refuses a mirror with
`repo_owned`: an *edit* to a mirrored document would create two writers of one file, which is the
property the ownership gate protects; *removing* its entry is not a claim about its content, it is
the decision to stop mirroring it.

**Success response** `200 OK`

```json
{
  "ok": true,
  "domain": "second-brain",
  "project": "lumina",
  "removed": "decisions.md",
  "ownership": "repo",
  "origin": "folder",
  "sourceKept": true,
  "source": { "label": "second-brain", "path": "docs/decisions.md" },
  "group": { "id": "s1", "kind": "folder", "label": "second-brain" },
  "groupRemoved": false,
  "wasOrphan": false
}
```

`ownership` is the **row's own** kind (`"repo"` or `"curator"`) — which kind of removal this was,
read from the manifest **before** the write; on a mixed manifest the project-level `ownership` may
read `"mixed"`, but this field is always the one document's. `origin` (**v3.69.0**) is
`"written"` \| `"copied"` \| `"folder"` \| `"github"` \| `null`. `sourceKept` is `true` for any
mirrored or copied document: the copy is gone and the original — the folder file, the GitHub file,
or (for a copy) the source it was copied from — is untouched; **a later refresh will NOT bring it
back**, since the store no longer lists it — re-add it from the checklist. `source` (**v3.69.0**)
names where it came from — `{label, path}` for a mirror, `{label: copiedFrom, path: null}` for a
copy, `null` for a written document. On a written document the copy is the only copy, so
`sourceKept` is `false` and the removal cannot be undone from inside The Curator (a git client can
still recover it if you sync). `group` (**v3.69.0**) names the source group this document belonged
to, `null` for a written or copied document; `groupRemoved: true` when this was that source's
**last** document, so the source itself was removed in the same write. `wasOrphan` is `true` when
the file existed on disk with no matching manifest entry (a document `listFoundations` would
already have disclosed as `orphanFiles`) — deleting one of those still succeeds, and is reported as
what it was.

| Status | Condition |
|--------|-----------|
| `400` | `confirm_required` (missing, empty, or not an exact match). `no_manifest` — no manifest exists yet. `manifest_unreadable` — a manifest exists but this store cannot parse it. `repo_owned` no longer applies here — see above; it still applies to `PUT` |
| `403` | `readonly` |
| `404` | `foundation_not_found` — no document at that slug (and no orphan file either); or unknown domain/project |
| `409` | `locked` — the same cross-process lock `PUT` takes |

### PATCH /api/memory/:domain/projects/:project

Rename a project, replace its standing brief, or both. Body: `{ rename?, brief? }`; sending
neither is a `400 nothing_to_do` rather than a silent success.

**Both in one call because they are one gesture in the UI**, and because two requests would leave
a rename applied with the brief write aimed at the OLD name if the second failed. The rename is
applied **first** and the brief is written to whatever name the project now has, so a partial
failure is always *"renamed, brief unchanged"* — visible, and re-runnable.

**Success response** `200 OK`

```json
{
  "ok": true,
  "domain": "second-brain",
  "project": "lumina-2",
  "renamed": { "from": "lumina", "to": "lumina-2" },
  "briefSaved": true
}
```

`renamed` is `null` when nothing was renamed. The brief is written **whole**: the store replaces
the document rather than merging into it, so a partial brief silently drops what it omits — the
same "send the complete thing" rule a scope save follows. The write is stamped
`authoredBy.kind: 'human'`, which is what the store's brief-authority reading looks for.

**A brief larger than `MAX_BRIEF_BYTES` (32 KB) is REFUSED, not trimmed**, and this is one of two
places the route does not defer to the store. The store trims an over-budget write and discloses
the trim, which is right for an agent near its context limit — a refused handoff is a lost
handoff — and wrong for a person who typed the text and can see it. The refusal names both
numbers and nothing is written. The cap is measured in **bytes**: a brief of em-dashes is three
bytes a character in places.

**The store's destructive-shrink guard is waived on this route**, which is the other. The store
refuses a write that cuts a brief to under 5% of itself, because `project.md` is overwritten in
place with no journal behind it — right for an agent composing a document it cannot see, and wrong
here: the app's editor is *seeded with the current text*, so a shrink is something a person did to
text on their own screen. The refusal's own advice — *"repeat the call with `replace: true`"* — is
advice a person in a browser cannot take, and advice that cannot be followed is worse than none.
An **empty** brief is still refused (`reason: "empty-brief"`), ahead of the shrink guard and
regardless of the waiver. The one thing this gives up: a brief longer than the read cap arrives in
the editor truncated, and saving it drops the tail; the view says *"the tail is not shown"* above
the box when that is true, and the route cannot see it.

| Status | Condition |
|--------|-----------|
| `400` | `nothing_to_do`, `invalid_project`, `reserved_project`, `brief_too_large` |
| `403` | `readonly` |
| `404` | Unknown domain, or the project does not exist |
| `409` | A **rename** while that domain has a write in flight (a rename moves a directory; a brief write on the same busy domain is allowed, because it touches one file an ingest never opens) |

### DELETE /api/memory/:domain/projects/:project

Delete a project: its standing brief, every work-stream handoff under it, and every journal line.
Those are frequently the only record of decisions nobody wrote down anywhere else. The domain's
**wiki is not touched**. There is no in-app undo, but since v3.73.0 the project's folder is **moved**,
not erased, to `<user data>/.curator-trash/projects/<domain>--<project>--<UTC stamp>/`, and the
success response carries it as `trashPath`: `{ ok, domain, project, deleted: true, trashPath }`. To
restore, move that folder back to `domains/<domain>/state/` and rename it to the project name. With
Personal Sync configured the deletion still reaches GitHub on the next Sync.

**Body: `{ confirm }`, and it must equal the project name exactly** — case-sensitive, untrimmed.
The confirmation is enforced **at the route**, not only in the view: a confirmation that lives
only in a view is a confirmation every other client skips.

| Status | Condition |
|--------|-----------|
| `400` | `confirm_required` (missing, empty, or not an exact match) or `invalid_project` |
| `403` | `readonly` |
| `404` | Unknown domain, or the project does not exist |
| `409` | A write is in flight on that domain |

### GET /api/memory/:domain/:project/scopes/:scope/delete-preview

**New in v3.75.0.** What [`DELETE …/scopes/:scope`](#delete-apimemorydomainprojectscopesscope)
would take, read fresh — the Context view reads it when its **Delete handoff** confirm opens, so the
card lists every machine's copy rather than the one row that was pressed. Read-only. `:project` is
the domain name for the domain's own project.

```json
{
  "ok": true, "domain": "articles", "project": "articles", "scope": "auth-rework",
  "path": "state/auth-rework/", "restoreTo": "state/",
  "machines": [
    { "machine": "mac-studio-a1b2", "isThisMachine": true, "hasCurrent": true,
      "headline": "Token refresh wired; tests next", "writtenAt": "2026-09-25T10:02:11.000Z",
      "writtenAgeSeconds": 3600, "lastWriteAt": "2026-09-25T10:02:11.431Z",
      "harness": "Claude Code", "harnessLabel": "Claude Code", "model": "opus",
      "bytes": 2210, "hasJournal": true, "hasPrevious": false }
  ],
  "total": 1, "truncated": false, "unlistedMachines": 0, "otherMachines": 0,
  "trashDir": "/path/to/user-data/.curator-trash/scopes"
}
```

`machines` is newest first on the agent's clock (`writtenAt`, else the file's time) and capped at
200 (`total` is uncapped). `isThisMachine` is positive evidence only — the folder name equals this
installation's machine id. `otherMachines` counts the copies saved elsewhere, which Personal Sync
will remove there too. `hasCurrent: false` is a machine folder holding only a journal.

| Status | Condition |
|--------|-----------|
| `400` | `invalid_project`, `invalid_scope`, or `not_a_scope` (see below) |
| `403` | `readonly` — a Shared Brain mirror |
| `404` | Unknown domain, `project_not_found`, or `scope_not_found` |

### DELETE /api/memory/:domain/:project/scopes/:scope

**New in v3.75.0.** Delete **one work-stream** — the folder `state/[<project>/]<scope>/` with every
machine's saved copy in it: each `current.md`, each `journal.jsonl`, each kept `previous.md`. The
standing brief, the project's other work-streams and the wiki are not touched. Until this release a
single work-stream could only be removed by hand.

**Recoverable.** The folder is **moved**, never erased, to
`<user data>/.curator-trash/scopes/<domain>--<project>--<scope>--<UTC stamp>/` (for the domain's own
project, `<project>` is the domain name). To restore, move that folder back into the `restoreTo`
folder (`state/` or `state/<project>/`) and rename it to the scope name. With Personal Sync
configured the deletion still reaches GitHub on the next Sync, and from there your other computers.

**Body: `{ confirm }`, and it must equal the scope's folder name exactly** — case-sensitive,
untrimmed, checked at the route and again in the store. The name is taken literally: `latest` is
**not** resolved to the newest work-stream here (a real scope called `latest` is deleted by its own
name, and otherwise `latest` is `scope_not_found`), and no spelling is folded onto a
differently-named folder.

```json
{
  "ok": true, "domain": "articles", "project": "articles", "scope": "auth-rework", "deleted": true,
  "trashPath": "/path/to/user-data/.curator-trash/scopes/articles--articles--auth-rework--2026-09-25T14-03-22Z",
  "machines": ["mac-studio-a1b2", "laptop-c3d4"], "unlistedMachines": 0,
  "restoreTo": "state/", "recreated": false
}
```

`machines` is read under the lock, immediately before the move — what actually went.
`recreated: true` means a save landed in the same instant and re-created the work-stream holding
only itself: tier-2 saves take no lock (by design), so the delete cannot exclude them, and says so
instead of claiming a clean delete. The move itself is one `rename(2)`, so the trash copy is never
partial.

**There is no MCP tool for this, deliberately:** an agent must not delete the record of what earlier
sessions did. It is an owner action, typed, from the app.

| Status | Condition |
|--------|-----------|
| `400` | `confirm_required`, `invalid_project`, `invalid_scope`, or `not_a_scope` — the name is the documents folder (`foundations`), or, on the domain's own project, a folder under `state/` that is (or may be) a separate **project** |
| `403` | `readonly` — a Shared Brain mirror |
| `404` | Unknown domain, `project_not_found`, or `scope_not_found` |
| `409` | A write is in flight on that domain (`conflict: "write_in_progress"`), or another process holds its lock (`locked`) |
| `500` | `io` — the move failed; the folder is where it was |

### PATCH /api/memory/:domain/:project/knowledge/domains

**New in v3.65.0.** Sets which wikis a project's **knowledge** lives in — as opposed to its
**state**, tiers 1–3, which this route never touches — `setKnowledgeDomains` over HTTP.

**A human write, and legitimate, for the same reason the read-first flag is** (see
[`PATCH …/foundations/:slug`](#patch-apimemorydomainprojectfoundationsslug) above): `knowledgeDomains`
is curator **metadata about** the project — which wikis its knowledge lives in — held in
`state/[<project>/]project.json`, not part of tiers 2 or 3, so it has exactly one writer, the owner,
and stamps nothing with an agent's provenance. `save_working_state` and `my-curator save` do not
write it — an agent does not choose a project's knowledge domains.

**Four path segments, not three, and deliberately.** `PATCH /:domain/projects/:project` is already
registered on this router and matches any *three*-segment PATCH whose second segment is literally
`projects` — and a domain's own project is named **after the domain**, so a naive three-segment
route here would collide: the maintainer's own `projects/projects` would have had this write
swallowed by the rename handler, the same v3.62.0 collision `?as=project` exists to resolve on the
read side, in the one shape a query parameter cannot fix — a PATCH body cannot disambiguate a path
that already matched something else. Four segments cannot collide with it at all;
`…/foundations/:slug` is the precedent for a project sub-resource at that depth.

**Body**

```json
{ "knowledgeDomains": ["research", "business"] }
```
```json
{ "knowledgeDomains": null }
```

The body is **strict**: exactly the one field, `knowledgeDomains`; anything else sent alongside it
is `400 unexpected_fields`, naming what was sent. `null` **clears** the choice — the project goes
back to reading as its own containing domain — and is **not** the same as `[]`, which is refused: a
project that searches nothing has no knowledge, and nobody means that.

**Success response** `200 OK`

```json
{
  "ok": true, "domain": "acme", "project": "lumina",
  "knowledgeDomains": ["research", "business"],
  "knowledgeDomainsDefaulted": false,
  "cleared": false,
  "cap": 12
}
```

`knowledgeDomains` and `knowledgeDomainsDefaulted` are the same two fields the matching read,
[`GET /api/memory/:domain/:project`](#get-apimemorydomainproject), carries — so a client can
repaint from this reply without a second request. **`cleared` exists only on this write's own
response** — the read has no need of it, since `knowledgeDomainsDefaulted: true` already says the
project is back on the default; here it says so as a fact about *the write just made*, so
`cleared: true` is never mistaken for "sent an empty list" (which is refused, not accepted). `cap`
is `MAX_KNOWLEDGE_DOMAINS` (12), named rather than left for a client to hard-code.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | `invalid_knowledge_domains` — `knowledgeDomains` is missing from the body, is not a list, or (after normalising) is an empty list; `invalid_domain` — an entry is not a usable domain name; `too_many_domains` — more than 12 named, the refusal carries `cap`; `unexpected_fields` — a field other than `knowledgeDomains` was sent; `invalid_project` |
| `400` | `unknown_domain` — one or more named domains are not on this computer; the refusal names them in `domains`; `unsafe_path` — the project resolves outside the state folder |
| `403` | `readonly` — a Shared Brain mirror |
| `404` | `project_not_found` |
| `409` | `locked` — another write to this project's foundations is in flight (the same cross-process `.write-lock` [`PUT …/foundations/:slug`](#put-apimemorydomainprojectfoundationsslug) takes; this route reads and rewrites `project.json` under it because it has no machine segment, exactly as `state/project.md` does not) |

### GET /api/memory/:domain/:project

One project's working state. The response is the store's `readWorkingState` result verbatim, plus
`domain`, `project` and `readonly` — deliberately 1:1 with the store rather than reshaped here,
because a second shape maintained in the route would drift from the one the MCP tools return, and
then the app and the agent would describe the same file differently.

**Path / query parameters**

| Parameter | Description |
|-----------|-------------|
| `domain` | Domain slug. Resolved against `listDomains()` **before** any filesystem access, so an unknown name never reaches path resolution |
| `project` | Project slug inside that domain. Checked against the store's own `isSafeSegment` before any path is built; an unknown project is a `404`, an unusable name a `400` |
| `scope` | Optional work-stream (`main`, `auth-refactor`, …). Omit it to get the work-stream index instead of a handoff. **`latest`** (case-insensitive) resolves to the newest-written work-stream, so a client can open the freshest handoff without first fetching the index to learn its name; on a project with nothing saved it degrades to the scope-less read rather than erroring about a scope the caller never named. The keyword is passed to the **store**, which owns it — a work-stream *actually named* `latest` wins over the keyword, because opening a different work-stream than the one named is a correctness bug wearing a helpfulness costume. The response reports `scopeResolvedBy` (`exact` \| `latest`) so a caller can tell which happened |
| `machine` | Optional. With `scope` set and no `machine`, the **most recently written** machine wins — that is what makes cross-machine handoff work — and the response names the machine it chose |
| `journalLimit` | Optional. Passed to the store **un-clamped on purpose**: the store clamps to `[1, MAX_JOURNAL_ENTRIES]` (50, default 10) itself, and clamping a second time here is the two-copies-of-a-bound shape. A non-numeric value is not passed at all, so the store's default applies |
| `open` | Optional, **`newest` is the only value**, and it is **ignored when `scope` is set**. Adds an `open` object carrying one work-stream's full handoff *alongside* the work-stream index, so a client can paint a whole project from one request instead of two serial ones. See below |
| `previous` | Optional, `1` or `true`. **v3.74.0.** Only meaningful on a scope-targeted read (`scope` set): asks the store for the **text** of `previous.md`, the one kept copy of a handoff another tool's save replaced in this `(scope, machine)` folder. Without it, a scope-targeted read still carries `previous`'s summary facts (no text) whenever the copy exists, and carries no `previous` key at all when it does not |

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
    "headingsSuspect": false,
    "authoredBy": null,
    "writtenAt": "2026-08-20T09:12:43.871Z"
  },
  "scope": null,
  "scopes": [
    { "scope": "main", "machine": "alices-macbook-pro-9f3c1a20", "lastWriteAt": "2026-08-27T18:03:11.000Z", "bytes": 3598, "ageSeconds": 5421, "headline": "Docs pass — nine false claims corrected", "harness": "claude-code", "harnessLabel": "Claude Code" }
  ],
  "scopeCount": 3,
  "distinctScopeCount": 2,
  "savedCopies": 3,
  "scopesTruncated": false,
  "unlistedEntries": 0,
  "unlistedReason": null,
  "knowledgeDomains": ["second-brain"],
  "knowledgeDomainsDefaulted": true,
  "readonly": false
}
```

**`knowledgeDomains` and `knowledgeDomainsDefaulted` are new in v3.65.0** — which wikis this
project's knowledge lives in, and whether that list was the owner's own choice or the fallback to
the project's containing domain. Forwarded straight from `readWorkingState` like every other field
on this route (this route is deliberately 1:1 with the store rather than reshaped, per the note
above), so no separate call is needed to read them; set them with
[`PATCH …/knowledge/domains`](#patch-apimemorydomainprojectknowledgedomains) above.

A **third** field, `knowledgeDomainsError`, rides along **only** when `project.json` could not be
read or parsed — over the 64 KB read cap, not valid JSON, not an object, or a chosen list that
normalises to empty. It names the defect while `knowledgeDomains` still reports the default, so an
unreadable metadata file never takes a project's bootstrap down with it.

**On this route `scopeCount` is the `(scope, machine)` pair count** — the opposite of what the
same name means on `GET /api/memory`, because this route spreads the store's shape verbatim.
Read `savedCopies` (pairs) and `distinctScopeCount` (work-streams) instead; see
[Reading the counts](#reading-the-counts-scopecount-means-two-different-things) above.

`savedCopies` and `distinctScopeCount` appear only on this **scope-less** form. A
scope-targeted read reports `machineCount` instead and has no project-wide pair total to
alias — the fields below replace them.

`unlistedEntries`/`unlistedReason` carry the same meaning as on the index route above:
directory entries the store will not address, counted rather than silently skipped.

**`brief.writtenAt` (v3.76.0)** is the brief's own stamp (see `briefWrittenAt` on the index
route); `brief.updatedAt` stays the file's mtime. **`scopes[].harnessLabel` (v3.76.0)** is each
row's tool through `normaliseHarness()`, added by this route (not the store) to the envelope and to
`open` alike, so `open` stays what the scoped read answers; `harness` keeps the raw spelling.
`null` when the save named no tool.

**`stateBudgetBytes` (v3.66.0)** rides on this envelope (and on `open`, and on a scoped read) —
`49152`, the size a handoff is trimmed to. Every `scopes[].bytes` is at or under it: an over-budget
save is trimmed and disclosed in the handoff, never refused, so a handoff can never legitimately
read as over its own budget.

**`readingBudgetBytes` / `readingBudgetDefaulted` / `readingBudgetError` (v3.67.0)** name the
project's session-start reading budget: `0` for Index only, or `8192`–`819200` (the cap moved
200 KB → 800 KB in v3.70.0, with the ladder itself now seven presets); absent means "not set" and
the effective 120 KB default applies. `readingBudgetDefaulted` is `true` whenever the owner has not
chosen one. It is written only by the app (`PATCH …/reading/budget`, above) — no agent tool or CLI
command writes it. A hand-edited invalid value reads as "not set" rather than throwing, with
`readingBudgetError` naming the defect found.

**New in v3.59.0: `foundations`.** Both the scope-less and the scope-targeted response gain a
`foundations` field — the **index only**, never document bodies, matching `listFoundations` through
this file's own `foundationsWire()` allow-list, which carries exactly `present`, `ownership`,
`repo`, `budgetBytes`, `totalBytes`, `remoteMirror`, `remoteChecked`, `remoteCommit`,
`remoteError`, `skeletonCount`, `readFirstCount`, `onRequestCount`, `readFirstBytes`,
`readFirstBudgetBytes`, `readFirstBudgetExceeded`, `documents`, `orphanFiles` and `manifestError` — **no `count` and no `staleCount`** (those two exist only on the MCP
`get_working_state` tool's own foundations summary, a different, smaller object built by different
code; see below):

```json
"foundations": {
  "present": true,
  "ownership": "repo",
  "repo": { "root": "/Users/you/code/your-project", "remote": null,
    "lastRefreshAt": "2026-09-10T08:00:00.000Z", "lastRefreshCommit": "9623343" },
  "budgetBytes": 200000,
  "totalBytes": 148230,
  "remoteMirror": false,
  "remoteChecked": false,
  "remoteCommit": null,
  "remoteError": null,
  "skeletonCount": 0,
  "readFirstCount": 2,
  "onRequestCount": 4,
  "readFirstBytes": 38400,
  "readFirstBudgetBytes": 122880,
  "readFirstBudgetExceeded": false,
  "documents": [
    { "slug": "architecture.md", "role": "architecture", "title": "Architecture",
      "bytes": 41200, "sha256": "…", "updatedAt": "2026-09-10T08:00:00.000Z",
      "commit": "9623343", "source": { "kind": "repo", "path": "docs/architecture.md" },
      "authoredBy": { "kind": "human" }, "freshness": "fresh", "skeleton": false,
      "readFirst": true }
  ],
  "manifestError": null,
  "orphanFiles": []
}
```

See [Document-level source](working-state.md#document-level-source-and-the-one-writer-rule-project-wide-ownership-retired-in-v3690)
for what each field means, and [manifest version 2](working-state.md#manifest-version-2--per-document-sources)
for `sources[]`/`source.group` on a project that mixes kept and mirrored documents or mirrors from
2+ sources; a project with no foundations yet reports `present: false` and an empty `documents`
array, never an omitted key. `repo` is `null` (v1) when nothing is mirrored — there is no checkout
to name. **`skeletonCount` and `documents[].skeleton`
are new in v3.61.0**: `skeleton` is `true` on a document seeded by
[project creation or `…/foundations/init`](#post-apimemorydomainprojectfoundationsinit) that has
never been saved since, and `false` on every other document, **always present** rather than omitted
when false — a Foundations block reading "N skeletons to fill" needs both a positive and a negative
answer from every row, not an absence to interpret. Filling a skeleton in and saving it (from the
app or through `save_foundation`) clears the mark on the very next read.

**The four remote readings are new in v3.63.0**, and they are **project-level facts, not per-document
ones**, which is why they sit beside `repo` rather than inside a row. `remoteMirror` says whether a
GitHub repository is recorded for this mirror at all; `remoteCommit` and `remoteError` report what
the **last refresh** found. **`remoteChecked` is always `false` off this call, by design** — a GitHub
comparison happens only inside
[`…/foundations/refresh`](#post-apimemorydomainprojectfoundationsrefresh), an action with a button,
never on a read that rides on every project switch and on the menu bar widget's summary. The field
exists so a surface can tell *"nobody has asked GitHub"* from *"GitHub said the copy is current"*,
which are different facts and would otherwise both look like silence.

**`readFirst` and the five read-first readings are new in v3.62.0.** `documents[].readFirst` is the
owner's routing instruction — `true` means every session is handed that document's **text**, and
everything else rides as an index row an agent opens by name. It follows `skeleton`'s rules exactly:
`=== true`, **always present** rather than omitted when false, because a table with a *read first*
column needs a negative answer from every row rather than an absence to interpret. It is curator
metadata *about* a document rather than part of it, which is why it exists on a mirror at all — the
manifest moves, the copied bytes do not. Set it with
[`PATCH …/foundations/:slug`](#patch-apimemorydomainprojectfoundationsslug).

The five counts are **forwarded from the store, never derived here** — the same figures
`setFoundationReadFirst` and `get_project_context` answer with, so three surfaces cannot each arrive
at their own. An absent fact becomes `0` / `false`, so a consumer can tell *"the store looked and
there was nothing"* from *"this server does not know the field"*. **`readFirstBudgetBytes` is not
`budgetBytes`**: 120 KB is the **bootstrap's reading** budget — what one session is handed — while
200 KB is the **project** budget — what tier 0 may hold on disk. A project can sit comfortably under
200 KB and still flag more than a bootstrap will send.

#### `?open=newest` — the index and one handoff in a single answer

A client that wants to *show a project* needs both halves: the work-stream index, which only the
scope-less form produces, and one pair's `current.md`, which only the scope-targeted form
produces. Until v3.57.0 that meant two requests **in series**, because the second URL is not
knowable until the first has answered. Measured in a browser on a real store, one project switch
in the Project-context view cost three requests, three whole-column repaints and a column that
collapsed from 5,062 px to 215 px for a frame in between.

`?open=newest` adds an `open` object to the scope-less response:

```json
{
  "ok": true,
  "scope": null,
  "scopes": [ "…the work-stream index, unchanged…" ],
  "open": {
    "ok": true,
    "scope": "auth-refactor",
    "machine": "alices-macbook-pro-9f3c1a20",
    "current": { "present": true, "…": "…" },
    "journal": { "…": "…" }
  }
}
```

**`open` is byte-for-byte what the equivalent `?scope=&machine=` request answers** — the same
store call through the same envelope, not a projection of it — so a client uses one code path for
both and no disclosure field can be dropped on the way. `journalLimit`, if given, applies to it.

**Which pair it opens.** The one a client sorting by the **agent's clock** would put first:
`writtenAt`/`writtenAgeSeconds` when the journal recorded a time, the file clock only as a
fallback, and an exact tie broken by scope name, then machine name, then the store's own order.
That is deliberately *not* the store's order, which is `mtime` — on any machine that syncs, git
stamps `mtime` with the moment the checkout landed, so the two disagree routinely and ties on a
freshly-cloned store are the normal case rather than the corner one.

**It is ignored when `scope` is set** (the caller has already decided what to open), and an
unrecognised value is ignored rather than refused, so a newer client cannot turn this read into an
error on an older server. With either of those, the response is byte-for-byte the one you would
get without the parameter.

**`"open": null` is an answer**, not an omission: it means the project has no work-streams to
open, or the inner read failed (the index half is still correct and is still returned, with `200`).
A server that predates this option omits the key entirely, which is how a client tells "nothing to
open" from "this server does not know the option".

**What it does not change.** `scope=latest` is untouched — it serves callers that have no index in
hand, and it resolves on the store's own rule. Neither the MCP tools nor the menubar widget use
this route.

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
  "previous": {
    "harness": "antigravity",
    "harnessId": "antigravity",
    "harnessLabel": "Antigravity",
    "model": "gemini-3-pro",
    "writtenAt": "2026-08-26T14:20:00.000Z",
    "headline": "Wired the compile ladder's summary-only rung",
    "bytes": 2411,
    "path": "state/main/alices-macbook-pro-9f3c1a20/previous.md"
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

**`previous`** *(v3.74.0)* is present only when this `(scope, machine)` folder holds a kept copy of
a handoff a DIFFERENT tool's save replaced — an absent key means no such copy exists, never `null`.
Its facts are parsed from the copy's own provenance header, the same way `brief`/`current` are:

| Field | Type | Meaning |
|---|---|---|
| `harness` | string \| `null` | The replaced handoff's own (unnormalised) tool spelling |
| `harnessId` | string \| `null` | That tool, normalised (`normaliseHarness().id`) |
| `harnessLabel` | string \| `null` | That tool's normalised display label |
| `model` | string \| `null` | The model that wrote the replaced handoff |
| `writtenAt` | string \| `null` | ISO timestamp the replaced handoff was saved |
| `headline` | string \| `null` | The replaced handoff's one-line headline |
| `bytes` | number | Size of the kept copy in bytes |
| `path` | string | The copy's path relative to the project's state root (`state/<scope>/<machine>/previous.md`) |

With `?previous=1`, three more fields ride on `previous`: `text` (the copy's full, sanitised
content — recorded data, framed the same way `current.text` is, never instructions to obey),
`truncated` (whether the read capped it) and `sanitisedOnRead` (whether protocol-shaped markup was
neutralised on the way out). Without `?previous=1`, `previous` carries the summary table above only
— no `text`.

There is at most **one** kept copy per `(scope, machine)` folder: the next cross-tool replacement
overwrites it, so `previous` always reflects the most recently displaced handoff, never a history of
every one.

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
| `404` | Unknown domain, or the project does not exist in it (`{ok: false, reason: "project_not_found"}`) |
| `400` | An unusable project name, or a store refusal — `{ok: false, reason, message, error}`, with `reason` one of `invalid_project`, `invalid-scope`, `invalid-machine` on this route |
| `500` | Filesystem read error |

A **named** project that was never created is a `404`, not a `200` describing an empty tree. The
store answers `ok: true, projectExists: false` — it distinguishes *created but empty* from *never
created*, which its callers need — but over HTTP those are different answers to "GET this project",
and a `200` for a name that does not exist is how a typo renders as a working, blank page. The
domain's own project always exists, so this can only fire for a named one.

Store refusals carry their `reason` unchanged (the store's are hyphenated, `unknown-state-project`;
this router's are underscored, `invalid_project`) and their prose on **both** `message` and
`error`. Neither is normalised into the other: rewriting the store's `reason` on the way out would
break a caller matching the string the store gave it, and the shell reads `error`.

### GET /api/memory/:domain/:project/foundations/:slug

**New in v3.59.0.** One canonical document, verbatim, with its metadata — `readFoundation` over
HTTP.

**Path parameters**

| Parameter | Description |
|-----------|-------------|
| `domain` | Domain slug, resolved before any filesystem access, as above |
| `project` | Project slug, validated the same way as the detail route above |
| `slug` | The document's slug, validated at the boundary against `^[a-z0-9][a-z0-9-]{0,63}\.md$` before it reaches `resolveInsideState` — an unusable slug is a `400`, never a path build attempt |

**Query parameters**

| Parameter | Description |
|-----------|-------------|
| `raw` | **New in v3.61.0.** `?raw=1` returns the **verbatim** stored bytes (`sanitisedOnRead: false`, unconditionally) instead of the defanged default. This is what the Foundations editor loads FROM — an editor seeded from the defanged read would silently strip a live URL or shell command out of a document on its very first save, with no edit having been made at all (D3). Round-tripping the raw text through the editor and saving it again reproduces the identical `sha256` |

**Success response** `200 OK`

```json
{
  "ok": true,
  "slug": "architecture.md",
  "role": "architecture",
  "title": "Architecture",
  "text": "# Architecture\n…",
  "bytes": 41200,
  "sha256": "…",
  "updatedAt": "2026-09-10T08:00:00.000Z",
  "commit": "9623343",
  "source": { "kind": "repo", "path": "docs/architecture.md" },
  "authoredBy": { "kind": "human" },
  "skeleton": false,
  "sanitisedOnRead": false
}
```

`text` is, **by default**, the stored document sanitised on read the same way a handoff is (control
characters stripped, protocol-shaped markers neutralised, URLs and shell pipes defanged) — never
deleted, only defanged, and `sanitisedOnRead` says whether anything fired; with `?raw=1` it is the
stored bytes unchanged and `sanitisedOnRead` is always `false`. This route never returns a body for
more than one document; the index above is what a listing needs. `skeleton` (v3.61.0) is `true` when
this document is still an unfilled skeleton — cleared the moment it is saved through `PUT` or
`save_foundation`, by either a human or an agent.

**Error responses**

| Status | Condition |
|--------|-----------|
| `404` | Unknown domain or project (as above), or no document at that slug |
| `400` | An unusable slug |

### POST /api/memory/:domain/:project/foundations/refresh

**New in v3.59.0, multi-source since v3.69.0.** Re-mirrors one or all of a project's sources from
their checkout or repository — `refreshFoundationsFromRepo` over HTTP. The route is a legitimate
writer here even though the app stays read-only over foundations otherwise: a refresh is a
**deterministic byte copy** driven by comparing sha256 against a file on disk, never a second
author composing content, which is the distinction the read-only rule in this file protects.

**As of v3.69.0**, the body takes an optional `group` (a source id, e.g. `"s1"`) refreshing that
one source, or an empty body `{}` refreshing **every** source under one lock — every source is read
first, a source that fails is named in `groups[]` and left byte-for-byte as it was, the others
still refresh, and the manifest is written **once**, last. The response gains `groups: [{id, kind,
label, ok, source, refreshed, unchanged, missing, added, refused, commit, reason?, message?}]` and
`failedCount`; with two or more sources involved, top-level `source` reads `'mixed'`. A project with
no manifest at all still answers `409 repo_unreachable`; a present, kept-only manifest (nothing to
refresh) answers `400 no_sources` with the same prose the UI shows. `group_required` (400) is
returned when the body has `files` but the project has 2+ sources and does not say which one;
`unknown_group` (404) when a named `group` does not exist; `invalid_group` (400) for a malformed
one. `tokenSource` is **no longer defaulted to `'config'`** — a source's own recorded token file
wins unless the body names a different one, and an unrecognised `tokenSource` value is now `400`
rather than silently coerced. The single-source shape below is what a project with exactly one
source still gets, unchanged.

**Body**

```json
{
  "source": "auto",
  "tokenSource": "config",
  "remote": "acme/lumina",
  "repoRoot": "/Users/you/code/your-project",
  "files": [{ "path": "docs/roadmap.md", "role": "roadmap" }]
}
```

Every field is optional. **`source`** (v3.63.0) picks the arm — `auto` (the default: take the
checkout when it is here, GitHub when it is not), `local` (this machine's checkout only) or
`remote` (the repository only). Naming `local` with no reachable root is refused rather than
quietly doing the other thing, because naming an arm is a decision.

**`tokenSource`** (v3.63.0) names **which file the GitHub token is read from** — `config` (the
default: the `githubReadToken` key in `.curator-config.json`, which should be a fine-grained,
read-only token scoped to the source repository) or `sync` (Personal Sync's PAT). **No token
crosses this route.** A `token` field in the body is not read here or in the store: a credential
that can arrive in an HTTP body is a credential path, and this feature is not going to be the first
one into the app.

**`remote`** (v3.63.0) names the repository for this call — `owner/repo`, an `https://` or `git@`
URL, or the `{owner, repo, ref, path}` object — when the manifest does not already record one. An
unparseable value is a `400 invalid-remote` rather than a silent fallback.

`repoRoot` is optional — when omitted, the manifest's own `repo.root` (the checkout that last
refreshed, on whichever machine that was) is tried instead. Both are resolved and prefix-checked
against the manifest's recorded source paths before anything is read; a path pointing outside the
named root, or a source whose extension is not `.md`/`.txt`, is refused rather than followed.

**`files` (new in v3.61.0)** adds documents to the mirror rather than only re-copying ones the
manifest already names — the gap the [repo-scan picker](#get-apimemoryrepo-scanrootabs) exists to
close: before this release a repo-owned project's *first* documents could only be mirrored by
naming them at `init`, and nothing could add a second wave later short of asking an agent to write
a fresh document by hand. Each entry is validated with the same `sourceDigest` rules any mirrored
path already follows (must resolve inside `repoRoot`, must be `.md`/`.txt`, must not exceed 512 KB)
before it is read.

**Success response** `200 OK`

```json
{ "ok": true, "domain": "acme", "project": "lumina",
  "source": "remote", "remoteChecked": true, "remoteCommit": "9f3c1a…", "remoteError": null,
  "remote": { "owner": "acme", "repo": "lumina", "ref": "main", "path": "docs" },
  "tokenSource": "config", "repoRoot": null, "commit": "9f3c1a…",
  "refreshed": ["architecture.md"], "unchanged": ["decisions.md", "roadmap.md"],
  "missing": [], "added": ["conventions.md"], "refused": [] }
```

**The five v3.63.0 fields are always present, on both arms**, because an absence is not an answer:
`source` is `local` or `remote`; `remoteChecked` says whether GitHub was actually asked, which is
the fact a view needs to choose between *"source not on this computer"* and *"mirrored from GitHub
@ 9f3c1a"*; `remoteCommit` is the commit read; `remoteError` is a **code** rather than a sentence
(the sentence is in `error`, and a code is what a client can branch on); and `tokenSource` names
**which file** the token came from — **never the token** — reading `null` on the local arm, which
needs none. `repoRoot` is taken from the store rather than echoed from the request, so a response
can never name a folder that was not the source.

A document whose source path no longer exists at the checkout is reported in `missing` — the
stored copy is **left in place**, never deleted, because the checkout being unreachable from this
machine right now is not evidence the document should disappear. `added` lists documents that
entered the mirror for the first time this call, via `files`. **`refused` (new in v3.61.0)** lists
any `files` entry that failed its own validation — `{ path, reason }`, each string capped at 200
characters and the array itself capped at **50 entries** (`refreshWire()`) — forwarded rather than
silently dropped, and rendered **un-folded** beside the outcome rather than tucked behind a
disclosure, because a document someone asked to mirror and did not get is the kind of fact a fold
successfully hides. `refreshed`, `unchanged`, `added` and `missing` are forwarded **whole** on this
route; they carry `refreshWire()`'s 200-entry cap (and a `notes` array capped at 20) only where that
helper builds the report — inside `POST …/projects` and `POST …/foundations/init`.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | **v3.69.0:** `no_sources` — the project has a manifest but nothing mirrored to refresh (replaces the old `curator_owned` reason). `group_required`, `invalid_group`, `invalid-remote` |
| `409` | **Both arms are impossible** for the named/only source — no reachable checkout *and* no recorded repository, or `no-token`. The body's `arms` object names the reason for each one separately, because "we could not do it" without "and here is why each way failed" is not actionable. A project with **no manifest at all** also answers `409 repo_unreachable` |
| `404` | Unknown domain or project; `unknown_group` — the named `group` does not exist; or `remote-not-found` — the repository, the ref or the path is not there, **or the token cannot see it**, which GitHub answers identically and the message says so |
| `403` | `unauthorised` — the stored credential cannot read that repository. Not `401`: you are not being asked to authenticate to The Curator |
| `429` | `rate-limited` — GitHub's limit, not ours, and the one status that means *later* |
| `502` | `remote-tree-truncated` (GitHub silently truncates a huge recursive tree, and a silent miss would keep a stale copy while reporting success), `remote-http`, `remote-unreachable`, `remote-too-large`. Nothing is malformed and nothing is broken locally, which is what `502` says and `400` would deny |
| `500` | `remote-unavailable` — the GitHub read could not be completed and no more specific upstream condition applies |

**Nothing is written until everything is fetched** on the remote arm: the ref, the tree and every
changed blob are read first, and the documents and manifest are written only once all of them are in
hand. So *"a truncated tree refuses loudly"* also means *"and changed nothing"*.

### POST /api/memory/:domain/:project/foundations/source

**New in v3.65.1, semantics changed v3.69.0.** Through v3.68.0 this was *"Mirror from GitHub
instead"* — it re-pointed a project's one folder mirror to a repository, clearing `repo.root`.
**Since v3.69.0**, with project-wide ownership retired, this route **adds or points a GitHub
source** rather than replacing anything: it joins an existing GitHub source that has the same
owner/repo and ref (a second machine catching up), or opens a new one when none matches. **A
`POST`, not a `PATCH`**: it fetches blobs and rewrites files, so it joins the mutating-route census
beside `…/init` and `…/refresh`.

**Body** — a strict allow-list: `{remote, tokenSource?, files?, group?}`. `remote` (required) —
`owner/repo`, an `https://`/`git@` URL, or `{owner, repo, ref, path}`; unparseable is `400
invalid-remote`. `tokenSource` (optional) — `config` or `sync`; a source that already has one
recorded reuses it unless this call names a different one. `files` (optional) — defaults to the
matched source's own existing documents. `group` (**new, v3.69.0**) — required once the project has
2 or more sources, so the caller says which one this call means; with 0 or 1, it is inferred.
`no token crosses this route, ever` — `tokenSource` only names *which file* the credential is read
from.

**Success response** `200 OK` carries `group` (`{id, label, created}`) plus the same
`refreshed`/`unchanged`/`added`/`missing`/`refused`/`commit`/`totalBytes`/`budgetBytes` shape
`…/refresh` returns. Every mirrored document's `readFirst` flag **survives**, by slug.

**Error responses**

| Status | `reason` | Condition |
|--------|----------|-----------|
| `400` | `unexpected_fields` (+ `fields`) | A field outside the allow-list — a `token` key gets the extra "never sent here" sentence |
| `400` | `invalid_project` / `invalid-remote` / `invalid_token_source` / `group_required` (2+ sources, none named) / `invalid_group` | |
| `404` | `unknown_domain` / `unknown-state-project` / `unknown_group` | |
| `403` | `readonly` | A `shared-*` mirror — refused **before** the store is asked |
| `409` | `no_sources` | **v3.69.0** — replaces the old `ownership_mismatch`: the project has no manifest to add a source to yet ([init](#post-apimemorydomainprojectfoundationsinit) first) |
| `409` | `no-token` / `locked` | No readable credential for `tokenSource`; another tier-0 write holds this project's lock |
| `429` | `rate-limited` | GitHub's limit |
| `404` | `remote-not-found` | The repository, ref or path is not there — or the token cannot see it |
| `502` | `remote-tree-truncated` / `remote-http` / `remote-unreachable` / `remote-too-large` | The same statuses [`…/refresh`](#post-apimemorydomainprojectfoundationsrefresh) gives its own remote arm |
| `500` | `remote-unavailable` / `io` | |

### POST /api/memory/:domain/:project/foundations/add-remote

**New in v3.69.0.** *"Add from GitHub"* on step ①'s head row — mirrors ticked files from a GitHub
repository into the project, `addFoundationsFromRemote` over HTTP, the GitHub sibling of
`add-local`.

**Body** — strict allow-list: `{remote, ref?, tokenSource?, files}`. `remote` — `owner/repo`, a
URL, or `{owner, repo, ref, path}`; `tokenSource` — `config` or `sync`, forwarded only when the
body names one (an unnamed one reuses the source's own recorded token, or the server default);
`files` — the ticked candidates, `[{path, role?}]`.

**Success response** `200 OK`

```json
{ "ok": true, "mode": "mirror",
  "added": [{ "path": "docs/roadmap.md", "slug": "roadmap.md" }],
  "addedFiles": [{ "path": "docs/roadmap.md", "slug": "roadmap.md" }],
  "landed": [], "refused": [],
  "groupId": "s2", "groupCreated": true, "group": { "id": "s2", "label": "acme/lumina" },
  "remote": { "owner": "acme", "repo": "lumina", "ref": "main", "path": null },
  "tokenSource": "config", "commit": "9f3c1a…", "foundations": { "…": "…the wire shape…" } }
```

Joins an existing GitHub source with the same owner/repo and ref (`groupCreated: false`), or opens
one (`groupCreated: true`) — up to `MAX_SOURCES_PER_PROJECT = 8`. `added` names each file by its
path and the slug it landed as (a name already taken by another source lands under a readable
suffix, e.g. `roadmap-lumina.md` — see `landed`). `refused` lists `{path, reason, slug?}` for
anything that failed. Nothing is written until every named file is read successfully.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | `invalid_project`, `invalid-remote`, `invalid_token_source`, `too_many_sources` (8 sources already), `unexpected_fields` |
| `403` | `origin` refused by the server's cross-origin guard (proved against the real server) |
| `404` | Unknown domain or project; `remote-not-found` |
| `403` | `unauthorised` — the stored credential cannot read that repository |
| `429` | `rate-limited` |
| `502` / `500` | The same remote-fetch statuses `…/refresh` and `…/source` give |

**Nothing is written until every blob is in hand**, exactly as `…/refresh`'s remote arm: the ref,
the tree and every changed blob are read first; a truncated tree refuses *before the first blob is
fetched*, so a failed switch leaves the manifest — `repo.root`, `repo.remote`, every document —
**byte-identical** to what it was. The clearing of `repo.root` and the writing of the new `repo.remote`
happen in the **same** manifest write the document copy performs, never a second write, so there is
no window where a failure could leave a stale root beside a fresh remote.

### PATCH /api/memory/:domain/:project/reading/budget

**New in v3.67.0; a 7-preset token ladder since v3.70.0.** A strict one-field body:
`{readingBudgetBytes: int|null}`. `0` means **Index only**; otherwise a whole number of bytes from
the store's minimum up to its cap, now **800 KB** (was 200 KB). The seven presets the app offers,
in bytes: `0` (Index only, 0 tokens), `32768` (Lean, 8k), `65536` (Standard, 16k), `131072` (Deep,
32k — was 122880/120 KB through v3.69.0), `262144` (Large, 64k), `524288` (Extra large, 128k),
`819200` (Max, 200k — was 204800/200 KB). (The token names here are the store's `tokens` field,
thousands of 1,024; since v3.76.0 the app LABELS each preset with the meter's own figure, bytes ÷ 4
in thousands of 1,000 — Extra large reads *≈131k* — so one budget never shows two numbers.) `null`
clears it back to "not set". A project already
holding an older value (e.g. `122880` or `204800`) is untouched — it is still valid, and reads back
as a **Custom** value with its nearest preset named, never migrated. Any other key in the body, or
an out-of-range value, is a 400 naming exactly what was wrong. Writes only `project.json` — curator
metadata about the project, never a document's own content.

### GET /api/memory/:domain/:project/session-start

**New in v3.67.0; rebuilt around the window meter in v3.70.0.** Reports what an agent is actually
handed at the start of a session against every named limit: the brief, the latest handoff, journal
lines, the document list and the text of whichever documents are marked **read first**, up to the
effective reading budget (`ownerBytes` — the owner's own budget, or the 120 KB default when none is
set). Each part carries its own size **and token estimate** (bytes ÷ 4) so a client can draw the
same meter the app does. Since v3.70.0 the response also carries: `layers[{key, label, bytes,
tokens}]` (the drawing order for the meter); `budget{bytes, tokens, source, preset, custom,
nearest}`; `onDemand{documents, tokens}` (what is read-first or on-request but outside the reading
budget's room — "on demand, outside the window"); `delivery{replies, paged, pageTokens}` (how many
MCP replies this bootstrap actually takes, from the same paging plan `get_project_context` uses);
`window{tokens, set}` and `harness{tokens, set}` (this computer's own settings, read from
`GET /api/config/context-window`, never written here); `meter`, the same shape the bucket kit
(`shared/bucket.js`) renders directly; and, **new in v3.72.1**, `chat{ceilingChars,
effectiveChars}` — what Chat itself would actually hand an agent for this project:
`ceilingChars` is Chat's own fixed 40,000-character ceiling, and `effectiveChars` is the
smaller of the reading budget and that ceiling (`0` when the reading budget is Index only).
This is additive and lets a client show "what Chat is really handed" without duplicating
Chat's own budget constant. It is a pure read: nothing is written, ever.

### POST /api/memory/:domain/:project/session-start/preview

**New in v3.67.0.** Same report as the `GET` above, but takes a `plan` — a proposed
`{slug: 'read-first'|'on-request'|'not-at-start'}` map, or since v3.70.0 a `budgetBytes` override —
and answers **as if** that were applied, without writing anything. This is what powers "Suggest a
reading plan"'s live preview and step ④'s hover-a-preset preview before you press Apply / choose.

### GET /api/reading-plan/:domain/:project/estimate

**New in v3.67.0 (`src/brain/reading-plan.js`).** `→ {ok, documentCount, inputChars, budgetBytes,
budgetSource: 'owner'|'standard', runsOn}`. Answers `200` even with no provider key saved, in which
case `runsOn.needsKey` is `true` — this route is read-only and safe to call to populate the ✨
Suggest-with-AI button's resting cost line.

### POST /api/reading-plan/:domain/:project/suggest

**New in v3.67.0.** Body is exactly `{arm: 'free'|'ai'}`. `→ {ok, arm, budgetBytes, budgetSource,
setBudgetSuggested, proposals: [{slug, title, bytes, current, proposed, reason, differs}], totals:
{readFirstCount, readFirstBytes, onRequestCount, notAtStartCount}, dropped: [{slug, reason}], notes,
runsOn?, spent?}`. **It never writes** — the caller applies a proposal through the existing `PATCH
…/foundations/:slug` route, one document at a time or in a batch. Refusals: `400 needs_key` (with
`runsOn`, on the `ai` arm with no key), `invalid_arm`, `unexpected_fields`, `invalid_project`; `403
readonly` (a Shared Brain mirror); `404 unknown_domain` / `project_not_found`; `409
manifest_unreadable`; `502 ai_failed` / `ai_unusable` (with `runsOn`, and `spent` whenever the
model billed before failing). With no reading budget set yet, the free and AI arms both plan
against **Standard** (64 KB) and `setBudgetSuggested` is `true`.

### POST /api/sharedbrain/check-clash

**New in v3.65.3.** Body `{storage_type, github_repo_owner, github_repo_name, shared_domain,
shared_brain_slug}` — no credential in the request. Runs the exact refusal `/save` runs, without
saving anything, so a clash can be caught on the wizard's first step rather than after a token has
already been pasted. `→ 200 {ok:true}` when the connection would be accepted, or `200 {ok:false,
kind:'identity'|'mirror', label, mirror, error}` naming which of the two clashes it is — the same
brain twice, or a different brain already using this computer's local mirror domain. `400` when the
body names no brain at all.

### GET /api/memory/:domain/:project/capture

**New in v3.63.0; shown on screen as Agent sessions since v3.70.0** (the route, and the store's
`captureFacts`, keep the old name — the same on-disk/on-screen split v3.65.1 gave Documents/Memory).
The **honesty meter**: *did this project's agent sessions start by reading its
state, and did they save before they stopped?* It counts only sessions that reached this project
**through the my-curator MCP bridge** — a session started only by the SessionStart hook or by
`my-curator context` at the command line reads the context without ever calling this route's
underlying tool, so it is not counted, and a zero reading can be an honest answer on a busy
project. It reads the local, content-free
[MCP usage log](mcp-user-guide.md) and groups it into sessions by the `sid` field v3.63.0 added,
filtered to one project by the `project` field it added beside it.

**It is read-only and it never blocks.** Nothing here writes — not the log, not the store, not a
cache — so asking for the meter costs nothing and can fail nothing. A meter that could refuse a
session would be enforcement, and capture is deliberately advisory.

**Query**

| Parameter | Default | Notes |
|---|---|---|
| `since` | 30 days ago | ISO 8601. **Best-effort**: an unparseable value falls back to the default rather than `400`ing |
| `limit` | `20`, max `200` | How many sessions to list. Non-numeric, or below 1, falls back to the default; above 200 is **clamped** to 200 |

**Success response** `200 OK`

```json
{
  "ok": true,
  "domain": "acme",
  "project": "lumina",
  "since": "2026-08-20T09:00:00.000Z",
  "logPresent": true,
  "lineCeiling": 300,
  "lineCeilingLabel": "300 bytes",
  "totals": {
    "sessions": 6, "sessionsRead": 5, "sessionsSaved": 4,
    "sessionsReadNotSaved": 1, "legacyLines": 0, "selfTestLines": 24
  },
  "sessions": [
    { "sid": "9f2c1a4b7e30", "client": "claude-code",
      "startedAt": "2026-09-19T09:02:11.000Z", "endedAt": "2026-09-19T10:44:02.000Z",
      "calls": 14, "read": true, "saved": true }
  ],
  "sessionsShown": 6,
  "sessionsTruncated": false,
  "newestSaveAt": "2026-09-20T13:05:00.000Z",
  "noSessionsButSaves": false,
  "note": null,
  "unit": "mcp-bridge-process",
  "logStartsAt": "2026-08-15T04:12:00.000Z",
  "windowStartsAt": "2026-08-20T09:00:00.000Z",
  "windowDaysCovered": 30,
  "windowCovered": true,
  "savesByTool": {
    "windowSeconds": 604800,
    "events": 9,
    "lowerBound": false,
    "eventsWithoutTool": 1,
    "tools": [
      { "id": "claude-code", "label": "Claude Code", "events": 6, "lastSeenAt": "2026-09-24T11:03:00.000Z" },
      { "id": "claude-desktop", "label": "Claude Desktop", "events": 2, "lastSeenAt": "2026-09-22T08:40:00.000Z" }
    ],
    "note": null
  }
}
```

**`unit`** *(v3.74.0)* names what a counted "session" actually is: one MCP bridge process id —
Claude Code starts one per session, Claude Desktop keeps one open across many conversations. The
value is always the literal `"mcp-bridge-process"`; the view words `sessions`/`sessionsRead`/
`sessionsSaved` as "connections" rather than renaming the wire fields.

**`logStartsAt` / `windowStartsAt` / `windowDaysCovered` / `windowCovered`** *(v3.74.0,
`captureWindowFacts()` in `src/brain/tray-summary.js`)* — the window the usage log **actually**
covers, alongside the window `since` *asked* for. A log that only began 5 days ago cannot support a
30-day claim:

| Field | Type | Meaning |
|---|---|---|
| `logStartsAt` | string \| `null` | ISO timestamp of the oldest line in the log |
| `windowStartsAt` | string \| `null` | ISO timestamp of the later of `logStartsAt` and `since` |
| `windowDaysCovered` | number \| `null` | Days from `windowStartsAt` to now, rounded to one decimal |
| `windowCovered` | boolean \| `null` | `true` only when the log reaches back to `since` at all |

All four are `null` together when no line in the log carries a usable time (including when
`logPresent` is `false`) — not measured, never `0`. This is the same derivation the widget and
`GET /api/mcp/usage?include=projects`'s `byProjectWindow` use, so the three never disagree about
how far back the log goes.

**`savesByTool`** *(v3.74.0, `projectSavesByTool()` in `src/routes/memory.js`)* — this project's
saves, per tool, over the pulse strip's fixed 7-day window (independent of `since`/`limit` above),
computed by the same `computePulse()` the menu-bar widget's "Saves by tool" strip uses, so the app
and the widget count a project's saves identically. `null` when nothing could be read (not
measured, never zero — a store with no work-streams, or a `listWorkingScopes` failure).

| Field | Type | Meaning |
|---|---|---|
| `windowSeconds` | number | The pulse window's width in seconds (fixed, currently 7 days) |
| `events` | number | Saves counted inside the window, across every tool |
| `lowerBound` | boolean | `true` when any journal tail was read only partially (16 KB cap) or the scope index itself was truncated — the counts below are then a **floor**, never an exact count |
| `eventsWithoutTool` | number | Saves in the window that named no tool at all |
| `tools[]` | array | One entry per distinct normalised tool seen, newest-seen first |
| `tools[].id` | string | The normalised tool id |
| `tools[].label` | string | The normalised display label |
| `tools[].events` | number | Saves by that tool inside the window |
| `tools[].lastSeenAt` | string | ISO timestamp — when that tool was **last seen** in what was read, never "last save": a save past a truncated tail is not seen at all |
| `note` | string \| `null` | The data layer's own wording for why the counts are a floor, when `lowerBound` is `true`; `null` otherwise |

**`totals` is computed over every session in the window, before `limit` truncates the list below
it** — the store's own rule (`distinctScopeCount`, `savedCopies`) restated for this reading: a count
taken after a display cap is a cap reported as a measurement. `sessionsTruncated` is how a caller
learns the list was cut without comparing lengths itself.

**What each reading means, exactly**

| Field | Definition |
|---|---|
| `sessions` | distinct `sid` with at least one line at or after `since`; a session touched by the window is then read **whole**, so one that bootstrapped eight days ago and saved today is not reported as *"did not read"* |
| `sessionsRead` | sessions where `get_project_context` or `get_working_state` answered `ok: true` **before that session's first save** |
| `sessionsSaved` | sessions where `save_working_state` answered `ok: true`. A **refused** save is not a save |
| `sessionsReadNotSaved` | the reading that matters: the agent had the context and did not write one back |
| `legacyLines` | lines with no `sid` — every line written before v3.63.0. Counted **before** the project filter, deliberately, because such a line carries no project and never could: the number is about the **log**, not about this project, and it is what lets a caller tell *"no sessions"* from *"this log predates the meter"* |
| `selfTestLines` | lines from the app's own *Test all 24 tools* run, excluded from every session figure |
| `newestSaveAt` *(v3.64.1)* | The newest save's **file** clock, independent of `sessions` and of the session-based totals above it — kept as its own reading precisely so it can disagree with them, which is the signal `noSessionsButSaves` below is built from |
| `noSessionsButSaves` *(v3.64.1; third term v3.65.1)* | `true` when a usage log exists, the window holds at least one save (by file clock), and zero sessions were logged in it — an absent log takes the plain "no usage log yet" note instead, never this one. The shape a bridge left running across an app update leaves: it keeps writing saves but, predating the session line added in v3.63.0/moved in v3.64.0, logs no session for them |

**`client` is `null`, not `"other"`, when no session line survives for that id** — rotated away, or
the append was in flight when the bridge child exited. *"A name we did not recognise"* and *"no
session line at all"* are different facts and stay different.

**An absent log is not an error.** `logPresent: false` with zeroed totals, an empty `sessions` array
and a `note` saying the meter starts counting with the first bridge session on v3.63.0. Silence in a
never-written log is not evidence that no agent ever worked here.

**`note` carries a second message, added in v3.64.1, when `noSessionsButSaves` is `true`:**
*"Saves in this window arrived through a bridge that logged no sessions — restart the app that
launched it (usually Claude Desktop)."* It answers the contradiction a plain reading of `totals`
cannot: a project can show `sessions: 0` in the same window `newestSaveAt` names a save from
minutes ago, because the bridge that wrote those saves predates the session line this meter counts
on. The note is present only under that condition and absent otherwise, so a genuinely quiet
project's `note` stays `null`.

**The log's on-disk path is deliberately not in this envelope.** The MCP bridge page's own privacy
panel is where a user reads it, and repeating it here would be a second place for that sentence to
go stale if the path ever moves.

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | `invalid_project` — the name is not a usable project name |
| `404` | Unknown domain, or `project_not_found` |

There is **no `403`** here and no `readonly` on the envelope: this is a read, and a Shared Brain
mirror's usage history is still real history. `refuseMirror` is reserved for this router's write
routes, and this is not one.

### GET /api/memory/:project — DEPRECATED

The v3.17.0–v3.47 detail route, where `:project` meant a **domain**. It is kept for **one
release**, resolving to that domain's *default project* (the legacy tree, read under the domain's
own name), and every response carries:

```json
{
  "deprecated": true,
  "deprecationNote": "GET /api/memory/second-brain is deprecated and will be removed after v3.48.0. Use GET /api/memory/second-brain/second-brain.",
  "replacedBy": "/api/memory/second-brain/second-brain"
}
```

It is kept not because anything in this repo still calls it — the `/next` view moved in the same
release — but because a user's browser can be running a cached older shell against a newer server
for as long as the tab is open. Otherwise identical to `GET /api/memory/:domain/:project`,
including `scope=latest`.

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
- **The standing brief has two writers, and both are the owner's.** It was written by nobody but a
  text editor until v3.48.0, which gave it the app's own editor (`PATCH …/projects/:project`,
  stamped `authoredBy.kind: 'human'`) and one MCP tool, `save_project_brief`, which refuses unless
  the caller says the owner instructed it and prepends a provenance comment saying so. That is what
  the **read** side rests on: `brief_authority` is four-valued, and its `commissioned` arm exists
  precisely *because* an agent can write the brief on the owner's instruction — so a verified
  brief's standing directives are still the user's own rather than an earlier session's untrusted
  notes. See [working-state.md § 4](working-state.md#tier-1-is-not-tier-2-the-brief-is-the-owners).
- **New in v3.59.0: `save_working_state` accepts `foundations_read` and `repo_root`.**
  `foundations_read` (camelCase `foundationsRead` also accepted) is `{slug: sha256}` — the
  documents this session actually read, recorded from `get_project_context`'s own response — and
  is written into `current.md` as a real `## Foundations read` bulleted section, counted toward
  the same 48 KB handoff budget as any other list. `repo_root` is advisory: when the project is
  repo-owned and `<repo_root>/.curator-project` names this domain/project and the path is
  reachable, the save **also** runs a foundations refresh as a side effect and reports it under
  `foundationsRefresh` in the result — never failing the save itself if the refresh does. Neither
  field is required; a save that omits them behaves exactly as before v3.59.0.
- **New in v3.59.0: `get_working_state` gains a `foundations` summary**, forwarded whole from
  `summariseFoundations` — `{present, count, totalBytes, staleCount, unreachableCount,
  skeletonCount, readFirstCount, onRequestCount, budgetExceeded, orphanFileCount, manifestError}`,
  grown by v3.61.0 and v3.62.0 — on every response, scope-less or scoped, disclosed
  the same way every other field on this response already is (`test-working-state-disclosure.js`
  extended for it, never exempted).
- **New in v3.65.0: `get_working_state` also forwards `knowledgeDomains` /
  `knowledgeDomainsDefaulted`** (and `knowledgeDomainsError` when `project.json` is unreadable), in
  the store's own spelling, exactly as `get_project_context` does — one fact, one spelling, across
  both tools.
- **New in v3.74.0: `save_working_state` returns `overwrote`, non-null when this save replaced a
  handoff a DIFFERENT tool wrote in this `(scope, machine)` folder** — always present (never
  omitted), so "no other tool's handoff was replaced" is itself a stated value (`null`), not an
  absent key to interpret. No warning fires when either side named no tool: an unnamed harness is
  no evidence the prior save came from a different tool. Shape:
  `{harness, harnessId, harnessLabel, model, writtenAt, headline, bodyBytes, suggestedScope,
  previousPath, previousError}` —
  `harness`/`harnessId`/`harnessLabel` name the tool whose handoff was just replaced (raw spelling,
  normalised id, normalised label); `model`/`writtenAt`/`headline` describe that replaced save;
  `bodyBytes` is the replaced handoff's own size; `suggestedScope` is a scope slug named for the
  **incoming** tool (e.g. `claude-code`) — where to save from now on instead of colliding again;
  `previousPath` is the path the replaced handoff's bytes were copied to as `previous.md`
  (`state/<scope>/<machine>/previous.md`), or `null` if the copy could not be made; `previousError`
  is present only when the copy failed (`'unsafe-path'`, `'too-large'`, or the write error's code)
  and is absent when the copy succeeded. The copy is best-effort — a failed copy never fails the
  save itself, per the owner's warn-never-refuse rule. `report` restates the same fact in one
  sentence (`otherToolReplaceSentence()`), and the journal gets its own note naming the tool, the
  time and where the text was kept.
- **New in v3.74.0: `get_working_state` accepts `previous: true`** (boolean input arg; strict
  `=== true`, the same convention `replace` uses) and, when the requested `(scope, machine)` folder
  holds a kept copy of another tool's replaced handoff, returns `previous`. Without `previous: true`
  in the call, `previous` still appears — whenever the copy exists — as a summary with no text:
  `{harness, harnessId, harnessLabel, model, writtenAt, headline, bytes, path}` (identical shape to
  the HTTP route's `previous`, [documented above](#get-apimemorydomainproject)). With
  `previous: true`, the same object additionally carries `text` (the copy's full sanitised content,
  framed as recorded data exactly like `current.text` — never instructions to obey), `truncated` and
  `sanitisedOnRead`. `previous` is omitted entirely (not `null`) when no such copy exists for that
  `(scope, machine)` folder.

Full contract: [working-state.md](working-state.md) and
[architecture.md § `src/brain/working-state.js`](architecture.md#srcbrainworking-statejs-v3170).

---

### `get_project_context` and `save_foundation` — MCP-only, no HTTP surface

**New in v3.59.0.** Like `save_working_state` and `save_project_brief` above, these two tools have
no HTTP route: they are reached only through the My Curator MCP, from a local client that can spawn
`mcp/server.js` as a stdio child process.

**`get_project_context`** *(read)* — the session-start bootstrap. Input:

```json
{ "domain": "acme", "project": "lumina", "scope": "latest",
  "include": "changed", "max_bytes": 120000,
  "seen_hashes": { "architecture.md": "9f2a…" } }
```

Every argument is optional. With no `seen_hashes` (a first session), `include` defaults to `all`;
with `seen_hashes` supplied — directly, or defaulted from the latest handoff's own
`foundations_read` when the caller sends none — it defaults to `changed`, so a returning session's
bootstrap carries only what has moved since it last recorded reading.

```json
{
  "ok": true, "domain": "acme", "project": "lumina", "resolved_by": "explicit",
  "content_is_data": ["current", "foundations.documents"],
  "knowledgeDomains": ["acme"], "knowledgeDomainsDefaulted": true,
  "brief": { "authority_note": "…", "brief_authority": "owner", "text": "…", "…": "…" },
  "current": { "…": "…" },
  "foundations": {
    "index": [ { "slug": "architecture.md", "changedSinceSeen": false, "…": "…" } ],
    "documents": [ { "slug": "decisions.md", "text": "…", "sha256": "…" } ],
    "includeMode": "changed",
    "budget": { "maxBytes": 120000, "usedBytes": 8420, "truncated": false, "omitted": [] },
    "readingOrder": ["architecture.md", "decisions.md", "conventions.md"]
  },
  "seen": { "architecture.md": "9f2a…", "decisions.md": "b71c…" },
  "report": "Loaded the brief, the latest handoff, and 1 of 6 foundations that changed since you last read them; 5 were already current."
}
```

**Paged delivery (v3.70.0).** Add `"page": 2` (a whole number ≥ 1; anything else is a 400-style
`invalid-page` refusal) to fetch page 2 onward of a bootstrap too large for one reply. A reply that
is not the last one carries `foundations.continuation: {page, of, remaining, slugs}`, and `report`
is prefixed `"PAGED: this project context arrives in N replies of at most ≈20k tokens each…"` with
the exact next call spelled out. **Call again with the same arguments plus that `page` number, and
keep going until a reply carries no `continuation` — read every page before you start work.** Do
not pass a later page's `seen` back as `seen_hashes` between pages; record **page 1's** `seen` as
`foundations_read` on your next `save_working_state`. A reply that already fits in one page (≈80 KB,
`CONTEXT_PAGE_BYTES`) carries no `page`/`continuation` at all and is byte-identical to v3.69.0. This
exists because Claude Code — and likely other harnesses — shows an MCP reply of at most ≈25,000
tokens and silently saves anything larger to a file instead of putting it in the model's window;
paging keeps every reply inside that cap so nothing sent "arrives" only in a file the agent never
opens.

The envelope order mirrors `get_working_state` exactly — `ok`, `project`, `domain`, `resolved_by`,
`content_is_data`, then `brief` with `authority_note`/`brief_authority` first inside it — because a
caller that has already learned to read one response should not have to re-learn the other. `seen`
is the map to send back on the **next** `save_working_state` call, as `foundations_read`: the
bootstrap itself never writes, so recording what was read is the caller's job, on its own save.

**New in v3.65.0:** the envelope also carries `knowledgeDomains` / `knowledgeDomainsDefaulted` —
and `knowledgeDomainsError` when `project.json` could not be read — because the handler forwards
every unhandled store key verbatim, and `report` gains a clause naming which wikis to search with
`search_wiki` / `search_cross_domain`.

**`save_foundation`** *(write)* — refused without `commissioned_by_owner: true`, the same
commissioned-only rule `save_project_brief` already enforces:

```json
{ "domain": "acme", "project": "lumina", "slug": "conventions.md", "role": "conventions",
  "title": "Conventions", "text": "# Conventions\n…", "commissioned_by_owner": true }
```

```json
{ "ok": true, "slug": "conventions.md", "bytes": 6120, "sha256": "…",
  "replaced": false, "budget_exceeded": false }
```

Calls `refuseIfReadonly()` only — foundations sit outside the wiki's graph cache, so this tool does
**not** call `invalidateGraph`, unlike the wiki-mutating tools above. **As of v3.69.0** the check is
per document, not per project: it is refused only when the slug it is asked to write is a
**mirrored** document's (`ownership-mismatch`, naming the source) — a save under a new slug always
succeeds, in any project, including one that also mirrors — see
[Document-level source](working-state.md#document-level-source-and-the-one-writer-rule-project-wide-ownership-retired-in-v3690).

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
`GET /api/memory` calls, so the widget and the Project-context view cannot disagree about what is on
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
> **14 cells of 12 hours** in 55 × 15 points. Nothing here changes: `windowSeconds`, `bucketSeconds`
> and `buckets[]` are the contract, and a consumer is free to draw them at full resolution. A
> renderer's legend must quote `drawnBucketSeconds()` rather than `bucketSeconds`, because a legend
> has to describe the picture in front of the reader. The 13-of-28 store above folds to **6 of 14**
> unknown cells — still half the strip.

> **`TRAY_DEFAULT_LIMIT` is 8; the tray shell asks for 40.** The default is what a caller gets when
> it expresses no opinion. `desktop/main.js` sets `TRAY_ROW_LIMIT = TRAY_FETCH_ROWS` (**40**,
> imported from `tray-model.js`), and `buildTrayModel()` caps the DISPLAY at `MAX_ROWS` (5)
> independently. It asks for more than it can show on purpose: since v3.48.0 the menu GROUPS rows
> by project, and a fetch capped at what fits cannot group — it would hand the model five rows
> already chosen by another rule. Because `total` and `pairsOnDisk` are both counted **before** the slice,
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

## GET /api/config/instances

**Is another copy of The Curator serving this same knowledge folder right now?** (v3.46.0.) No
body, no side effects, no network, no LLM. One `readdir` of a directory holding one small JSON file
per live process, plus a `kill(pid, 0)` liveness probe per file.

The `/next` shell calls this **once per page load** and renders a dismissible banner when the list
is non-empty. It is deliberately not on a timer: the condition it reports is "you launched two
apps", which does not change second by second.

**Success response** `200 OK`

```json
{
  "ok": true,
  "domainsPath": "/Users/you/the-curator/domains",
  "othersTotal": 1,
  "others": [
    { "pid": 4123, "port": 51234, "kind": "the Mac app", "startedAt": 1788504930160 }
  ]
}
```

| Field | Meaning |
|---|---|
| `ok` | `true` when the registry could be read. `false` means *we could not find out* — never *nobody else is running* |
| `domainsPath` | The resolved knowledge folder this answer is about |
| `othersTotal` | The **honest** count of other live instances, before the array cap |
| `others` | Up to 10 of them. **This process is always excluded** — a banner must never fire for the app the user is looking at |
| `others[].pid` | The other copy's process id. Reported deliberately: this is a loopback-only single-user app, and the pid is the one thing that lets a user find and quit it |
| `others[].port` | The port it bound, or `null` if it did not record one |
| `others[].kind` | Plain words: `the Mac app` · `an installed app` · `a terminal checkout` |
| `others[].startedAt` | Epoch ms |

The per-instance shape is an **explicit allow-list**, never a spread of the stored record (the
v3.3.0 `toWire()` rule), and `othersTotal` rides alongside the capped array so a cap can never be
mistaken for a measurement (v3.17.0's rule).

**Never 500s.** A registry that cannot be read answers `200` with `ok: false`, an empty `others`
and an `error` string. A detection endpoint that threw would make the client's banner logic the
thing that breaks.

**What this does NOT do.** Nothing is refused, locked, or blocked. Two Curators over one folder is
a supported configuration (see
[user-guide.md § Two installs, one knowledge folder](user-guide.md#two-installs-one-knowledge-folder));
this endpoint only makes it visible. One known false positive: if a Curator was force-killed and
the OS re-used its pid, a stale record can read as live. A clean quit removes its own record, so
this is rare, and the design prefers it to a heartbeat that could lapse and go silent while two
apps really were writing.

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

## POST /api/config/pick-path

**New in v3.61.1.** Open a native folder picker and say what was picked. **Unlike `pick-folder`
above, this route mutates nothing** — it calls no setter, takes no write lock and needs no
`guardConcurrent`, because there is nothing for a concurrent write to conflict with. It exists for
the Foundations chooser, which needs a folder *name* to put in a text field with the knowledge base
left exactly where it is — folding that into `pick-folder` behind a flag would put "and sometimes
it does not repoint your whole knowledge base" inside a route every existing caller depends on for
the opposite behaviour.

**Body**

| Parameter | Description |
|---|---|
| `prompt` | Optional. A **key** into a frozen table of dialog-title literals (`foundations` → *"Choose the folder that holds this project's documents:"*, anything else, including omitted, → the generic *"Choose a folder:"*). Never interpolated into the dialog title directly — the repo arm builds an `osascript` command string, so a client-supplied prompt would be shell-interpolated, which this app refuses everywhere. An unknown key takes the default rather than being refused |

**Success response** `200 OK` — a folder was chosen

```json
{ "ok": true, "path": "/Users/you/code/your-project" }
```

**Success response** `200 OK` — the user dismissed the dialog

```json
{ "ok": false, "reason": "cancelled" }
```

**Refusal response** `501 Not Implemented` — this build/platform has no picker at all

```json
{
  "ok": false, "reason": "no-dialog",
  "message": "This build cannot open a folder picker (no folder picker on this system).",
  "hint": "Type or paste the full path to the folder instead."
}
```

**Error response** `500` — a picker that should work did not — `{ "ok": false, "reason": "failed", "message": "…", "hint": "…" }`.

⚠️ **The client keys on `reason` alone**, and `no-dialog` is a **fact**, not a failure: the
Foundations chooser withholds its "Choose folder…" button and prints the reason rather than
offering a control that can only ever refuse. Same repo-arm/`native-dialog`-arm fork as
`pick-folder` (macOS `osascript`, or the desktop shell's `pickFolder` hook under Electron), and the
same `-128`-is-cancel / bare-exit-1-is-cancel classification — but every other post-pick decision
`pick-folder` makes (existence check, `setDomainsDir()`, the concurrency re-check) is absent here on
purpose.

---

## GET /api/config/github-read-token

**New in v3.65.2.** Status of the read-only GitHub token the Documents "Mirror from GitHub" panel
reads with under `tokenSource: 'config'`. **Never returns the value** — only whether one is saved,
its last four characters, and its kind.

**Success response** `200 OK`

```json
{ "ok": true, "present": true, "last4": "ab12", "kind": "fine-grained" }
```

`kind` is `"fine-grained" | "classic" | null` (`null` only for a hand-edited value of an
unrecognised shape — reported as present, not silently treated as absent). With nothing saved:
`{ "ok": true, "present": false, "last4": null, "kind": null }`.

---

## PUT /api/config/github-read-token

**New in v3.65.2.** Save the read-only token. `guardConcurrent`'d, like every credential write in
this file.

**Body**

| Parameter | Description |
|---|---|
| `token` | Required, a string. Trimmed; must match `github_pat_…` (fine-grained) or `ghp_…` (classic), with no whitespace, within a sane length bound |

**Success response** `200 OK` — same shape as the GET, `present: true`.

**Refusal response** `400 invalid_token` — the value did not trim to a recognised shape.

**Error response** `500 config_unreadable` — `.curator-config.json` exists but does not parse as
JSON; nothing was written, because writing would have replaced every other setting in it with an
empty object.

⚠️ The token is never echoed back in any response, log line or thrown error — a redaction pass
strips it from error messages even on an unexpected failure.

---

## DELETE /api/config/github-read-token

**New in v3.65.2.** Remove the saved token. `guardConcurrent`'d.

**Success response** `200 OK`

```json
{ "ok": true, "present": false }
```

Removes only the `githubReadToken` key; every other setting in the file is carried through
untouched. A config with no token saved is not rewritten at all — Disconnect on a clean install
creates no file and moves no mtime.

---

## POST /api/config/github-read-token/test

**New in v3.65.2.** Read one repository's ref with the **stored** token, to confirm it can see what
it is meant to mirror. **Not** `guardConcurrent`'d — it is a read.

**Body**

| Parameter | Description |
|---|---|
| `remote` | Required. `owner/repo`, or the `https://` or `git@` address GitHub itself prints |
| `ref` | Optional. A branch or tag name. Omitted, the client resolves the repository's default branch first (a second GET) |

A `token` field in this body, if sent, is **ignored** — the route always reads with the token
already saved on this computer, never one supplied over HTTP.

**Success response** `200 OK` — the request ran and GitHub answered

```json
{ "ok": true, "repo": "owner/repo", "ref": "main", "sha": "a1b2c3d…", "requests": 1 }
```

`requests` is `1` when `ref` was named, `2` when the default branch had to be resolved first.

**Success response** `200 OK`, `ok: false` — the request ran and GitHub **refused**

```json
{ "ok": false, "code": "unauthorised", "repo": "owner/repo", "message": "…", "requests": 1 }
```

`code` is one of `unauthorised` / `not_found` / `rate_limit` / `network` / `malformed` / `http` /
`failed`. This is a **200**, not an error status — the test *ran*; GitHub's answer is the payload,
not a failure of this endpoint. Every message names the token's *source*, never its value.

**Refusal response** `400` — the request itself could not be made:

| `code` | When |
|---|---|
| `invalid_remote` | `remote` did not parse as `owner/repo` or a recognised GitHub URL |
| `invalid_ref` | `ref` was sent but is not a string this app will put in a URL |
| `no_token` | No read-only token is saved in Settings → Knowledge base — nothing to test with |

⚠️ **This is the only HTTP path a GitHub token value ever arrives on** (the `PUT` above) — every
other response about it (this GET, the Context view's own reads) carries presence and `last4` only,
never the value.

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
  "connected": { "gemini": true, "anthropic": false, "openrouter": false },
  "activeProvider": "gemini",
  "activeModel": "gemini-2.5-flash-lite",
  "build": {
    "model": "gemini-2.5-flash-lite",
    "provider": "gemini",
    "source": "default",
    "facts": {
      "contextLength": 1048576,
      "priceIn": 0.10,
      "priceOut": 0.40,
      "measured": true,
      "thinks": false,
      "outlineNote": "plans 18–20 pages per source"
    },
    "cheapestMeasured": {
      "model": "gemini-2.5-flash-lite",
      "provider": "gemini",
      "priceIn": 0.10,
      "priceOut": 0.40,
      "same": true
    },
    "liveMissing": false,
    "liveListing": { "checkedAt": "2026-09-16T13:38:55.201Z", "source": "network", "count": 41 }
  },
  "catalogueCounts": { "total": 7, "canBuild": 6, "measured": 7, "free": 0, "batchHidden": null },
  "chat": { "startsOn": { "model": "gemini-2.5-flash-lite", "provider": "gemini" }, "count": 7 },
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

### The Providers-page fields (v3.45.0)

All additive; every existing field above is unchanged. Every one is computed **on the server**,
because each is a derived money fact and a client re-deriving it would be a second opinion about
what the user is paying.

- `connected` — `{ gemini, anthropic, openrouter }` booleans. The **same expression** as the
  `hasXKey` fields beside them, in a shape a client can iterate a provider list over. The older
  names are pinned by an earlier contract and cannot be removed; both are derived once, in one
  place, so they cannot disagree.
- `build` — what actually builds the wiki right now, `null` when no provider resolves.
  - `source` — `'default'` | `'selected'` | `'env'` | `'fallback'`. `'fallback'` ranks first: it is
    the one case where the model in force is not the model anybody chose, and it describes what is
    actually being billed. `'env'` means `LLM_MODEL` is overriding everything.
  - `facts` — read off the catalogue entry, never re-typed. **Every field is `null` when the entry
    does not carry it**: absent means UNPUBLISHED or UNMEASURED, and a zero would state a
    measurement nobody took. `outlineNote` is a composed one-liner (`"plans about 23 pages per
    source · about 48s per call"`), built from the promoted measurement *fields* rather than by
    regexing a number back out of the model's `note` prose; a clause whose field is absent is
    omitted, and `null` means nothing was measured at all.
  - `liveMissing` — **three-valued: `true` | `false` | `null`.** Has the provider removed the model
    this user is pinned to? `null` is a VALUE, not an omission: it means *nobody has checked in this
    process, the last check failed, or the provider was never connected*. Render it as **unknown**,
    never as `false` — *"we could not check"* must never be served as *"it is present"*. Populated
    by [`POST /api/config/models/check`](#post-apiconfigmodelscheck), and for OpenRouter also at
    boot from the persisted catalogue sidecar (no network, no key).
    ⚠ **A `true` here does not change what runs.** `activeModel` and `build.model` above are still
    the model the engine resolves; this field drives a message and a pre-spend refusal, never a
    silent re-pin (v3.45.0's Option B — moving the build lane, and the bill, is the user's act).
  - `liveListing` — what the verdict was taken against: `{checkedAt, source, count}` or `null`. A
    verdict with no denominator is not reviewable, so the size and provenance of the list travel
    with it. `source` is `'network'` or `'disk'`.
  - `cheapestMeasured` — the cheapest model, across the providers the user has **connected**, that
    is both build-lane and measured, or `null`. Derived from the **whole, unfiltered,
    price-ordered** population — never index 0 of a display list, which is precisely the defect the
    router audit found in the client's old `cheapest` badge (under *most expensive first* it badged
    the dearest row). `same: true` means it IS the model already in force. ⚠ `priceIn`/`priceOut`
    are `null` for a **free** model — free is a price we know exactly and has no per-token figure;
    render it as free, never as *unpriced* and never as `$0.00`.
- `catalogueCounts` — `{ total, canBuild, measured, free, batchHidden }`, counted over the same
  key-gated population `offerable` serialises, with no sort, filter or cap applied first (reporting
  a CAP as a MEASUREMENT is a defect this project has shipped twice). `batchHidden` is **not** a
  count of that population — those `:batch` ids were rejected before admission — it comes from the
  last catalogue sync's own funnel and is **`null` when unknown** (a catalogue persisted by an older
  build carries no funnel). Null must render as unknown: `0` would assert that no batch-only id was
  found, which was false for 60 of them on the 2026-09-02 catalogue.
- `chat` — `{ startsOn: { model, provider } | null, count }`. `startsOn` is a **readout** of the
  engine's own resolution (the pair that answers if the user sends a message without touching the
  composer's picker), not a second derivation of the precedence ladder. `count` is the whole
  connected population: chat has no build-lane gate, deliberately.

## POST /api/config/api-keys

Save API keys (partial update — only overwrites provided fields).

**Since v3.45.0 a key save sets `activeProvider` ONLY when nothing is active yet** — the first key
you connect takes the build lane; every later save leaves it where it is. `POST
/api-keys/build-model` is the only writer afterwards. The policy is one constant,
`ACTIVE_PROVIDER_DERIVED` in `src/brain/config.js`; `false` restores v2.4.2 *last-saved-wins*
exactly, with no field or storage change. See
[model-lifecycle.md](model-lifecycle.md#saving-a-key-does-not-change-which-model-builds-your-wiki-v3450).

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
  "skippedActivation": [],
  "activationDeferred": [{ "provider": "anthropic", "activeProvider": "gemini" }],
  "activationPolicy": "derived"
}
```

- `activationPolicy` — `"derived"` (v3.45.0+) or `"last-saved-wins"`. Reported on **every** save,
  never only when interesting: a client that must distinguish a deferring build from an older
  always-switching one cannot do it from an absent field, and inferring the policy from behaviour is
  how a client ends up asserting a rule the server does not have.
- `activationDeferred` — an array of `{ provider, activeProvider }`. An entry means the key **was
  saved**, that provider **could** have taken the build lane, and deliberately did not because one
  is already set. It is a successful policy, not a failure, and is kept **out of**
  `skippedActivation` for that reason — that array means *could not be activated* and renders under
  a warning icon; announcing a working policy as a warning on every second key save trains users to
  ignore the array that carries the real failure.

- `skippedActivation` — an array of `{ provider, reason }`. An entry means the key
  **was saved** but that provider did **not** become active, because it has no model available for
  the build lane (`reason: "no_build_model"`). The save genuinely succeeded, so this is not an
  error — it is the signal a UI needs in order to explain why the active provider did not move.
  Without it the user sees a successful save and an unchanged active provider with no reason given,
  which reads as the app ignoring the click.
  - ⚠ **It is empty for every provider that ships today.** All three — `gemini`, `anthropic` and
    `openrouter` — have a build-lane model, so none of them is refused for that reason. Treat this
    array as a channel that may legitimately never carry anything. It is **not** the signal that a
    save left the build lane alone — that is `activationDeferred` above, and the two mean different
    things: *could not* versus *deliberately did not*.

  It exists because activating a provider that cannot build silently breaks ingest, Health and
  Compile. See
  [model-lifecycle.md → OpenRouter](model-lifecycle.md#the-state-of-the-build-lane-in-this-release).

## POST /api/config/api-keys/disconnect

Clear one provider's stored key. Body: `{ "provider": "<provider>" }`. Config keys only — a
lingering `.env` key does not hold a provider active after the user disconnected it (the v3.0.13
rule).

**If the cleared key was the active one, the build lane moves — and since v3.45.0 it moves by
PRICE rather than by position in a hardcoded array.** The destination is the cheapest provider still
connected that has a **measured build-lane model**, falling back to provider order when there is
nothing to order. The response says so, because silently changing what a user is billed for and then
not mentioning it is the surprise this release exists to remove, not to relocate:

```json
{
  "ok": true,
  "activeProvider": "openrouter",
  "activeModel": "upstage/solar-pro4",
  "buildLaneMoved": true,
  "previousActive": "gemini",
  "reason": "cheapest_measured"
}
```

- `reason` — `"cheapest_measured"` (price ordering ran and governed), `"first_connected"` (there was
  nothing to order, or the ordering could not be trusted), `"all_refused"` (candidates existed and
  every one was refused the build lane), `"none_left"` (no candidate at all), or `"not_active"` (the
  disconnected provider was not the one building, so nothing moved).
- `buildLaneMoved` is `false` whenever the disconnected provider was not the active one.

## POST /api/config/models/check

Ask ONE provider for its current model list and record it, so the app can answer
*"has the provider removed the model I am pinned to?"*.

**Body**

```json
{ "provider": "openrouter" }
```

`provider` is one of `gemini` | `anthropic` | `openrouter`. Anything else is a
**400**. A provider with no key **saved in Settings** is a **400** — config-scoped,
never `.env` (the v3.0.13 rule): a provider the user Disconnected must not be
polled with a lingering developer key.

**Response — 200**

```json
{
  "provider": "openrouter",
  "checkedAt": "2026-09-16T13:38:55.201Z",
  "source": "network",
  "chosen": "minimax/minimax-m3:free",
  "liveMissing": true,
  "listedCount": 443
}
```

- `chosen` — the model the verdict is **about**, resolved through the engine's own
  `getDefaultModel()`, so the answer cannot be about a different model from the one
  that would spend.
- `liveMissing` — `true` | `false` | `null`, with the same three-valued meaning as
  on `GET /api-keys` above.
- `listedCount` — how many ids the provider published, so the verdict has a
  denominator. `null` when nothing was recorded.

**Response — 200 on FAILURE**

```json
{
  "provider": "openrouter",
  "checkedAt": "2026-09-16T13:41:02.884Z",
  "source": "network",
  "chosen": "minimax/minimax-m3:free",
  "liveMissing": null,
  "listedCount": null,
  "error": "openrouter could not be reached, so nothing was checked: …"
}
```

A failure is a **200 with a verdict**, not an HTTP error — the same posture as
[`POST /api/config/api-keys/validate`](#post-apiconfigapi-keysvalidate), and for
the same reason: a 502 here lands in the client's generic network-error path and
the actionable detail is discarded. `liveMissing` is `null`, **never `false`** — a
failed check learned nothing. **Nothing is recorded**, so a previously recorded
listing and the persisted catalogue are left byte-identical; one transient DNS
blip can never read as *every model you own has been removed*.

**Cost: free.** All three are list endpoints — no tokens, no generation, no charge.

**It may never admit a model.** This route stores a set of strings. It does not
call `defineOfferableModel` or `setOpenRouterCatalogue`, and an offline suite
asserts `listOfferableModels(provider)` is byte-identical across a *successful*
check that fetched an id the app has never offered. The standing rule is that a
model may not be offered for a feature it has never been measured against, and an
availability check is exactly the mechanism that would erode it.

**Concurrency:** carries `guardConcurrent`, so it **409**s while a write is in
flight. That is deliberate and is the opposite of `/api-keys/validate`, which is
exempt: this route records process-wide state that the ingest pre-spend gate
reads, so a check landing mid-batch could change what the next item is allowed to
do. The axis is *"does an in-flight write observe this"*, not *"does it touch the
disk"*.

⚠ **Anthropic lists dated ids** (`claude-haiku-4-5-20251001`) while the app pins
undated aliases (`claude-haiku-4-5`). A `false` for such an alias is resolved
through an explicit dated-suffix rule; see
[docs/model-lifecycle.md § When a provider removes a model](model-lifecycle.md#when-a-provider-removes-a-model).

---

## GET /api/config/models/new

**Free.** What your connected providers list that this app has no record of. Every endpoint behind
it is a *list* endpoint: no tokens, no generation, no charge. Cached for 24 hours in a sidecar;
`?force=1` bypasses the cache.

**It never offers anything.** The result is a list of ids and the date each was first seen. Nothing
writes to the offer table, and there is deliberately no companion `POST` that would: adding a model
requires a measurement, which is a human act. "Not offered" means **unmeasured** — never better, and
never worse.

```json
{
  "ok": true,
  "checkedAt": "2026-09-02T13:00:00.000Z",
  "cached": false,
  "ageMs": 0,
  "maxAgeMs": 86400000,
  "providers": {
    "anthropic": {
      "connected": true,
      "checked": true,
      "error": null,
      "listed": 11,
      "rejectedUnoffered": null,
      "suppressed": { "movingAlias": 0, "belowChatFloor": 0 },
      "models": [
        { "id": "claude-fable-5-1", "label": "Claude Fable 5.1",
          "contextLength": 1000000, "created": "2026-08-28T00:00:00Z",
          "firstSeen": "2026-09-02T13:00:00.000Z" }
      ]
    },
    "gemini": { "connected": true, "checked": true, "error": null, "listed": 38, "rejectedUnoffered": null, "models": [] },
    "openrouter": { "connected": false, "checked": false, "error": null, "listed": null, "rejectedUnoffered": null, "models": [] }
  }
}
```

- **`connected` and `checked` must BOTH be read.** `checked: false` with an empty `models` means
  *we could not ask* — which is not the same fact as *nothing new* and must never render as one.
  A failing provider carries `error`; a disconnected one carries `connected: false` and no error.
- `firstSeen` is **sticky**: an id already known keeps the date it was first observed across
  refreshes. Restamping everything with today's date would make every id look new forever.
- `suppressed` — `{ movingAlias, belowChatFloor }`, ids dropped because the app would refuse them
  anyway: a `*-latest` moving alias (the offer factory refuses those by name) or a window under the
  32,768-token admission floor. **Counted, never silently dropped** — `listed − models.length`
  is fully accounted for by these two numbers plus what the app already has a record of. Measured
  live on 2026-09-02: Gemini listed 38, of which 31 were unrecorded and 6 of those unactionable
  (3 aliases, 3 text-to-speech models at 8,192 tokens). An **unknown** context length never
  suppresses: unknown is not small, and over-reporting is the safe direction.
- **Anthropic and Gemini** report any listed id the app has no record of, where "record" means
  `OFFERABLE_MODELS` ∪ `AWAITING_MEASUREMENT` ∪ the provider default ∪ its fallback chain — so a
  model somebody already looked at and deliberately deferred is not re-raised every day.
- **OpenRouter asks a narrower question**, because its catalogue is synced wholesale: it reports
  only ids that **pass** the eligibility filter and are still not offered, i.e. the synced catalogue
  is stale. The rejected-and-unoffered population is reported as the count `rejectedUnoffered` so the
  arithmetic adds up without listing ~200 correctly-rejected ids.
- **Known false positive, kept deliberately:** Anthropic lists dated ids
  (`claude-haiku-4-5-20251001`) while the app stores the undated alias, so the dated form is
  reported as unknown. Stripping a trailing `-YYYYMMDD` would be a guess about another vendor's id
  scheme, and a wrong strip would *suppress* a genuinely new model — the one thing this check exists
  to catch. Over-reporting is the safe direction.

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
- `POST /api/query` (above) is a simple, single-shot Q&A endpoint — separate from the Chat view's `POST /api/chat/:domain` — and it still sends up to 90,000 characters of concatenated wiki content to the LLM in one call, in arbitrary file order (`src/brain/query.js`). On a wiki bigger than ~90 KB of raw page content, later pages are silently left out of that request. **The Curator's own web UI never calls this endpoint** — there is no reference to it anywhere in `src/public/`, so the only way to reach it is a direct HTTP call to the loopback server (curl, a script, another tool). The Chat view does **not** have this limitation: since v3.0.1-beta.11 it uses query-driven page selection (score pages by relevance to the question, load up to ~60 KB of full content plus a ~12 KB slug catalogue — see [docs/ingestion-pipeline.md §10b](ingestion-pipeline.md#10b-the-chat-read-side-v301-beta11-refined-in-v301-beta13)), so it scales to much larger wikis. If you're calling `/api/query` directly against a large wiki (150+ pages), prefer `/api/chat/:domain` instead, or expect its answers to reflect only whatever page content the alphabetical/readdir order happened to include.
- **Known limitation — `POST /api/ingest-queue` and a filename containing a raw double-quote character.** The multipart parser (upstream of the batch-ingest queue's own code, in `busboy`) mis-parses a `Content-Disposition` header whose filename contains an unescaped `"`: the request still returns `200`/`ok: true`, but that one file is silently absent from `items` — no `rejected` entry, no warning of any kind. A NUL byte in a filename fails the parse outright instead, and is reported as a plain `400`. Neither is reachable from a browser — the WHATWG form-serialisation spec escapes `"` to `%22` before the request is ever built, and NUL is not a legal filename byte on any mainstream filesystem — but a hand-built multipart request from a script or another tool can trigger the quote case silently. If you are integrating against this endpoint programmatically, avoid unescaped `"` in filenames sent this way.
- **Known limitation — a domain missing `wiki/log.md` fails a completed ingest at the very last step.** This affects both `POST /api/ingest` and `POST /api/ingest-queue` identically (both funnel through the same `appendLog` in `src/brain/files.js`, which has no existence check on `log.md`, unlike the equivalent `readIndex` two lines below it). If it's missing, the ingest still runs to completion — pages are written to disk, real AI spend has happened — and only the final logging step throws `ENOENT`, which surfaces as a `failed` item with a cryptic error. Not reachable through any documented path (`createDomain()` always writes `log.md`, and [docs/domains.md](domains.md) tells manual-setup users to create it too), so it takes a hand-built domain folder to hit. Recovery: the pages are correct and unaffected — create an empty `wiki/log.md` and re-ingest the same source (safe; see the idempotency notes above).
