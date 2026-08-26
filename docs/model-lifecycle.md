# Model Lifecycle & Fallback Safety Net

> **Applies from:** v2.4.0+
> **Scope:** ingest pipeline, chat, query, AI Wiki Health (broken-link suggestions v2.4.3+, orphan rescue v2.4.4+, semantic-duplicate detection v2.4.5+), MCP-adjacent tools
> **Audience:** every Curator user; also relevant to developers shipping new releases

The Curator uses an LLM for every text-writing task — ingest (atomising a source into entities / concepts / summary), chat, and AI-assisted Wiki Health actions (broken-link suggestions, orphan rescue, semantic-duplicate detection). Every one of those calls flows through a single chokepoint in [`src/brain/llm.js`](../src/brain/llm.js).

This document explains **what happens when a provider retires a model** — and what you, as a user, should do.

---

## The problem in one sentence

Providers rename and retire models. When Google retires `gemini-2.5-flash-lite` or Anthropic renames `claude-sonnet-4-6`, every call from a Curator installation pinned to that exact model ID starts returning `404 not found` — and ingest, chat, and health all break.

## The Curator's strategy

**Primary path: pin + release new version.** Each Curator release pins its preferred model in `DEFAULTS`:

```js
const DEFAULTS = {
  gemini:    'gemini-2.5-flash-lite',   // Google's low-cost tier
  anthropic: 'claude-haiku-4-5',        // Anthropic's low-cost tier
};
```

Both defaults target the **low-cost tier** of their respective providers so ingestion of large libraries stays affordable. Users who prefer higher-quality (and costlier) output can override via `LLM_MODEL=<model-id>` in `.env`.

When a provider retires or supersedes one of these, we bump the constant in a new release and push. Users get the new default via **Settings → Check for Updates**.

**Safety net: fallback chain.** Between the time the provider retires a model and the user clicks Update, the Curator doesn't go silent. On a *model-not-found* error, it tries a short ordered chain of next-best models:

```js
const FALLBACK_CHAINS = {
  gemini: [
    'gemini-3.1-flash-lite',        // closest live successor — verified drop-in, but 2.5x in / 3.75x out
    'gemini-2.5-flash',             // higher (costlier) tier — last resort
  ],
  anthropic: [
    'claude-sonnet-5',              // $2/$10 — cheapest live non-Haiku AND the newest
    'claude-sonnet-4-6',            // $3/$15 — ties 4.5 on price, newer, 128k output ceiling
    'claude-sonnet-4-5',            // $3/$15 — oldest live rung, 64k output ceiling
  ],
};
```

**`gemini-3.5-flash-lite` was removed from the Gemini chain on 2026-08-26** — a
deletion, not a reorder, so the chain stays cheapest-first ($0.25 → $0.30). It
was **strictly dominated** by `gemini-2.5-flash`, the rung now directly after
it: identical published price ($0.30/$2.50 on both), but measurably worse on
the two axes that matter for a fallback rung. Measured live against this
repo's real `buildOutlinePrompt` (not a toy prompt) over 9 runs each:

- **JSON reliability:** 2 of 9 `gemini-3.5-flash-lite` runs produced JSON that
  neither `JSON.parse` nor the `jsonrepair` fallback could fix — a dropped
  object key (`{ "concepts/knowledge-graph.md", "summary": "..." }`, missing
  its `"path":` key), unrecoverable because repair would have to invent the
  key. `finishReason` was `STOP` both times, so this was **not** truncation —
  a genuine generation defect, not a budget problem the output-token-limit
  handling could route around. `gemini-3.1-flash-lite` and `gemini-2.5-flash`
  were 3/3 and 3/3 clean on the identical probe.
- **Outline coverage** on an identical source: `gemini-3.1-flash-lite` planned
  5–12 pages, `gemini-2.5-flash` planned 17–19 pages, and
  `gemini-3.5-flash-lite` sat in between at 12–16 — so it didn't even fill a
  coverage gap between its neighbours that would have justified keeping it
  despite the reliability cost.

