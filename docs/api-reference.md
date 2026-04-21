# API Reference

The server exposes a REST API at `http://localhost:3333/api`. All endpoints return JSON.

---

## GET /api/domains

List all available domains.

**Response**

```json
{
  "domains": ["ai-tech", "business-finance", "personal-growth"]
}
```

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

`syncWarning` is `true` when GitHub sync is configured — the rename appears as a delete + add on GitHub, so the user should Sync Up promptly.

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

`syncWarning` is `true` when sync is configured — the deletion will propagate to GitHub on the next Sync Up.

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
| `500` | Claude API error; PDF parsing failure; filesystem write error |

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
| `500` | Claude API error |

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

## POST /api/health/:domain/ai-suggest

Ask the LLM to propose a target for an issue that the algorithmic scanner could not resolve. **Read-only — does not modify the wiki.** To apply the suggestion, call `POST /api/health/:domain/fix` with the returned target patched into `issue.suggestedTarget`.

**Phase 1 (v2.4.3)** supports only `type: 'brokenLinks'`. Other types will be added in v2.4.4 (orphans) and v2.4.5 (semantic duplicates).

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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | `"brokenLinks"` (Phase 1). |
| `issue` | object | Yes | The issue object as returned by `GET /api/health/:domain`. |

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

**Error responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `type`/`issue`, unsupported `type`, or no API key configured. |
| `404` | Unknown domain. |
| `500` | LLM call failed after the fallback chain was exhausted, or the response could not be parsed as JSON. |

Privacy note: this endpoint sends a ~4 KB excerpt of the source page plus the list of page slugs in the domain to the configured LLM provider. See [ai-health.md](ai-health.md) for the full disclosure.

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

- All endpoints are local-only (`localhost`). There is no authentication.
- The ingest endpoint blocks until Claude returns a response. For large PDFs (50k+ words) this may take 60+ seconds. The 50MB file size limit is a rough guard — what actually matters is the text length extracted from the file (capped at 80,000 characters sent to Claude).
- The query endpoint sends up to 90,000 characters of wiki content to Claude in a single call. Very large wikis (150+ pages) may hit the context limit. In that case, consider splitting the domain or removing less useful pages.
