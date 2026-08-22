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

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `displayName`; new slug identical to old slug |
| `404` | Domain not found |
| `500` | Filesystem error |

---

## DELETE /api/domains/:domain

Permanently delete a domain and all its contents (wiki pages, conversations, source files).

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

**Read-only mirrors (v3.0.2+):** every mutating Health endpoint (`/fix`, `/fix-all`, `/fix-all-safe`, `/broken-links/apply`, `/orphans/apply`, `/semantic-dupes/merge-batch`) returns **400** when `:domain` is a read-only Shared Brain mirror (`readonly: true` in the domain's `CLAUDE.md`) — fixes to a mirror would be overwritten on the next Pull. Scanning (`GET /api/health/:domain`) and read-only planning endpoints still work on mirrors.

**Success response** `200 OK`

```json
{ "ok": true, "fixed": 1, "total": 1 }
```

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `type`; type is review-only (`orphans`), or `brokenLinks` issue has no `suggestedTarget` |
| `404` | Unknown domain |

---

## POST /api/health/:domain/fix-all

Apply every fix of a given type in one call. Re-scans the wiki, then applies each fix in turn.

**Request body** `Content-Type: application/json`

```json
{ "type": "missingBacklinks" }
```

**Success response** `200 OK`

```json
{ "ok": true, "fixed": 7, "total": 7 }
```

`fixed` may be less than `total` if any individual fix fails (each failure is logged to the server console but does not abort the batch).

**Error responses** — same as `/fix`.

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
| `POST /api/sharedbrain/generate-invite` | Body: `{repo, name, shared_domain, branch?, storage_type?, data_handling_terms?}`. Encodes metadata into an `sbi_...` token (deterministic — same metadata reproduces the same token, which is how the card's "Show invite token" works). v3.0.5+: the response also carries a freshly generated `admin_token` for the admin wizard; it is NOT embedded in the invite token, is not persisted by this call, and should be ignored by non-wizard callers. |

### Live PAT validator (server-proxy)

| Path | Description |
|---|---|
| `POST /api/sharedbrain/validate-pat` | Body: `{repo: "owner/name", pat: "github_pat_..."}`. Curator backend makes one GitHub API call with the supplied PAT, returns `{valid, hasWriteAccess, repoFullName, isPrivate, defaultBranch, message}`. The PAT never leaves the user's machine via the browser. PAT length capped at 400 chars (DoS defense). v3.0.4+: a `valid: true, hasWriteAccess: false` verdict is no longer a dead end — the wizard lets the user continue as a read-only member; 401/403/404 error copy explicitly points at the unaccepted-collaborator-invitation case. |

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
