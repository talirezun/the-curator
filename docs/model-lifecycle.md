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
a rung that was never the cheapest option at its price point. **Do not re-add
it as a rung without re-measuring live with the real ingest prompt** — a toy
"return this JSON" probe will not reproduce the failure, the same lesson the
Anthropic thinking-block note above teaches about prompt realism when probing
a fallback rung.

> **Update (multi-model work):** its price entry was originally deleted along
> with the rung, on the rule that an unshipped id's price is dead weight. It is
> **priced again** — not a reversal of the removal, which stands. It is priced
> because it is now **offerable**: a user may pick it deliberately for chat with
> its measured JSON defect shown, while it stays banned from the chain, which
> picks *for* the user silently. Two lists, two rules — see
> [DOMINATED](#dominated--alive-fairly-priced-and-beaten-by-a-same-priced-sibling).
> The bespoke pair of assertions that used to name this model specifically is
> now a class invariant over `DOMINATED_MODELS`.

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

The comparison uses `MODEL_PRICES_USD_PER_MTOK` in [`llm.js`](../src/brain/llm.js) — an **exact-model-id** table covering every id we can actually run (`DEFAULTS` + every `FALLBACK_CHAINS` rung + every `OFFERABLE_MODELS` entry), with published per-1M-token prices. A legacy `costlier` boolean is still returned for compatibility, but the banner drives off `costTier` so `unknown` isn't collapsed into a misleading "no warning".

> ⚠ **These numbers used to be internal; they are user-visible now.** While the table fed only this banner's `costlier`/`similar`/`unknown` ordering, a stale *absolute* price was harmless as long as the *order* was right — and this doc said so. With the model picker they are quoted to a user who is deciding what to spend their own API key on, so an absolute value being right now matters as much as the ordering does. Verify prices against the **live** provider page, never a cached table.

> **Why not infer the tier from the model family?** That was the first implementation and it was structurally wrong. The family word (`flash-lite`, `haiku`) is stable *across generations* while the price is not: it scored `gemini-2.5-flash-lite` → `gemini-3.1-flash-lite` as "same tier" when that successor is **2.5× input / 3.75× output** — staying silent on the rung the chain reaches **first**, which defeated the entire feature. Only an exact-id table can see a within-family price change. The same table also correctly sees a within-family price *drop*: `claude-sonnet-5` is **cheaper** ($2/$10) than both `claude-sonnet-4-6` and `claude-sonnet-4-5` ($3/$15), so the newest Sonnet is also the cheapest — which no family-name heuristic could ever tell you.

**Never imply parity when we don't know.** An id missing from the table yields `unknown`, not `similar`. Any fallback means the user is off the model they configured, so the honest line is "pricing may differ" — silence would be a claim we can't support.

Prices verified 2026-08-26 against [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing) and [platform.claude.com pricing](https://platform.claude.com/docs/en/about-claude/pricing). The table now covers every id the app can run — defaults, fallback rungs, and every model a user may pick for themselves (see [Choosing a model](#choosing-a-model-multi-model-support) below):

| Model | Input / 1M | Output / 1M | vs its default |
|---|---|---|---|
| `gemini-2.5-flash-lite` *(default)* | $0.10 | $0.40 | — |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 | 2.5× / 3.75× |
| `gemini-2.5-flash` | $0.30 | $2.50 | 3× / 6.25× |
| `gemini-3.5-flash-lite` | $0.30 | $2.50 | 3× / 6.25× |
| `gemini-3.7-flash` | **$0.75** *(→ $1.50 on 2027-01-01)* | **$3.75** *(→ $7.50)* | 7.5× / 9.4× *(15× / 18.8× from 2027)* |
| `gemini-3.6-flash` | **$0.75** *(→ $1.50 on 2027-01-01)* | **$3.75** *(→ $7.50)* | 7.5× / 9.4× *(15× / 18.8× from 2027)* |
| `gemini-3.5-flash` | $1.50 | $9.00 | 15× / 22.5× |
| `claude-haiku-4-5` *(default)* | $1.00 | $5.00 | — |
| `claude-sonnet-5` | $2.00 | $10.00 | 2× / 2× *(≈2.66× input on real text — see tokenizer note)* |
| `claude-sonnet-4-6` | $3.00 | $15.00 | 3× / 3× |
| `claude-sonnet-4-5` | $3.00 | $15.00 | 3× / 3× |
| `claude-opus-5` | $5.00 | $25.00 | 5× / 5× *(≈6.65× input on real text)* |
| `claude-opus-4-8` | $5.00 | $25.00 | 5× / 5× *(≈6.65× input on real text)* |
| `claude-opus-4-5` | $5.00 | $25.00 | 5× / 5× |

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

## Choosing a model (multi-model support)

For most of its life The Curator could run exactly **two** models — one per provider, both the cheapest tier. That kept ingesting a large library affordable, and it is still the **default**. But it also meant a user who wanted more capability out of a big wiki, and was willing to pay for it on their own API key, had no way to ask.

`OFFERABLE_MODELS` in [`llm.js`](../src/brain/llm.js) is that ask: the set of models the app will let you select, per provider, **cheapest first**. Every entry was probed live on 2026-08-26 against this repo's **real** ingest outline prompt on real prose — never a toy `return this JSON` probe — and carries what that probe measured, so the cost *and* the trade-off are visible at the moment of choosing.

**The defaults do not change.** `gemini-2.5-flash-lite` and `claude-haiku-4-5` remain pinned, and remain the cheapest thing on their provider. Picking a stronger model is a deliberate act, and the price is on screen when you do it.

### What each entry tells you

| Field | Meaning |
|---|---|
| `input` / `output` | USD per 1M tokens, **as billed today**. Resolved at read time, so a promotional price that expires mid-session corrects itself. |
| `standardInput` / `standardOutput` | The price after any promotion ends. Identical to `input`/`output` when there is no promotion. |
| `promotionUntilIso` / `standardPriceFromIso` | The dates a promotion runs to and the standard price starts from, or `null`. |
| `maxOutput` | Hard output ceiling, in tokens. |
| `thinks` | Does it spend **hidden reasoning tokens**? Those are billed as *output* and drawn from the *same* budget as the answer. |
| `jsonRaw` | Does a raw `JSON.parse` of the ingest outline succeed, or is the `jsonrepair` fence-stripping fallback load-bearing? |
| `tokenizerFactor` | Measured **input-side** token multiplier against the provider's older tokenizer. `1.0` = no premium. |
| `suitability` | `general` · `chat-only` · `caution` — see below. |
| `note` | The measured reason behind `suitability`, written to be shown to a user verbatim. |

`suitability` describes **fitness for a feature** and nothing else. Cost lives in the price fields and hidden reasoning spend lives in `thinks`; folding either into `caution` would put five of seven Gemini models in one bucket and the label would stop meaning anything.

- **`general`** — measured clean for every feature, ingest included.
- **`chat-only`** — measured *unfit for ingest specifically*. Ingest is JSON mode; chat is text mode and is unaffected by a JSON defect, so the model stays genuinely useful for chat instead of being hidden. `gemini-3.5-flash-lite` is the only current case.
- **`caution`** — usable everywhere, but carries a measured downside (a scheduled price rise, thinner outlines than a *cheaper* model, a same-priced sibling that beat it) that the user must see before choosing it.

### The three measured surprises worth knowing

**1. Thinking behaviour is PER-MODEL, not per-generation.** `claude-opus-5` was released *after* `claude-sonnet-5` and ran no hidden reasoning at all (0/3), while `claude-sonnet-5` ran adaptive thinking on **every single call** (7/7). Two models one release apart, opposite behaviour. So for any model nobody has probed, `thinks` is genuinely **unknown** — not "probably like its neighbour". This is why unprobed models are refused outright (below).

**2. The headline price understates the newest Anthropic models by ~33%.** `claude-sonnet-5`, `claude-opus-5` and `claude-opus-4-8` use a newer tokenizer that produced **1.329× more input tokens** than `claude-haiku-4-5` on the same Curator prose. So `claude-opus-5` at $5/1M input really costs **≈$6.65 per 1M Haiku-equivalent tokens — 6.6×, not the 5× the headline implies**. A cost estimate computed from *character count* under-reports these models by about a quarter unless the factor is applied. It is carried per-model as `tokenizerFactor` rather than folded into the price, because folding it in would make our table disagree with the provider's own invoice. It is deliberately **not** applied to output: the 1.329× figure was measured on prompt text, and extending an input measurement to output would be over-claiming. It is also **provider-relative** — it compares models within one provider and says nothing about Gemini-vs-Anthropic token counts.

**3. More money does not buy a better plan.** `gemini-3.5-flash` costs **15× the input and 22.5× the output** of the default and planned *fewer* outline pages than it (8–14 against 18–20). `gemini-3.1-flash-lite` is 2.5× the price and thinner still (5–12). The strongest reason to reach for a bigger model is not the Flash ladder — it is `claude-haiku-4-5`'s **outline variability**: 5 to 13 pages on the *same source*, the widest spread measured, so a long document can be planned much more thinly on one run than the next. `claude-opus-5` planned 25–27 pages on that same source.

### Two rules that keep the catalogue honest

**A model may not be offered for a feature it has never been measured against.** `claude-opus-4-7` and `claude-opus-4-6` are real, documented, and have a published price and ceiling — and are **not offerable**, because neither has been run against the real ingest prompt. They sit in `AWAITING_MEASUREMENT` with the reason, and the suite asserts they carry no price, are not a default, are not a fallback rung, and are refused by `getProviderInfo`. To promote one: probe it live with the real prompt, then add its price, cap and measured fields together.

**A model may not be offerable unless it is fully specified.** This is structural, not a convention: `OFFERABLE_MODELS` entries are built by a factory that **throws at module load** if any measured field is missing, if the id has no entry in `MODEL_PRICES_USD_PER_MTOK`, or if it has no entry in the provider's output-cap map. Price and ceiling are **derived** from those tables rather than re-typed into the entry, so there is no second copy to drift — two hand-maintained copies of one fact is this repo's named cause of the v3.2.0 CRITICAL, and here the fact is a number a user makes a spending decision from.

### DOMINATED — alive, fairly priced, and beaten by a same-priced sibling

`DOMINATED_MODELS` is the companion to the `RETIRED` list in `test-chat-model.js` §9, and deliberately a **separate** idea:

| List | Meaning | Consequence |
|---|---|---|
| `RETIRED` | The id **404s**. | Shipping it does nothing at all. Banned everywhere. |
| `DOMINATED` | The id **works** and is honestly priced, but another model at the **same price** measured better on every axis tested. | Banned from `FALLBACK_CHAINS`. **Allowed** in `OFFERABLE_MODELS`. |

That split is the whole point. A **fallback chain** picks *for* the user, silently, on the worst possible day — their pinned default has just been retired. A dominated rung there is indefensible: nobody chose it, nobody was told, and the chain's documented promise is "the cheapest model that still *works*". The **offerable catalogue** is the opposite: the user picks, deliberately, with the measured reason on screen. Hiding a working model there would be deciding for someone what they may spend their own API key on. The honest answer is to show it and label it. So `DOMINATED ∩ FALLBACK_CHAINS = ∅`, while `DOMINATED ⊆ OFFERABLE` is fine.

Current entries:

- **`gemini-3.5-flash-lite`** — dominated by `gemini-2.5-flash`. Identical $0.30/$2.50, but 2 of 9 live runs against the real ingest prompt returned JSON that *neither* `JSON.parse` nor `jsonrepair` could fix (a dropped object key, `finishReason: STOP` — a generation defect, not truncation the output-token-limit ladder could route around). `gemini-2.5-flash` was 3/3 clean on the identical probe and plans wider outlines. It was pulled from the Gemini chain on 2026-08-26 by a bespoke pair of assertions naming it specifically; those are now folded into this list, so the *next* dominated model is caught by the same class invariant instead of needing its own pair.
- **`claude-opus-4-5`** — dominated by `claude-opus-5`. Identical $5/$25 and behind on all three measured axes: half the output ceiling (64,000 vs 128,000), fenced JSON where opus-5 returns bare JSON, and 12–13 outline pages against 25–27. It plans more thinly than `claude-sonnet-5` does at two-fifths of the price.

Two models were **considered and deliberately not listed**, because an over-claimed domination is worth less than an honest number:

- **`claude-opus-4-8`** meets the definition on the data — same price and ceiling as `claude-opus-5`, no axis better, 19–20 outline pages against 25–27 — but that verdict rests on **outline coverage alone from a small sample**. It carries `suitability: 'caution'` with the measured number instead.
- **`claude-sonnet-4-5`** is behind the same-priced `claude-sonnet-4-6` on three axes (64,000 vs 128,000 ceiling, fenced vs raw JSON, 15–16 vs 17 outline pages). It is **not** listed only because it is a live `FALLBACK_CHAINS` rung, and listing it would break the invariant that makes `DOMINATED` meaningful. Recorded here rather than quietly dropped: **if the Anthropic chain is ever revisited, `claude-sonnet-4-5` is the rung to re-examine.**

### Promotional prices expire — the app handles the date itself

`gemini-3.6-flash` and `gemini-3.7-flash` bill at **$0.75/$3.75 through 2026-12-31 and double to $1.50/$7.50 on 2027-01-01**. Three ways to handle that, and only one is safe:

- ❌ **Hard-code $0.75/$3.75 as if permanent.** This is the [cached-price near-miss](#when-a-price-decides-chain-order-verify-it-against-the-live-provider-page) with the clock running the other way. On 2027-01-01 the picker would quote every user **half** what they are billed, on the one surface whose entire job is cost honesty — and **no ordering assertion would notice**, because the array order survives the doubling. Proven by mutation: encoding both promos as permanent leaves every cheapest-first assertion **green**.
- ❌ **Don't offer the two models.** Over-correction — they are the modern non-lite Flash tier at a genuinely good rate today.
- ✅ **Resolve by date, and state the expiry in the record.** Both halves matter: the date resolution means nobody has to remember to ship a release on New Year's Day, and the stated expiry means a human reading `$0.75` cannot mistake it for a stable price.

Mechanically: `MODEL_PRICES_USD_PER_MTOK` holds the **standard (post-promotional)** price, and `PROMOTIONAL_PRICES` holds the discount with an inclusive, UTC-pinned expiry. `resolveModelPrice(id, atMs)` applies the discount only while it is live; `getModelPrice(id)` is that at `Date.now()`, so every existing consumer became date-correct for free with no signature change.

**Every failure mode resolves to the higher price** — a wrong clock, a dropped promotional record, a typo'd id. That is deliberate, and it matches the direction this repo already takes on money (an unrecognised cost tier resolves to `unknown`, never `similar`). A user quoted *more* than they are billed picks a cheaper model than they needed; a user quoted *less* was lied to.

The guard is exercised on **both sides of the boundary today**, not on the day it matters — a check that can only run in January is a comment, not a guard. `test-chat-model.js` §13 additionally requires a promotion to be *strictly* cheaper than the standard price it precedes, so writing the promo value into the standard table collapses the two and goes red.

### Where the allow-list is enforced

Inside **`getProviderInfo()`** — the single producer of the model string both SDKs receive — and nowhere else. Validating at a route would leave the other seven `generateText` entry points (ingest, compile, chat, query, health-AI, shared-brain, diagnostics) open **and** create a second hand-maintained copy of the guard, which is exactly the shape that produced the v3.2.0 CRITICAL.

A model id that is not offerable for the resolved provider is **refused by falling back to that provider's default**, not by throwing. Two reasons, both about failing safe:

1. A stored selection can outlive the model it names — a user picks a model, we later pull it after a bad live probe, and their saved preference now points at an id we refuse. Throwing would hard-fail every chat and every ingest for that user; falling back keeps them working.
2. The default is the **cheapest** model on that provider, so a refusal can only ever spend *less* than the user asked for, never more.

This mirrors `normalizeChatProvider` (invalid provider → `null` → global) and `anthropicMaxOutputTokens` (unknown id → conservative cap). A caller that needs to know a refusal happened can compare: `getProviderInfo` returns the model it actually resolved, so `result.model !== requested` is the signal. Prototype-pollution inputs (`__proto__`, `constructor`, `toString`) are refused **by construction** — `isOfferableModel` scans an array comparing with `===`, so no object is ever indexed by the caller's string.

---

## For developers (release checklist)

When releasing a new version that updates a model default:

1. **Update `DEFAULTS`** in [`src/brain/llm.js`](../src/brain/llm.js).
2. **Update `FALLBACK_CHAINS`** — put the closest-priced live successor first, and **probe every rung against the live API before shipping** (a chain is untested by definition until it fires). Never add a rung that is older than the primary. Adding the *previous* primary is only right when it is still alive and still cheaper-or-equal.
   - A costlier rung is fine — it is the last resort — and the cost banner will tell the user.
3. **Add the new model's published price to `MODEL_PRICES_USD_PER_MTOK`** in [`llm.js`](../src/brain/llm.js), for the new default, every new rung, **and every new offerable model**. Without it the fallback degrades to the vaguer `unknown` wording — and an offerable model would show a blank price in the picker. `test-chat-model.js` §5 asserts that **every** `DEFAULTS` + `FALLBACK_CHAINS` + `OFFERABLE_MODELS` id is priced *and* that the table carries nothing beyond them, so both forgetting a price and leaving a dead-weight one fail `npm test` rather than shipping silently.
   - If the price is **promotional**, put the **standard** price here and the discount in `PROMOTIONAL_PRICES` with its expiry. Never write a promotional number into the standard table — see [Promotional prices expire](#promotional-prices-expire--the-app-handles-the-date-itself).
4. **Add its output ceiling** to `ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS` or `GEMINI_MODEL_MAX_OUTPUT_TOKENS`. Caps are **not** monotonic with recency — look it up, never infer it from a version word.
5. **To make it user-selectable, add an `OFFERABLE_MODELS` entry** — but only after probing it live with the **real** ingest outline prompt. Record what you measured: `thinks`, `jsonRaw`, `tokenizerFactor`, a `suitability` verdict and the `note` explaining it. The factory refuses an incomplete entry at module load, so an under-specified model does not merely fail a test — the app refuses to boot. If you cannot probe it yet, add it to `AWAITING_MEASUREMENT` with the reason instead.
6. **Bump `package.json` version** and push. End users pull via the existing auto-updater.
7. Note the model change in [`CLAUDE.md`](../CLAUDE.md) "Git History of Major Fixes" table.

> **The provider selector requires no change here.** The chat *provider* selector (Gemini / Claude) reads the current `DEFAULTS[provider]` from the backend (`getDefaultModel` → `GET /api/config/api-keys` `models`), so bumping `DEFAULTS` updates its label automatically.
>
> **The model picker is different, and does need step 5.** It reads `OFFERABLE_MODELS` (served additively as `offerable` on the same endpoint), so a new model appears there only when you add a measured entry for it — deliberately, because that entry is where its price, its ceiling and its trade-off come from. Bumping `DEFAULTS` alone changes which model is *pre-selected*, not what is *available*.

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
