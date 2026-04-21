# AI Wiki Health

*Available from v2.4.3. Orphan rescue added in v2.4.4. Semantic duplicates added in v2.4.5.*

Wiki Health has always scanned your wiki for structural issues — broken links, orphans, duplicates, missing backlinks — and offered one-click fixes where the algorithm can solve them deterministically. Some issue types, however, need semantic judgement: *"which existing page did I mean when I wrote `[[ecdhe]]`?"*

**AI Health** adds an opt-in, pay-as-you-go AI assist layer for exactly those judgement calls. It is strictly additive: nothing that worked before changes, and no AI call happens unless you click a button.

---

## What AI adds today

| Phase | Issue type | What AI does | Version |
|---|---|---|---|
| 1 | Broken links (no algorithmic suggestion) | Reads page context + your slug inventory → proposes the most likely intended target, or says "no good target exists". | **v2.4.3** ✅ |
| 2 | Orphan pages | Proposes up to 5 existing pages that should link to the orphan, each with an AI-written bullet description. | **v2.4.4** ✅ |
| 3 | Semantic near-duplicates | Detects pages like `email.md` + `e-mail.md`, `rag.md` + `retrieval-augmented-generation.md`, `neural-network.md` + `neural-networks.md` that are the same concept under different slugs. | **v2.4.5** ✅ |

Issues that the algorithm solves perfectly (missing backlinks, folder-prefix links, hyphen variants, cross-folder duplicates) are **not** AI-assisted — determinism wins there.

---

## How it works (Phase 1 — broken links)

When Wiki Health finds a broken link it could not match algorithmically, the row is tagged **Review** and a new **✨ Ask AI** button appears (only if you have an API key configured in Settings).

Clicking **✨ Ask AI**:

1. Sends a short excerpt (~4 KB of text) around the broken link, plus a list of your wiki's page names, to your configured LLM provider.
2. The model returns `{ target, rationale, confidence }`:
   - `target` must be a real slug from your wiki, or `null` if nothing fits. The server rejects hallucinated slugs before you see them.
   - `confidence` is `high` / `medium` / `low`, set by the model.
3. You see the proposal inline — rationale and confidence visible before you act.
4. **Apply** rewrites `[[old]]` → `[[suggested]]` using the same fix endpoint that already handles algorithmic suggestions. Nothing new writes to disk.
5. **Skip** dismisses the suggestion without changes.

If the model answers `target: null` or `confidence: low`, no **Apply** button is shown — the UI suggests creating a new page or removing the link instead.

---

## How it works (Phase 2 — orphan rescue)

An **orphan** is an entity or concept page with zero incoming `[[wikilinks]]` — content you captured that the graph doesn't yet know about. The Health scan has always listed orphans as review-only. From v2.4.4, each orphan row gets a **✨ Ask AI** button (when an API key is configured).

Clicking **✨ Ask AI** on an orphan:

1. Sends the orphan's content (up to ~4 KB) and the domain's list of entity + concept slugs to your configured LLM provider. **Summaries are intentionally excluded** from the candidate inventory — see the design note below.
2. The model returns up to 5 candidates, each `{ target, description, confidence, rationale }`:
   - `target` must be a real slug in your wiki's entities/ or concepts/. The server rejects hallucinated slugs before you see them.
   - `description` is an AI-written one-liner (max 140 chars, trimmed server-side) that will become the bullet text.
   - `confidence` is `high` / `medium` / `low`.
3. Each candidate renders as its own mini-card with its own **Apply** / **Skip** buttons. You can apply one, skip the rest, or apply several one-by-one.
4. **Apply** writes `- [[orphanSlug]] — <description>` into the target page's `## Related` section (dedup-safe — re-applying does nothing if the bullet already exists). After a successful apply, Health auto-re-scans; a truly rescued orphan drops off the orphan list because it now has an incoming link.
5. Low-confidence candidates show a "review manually" tag instead of an Apply button — the AI flagged its own uncertainty.

### Why summaries are never candidate targets

The wiki convention in The Curator is that **summaries reference entities during ingest**, not the other way around. A summary page lists its `Entities Mentioned` at the time the source document is processed; retroactively adding `- [[some-orphan]]` to a summary's Related section would be backwards causality.

Entities and concepts, by contrast, accumulate relationships over time — a new summary or another entity may naturally extend their Related sections. That's the direction orphan rescue flows.

---

## How it works (Phase 3 — semantic near-duplicates)

