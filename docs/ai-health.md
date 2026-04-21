# AI Wiki Health

*Available from v2.4.3.*

Wiki Health has always scanned your wiki for structural issues — broken links, orphans, duplicates, missing backlinks — and offered one-click fixes where the algorithm can solve them deterministically. Some issue types, however, need semantic judgement: *"which existing page did I mean when I wrote `[[ecdhe]]`?"*

**AI Health** adds an opt-in, pay-as-you-go AI assist layer for exactly those judgement calls. It is strictly additive: nothing that worked before changes, and no AI call happens unless you click a button.

---

## What AI adds today

| Phase | Issue type | What AI does | Version |
|---|---|---|---|
| 1 | Broken links (no algorithmic suggestion) | Reads page context + your slug inventory → proposes the most likely intended target, or says "no good target exists". | **v2.4.3** ✅ |
| 2 | Orphan pages | Proposes 1–5 existing pages that should link to the orphan. | v2.4.4 (planned) |
| 3 | Semantic near-duplicates | Detects pages like `email.md` + `e-mail.md` that are the same concept under different slugs. | v2.4.5 (planned) |

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

## Privacy — what leaves your machine

When you click **✨ Ask AI**, The Curator sends to your configured LLM provider (Google Gemini or Anthropic, whichever you set in Settings):

- A **~4 KB excerpt** from the wiki page containing the broken link (roughly 800 words of context).
- A list of your wiki's **page names only** — *not* their contents. For a 2000-page domain this is ~15 KB of slugs.

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
| `POST` | `/api/health/:domain/ai-suggest` | Body: `{type: 'brokenLinks', issue}`. Phase 1 only accepts `brokenLinks`. |
| `POST` | `/api/health/:domain/fix` | Existing endpoint — used unchanged to apply an accepted AI suggestion. |

No existing endpoint was modified.
