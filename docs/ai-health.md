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

Issues that the algorithm solves perfectly (missing backlinks, folder-prefix links, hyphen variants, cross-folder duplicates) are **not** AI-assisted — determinism wins there. For the structural-scan checks and step-by-step fix walk-throughs (especially **Hyphen variants** with honorific-aware grouping in v3.0.1-beta.3+), see [docs/user-guide.md §17 Wiki Health](user-guide.md#17-wiki-health).

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

## Bulk broken-link fix (v3.0.1-beta.16)

The per-link **✨ Ask AI** button (Phase 1) is perfect for a handful of broken links, but a mature domain can accumulate **hundreds or thousands** — clicking each one is impractical. The **✨ Fix broken links with AI** card (it appears in the Health tab when AI is configured and the domain actually has broken links) resolves them in bulk.

It's a two-tier resolver with a preview-then-confirm flow, so you always see the plan before anything is written:

1. **Estimate (free).** Click the button and a dialog shows the totals: how many broken links, how many resolve **for free** by formatting rules, how many need the AI, and the estimated AI cost.
2. **Free pass.** Pure formatting fixes run with no LLM cost — slugifying spaces (`[[artificial intelligence]]` → `[[artificial-intelligence]]`), stripping `.md` (`[[tali-rezun.md]]` → `[[tali-rezun]]`), removing folder prefixes, hyphen-normalising — matched against your real page names.
3. **AI pass.** The remaining unique targets go to the LLM in batches with your full page-name inventory. For each, it picks the existing page the writer meant, or says "no real match."
4. **The lexical-variant gate (the safety net).** An AI suggestion is only accepted as a **retarget** when the broken link and the target genuinely share words — a spelling/ordering variant, an acronym, or one containing the other (`rezun-tali` → `tali-rezun`, `mcp` → `model-context-protocol-mcp`, `iot` → `iot-and-ai`). When the AI reaches for a merely *related* page (`context-window` → `agent-memory`, `big-data` → `ai-and-weather-forecasting`, `healthcare` → `ai-in-medicine`), that's a different concept — it would be a **wrong** graph connection — so it falls through to **strip** instead. This keeps the AI from inventing false links.
5. **Preview.** When planning finishes you see two columns — **repointed to a real page** and **brackets removed (no real page)** — with sample lists and counts. Nothing has been written yet.
6. **Apply.** Click **Apply** and the plan is written: retargeted links point to the real page (alias display text preserved); stripped links lose only their brackets, keeping the readable words (a `[[big-data|Big Data]]` becomes plain `Big Data`). Health then auto-re-scans so you can confirm the count dropped.

**Removing the brackets vs. leaving a broken link.** A link to a page that doesn't exist isn't helping you — it's a dead end in the graph. Removing the brackets keeps the words readable in your notes while clearing the broken-link clutter. (If you'd rather a missing concept *became* a page, write it up and re-link — the bulk fixer never invents pages.)

**Safety.** Like every Health fix, this is git-tracked. If a batch result looks wrong, revert it from the **Sync** tab before pushing. The apply is registered as a write operation, so a concurrent sync/update/delete is refused with a clear message until it finishes. The planning step is strictly read-only — it makes the AI calls but writes nothing; only **Apply** touches your files.

**Cost.** The dominant cost is re-sending your page-name inventory in each batch, so large batches (100 targets/call) keep it low. On a real 3,300-page domain with 1,000+ broken links the full plan cost about **$0.014** on Gemini Flash Lite. You see the estimate before confirming.

---

## Bulk orphan rescue (v3.0.1-beta.17)

The per-orphan **✨ Ask AI** button is fine for a few orphans, but a mature domain can have hundreds (one real articles domain had **604**). The **✨ Rescue N orphans** button in the Quick maintenance bar handles them in one reviewed batch.

For each orphan, the AI picks the ONE existing page that should most naturally link *to* it, and writes a short relationship description. Applying injects `- [[orphan]] — description` into that page's *Related* section — giving the orphan an incoming link so it drops off the orphan list. The flow is the familiar one: estimate → confirm → plan (with progress) → **preview** → Apply → auto re-scan.