Some duplicates can't be caught by string matching. `email.md` + `e-mail.md` look different to a hyphen-collapse algorithm. `rag.md` + `retrieval-augmented-generation.md` share no characters. These pages **fragment the knowledge graph** — queries return partial results, Obsidian shows separate nodes for the same idea.

Phase 3 adds a dedicated scan for these cases. Unlike Phases 1 and 2, this scan is **opt-in** — it runs only when you click **Scan for semantic duplicates** in the Health tab. It's gated by a cost preview and a cost ceiling.

### The pipeline

1. **Local pre-filter** (no LLM, runs in seconds even at 20k pages). An inverted token index finds slug pairs that share ≥1 non-stopword token or have high character-level similarity (Jaro-Winkler ≥ 0.85). Ranked by a combined score; capped at your configured maximum (default 500 pairs).
2. **Cost estimate** is shown in a confirm dialog: number of candidate pairs, estimated tokens, estimated USD cost on your current model, and whether it exceeds your cost ceiling.
3. **You click Run scan**. The server streams progress over SSE (batches of 20 pairs per LLM call), and accepted pairs appear in the UI as they arrive. The LLM is asked to judge each pair as duplicate / not-duplicate and pick the more canonical slug.
4. **Only `medium` and `high` confidence duplicates surface** in the UI. Low-confidence and non-dupe verdicts are dropped silently.
5. **Merge requires preview.** Each pair card has a disabled **Merge** button. You must first click **Preview diff** to see the kept path, the delete path, the count and list of files whose links will be rewritten, and a 4 KB sample of the merged content. After preview, Merge enables. You can also click **Flip** to swap which side is kept (if the AI picked the wrong canonical) or **Skip** to dismiss the pair.
6. **When you click Merge** (from within the preview modal), the server: merges bullet sections (larger body wins as the base), rewrites every `[[removeSlug]]` and `[[folder/removeSlug]]` link across every .md file in the domain (including summaries), writes the merged content to the kept file, and **deletes the duplicate file**.

### Scale caps (baked into the code)

| Cap | Default | Configurable in |
|---|---|---|
| Max pages for a scan to run at all | 20,000 | hard-coded (contact maintainer to raise) |
| Max candidate pairs sent to the LLM | 500 | Settings → AI Wiki Health → Maximum candidate pairs per scan |
| Cost ceiling per scan (tokens) | 50,000 | Settings → AI Wiki Health → Cost ceiling per scan |
| Batch merge | **Never offered** | — |

Batch merges are deliberately omitted at every scale. A single wrong batch merge across thousands of pages could wreck a wiki; the per-pair preview gate makes that impossible.

### Cost

Using the defaults on Gemini Flash Lite:

- A scan of 500 candidate pairs ≈ 200k tokens ≈ **$0.03**.
- A scan of 50 candidate pairs ≈ 20k tokens ≈ **$0.003**.

On Claude Haiku 4.5 the cost is roughly 10× higher but still under $0.50 for a default scan.

The estimate shown in the confirm dialog uses published per-1M-token pricing from 2026-04; treat the USD figure as an order-of-magnitude guide, not a billing authority.

### What Phase 3 will NOT do

- Merge pairs that are related-but-distinct (e.g. `gpt-4` vs `gpt-4-turbo`). The LLM is instructed to err toward non-dupe when ambiguous.
- Touch `summaries/` as a merge target. A summary can never be the kept or removed page in a merge; link rewrites still go through summary pages (because summaries may link to the old slug and need to point to the new one), but the summary itself is never deleted or structurally modified.
- Batch-merge. One pair at a time, always, even if 100 high-confidence pairs are found.
- Run without your explicit click. This is the only AI Health feature with a cost preview + cost ceiling, because it's the only one that scans the whole domain.

---

## Privacy — what leaves your machine

When you click **✨ Ask AI**, The Curator sends to your configured LLM provider (Google Gemini or Anthropic, whichever you set in Settings):

- For **broken links**: a ~4 KB excerpt from the wiki page containing the broken link, plus a list of your wiki's page names (entities, concepts, and summaries — slugs only, not contents).
- For **orphan rescue**: up to ~4 KB of the orphan page's content, plus a list of entity and concept slugs (summaries are omitted). A 2000-page domain adds ~15 KB of slugs.
- For **semantic duplicates**: for each candidate pair, the slug + first paragraph (~500 chars) of each of the two pages. At 500 pairs that's roughly 500 KB of text across all batches, spread over ~25 separate LLM calls.

It does **not** send:

- The full text of any page
- Any other domain's content
- Your API key to anyone but the provider you configured
- Raw source files from the `raw/` folder