In production this rung fired ingest's Phase-1 stricter-retry ladder on
roughly 22% of the calls that reached it — silent extra latency and spend on
a rung that was never the cheapest option at its price point. Its price entry
was removed from `MODEL_PRICES_USD_PER_MTOK` in the same change (an unshipped
id's price is dead weight the length-equality invariant in
`test-chat-model.js` §5 exists to catch). **Do not re-add it without
re-measuring live with the real ingest prompt** — a toy "return this JSON"
probe will not reproduce the failure, the same lesson the Anthropic
thinking-block note above teaches about prompt realism when probing a
fallback rung.

The first model that responds is the one used for that call. Subsequent calls retry the primary first — when the provider restores it (or when you update), the Curator silently goes back to primary.

**Chains run forward in time, cheapest-first.** A chain only fires because the primary was *retired*, so escalating **backwards** to an older generation is the wrong direction — an older model is more likely to be retired than the one that just replaced it. Each rung is therefore the closest-priced live successor first, then progressively pricier ones. This was a real defect: until v3.0.15 the Gemini chain escalated to `gemini-1.5-flash` and `gemini-1.5-flash-latest`, and a live probe on 2026-08-22 (with the Curator's exact call shape — JSON mode, `maxOutputTokens: 65536`) found **both already returning 404**. Two of the three rungs were dead, so a real retirement of `gemini-2.5-flash-lite` would have fallen through to a single working model. Verify every rung against the live API when you edit a chain — a fallback chain is untested by definition until the day it is needed.

**The default is deliberately NOT bumped to the successor.** `gemini-2.5-flash-lite` stays the pinned default because it is 2.5x cheaper on input and 3.75x cheaper on output than `gemini-3.1-flash-lite`, its own closest successor (and cheaper still than the rungs below it). The chain exists to keep users *working* when the default disappears, not to move them off it early — which is also precisely why a fallback warrants a cost warning.

**Only `model-not-found` errors trigger fallback.** Rate limits (429), service-unavailable (503), and authentication failures (401) go through their existing retry / surface paths. They don't cascade through the chain.

---

## What you'll see as a user

### Normal operation

Nothing. The Settings tab shows the usual provider badge:

> 🟢 Active: Gemini — `gemini-2.5-flash-lite`

### When a fallback is in use

An amber banner appears just below the provider badge in Settings:

> ⚠ **Using fallback model.** Gemini's `gemini-2.5-flash-lite` is unavailable; currently running on `gemini-3.1-flash-lite`. Open **Check for Updates** above to pull the latest Curator with an updated default model.
>
> 💰 This model costs more than your usual one — every ingest, compile and chat is billed at the higher rate until the default is restored.

That is the real first rung of the Gemini chain, and it is `costlier` — so this is exactly what a Gemini user sees the moment the pinned default is retired.

Why it matters: without it, a retirement silently multiplies the user's per-ingest bill with nothing on screen connecting the two. **Every rung of the current Gemini chain is more expensive than the default**, so this line is the normal case, not an edge case.

**How the verdict is reached** (v3.0.15). `getFallbackStatus()` returns `costTier`, and `GET /api/config/api-keys` passes it straight through:

| `costTier` | Meaning | Banner |
|---|---|---|
| `costlier` | Confirmed higher input and/or output price | 💰 "This model costs more than your usual one…" |
| `similar` | Confirmed same-or-cheaper | no cost line |
| `unknown` | We have no price for one of the two ids | ℹ️ "Pricing for this model may differ… check your provider's pricing page" |

The comparison uses `MODEL_PRICES_USD_PER_MTOK` in [`llm.js`](../src/brain/llm.js) — an **exact-model-id** table covering only the ~7 ids we can actually run (`DEFAULTS` + every `FALLBACK_CHAINS` rung), with published per-1M-token prices. The values are used **only for ordering** and are never shown to the user, so a stale absolute price is harmless as long as the order is right. A legacy `costlier` boolean is still returned for compatibility, but the banner drives off `costTier` so `unknown` isn't collapsed into a misleading "no warning".

> **Why not infer the tier from the model family?** That was the first implementation and it was structurally wrong. The family word (`flash-lite`, `haiku`) is stable *across generations* while the price is not: it scored `gemini-2.5-flash-lite` → `gemini-3.1-flash-lite` as "same tier" when that successor is **2.5× input / 3.75× output** — staying silent on the rung the chain reaches **first**, which defeated the entire feature. Only an exact-id table can see a within-family price change. The same table also correctly sees a within-family price *drop*: `claude-sonnet-5` is **cheaper** ($2/$10) than both `claude-sonnet-4-6` and `claude-sonnet-4-5` ($3/$15), so the newest Sonnet is also the cheapest — which no family-name heuristic could ever tell you.

**Never imply parity when we don't know.** An id missing from the table yields `unknown`, not `similar`. Any fallback means the user is off the model they configured, so the honest line is "pricing may differ" — silence would be a claim we can't support.

Prices verified 2026-08-22 against [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing) and [platform.claude.com pricing](https://platform.claude.com/docs/en/about-claude/pricing):

| Model | Input / 1M | Output / 1M | vs its default |
|---|---|---|---|
| `gemini-2.5-flash-lite` *(default)* | $0.10 | $0.40 | — |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 | 2.5× / 3.75× |
| `gemini-2.5-flash` | $0.30 | $2.50 | 3× / 6.25× |
| `claude-haiku-4-5` *(default)* | $1.00 | $5.00 | — |
| `claude-sonnet-5` | $2.00 | $10.00 | 2× / 2× |
| `claude-sonnet-4-6` | $3.00 | $15.00 | 3× / 3× |
| `claude-sonnet-4-5` | $3.00 | $15.00 | 3× / 3× |

What to do:
1. Click **Check for Updates** in Settings → **App**.
2. Update if a new version is available — it will have a refreshed default model.
3. The banner disappears on its first successful primary call.

Your existing wiki, ingests, chats, and sync all continue to work the whole time. Fallback is seamless at the feature level — the banner exists purely to nudge you to update before the fallback chain itself runs out of models.

### If every model in the chain is gone

Extremely unlikely (it would mean an entire generation of models was retired in a single sweep). In that case the call fails with a clear error:

> All `<provider>` models failed. Please run Check for Updates.

You'd then update and get a fresh chain.

---

## For developers (release checklist)

When releasing a new version that updates a model default:

1. **Update `DEFAULTS`** in [`src/brain/llm.js`](../src/brain/llm.js).
2. **Update `FALLBACK_CHAINS`** — put the closest-priced live successor first, and **probe every rung against the live API before shipping** (a chain is untested by definition until it fires). Never add a rung that is older than the primary. Adding the *previous* primary is only right when it is still alive and still cheaper-or-equal.
   - A costlier rung is fine — it is the last resort — and the cost banner will tell the user.
3. **Add the new model's published price to `MODEL_PRICES_USD_PER_MTOK`** in [`llm.js`](../src/brain/llm.js), for both the new default and every new rung. Without it the fallback degrades to the vaguer `unknown` wording. `test-chat-model.js` §5 asserts that **every** `DEFAULTS` + `FALLBACK_CHAINS` id is priced, so forgetting this fails `npm test` rather than shipping silently.
4. **Bump `package.json` version** and push. End users pull via the existing auto-updater.
5. Note the model change in [`CLAUDE.md`](../CLAUDE.md) "Git History of Major Fixes" table.

> **The chat Model selector requires no change here.** It shows the provider (Gemini / Claude), and its version label reads the current `DEFAULTS[provider]` from the backend (`getDefaultModel` → `GET /api/config/api-keys` `models`). Bumping `DEFAULTS` updates that label automatically — users never select a specific model version; that stays a global decision. (Pending example: Gemini `2.5-flash-lite` → its successor when Google retires it; the selector will reflect it the moment `DEFAULTS.gemini` is bumped.)

When a model is retired without a direct successor (rare):

1. Pick a sensible substitute from the current generation.
2. **Before changing `DEFAULTS`**, verify the new model works on a test account for both free-tier and paid quotas.
3. Ideally release the fallback-chain update first and the `DEFAULTS` bump second, so users have at least a week of the old primary still working as the new fallback.

## Overriding the default locally (developers only)

Set `LLM_MODEL=<model-id>` in `.env` to override for the running provider. The Curator treats this the same as a pinned default — fallback still activates if the override itself is rejected. Useful for:

- Testing against a new model before releasing.
- Pinning to a known-good older model during a provider outage.
- Experimenting with Gemini Pro / Claude Opus for specific workloads.

Example:

```bash
LLM_MODEL=gemini-2.5-pro npm start
```

---

## Anthropic-specific notes

The Anthropic default is **`claude-haiku-4-5`** — Anthropic's low-cost tier, chosen to mirror the cost profile of Gemini's `gemini-2.5-flash-lite`. Two known differences relative to the Gemini path:

1. **No native JSON response mode.** Gemini supports `responseMimeType: 'application/json'`, which forces structurally-valid JSON output. Anthropic does not expose an equivalent, so JSON-producing code paths (primarily `src/brain/ingest.js`) rely on the system prompt instruction *"Return ONLY valid JSON"* combined with the `jsonrepair`-based fallback parser. Empirically this works, but expect slightly more retries on large ingests than Gemini produces.

   **Measured 2026-08-26** (real `buildOutlinePrompt`, 3 live runs per model): `claude-haiku-4-5` — the pinned default — wraps its ingest-outline response in ` ```json ` fences 3/3, so raw `JSON.parse` fails 3/3 and every ingest on this default depends on the `jsonrepair` fallback to strip the fence before parsing. `claude-sonnet-4-5` and `claude-opus-4-5` showed the same 3/3 fenced behaviour. Everything 4.6-and-later (`claude-sonnet-4-6`, `claude-sonnet-5`) returned bare JSON and parsed raw 3/3. This is benign today — `parseJSON` is deliberately lenient for exactly this reason — but it means the fence-stripping path is the *normal* case for the default, not a rare edge case; see the comment above `DEFAULTS.anthropic` in `llm.js`.

2. **Model ID format.** Anthropic's SDK v0.39.0 recognises up to `claude-3-7-sonnet-latest` / `claude-3-5-haiku-latest` in its TypeScript types; newer model IDs like `claude-haiku-4-5` and `claude-sonnet-4-5` are accepted as opaque strings but not validated at build time. If your primary model rejects with `404`, the fallback chain escalates straight to Sonnet — as of the 2026-08-24 live probe there is **no live Haiku other than the default**, so there is no same-tier rung to walk. The first rung (`claude-sonnet-5`) is both the newest and the cheapest of the three — and until v3.9.1 it was **dead on arrival**, for the reason in note 4 below.

3. **Output-token cap + streaming transport (v3.0.1-beta.14).** Ingest single-pass and conversation compile request a `65536`-token output budget — correct for Gemini 2.5 Flash, but two limits make it invalid on Anthropic, so the Anthropic branch of `callProvider` (in `src/brain/llm.js`) handles both:
   - **Hard output cap.** Claude Haiku 4.5 caps output at **64,000** tokens; the API rejects `max_tokens: 65536` outright as `max_tokens: 65536 > 64000`. The Anthropic branch resolves a **per-model** ceiling via `anthropicMaxOutputTokens(model)` (64,000 for Haiku 4.5 / Sonnet 4.5; 128,000 for Sonnet 4.6 / Sonnet 5; the conservative 64,000 for any unrecognised id). `ANTHROPIC_MAX_OUTPUT_TOKENS` still exists and still equals 64,000, but now means *that conservative default*, not a flat clamp. Gemini keeps the full 65,536 — it is not clamped.
   - **Mandatory streaming above ~21k tokens.** SDK v0.39 throws *"Streaming is strongly recommended for operations that may take longer than 10 minutes"* for **any** non-streaming `messages.create()` call whose `max_tokens` implies a computed timeout over 10 minutes — which fires for any budget above ~21,333 tokens, regardless of model or actual latency. So the clamp alone is insufficient; the Anthropic branch uses `client.messages.stream(...).finalMessage()` (fixed 600s timeout, no guard). `.finalMessage()` returns the identical `Message` object, so `stop_reason` handling is unchanged. (Content handling is *not* unchanged as of v3.9.1 — see note 4.)

   Net effect: Anthropic users on Haiku can run Compile-to-Wiki and single-pass ingest without hitting either error.

   Which call sites sit where, relative to the ~21,333-token streaming threshold:

   | Call site | Requested output budget | Above the streaming threshold? |
   |---|---|---|
   | Chat / query | 4,096 · 8,192 · 12,288 (`RESPONSE_STYLES` in `chat.js`) | No |
   | Multi-phase ingest — Phase 2 batch (`MULTI_PHASE_BATCH_TOKENS`) | 16,384 | No |
   | Multi-phase ingest — **Phase 1 outline** (`MULTI_PHASE_OUTLINE_TOKENS`) | **24,576** | **Yes** — this call depends on the streaming transport |
   | Single-pass ingest · Compile-to-Wiki | 65,536 (clamped per model) | Yes |

   Note the Phase 1 outline call: at 24,576 it is **above** the guard, so it is not exempt — an earlier version of this note wrongly grouped all of multi-phase ingest as "always under both thresholds". It works because the Anthropic branch streams unconditionally, not because its budget is small.

4. **A reply can arrive in several content blocks, and the first one is not always the answer (v3.9.1).** An Anthropic response body is an array of typed blocks, not a single string. Until v3.9.1 both extraction points in `callProvider` read `content[0].text`. A `thinking` block carries a `.thinking` field and **no** `.text` field, so the moment a model put one first, `content[0].text` was `undefined` and the call threw:

   > ⚠ Claude returned no text content (stop_reason: end_turn). This is rare and usually transient — try again.

   The message was wrong on both counts: it was neither rare nor transient. **Why it only hit some models.** The Curator sends no `thinking` parameter at all. Omitting it means *adaptive* thinking on `claude-sonnet-5` (the model decides per prompt), and *no* thinking on `claude-sonnet-4-6` and `claude-haiku-4-5`. Measured over three trials each with a real ingest-shaped prompt: `claude-sonnet-5` returned `[thinking, text]` 3/3, while `claude-sonnet-4-6` and `claude-haiku-4-5` returned `[text]` 3/3.

   **That made it a fallback-chain failure, not a curiosity.** `claude-sonnet-5` is the *first* rung of `FALLBACK_CHAINS.anthropic`. The chain's whole promise is to keep you working on the day your pinned default is retired — and rung 1 failed 100% of the time, on exactly that day. Same shape as the v3.6.0 finding where four of five Anthropic rungs returned 404: **a safety net is untested by definition until it is needed.**

   The fix (`extractAnthropicText` in `src/brain/llm.js`) concatenates **every** `type: 'text'` block regardless of position or count, and returns `null` only when there is no text block at all — which is still a real failure and still throws. It concatenates rather than taking the first text block because one reply can legitimately carry several: citations split a response into multiple text blocks, and a server-side refusal fallback can interleave a block between them. The truncation path (`stop_reason: 'max_tokens'`) had the same defect and is fixed the same way — before, a cut-off but perfectly useful chat answer on Sonnet 5 arrived as nothing but the truncation note.

   **The honest cost note.** Because the reply now extracts correctly, a fallback onto `claude-sonnet-5` succeeds — but the thinking tokens it spends are billed as output tokens and the reasoning itself is discarded unread. Nothing in the code suppresses or uses it. So a Sonnet 5 fallback can cost somewhat more per call than its $2/$10 headline rate implies, on top of already being pricier than the Haiku default. This is recorded rather than compensated for, the same way the Gemini reasoning-token note below is.

   **Do not verify this path with a toy prompt.** Adaptive thinking is prompt-dependent: `Return {"ok":true}` comes back as `[text]` and passes green while a real ingest prompt fails. `scripts/test-anthropic-content-blocks.js` therefore asserts a class invariant over generated content arrays rather than a list of remembered shapes.

If your usage patterns make Haiku's quality insufficient (rare for wiki ingest but possible for dense academic PDFs), you can opt into Sonnet via:

```bash
# in .env
LLM_MODEL=claude-sonnet-4-5
```

Or any other model ID Anthropic accepts. The fallback chain still applies on top of your override.

---

## Verifying the safety net locally

You can simulate a model deprecation without changing any code:

```bash
LLM_MODEL=gemini-nonexistent-retired npm start
```

Then trigger any LLM call (chat, ingest a tiny file, etc.). The server log should show:

```
[llm] Model "gemini-nonexistent-retired" returned "not found"; trying fallback "gemini-3.1-flash-lite"...
[llm] Primary model "gemini-nonexistent-retired" is unavailable; using fallback "gemini-3.1-flash-lite". Please run "Check for Updates" in Settings to upgrade to a current model.
```

And the Settings provider area will show the amber banner. Remove the env override and restart — banner clears on the next successful call.

---

## Verify a chain against the live API, not against memory

**This failure has now happened twice.** In v3.0.15 a live probe found **two of three** Gemini rungs already returned `404` — they had been assumed alive and never tested. On 2026-08-24 a probe of the Anthropic chain found **four of five rungs dead**: `claude-3-5-haiku-latest`, `claude-3-5-haiku-20241022`, `claude-3-7-sonnet-latest` and `claude-3-5-sonnet-latest` are all gone from the direct API.

Both times the chain still "worked" — `isModelNotFound()` skips a 404 rung — so nothing was visibly broken. What was broken is the chain's actual promise: *reach the cheapest still-working model*. With four rungs dead it silently landed on Sonnet 4.5, **3× the price of Haiku**, and no error was ever surfaced.

A chain is a safety net that is only exercised on the day a provider retires your default. That is the worst possible day to discover it rotted. **Probe every rung with the app's real call shape** — JSON mode for Gemini, `messages.stream(...).finalMessage()` for Anthropic — because a name appearing in a models listing is not evidence it works here.

## When a price decides chain ORDER, verify it against the live provider page

Chain order is cheapest-first, so a wrong price silently reorders the chain.

While adding `claude-sonnet-5`, a cached pricing table stated its $2/$10 rate was **introductory and expiring within days**. The live provider page showed the rise had been cancelled and $2/$10 made permanent. Had the cached figure been trusted, the chain's cost ordering would have inverted about a week after shipping — with nothing failing and no error to notice.

**Rule: a price that determines ordering is verified against the live provider page, never a cached table.**

## Output caps are per-model, and not monotonic with recency

`ANTHROPIC_MAX_OUTPUT_TOKENS` (64,000) is no longer a flat clamp for every Anthropic call. It is now the **conservative default for an unrecognised model id**; real caps come from `anthropicMaxOutputTokens(model)`:

| Model | Max output tokens |
|---|---|
| `claude-haiku-4-5` | 64,000 |
| `claude-sonnet-4-5` | 64,000 |
| `claude-sonnet-4-6` | **128,000** |
| `claude-sonnet-5` | **128,000** |
| *anything unrecognised* | 64,000 |

Note the caps are **not monotonic with recency** — Sonnet 4.5 is 64k while the newer 4.6 is 128k — so a cap can never be inferred from a version number.

An unknown id resolves to the **conservative** value on purpose: guessing high produces a hard API rejection, while guessing low merely truncates, and chat degrades gracefully on truncation (v3.0.7).

**Release-checklist addition:** when adding a rung, record its **output cap** as well as its price. A test now fails on a shipped id with no cap entry, mirroring the existing price invariant.

## Gemini reasoning tokens draw from the same output budget

`gemini-2.5-flash` — currently the last Gemini rung — spends hidden reasoning tokens from the **same** budget as visible output. A probed request with a 30-token budget returned `finishReason: MAX_TOKENS` after **zero visible tokens**, with 26 consumed by `thoughtsTokenCount`. The flash-lite models showed 0–2.

Nothing in the code compensates for this, deliberately. It is recorded so that a truncated answer on that rung is recognised for what it is rather than investigated as a bug.