**Conservative by design.** The AI is told to return *no home* unless there's a genuine conceptual relationship — a loose topical association isn't enough. On the 604-orphan run, 391 got a confident home (e.g. `breaches` ← `data-leaks`, `hewlett-packard` ← `dell-technologies`, `coindesk` ← `blockchain-technology`) and **213 were deliberately left for manual review** rather than forced into a weak link. A removed orphan with a wrong link is worse than an orphan you decide on yourself.

**Summaries are never homes.** Per the wiki convention, summaries reference entities at ingest time, not retroactively — so only entity and concept pages are candidate homes (the same rule as the per-orphan Phase 2 rescue).

**Safety.** Read-only planning; the apply is write-locked and git-tracked (revert from Sync). Every plan entry is re-validated on apply: the orphan slug and the target must both exist on disk, the description is stripped of any `[[ ]]` so it can't fabricate links, and a malformed/crafted entry is skipped rather than written.

---

## One-click "Fix N safe issues" (v3.0.1-beta.17)

The **🛠 Fix N safe issues** button runs every *deterministic* fix at once — folder-prefix links, cross-folder duplicates, hyphen variants, missing backlinks, and broken links the scanner already matched to a target. These are mechanical and unambiguous, so there's no AI, no cost, and no preview step (the rule fully determines the fix). It's the fastest way to clear the "safe" pile before you spend a moment of thought on the judgement calls (orphans, semantic duplicates, unmatched broken links). It's one write-locked operation, then the wiki re-scans.

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

### Merge all high-confidence duplicates (v3.0.1-beta.15)

When a scan returns a long list (e.g. 245 pairs), reviewing each one by hand is impractical. After the scan finishes, a **✨ Merge all N high-confidence duplicates** bar appears above the results. It acts ONLY on the green **high confidence** pairs — clear near-identical duplicates like `opacity-objection-ai` ↔ `opacity-objection`. Medium- and low-confidence pairs still require the manual Preview → Merge gate, because they're the ones most likely to be genuinely distinct.

Clicking it shows a confirm step naming exactly how many pages will be deleted, then merges them one after another with a live progress bar (each card flips to ✓ Merged or ⊘ Skipped as it goes). Merges run sequentially server-side, so a pair whose file was already consumed by an earlier merge is safely skipped rather than erroring.

**Undo:** the entire wiki is git-tracked, so a batch merge you regret can be reverted from the **Sync** tab (it shows the pending changes; you can discard them before pushing).

### Scale caps (baked into the code)

| Cap | Default | Configurable in |
|---|---|---|
| Max pages for a scan to run at all | 20,000 | hard-coded (contact maintainer to raise) |
| Max candidate pairs sent to the LLM | 500 | Settings → AI Wiki Health → Maximum candidate pairs per scan |
| Cost ceiling per scan (tokens) | 50,000 | Settings → AI Wiki Health → Cost ceiling per scan |
| Batch merge | High-confidence only, confirm-gated | per-pair Preview still required for medium/low |
| Max pairs per batch merge | 2,000 | hard-coded |

The batch merge is restricted to high-confidence pairs and guarded by an explicit confirm step; medium/low pairs keep the per-pair preview gate. Because the wiki is git-tracked, any batch merge is revertable from the Sync tab — that's the safety net that makes a bulk operation acceptable here.

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

## Persistent dismissals (v2.5.1+)

Some flagged issues are not real problems — two pages the LLM thinks are duplicates that you intentionally keep separate, an orphan page you're planning to develop later, a broken link in a draft you haven't finished. Before v2.5.1, clicking **Skip** removed the issue from view but the next scan would re-surface it, forcing you to re-decide on every run.

In v2.5.1, dismissals persist.

### What you can dismiss

A **Dismiss** button appears on every review-only Health row:

- **Orphans** — pages with no incoming links (with or without ✨ Ask AI suggestions).
- **Broken links** that have no auto-fix suggestion — anything where AI couldn't propose a target, or you didn't accept the proposal.
- **Semantic-duplicate pair cards** — the existing **Skip** button now persists (this is the change that motivated the feature).

Auto-fixable issues (broken links *with* a suggested target, folder-prefix violations, cross-folder duplicates, hyphen variants, missing backlinks) deliberately do **not** have a Dismiss button — the right action there is **Apply**, not skip. If you change your mind later, you can dismiss anything from the Dismissed section.