The provider's privacy policy applies to the excerpt and slug list you send. See:

- [Google Gemini API Terms](https://ai.google.dev/terms)
- [Anthropic Usage Policies](https://www.anthropic.com/legal/usage-policy)

A one-time disclosure modal summarises this the first time you click **✨ Ask AI** in a browser. Accepting it stores the acknowledgement in `localStorage` under the key `curator-ai-health-disclosure-seen-v1`.

---

## Cost

Broken-link suggestion is a small call:

- System prompt + excerpt + slug inventory ≈ **3–10k input tokens** (the bulk is slugs; scales with wiki size).
- Response ≈ **200 output tokens**.

Orphan rescue is slightly larger because it asks for up to 5 candidates with descriptions:

- Input tokens ≈ the same shape as broken-link (orphan page content + entity/concept inventory).
- Response ≈ **600–1000 output tokens** (5 × candidate block).

On the default low-cost models (Gemini 2.5 Flash Lite or Claude Haiku 4.5), each Ask AI click costs roughly **$0.0001–0.0005** — approximately one-thousandth of a cent to one-half of a cent.

The Curator does not aggregate or cache suggestions — each click is an independent call.

---

## How to disable

There is no global toggle. AI Health is gated purely on whether an API key is configured:

- **Remove both keys** in Settings → Disconnect. The ✨ Ask AI button disappears from the Health tab on the next scan.
- **Remove the `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`** values from `.env` if you only use the developer fallback.

The existing algorithmic Health fixes continue to work without any API key.

---

## Architecture notes (for developers)

### Chokepoint: one module, one invariant

All AI Health logic lives in [src/brain/health-ai.js](../src/brain/health-ai.js). The module has one non-negotiable invariant:

> **AI Health is READ-ONLY. It proposes fixes, it never writes to the wiki.**

Every mutation still flows through the existing `fixIssue()` in [src/brain/health.js](../src/brain/health.js) via `POST /api/health/:domain/fix`. The AI layer is a pure suggestion generator.

### Validation against hallucination

Before returning a suggestion to the UI, `suggestBrokenLinkTarget()`:

1. Parses the model's JSON response (with `jsonrepair` fallback for common LLM mistakes).
2. Checks `target` against the set of slugs actually present on disk (`entities/`, `concepts/`, `summaries/`).
3. If the model invented a slug that doesn't exist, it is coerced to `target: null` with `confidence: 'low'`, and the rationale is annotated to record the rejection.

This defence sits ABOVE the existing v2.4.0 model fallback chain, so a confused fallback model cannot leak a bad suggestion into the UI.

### Provider-agnostic

`health-ai.js` calls `generateText()` from [src/brain/llm.js](../src/brain/llm.js), which dispatches to whichever provider the user has activated (Gemini or Anthropic) with the full v2.4.0 fallback safety net. Swapping providers in Settings is picked up on the next Ask AI click — no special code.

### Endpoint surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health/ai-available` | Frontend probe. Returns `{available, provider, model}` or `{available: false, reason}`. |
| `GET` | `/api/health/ai-settings` | Returns the user's `{costCeilingTokens, semanticDupeMaxPairs}`. |
| `POST` | `/api/health/ai-settings` | Partial update of the same fields. Values are clamped to sane ranges. |
| `POST` | `/api/health/:domain/ai-suggest` | Body: `{type, issue}`. Accepts `type: 'brokenLinks'` (v2.4.3+) or `type: 'orphans'` (v2.4.4+). |
| `GET` | `/api/health/:domain/semantic-dupes/estimate` | Phase 3 — runs pre-filter only, returns `{pageCount, candidatePairs, estimatedTokens, estimatedUsd, costCeilingTokens, ...}`. No LLM calls. |
| `POST` | `/api/health/:domain/semantic-dupes/scan` | Phase 3 — SSE stream. Events: `start`, `progress`, `pair`, `batch-error`, `done`, `error`. |
| `POST` | `/api/health/:domain/semantic-dupes/preview` | Phase 3 — returns `{keepPath, removePath, mergedPreview, mergedLength, affectedFiles, affectedCount, totalLinksRewritten}`. READ-ONLY. |
| `POST` | `/api/health/:domain/fix` | Existing endpoint. Applies any AI-suggested fix. New types: `orphanLink` (v2.4.4), `semanticDupe` (v2.4.5). |

No existing endpoint was modified. The `orphanLink` and `semanticDupe` fix types are pseudo-types — the scanner never emits them; they exist only as routing keys so AI-applied operations go through the same `fixIssue()` chokepoint as every other write.