### How it persists

Dismissals are stored in `domains/<your-domain>/wiki/.health-dismissed.jsonl` — one JSON line per dismissal. The file lives inside the wiki folder, which is already git-tracked, so dismissals **sync between your computers automatically** via the existing GitHub sync. Skip a pair on your laptop, run sync, the same pair stays skipped on your desktop.

The format is line-oriented and append-only, so concurrent dismissals on different machines merge cleanly through git's standard 3-way merge.

### The Dismissed section

Below the regular Health issue list (and above the Semantic Duplicates panel), a collapsible **Dismissed (N)** section lists every previously-dismissed item. Each row has an **Un-dismiss** button — restore an item to the active scan with one click. Empty when N=0; hidden entirely if you've never dismissed anything.

A small "N dismissed" chip in the scan summary header tells you how many issues are being filtered.

### Stale records

When you rename a slug or merge two pages, dismissals that referenced the old names become stale. The Curator silently prunes them on every Health scan — if a dismissal record points at a file or slug that no longer exists, it's dropped without bothering you. The `.health-dismissed.jsonl` file stays clean over time.

### Why this matters

A 2000-page domain typically produces 70–500 semantic-duplicate candidate pairs. Reviewing them once is reasonable; reviewing the same false positives every month is not. Persistent dismissals turn the Health tab into a true to-do list — once you've dispositioned an issue, it stops competing for your attention.

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
| `POST` | `/api/health/:domain/semantic-dupes/merge-batch` | beta.15 — SSE stream. Body `{pairs:[...]}` (≤2000). Events: `start`, `progress` (`{done,total,pair,status}`), `done` (`{merged,skipped,errors,total,results}`), `error`. Registered as a write-op + file lock; concurrent sync/update/delete get 409. |
| `GET` | `/api/health/:domain/broken-links/estimate` | beta.16 — counts (unique / free / AI) + cost. No LLM. |
| `POST` | `/api/health/:domain/broken-links/plan` | beta.16 — SSE, READ-ONLY (makes LLM calls). Returns the retarget/strip plan. |
| `POST` | `/api/health/:domain/broken-links/apply` | beta.16 — SSE, DESTRUCTIVE. Body `{plan:[...]}` (≤20000). Write-op + file lock. |
| `GET` | `/api/health/:domain/orphans/estimate` | beta.17 — orphan count + cost. No LLM. |
| `POST` | `/api/health/:domain/orphans/plan` | beta.17 — SSE, READ-ONLY. Returns `[{orphanSlug, target, description, confidence}]`. |
| `POST` | `/api/health/:domain/orphans/apply` | beta.17 — SSE, DESTRUCTIVE. Body `{plan:[...]}`. Injects Related links; re-validates every slug on apply. |
| `POST` | `/api/health/:domain/fix-all-safe` | beta.17 — runs all deterministic fix types in one locked pass. Returns `{fixed, total, byType}`. No LLM. |
| `POST` | `/api/health/:domain/fix` | Existing endpoint. Applies any AI-suggested fix. New types: `orphanLink` (v2.4.4), `semanticDupe` (v2.4.5). |

No existing endpoint was modified. The `orphanLink` and `semanticDupe` fix types are pseudo-types — the scanner never emits them; they exist only as routing keys so AI-applied operations go through the same `fixIssue()` chokepoint as every other write.

## Health on Shared Brain mirror domains (`v3.0.0-beta+`)

If you've joined a Shared Brain (see [`docs/shared-brain.md`](shared-brain.md)), the collective wiki appears on your machine as a `shared-<slug>` domain. Health **scanning** works normally on these mirrors — you can run a scan, see broken links / orphans / duplicates, and review them.

**Health fixing does NOT work on mirror domains.** Direct fixes via `POST /api/health/:domain/fix` would not propagate to other contributors and would be overwritten on the next pull. To resolve a health issue in the collective wiki, fix it upstream in your **personal opted-in domain**, then **Push contributions** from the Sync tab. The fix gets pushed as a Delta and incorporated into the next synthesis.

This is the same read/write contract that the MCP write tools enforce — see [`docs/mcp-user-guide.md`](mcp-user-guide.md).
