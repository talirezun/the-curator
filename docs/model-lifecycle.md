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
  openrouter: 'upstage/solar-pro4',     // measured build-lane model — see below
};
```

All three pinned defaults target the **low-cost tier** of their respective providers so ingestion of large libraries stays affordable. Users who prefer higher-quality (and costlier) output pick a different model in **Settings → Providers & keys**, or per-chat from the composer — see [Choosing a model](#choosing-a-model-multi-model-support) below and [user-guide.md §16b](user-guide.md#16b-choosing-your-ai-model). (Developers additionally have the unrestricted `LLM_MODEL` escape hatch; it bypasses the allow-list and outranks the stored Settings choice.)

**OpenRouter now has a pinned default, and it was earned by measurement.** Until this release the entry was `null` and the consequence was intended: OpenRouter could not build a wiki at all. That changed when three routes through it were probed against this repo's real ingest outline prompt — nine runs each — and `upstage/solar-pro4` came back cleanest. It is now a **full build-lane provider**: it can run ingest, Health and Compile, it can be made the active provider, and — the part most likely to surprise you — **saving an OpenRouter key now makes it active**, exactly as saving a Gemini or Anthropic key always has. See [OpenRouter](#openrouter--a-third-provider-whose-catalogue-moves-without-us) below, and read [Saving a key changes which model builds your wiki](#saving-a-key-changes-which-model-builds-your-wiki) before you save one.

`upstage/solar-pro4` is also a genuine affordability win: **$0.03/$0.12 per 1M tokens**, roughly a third of `gemini-2.5-flash-lite` ($0.10/$0.40), which had been the cheapest model The Curator offered anywhere.

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
  openrouter: [
    'ibm-granite/granite-4.0-h-micro',  // $0.017/$0.112 — cheaper than the default it backs up
  ],
};
```

**OpenRouter's chain has exactly one rung, and both the inclusion and the exclusions are deliberate.** An earlier draft of this document argued that a chain here would be *wrong in principle*. That argument rested on there being no pinned default to rescue — which is no longer true — and it is superseded. What survives from it is the narrower point, which still holds: every OpenRouter request carries routing preferences forbidding OpenRouter from serving it out of a different upstream, and never sends the request shape that would let it swap the *model*. This chain is therefore the **only** substitution that can happen, which is why it is short and hand-checked.

`ibm-granite/granite-4.0-h-micro` qualifies on three counts: it was measured clean on the real ingest prompt, it is **paid** (so its availability does not depend on a shared free queue), and it is **cheaper** than the default it backs up — a safety net that cannot cost more than the thing it replaces. Its measured weakness is coverage, not correctness: it plans a thinner outline. Degrading to a thinner plan is the right trade when the alternative is not ingesting at all, and it mirrors what the Gemini chain already does.

**The free model is deliberately not a rung**, and the reason is a rule rather than a preference: a chain picks *for* the user, silently. Free routing may carry different data-handling terms from paid routing — an open question this project does not claim to have settled, set out under [Free models and privacy](#free-models-and-privacy--an-open-question-stated-rather-than-answered) — and that is not a change to make on someone's behalf without them choosing it. **A chain may degrade capability; it may not degrade privacy.**

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

The hand-measured catalogue holds **seven Gemini and seven Anthropic entries, plus a set of OpenRouter routes that grows as candidates are measured** — this document deliberately prints no running total, because the OpenRouter half moves with measurement; read `listOfferableModels(provider)` for the live list. Almost every entry may enter the build lane; `gemini-3.5-flash-lite` is the hand-measured exception, offered as `chat-only`. Gemini Pro is deliberately absent (a different price class again, and nothing in the list measured coverage-starved), as are `claude-opus-4-7` and `claude-opus-4-6` (real and documented, but never probed — see `AWAITING_MEASUREMENT` below). **OpenRouter** is additionally described in [its own section](#openrouter--a-third-provider-whose-catalogue-moves-without-us), because a *second*, much larger chat-lane list is read from the provider's live catalogue rather than hand-typed here. **That overlay is populated on demand**, by `POST /api/config/openrouter/sync` — so `listOfferableModels('openrouter')` returns the hand-measured entries above until a user refreshes, and those plus every admitted catalogue entry afterwards. A fetched entry is `chat-only` by construction and can never be promoted by a refresh; the one route out of that lane is a user's own [on-wiki qualification](#on-wiki-qualification--measuring-a-model-against-your-own-pages), which is a **third lane state** and never entry into this hand-measured one. The OpenRouter entries here were admitted the same way every other entry was, by measurement against the real ingest prompt.

### Where a user picks, and what each choice governs (v3.13.0)

The governing principle is **one model builds your brain; you choose freely when talking to it** — two lanes, not two halves of one setting:

| Lane | Surface | Persistence | Scope |
|---|---|---|---|
| **Build** | **Settings → Providers & keys →** the collapsible model list under a connected provider | Server-side, in `selectedModels` in `.curator-config.json`, keyed **per provider** | **Ingest, AI Health scans, Compile to Wiki, and chat** — everything |
| **Chat** | **Chat composer → Model dropdown** | `localStorage` in that browser (`curator-next-chat-model`) — sticky across conversations and restarts, **not** per-conversation | **Chat only** |

The build lane is **one setting rather than one per feature, deliberately**: Health scans read the same wiki that ingest wrote, in the same shapes, so there is nothing to gain from splitting them and a divergent pair would let the wiki be built and maintained by two models that disagree about it. It is also not a convention that could drift — `health-ai.js`, `compile.js` and `query.js` all call `generateText` **without an options argument**, so a per-model override there is inexpressible rather than merely unused. The structural argument is in [architecture.md → Two lanes](architecture.md#two-lanes-one-model-builds-the-wiki-chat-chooses-per-call).

The split between the lanes is about money and reversibility: ingest is the dominant token consumer, so trying an expensive model on one chat must not change what the next ingest costs. Note there is **no "follow the default" row in the composer menu** — to return, the user picks the default model explicitly. In Settings there *is* a **Follow the app default** button, and it is the only route back to the un-pinned state: picking today's default model by hand **pins** it, which is a different thing (a pinned choice survives a Curator release that bumps `DEFAULTS`; following does not).

**A pin is per provider, and only the active provider's pin is live.** `resolveProviderDefault` selects the provider first and consults `storedSelection(provider)` second, so a model pinned under the non-active provider is stored but dormant until that provider is made active. This matters when reading a bug report: "my pinned model isn't being used" is far more often an inactive provider than a router fault.

Resolution precedence is `per-call preferModel > LLM_MODEL > stored selection > DEFAULTS`, every refusal falls back rather than throwing, and the write route is `guardConcurrent`'d so a pick cannot land mid-ingest. The mechanics — the five model-producing sites, the config-only key gating at both ends, the persistence layer, and why `FALLBACK_CHAINS` and `OFFERABLE_MODELS` obey different rules — are in [architecture.md → Model selection](architecture.md#model-selection-the-router-v3120--v3130). The user-facing walkthrough is [user-guide.md §16b](user-guide.md#16b-choosing-your-ai-model).

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
- **`chat-only`** — measured *unfit for ingest specifically*. Ingest is JSON mode; chat is text mode and is unaffected by a JSON defect, so the model stays genuinely useful for chat instead of being hidden. `gemini-3.5-flash-lite` is the founding case.
- **`caution`** — usable everywhere, but carries a measured downside (a scheduled price rise, thinner outlines than a *cheaper* model, a same-priced sibling that beat it) that the user must see before choosing it.

#### `chat-only` is now ENFORCED, and until this release it was not

This is a **behaviour change to an existing feature**, not new plumbing, and a user who had pinned a chat-only model will see the app behave differently.

`suitability: 'chat-only'` used to be read in exactly three places, all of them badge rendering. Nothing acted on it. The route that pins a build model checked only that the id was in the catalogue and that the provider's key was saved — so a user could pin `gemini-3.5-flash-lite`, the model measured emitting unrepairable JSON in 2 of 9 real ingest runs, as the model that builds their wiki, and the app accepted the click while the badge beside it said *not for ingest*. **A label the code does not honour is worse than no label**: it reports that a decision was checked when it was not.

The lane is now a predicate — `isBuildLaneModel(provider, id)`, derived from `suitability` and nothing else, so exactly one place decides a model's lane — and it is applied at two layers:

1. **The pin route refuses it**, with a message naming the model, saying why, and pointing out that it is still selectable in chat. A silent no-op there would read as the picker being broken.
2. **A pin that is already stored falls back** to the provider default when the build lane resolves. Write-time refusal alone would be insufficient in both directions: a selection saved before this release is already on disk, and a model can be re-classified `chat-only` *after* it was validly pinned. Read-side enforcement is what covers both.

**Chat is deliberately untouched.** A chat-only model stays fully pickable in the composer — the verdict says *unfit for ingest*, and hiding it from chat would be the over-correction the verdict exists to avoid. The refusal also fails closed and cheaply: an unknown provider, an unknown id, or an id we do not offer all return `false`, and the response to `false` is the provider default, which is that provider's cheapest model. The worst case of a false negative is spending *less* than the user asked for.

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

Inside **`getProviderInfo()`** — the single producer of the model string every SDK and adapter receives — and nowhere else. Validating at a route would leave the other seven `generateText` entry points (ingest, compile, chat, query, health-AI, shared-brain, diagnostics) open **and** create a second hand-maintained copy of the guard, which is exactly the shape that produced the v3.2.0 CRITICAL.

A model id that is not offerable for the resolved provider is **refused by falling back to that provider's default**, not by throwing. Two reasons, both about failing safe:

1. A stored selection can outlive the model it names — a user picks a model, we later pull it after a bad live probe, and their saved preference now points at an id we refuse. Throwing would hard-fail every chat and every ingest for that user; falling back keeps them working.
2. The default is the **cheapest** model on that provider, so a refusal can only ever spend *less* than the user asked for, never more.

This mirrors `normalizeChatProvider` (invalid provider → `null` → global) and `anthropicMaxOutputTokens` (unknown id → conservative cap). A caller that needs to know a refusal happened can compare: `getProviderInfo` returns the model it actually resolved, so `result.model !== requested` is the signal. Prototype-pollution inputs (`__proto__`, `constructor`, `toString`) are refused **by construction** — `isOfferableModel` scans an array comparing with `===`, so no object is ever indexed by the caller's string.

**There is one case where falling back is not available, and it throws instead.** Falling back presumes the provider *has* a default to fall back to. Every provider now carries a pinned one, so this branch is **not reachable in the shipping configuration** — but it is deliberately kept, because it is the guard that makes adding a fourth provider safe. If a provider is ever wired up before a build-lane model has been measured for it, resolving it for the build lane with no per-call override yields no model to send, and that is refused at this same single chokepoint — the only correct place, since it is the one producer of the model string — with wording chosen to avoid every substring the recovery classifiers key on, so it cannot be mistaken for a token-limit, a missing model or an overload, retried with backoff, or used to walk a fallback chain. Failing there makes the failure loud, free and actionable; passing an empty model through would turn a configuration problem into an opaque provider error several layers away.

---


## OpenRouter — a third provider whose catalogue moves without us

Gemini and Anthropic are two vendors with two catalogues, and both are small enough to hand-measure in full. **OpenRouter is an aggregator**: one key, one wire format, and hundreds of models from many vendors behind it. That difference is the whole design problem, because this project's admission rule — *a model may not be offered for a feature it has never been measured against* — does not scale to a catalogue nobody on this project controls, that changes without a release of ours, and that is already large enough that measuring all of it is not a task with an end.

The answer is **two admission standards over one catalogue, split by lane**. It is the same principle the app already runs on, applied to a case that forces it to be precise.

| Lane | What it runs | What a model must satisfy to enter it |
|---|---|---|
| **Build** — ingest, AI Health scans, Compile | Writes pages into the user's wiki | **Hand-measured against the real ingest outline prompt.** Unchanged from the standard the 14 hand-measured models were held to. |
| **Chat** | Answers one question | Whatever the user's key unlocks, after the structural filters below — **clearly labelled as unmeasured**. |

> **Status: the chat lane's live-catalogue overlay is POPULATED, on demand.** The previous release shipped `fetchOpenRouterCatalogue()`, `openRouterRecordToSpec()` and `setOpenRouterCatalogue()` fully tested with **zero production callers**, so both lanes offered the same three models. `POST /api/config/openrouter/sync` is the join, driven by **Refresh model list** in Settings; it fetches, filters, admits, persists, and reports the funnel below. On one measured run (28 August 2026) it took `listOfferableModels('openrouter')` from **3 entries to 192**. It is now **also fetched automatically at startup when the catalogue is absent or older than `OPENROUTER_CATALOGUE_MAX_AGE_MS` (24 h)** — see [Automatic catalogue sync](#automatic-catalogue-sync) — and nothing fetched can reach the build lane.
>
> **No standing catalogue count appears in this document, and that is deliberate.** OpenRouter's list moved by **seven records inside five hours** on the day it was measured. Any absolute number here would be wrong within the week; the *method* is what is stable, so every figure below is dated.

### Automatic catalogue sync

**The problem it fixed.** Until this release the OpenRouter catalogue was populated *only* by the
Settings button. A user with an OpenRouter key who never found that button saw the five static
routes and nothing else, with no signal anywhere that a larger catalogue existed. That is the
direct cause of the reported symptom *"the models sometimes show and sometimes do not"*.

**The policy.** `openRouterCatalogueNeedsSync(nowMs)` in `src/brain/llm.js` classifies the stored
catalogue as `absent`, `undated`, `stale` or `fresh` against
`OPENROUTER_CATALOGUE_MAX_AGE_MS = 24 * 60 * 60 * 1000`. An unparseable **or future** timestamp
yields a `null` age and is treated as stale — a clock that cannot be trusted must not be read as
freshness.

**Where it fires, and why that matters.** `maybeAutoSyncOpenRouter()` in `src/routes/config.js` is
invoked from **inside `listen()`** in `src/server.js`, deliberately **not at module scope**: an
offline suite imports that router unisolated, and a module-scope call would make a test hit the
network and write a sidecar into the real user-data directory. It reports a skip reason rather
than failing silently — `test-isolated`, `unsupported`, `config-unreadable`, `no-key`,
`writes-active`, or `failed`.

**Failure is non-destructive, in both directions.** A fetch error is caught and the previous
catalogue is left exactly as it was. An *empty* result throws `OPENROUTER_EMPTY_CATALOGUE` before
anything is replaced — "OpenRouter has no models" is not a state that exists, whereas "we could not
read the answer" very much is. The manual `POST /api/config/openrouter/sync` route and its Settings
button remain, unchanged.

### The fetched catalogue is persisted, and re-checked on the way back in

A refresh writes the admitted **specs** to `<user-data>/.openrouter-catalogue.json` — a sidecar, deliberately *not* `.curator-config.json`, which is the credential store: it is 538 bytes, `chmod 0600`, atomically rewritten on every Settings save, and putting a few hundred kilobytes of third-party data in the blast radius of every key write is not a trade worth making for a list that one unauthenticated GET can rebuild. Persistence is **best-effort**: a disk failure never fails a sync that already succeeded over the network, and the panel says the models are loaded for this session only.

At boot the file is fed **back through the same admission function** the network path uses. A persisted entry gets no more trust than a freshly fetched one, which has three consequences, all intended: a model that has since become inadmissible is **dropped rather than grandfathered**; a hand-edited file claiming `suitability: 'general'` **cannot promote itself** into the lane that writes the wiki; and the price and free registries are rebuilt from the reload, so they cannot drift from what is offered. A corrupt or unreadable file restores nothing and never throws.

**Specs are persisted, not built entries.** An entry carries price *getters* that resolve promotional windows at read time; `JSON.stringify` would flatten one into today's number and freeze a promotional price past its expiry.

### Why the standards differ: the consequence is asymmetric

A bad chat answer costs one answer, and **you can see it** — it is prose, on your screen, and you can ask again on a different model for the price of another question. A bad ingest is not like that. It writes pages into the wiki permanently, it does so across a document you will not re-read, and you have already paid for it. The wiki is the thing this whole app exists to protect, and ingest is by far the largest token consumer in it.

So the lanes are not "strict" and "lax". They are two different bets with two different downsides, priced accordingly.

### What the app refuses structurally, before anyone measures anything

From the live catalogue, models are refused by construction rather than by judgement, because in each case the refusal follows from something the app cannot do rather than from a preference. The rules are applied in a fixed order and each rejected model is attributed to the **first** rule it fails, so the funnel the user sees is reproducible:

- **No JSON mode at all.** Ingest asks for structured output. A model whose published parameters include no way to request it cannot serve the build lane, and the app will not pretend otherwise. (This is candidacy, not a guarantee — see below.)
- **Router ids whose price is published as unknown.** An aggregator can offer meta-models that decide *at request time* which real model serves you, and whose price is therefore unknowable until after the call. Every cost surface in this app quotes a price **before** you choose. A model whose price cannot be stated before the call is incompatible with that, so it is refused rather than displayed with a blank.
- **Moving aliases.** Some ids are pointers that resolve to whatever the vendor currently considers newest. Pinning one means what you picked can change underneath you with no signal — the exact silent-swap the app refuses one layer down by forbidding provider substitution on every request.
- **Batch-only endpoints.** OpenRouter publishes a `<model>:batch` variant beside many models. It carries the same capability metadata as the model it shadows — same context, same output ceiling, same parameters — and answers every **synchronous** request with `404 "only available through the Batch API"`. The Curator makes only synchronous calls, so such a row is not slow or degraded, it is dead. Two things make it worth its own rule rather than a footnote: the batch variant is priced at roughly **half** its usable twin, and the picker sorts cheapest-first, so the dead rows cluster at the *top* of the list. Measured on a 2 September 2026 snapshot: **66 `:batch` records, 57 of which passed every other rule**, with the first one landing at position 8 and nine of them inside the top 40. The rule reads two independent signals — the exact final id segment `:batch`, and a display name ending in `" (batch)"` — and either alone refuses. It must not touch the twin: `google/gemini-2.5-flash-lite:batch` is refused while `google/gemini-2.5-flash-lite` stays eligible, because a rule that hid a working model would be worse than the defect it fixes. `:free`, a live and usable suffix, is deliberately untouched.
- **An output ceiling below 24,576 tokens, or none published at all.** That figure is what the Phase-1 ingest outline actually requests; a model beneath it is structurally unable to serve one however well it scores on anything else. Real examples exist in the live catalogue at 4,000 and 7,372 tokens — both pass every other filter. "No ceiling published" and "a ceiling of zero" get **different reason codes**: the first is *the API did not say*, the second is *the API said no*, and collapsing the two is the fact-vs-absence bug this repo keeps finding.
- **A context window below 200,000 tokens.** This is a **parity rule, not a round number**, and it is the one rule here that is policy rather than capability. `claude-haiku-4.5` — one of the app's own shipped defaults — publishes exactly 200,000, so the rule is *we will not offer an OpenRouter model that is worse on context than a model we already ship*. It costs something real and the cost is recorded rather than discovered later: the measured requirement is only about 110,000 tokens (prompt plus output floor), and the floor ejects the whole meta-llama family and `ibm-granite/granite-4.0-h-micro` at 131,000 — which is the app's own OpenRouter fallback rung and measured 9/9 clean. Granite survives as a **hand-measured static entry**; it simply cannot be admitted through the fetched path.
- **A declared retirement date within 30 days.** `moonshotai/kimi-k2.5` passed every other rule and expired **three days** after the fetch. A risk flag is the right shape for a fact the user should weigh; it is the wrong shape for a model that will stop existing inside the release's own lifetime. ⚠ **This rule needs an injected clock and cannot read one itself** — see [Purity and the clock](#purity-and-the-clock) below.

**Tiered (long-context) pricing is a fifth refusal, and only for the build lane.** Some models change their rate above a prompt-size threshold — one common case doubles both rates above 200,000 prompt tokens. The Curator's price model is a single `{input, output}` pair, and every consumer of it assumes one rate per model. A flat entry would therefore quote **half the real rate on exactly the largest ingests**, which is where a user spends most — and no ordering assertion would notice, because array order survives a doubling. Such a model is admitted **chat-only, structurally**: the factory refuses to build it as anything else. That is safe for the specific reason that chat's prompt is bounded and small — on the order of 20k tokens against a threshold an order of magnitude higher — so the flat rate quoted for chat is the rate actually billed. The build lane, the only lane that can cross a threshold, cannot reach these models at all.

**An eighth rule exists and is OFF by default: text output.** A model whose declared output modalities exclude text raises a **high-severity risk flag** but is not rejected, because the field is frequently absent and treating "did not say" as "cannot" would eject models on silence. It can be switched to a rejection deliberately.

**What one measured run looked like (2 September 2026).** Each row is *models entering the rule* → *models leaving it*. This snapshot is pinned in the repository as `scripts/test-fixtures/openrouter-catalogue-2026-09-02.json` and the whole cascade is re-run over it by `scripts/test-openrouter-batch-only.js`, so these figures are reproducible rather than remembered:

| Rule | In | Out | Dropped |
|---|---|---|---|
| `json_mode` | 421 | 362 | 59 |
| `knowable_price` | 362 | 360 | 2 |
| `not_moving_alias` | 360 | 346 | 14 |
| `not_batch_only` | 346 | 282 | 64 |
| `output_ceiling` | 282 | 221 | 61 |
| `context_window` | 221 | 164 | 57 |
| `not_expiring` | 164 | 162 | 2 |
| `text_output` | 162 | 162 | 0 |

162 eligible → **156 admitted**, with **4 superseded** (models the provider lists that The Curator has already hand-measured, so the measured entry is kept and the fetched copy dropped — reported separately so the arithmetic on screen adds up rather than looking as though the app refused its own defaults) and 2 refused by the spec mapper.

**The `not_batch_only` row is the one to read twice.** Before that rule existed, this same snapshot produced **219 eligible and 218 rows in the picker, 57 of them dead** — a quarter of everything on offer, clustered near the top because they were priced at half their twins. The rule's stage drops 64 rather than 66 only because the cascade attributes each model to its *first* failing rule and two of the `:batch` records already fail `json_mode`. The earlier reading of the same funnel (28 August 2026, 387 records → 193 eligible → 189 admitted) is superseded by this one; the catalogue grew by 34 records in five days, which is itself the reason no absolute count here should be treated as durable.

**What the filters narrow to, and what they do not decide.** They are a large reduction and still leave a large candidate set. The API narrows the field; it does not choose. That is the point of the next section.

### `eligible` is not `measured` — the line this whole design rests on

`eligible: true` means **"nothing in the published metadata disqualifies this model"**. It is a fact about metadata: checkable, reproducible, derivable from a payload with no network and no clock. It is the *absence of a disqualifier*, which is not the *presence of a qualification*.

`suitability` is the other thing entirely, and it requires measurement — nine real runs against the real ingest prompt. The eligibility module is written so it cannot blur the two: it never scores, never ranks, never recommends, and never emits the words *good*, *capable*, *reliable* or *measured*. Everything it produces is a fact plus a structured reason code.

Two consequences that must not be tidied away:

- **`response_format` in `supported_parameters` says the endpoint ACCEPTS the parameter, never that the output PARSES.** `gemini-3.5-flash-lite` — demoted here for returning JSON that neither the parser nor `jsonrepair` could recover in 2 of 9 runs — advertises full support.
- **Hidden reasoning spend is risk-flagged, never rejected, and the reason is measured.** `upstage/solar-pro4` (9/9 clean, the shipping default) and `nex-agi/nex-n2-mini` (0/3, entire 24,576-token output budget spent on hidden reasoning, nothing parseable returned) publish **byte-identical** reasoning metadata: `mandatory: false` with `default_enabled` absent. 59 of the 193 eligible models in the measured snapshot carry that shape — just under a third. A filter that cannot separate the best measured model from the worst measured model is not a filter, so this is a prompt to measure, not a rejection signal.

### Purity and the clock

`src/brain/openrouter-eligibility.js` is **pure**: no network, no filesystem, no `Date.now()`, no `Math.random()`. Every threshold is injected via `opts`, and the current instant is `opts.now`.

That purity has one sharp edge, and it is the reason the sync route has a guard nobody would think to add. With no clock injected, the expiry rule **cannot evaluate anything, so it abstains** — silently, and without rejecting. Measured on the live catalogue: **194 eligible with no clock, 193 with one**, and the model that differs expired three days later. A caller that forgets `opts.now` therefore ships an expiring model while every layer reports success.

So `syncOpenRouterCatalogue()` injects the clock at the impure boundary (it already touches the network), and then **reads back the module's own report of whether the clock landed** rather than trusting that the option name was spelt correctly. If it did not land, the sync **refuses and changes nothing** — "we could not check" must never be served as "we checked". `clockSupplied` is tri-state: a report that does not say is `null`, never `true`.

### Why measurement cannot be automated *for a fresh install* — and what changes once you have a wiki

The obvious idea is to qualify a model on demand: the user picks one, the app probes it, and if the probe passes it enters the build lane. Three of the four objections below still hold, and they shape everything about how qualification works. **Exactly one of them turned out to be a statement about a *fresh install* rather than about probing as such** — and correcting it is what made [on-wiki qualification](#on-wiki-qualification--measuring-a-model-against-your-own-pages) possible.

**Metadata says a model ACCEPTS JSON mode. It cannot say the JSON PARSES.** *Still holds — and is why a probe has to exist at all.* Those are different claims, and this project's own catalogue is the proof. `gemini-3.5-flash-lite` advertises structured output and honours the request — and in 2 of 9 live runs against the real ingest prompt it returned JSON that neither `JSON.parse` nor the `jsonrepair` fallback could recover: a dropped object key, unrecoverable because repair would have to invent it. In an aggregator's metadata that model looks fully JSON-capable, because it is. The defect is in what comes back, not in what is supported. `z-ai/glm-4.7` is the same shape and worse: it clears every structural filter this app has, it is **fast**, and it returned unrepairable output in **9 of 9** runs.

**A probe a *new install* could run would be a toy probe — but that is a claim about the PROMPT, not about probing.** A realistic ingest outline prompt measured **341,005 characters**, and the fixed scaffold The Curator contributes to it is about **3,500 characters** — roughly **1%**. Everything else is the user's own material: their `index.md`, their entity and concept filenames, and their own source document. A fresh install has none of it, so the only prompt it could assemble is the small synthetic one [this document forbids](#verify-a-chain-against-the-live-api-not-against-memory), and forbids for a measured reason: a trivial prompt returns a shape that passes green while a real prompt returns one that fails.

But **a user who wants to ingest with a different model has a wiki by definition** — that is what they are proposing to spend it on. Their own index *is* the realistic prompt. So this objection rules out probing at install time and rules out nothing else, and the rest of this argument was reasoned about a case that is not the one that matters. What follows from it is a hard requirement rather than a permission: a qualification run assembles the **real** `buildOutlinePrompt` from a real domain, read-only, and **refuses** if the domain is too thin to produce one. It never synthesises a prompt in order to have something to measure.

**One probe cannot see a 2-in-9 defect.** *Still holds, and is the reason nine runs is a floor and not a default.* At roughly a 22% failure rate, a single run passes a broken model about **78%** of the time. Fewer than nine runs are recorded honestly, with their run count on screen — and qualify nothing.

**And two of the recorded fields are comparative by nature.** *Still holds, and is the strictest rule the qualifier obeys.* `suitability` and `note` say things like *"a same-priced sibling measured better on every axis"* — a claim about a relationship between models, which no single model's probe can produce. So a qualification run emits **facts and never a verdict**: *"9 of 9 raw JSON, median 25 pages, 41 s mean, $0.005"*. It does not rank, recommend, compare, or write a `suitability` string. A model promoted by a local run keeps reporting `suitability: 'chat-only'` on the wire, and is badged as measured *by the user* rather than by us.

**One more, specific to an aggregator:** an OpenRouter id routes over upstream hosts that can change. A measurement can therefore go stale **without the id changing** — which is why every local record is stamped with **which wiki**, **which source document** and **when**, and why it is invalidated the moment the model leaves the eligible catalogue.

### On-wiki qualification — measuring a model against your own pages

An eligible OpenRouter model that has only ever been offered for chat can be promoted into the **build lane** (ingest, Wiki Health, Compile) by measuring it against the user's own wiki. `src/brain/openrouter-qualify.js` is the measurer; `POST /api/config/openrouter/qualify` drives it.

**What a run actually does**

1. **A free estimate first** — `GET /api/config/openrouter/qualify/estimate`. No network, no LLM, no spend: it assembles the real prompt read-only and reports what a run would cost. If no domain is named it picks the one with the **largest `index.md`** — the cheapest available proxy for *most realistic prompt*, and deliberately **not** the MCP default domain, which is a different question and is often a small scratch domain.
2. **The confirm leads with TIME, not money.** The estimate quotes a **range across models already measured** — 38 s to 382 s per call, so about **6 minutes to an hour** for nine runs — and later measurement widened the top of it further (one candidate took **491 s** for a single call). Money over the same span stayed under a dollar a run. A user quoted a price and not a duration will start a run they cannot afford in the only currency that matters. The estimate says plainly that it cannot predict *this* model; once run 1 lands, a real projection from a real measurement replaces the range.
3. **Nine runs of the real prompt, through the production adapter.** The prompt is assembled **once** and reused byte-identically, so the runs are comparable to each other. It deliberately does **not** go through `generateText`: that would apply the offerable allow-list and silently demote the candidate to the provider default (measuring `upstage/solar-pro4` nine times and filing it under the candidate's name), fold in the retry loop and fallback chain (confounding latency, spend *and* model identity), and convert `finish_reason: "length"` into a throw — turning the most expensive failure mode into an opaque error instead of a measurement.
4. **The run is cancellable, and closing the connection is the cancel.** There is no separate cancel endpoint and no run id to get wrong: the connection carrying the progress owns the run. A cancelled run settles as `CANCELLED`, is **never** stored, and is never recorded as a model defect — persisting it would overwrite a real earlier measurement with a stub.

**How each run is classified.** Three parse classes — `raw` (bare `JSON.parse` succeeded), `repaired` (the repair pass recovered it), `unrepairable` — plus an **independent usability gate**, because the two fail separately: a `raw` run can still be unusable (an empty `pages` array parses perfectly and plans nothing). The gate is ingest's own `usablePageArray`, imported rather than re-implemented, so it cannot drift from what ingest actually accepts.

**The honesty rules, which *are* the feature**

- **`repaired` is not a failure.** `claude-haiku-4-5` — the shipping Anthropic default — fences its outline in a markdown code block **3 times out of 3**, so a raw parse fails on 100% of its responses and every Anthropic ingest already depends on the repair path. Rejecting on `repaired` would reject the model this app ships. Only `unrepairable` and *parsed-but-unusable* are defects.
- **The word "verified" is never used.** The strongest outcome the summariser may emit is `NO_DEFECT_FOUND`, and it is deliberately weaker than "passed". By the rule of three, 9 clean runs are consistent with a true failure rate up to about **33%** at 95% confidence (12 runs, about 25%). What is shown is what was observed, with the run count beside it. `DEFECT_OBSERVED` is the stronger claim of the two, because a defect was actually seen.
- **A rate-limited run is `NOT_MEASURED`** — neither a defect nor a pass. Free ids draw on a shared upstream pool, so whether one answers is not a property of the user's account: over one ten-minute poll, one free model answered 8 of 8 while three of its free siblings answered 0 of 8, same account, same moment. Classifying that as a failure would blame the model for the queue.
- **Latency is recorded and shown, never auto-rejected.** A transient upstream slowdown must not permanently disqualify a good model — but a user about to pin a model that takes minutes per call deserves to see that before they do. `deepseek/deepseek-v4-flash-0731` produced clean JSON and took **491 seconds for a single outline call** — about 10× the control's 48 s median — while `z-ai/glm-4.7` was **fast (34–64 s) and broken in 9 of 9 runs**. Speed and correctness are independent axes, so neither is allowed to stand in for the other.
- **Spend is a floor, not a forecast.** An identical prompt on every run can hit an upstream prompt cache that a real ingest — different source each time, growing index — will not. On the reference harness 2 of 9 runs came back 75% cache-discounted, pulling a nine-run total **17% below list price**. Reported spend is therefore flagged as a lower bound rather than quoted as the cost of ingesting.
- **A defect record is stored too.** `z-ai/glm-4.7` failing 9 of 9 is the most valuable thing this feature can tell a user; discarding it would invite them to pay for the same six minutes again next week.

**Promotion is a THIRD lane state, not entry into the hand-measured lane.** This is the heart of it. *"We measured this across many documents"* and *"you ran nine of these last Tuesday"* are different epistemic claims and must never wear the same badge. `isBuildLaneModel` is therefore two **separate** disjuncts — the hand-measured clause is byte-unchanged, and `isLocallyQualified` is its own clause — so widening one can never silently widen the other, and the two claims stay distinguishable on screen and on the wire.

`isLocallyQualified` refuses at every step, and each refusal closes a different hole:

| Clause | What it refuses |
|---|---|
| OpenRouter only | The other catalogues are hand-typed and complete; there is no *never measured here* entry to fill. |
| The id must be offerable **right now** | The invalidation rule, checked **live** rather than pruned: a model that leaves the eligible catalogue stops granting the lane the instant it leaves, with no cleanup step that could be skipped. |
| The entry must still be `chat-only` | If a model is ever hand-measured into the build lane, that verdict governs and this predicate is not consulted. |
| `jsonRaw === null` — **we** have never measured it | A local run may fill a gap in our knowledge; it **may not overturn a negative finding of ours.** A user who gets nine clean runs on `gemini-3.5-flash-lite` has not refuted the 2-in-9 defect; they have sampled the other 78%. |
| The record must show no defect over at least nine completed runs | `isPassingRecord` — and it also rejects a malformed record, a missing count, a `NaN`, or a count hand-edited to a string, because the record file is local and hand-editable. |

**Invalidation keeps the evidence and withdraws the lane.** A record whose model has left the catalogue is **not deleted** — a qualification cost the user real money and up to an hour, and destroying that evidence because a catalogue fetch came back short would be unrecoverable. The record survives and is shown as void, and `GET /api/config/api-keys` reports `qualifies` and `stillOffered` per record, recomputed on every read.

**Where the records live.** `<user-data>/.openrouter-qualifications.json`, written atomically through `paths.js` and never inside `domains/` (Personal Sync's git work-tree — the v3.3.0 rule). One record per model: a re-run **replaces** its predecessor rather than accumulating, because keeping both and taking the best would let a user re-roll a failing model until it passed. Boot restore is not a trusted load — a malformed record is dropped, not repaired, and every record still has to pass the live predicate above.

**Two consequences that are known and deliberate**

- **A qualification run does not hold the write lock.** It writes no wiki page: it assembles a prompt read-only and calls a model. Registering it as a write would hold the process-wide gate for up to an hour, blocking Sync, Update and Delete — worse than the risk it removes. The route *is* `guardConcurrent`-guarded, so it cannot start while a write is running; but a **catalogue refresh started during a running qualification is not refused**. The accepted cost is named rather than hidden: a concurrent ingest may 429 a run, and a 429 is `NOT_MEASURED`.
- **If the persisted catalogue is missing at boot, a pin to a locally-qualified model falls back to a hand-measured model.** The model is no longer offerable, so the lane predicate answers no — the fail-safe direction, costing the user less than they asked for rather than more. A refresh restores it.

### What a second measurement session found, and why it changed the method

A second session on 2026-08-28 measured **nine more OpenRouter candidates** against the real prompt (343,716 chars this time — the `articles` domain had grown, so `tokenizerFactor` is a ratio against that session's own `solar-pro4` control). `upstage/solar-pro4` was re-run as a **positive control** and reproduced its recorded behaviour, 9 of 9 raw JSON, at a median of 25 pages against the 23 recorded previously — the run-to-run spread of one model, not a change in it.

**Two were admitted. Seven were refused, and the refusals split into two very different kinds.**

Four failed on generation or availability:

| Model | Result |
|---|---|
| `z-ai/glm-4.7` | **0 of 9 parseable — all 9 unrepairable** by both `JSON.parse` and `jsonrepair`. It clears every structural filter, is **fast** (34–64 s), and is priced like a serious model ($0.40/$1.75). Only the real prompt caught it. |
| `minimax/minimax-m3` | **0 of 9 parseable, all 9 unrepairable** — while its **free** sibling `minimax/minimax-m3:free` is shipped on 8 of 9 raw plus 1 repaired. |
| `deepseek/deepseek-v4-flash-0731` | Abandoned after **2** runs: the first took **491 seconds** for a single outline call (~10× the control's 48 s median) and the second never returned a body inside the adapter's 600-second ceiling. A latency defect, not a JSON one. |
| `z-ai/glm-5.2:free` | 3 of 3 attempts HTTP 429 before any work began — `NOT_MEASURED`, which is neither a defect nor a pass. **A model we could not measure may not be offered.** |

The `minimax` pair is the one to carry forward: **same base model, opposite result, and the *paid* route is the broken one.** Reliability here is a property of the **route**, not of the model's identity — which contradicts the natural assumption that a paid tier is the safer one, and means no measurement of one id may ever be carried across to a sibling id. And `glm-4.7` was **fast and broken** while `deepseek` was **slow and clean**, which is exactly why latency is reported beside correctness rather than standing in for it.

**The other three passed every JSON, ceiling and reasoning test and were refused on facts about the id itself** — the finding that changed the method:

| Model | Refused on |
|---|---|
| `qwen/qwen3-235b-a22b-2507` | **Price honesty.** 9 of 9 raw JSON, median 23 pages, ~40 s. Its cheapest JSON-capable endpoint publishes $0.0875/$0.35, but the one cold call billed **$0.011801** — a different endpoint's $0.14/$0.80 exactly, **1.64× what a table entry would have quoted, on the first request.** |
| `moonshotai/kimi-k2.6` | **Price honesty, in the opposite direction.** 9 of 9 raw JSON, median 25 pages, the fastest wide planner tested (22–38 s). 19 JSON-capable endpoints spanning $0.5372–$1.0900 on input (2.03×); the cold run billed $0.5372 while the catalogue headline reads $0.95. Over-quoting is the safe direction and it is **still a number we would be making up.** |
| `qwen/qwen3-30b-a3b-instruct-2507` | **Context floor.** Measured clean and the fastest of everything tested (13–22 s), price exact on all 8 runs that started. But the endpoint that bills it at $0.04815 carries a **128,000**-token window, below the 200,000 floor every build-lane model clears; the endpoints offering 262,144 cost 2–3× more. The cheap price and the large window are not available at the same time. |

**What the session added to the method.** The first session verified that a computed price matched `usage.cost` and treated it as a confirmation. It is a **filter**, and the sharpest one available: **three of the five candidates that passed every quality test failed it or the context floor.** It costs nothing — the probe already records the reported cost — and **only a cold run can perform it**, because a cached run bills a fraction and matches nothing.

**Admitted:** `moonshotai/kimi-k2-0905` — the widest outlines measured on OpenRouter (21–44 pages, median 30) at 25–43 s — and `z-ai/glm-5.3-flash`, clean and wide (median 27) but **slow and thinking**: 120–231 s per call against 23–88 s for the default, a 9th run that never returned inside the 600-second ceiling, and 79–86% of its entire output budget spent on reasoning the user never sees. Both carry those measurements in their `note`, because an entry whose weakness is only in a changelog is an entry the user cannot weigh.

### What the provider tells us, and what we measure

This is the honest narrowing of *"never offer an unmeasured model"*. It is not *"we measured everything"*; it is **"the provider tells us what it costs; we measure whether it can do our job."**

| Field | Source |
|---|---|
| Price (in / out) | **The provider's own API.** Read from the live catalogue, per token, converted to the per-million figures the app quotes. |
| Output ceiling | **The provider's own API**, per model. |
| Context window | **The provider's own API.** |
| Whether the model spends hidden reasoning tokens | **The provider's own API** exposes this as machine-readable metadata. |
| `jsonRaw` — does the ingest outline parse without the repair pass? | **Measured here.** Not derivable from metadata; see above. |
| `suitability` — which lane it belongs in | **Measured here, and written by a human.** Comparative. |
| `note` — the reason behind the verdict, shown verbatim | **Written by a human from measured numbers.** |

The price half is not taken on trust either: the aggregator's published prices were checked against this project's own independently hand-verified table and **matched on all five models compared**. That is a reason to read prices from the API rather than re-typing them, not a reason to skip the check.

**The headline price is not always the price, and the filter knows it.** Some catalogue entries carry pricing *overrides* — a higher rate above a prompt-size threshold, or a rate that varies by UTC time window. The eligibility module resolves an **effective price at the app's real ingest prompt size** (~85,000 tokens, derived from a measured ~341,000-character prompt at roughly 4 chars/token) and raises a high-severity flag when that effective rate exceeds the headline. Every failure direction on price resolves to the **higher** number — an unknown clock quotes a time-windowed model at its most expensive window, an unknown prompt size at its most expensive tier — so a user is never under-quoted.

Two limits on that, stated rather than implied: **the price rendered on a model row is the headline price**, not the effective one; and a tiered model is admitted **chat-only by construction**, where prompts are bounded and small enough that the headline rate is the rate billed. The internal risk flags (tiered-above-headline, time-variable price, unstated reasoning default, per-endpoint variance) are **not currently surfaced in the UI** — they exist for the admission decision and for whoever next reads a funnel.

Everything the aggregator reports is still held to the same structural standard as a hand-typed entry. A catalogue entry goes through the **same admission function** the hand-measured models use, so it must carry a label, a price posture, an output ceiling, a `thinks` verdict and a note, or it does not become an offer. Refusal is **per entry, not all-or-nothing**: one malformed record in a large response is dropped and the rest are admitted, because refusing the lot would hand a third party a switch that disables the feature.

### Free models must never be priced as zero

Some models on an aggregator are genuinely free. Recording that as `{input: 0, output: 0}` is the single most dangerous shape available, and it is refused by construction.

The reason is that zero is **truthy**. A zero-priced entry makes the price lookup return an object rather than nothing, which makes an ingest estimate resolve to `$0.00`, which makes the batch queue's budget guard **accept a spending cap it believes it can enforce** — and then track spend at zero forever while every flag reports success. That is a defect this project has already shipped once, in a form where the number at least moved.

So a free model is recorded by **membership**, never by a price, and the price lookup keeps returning *nothing* for it. Every downstream consequence of that is already implemented and already correct: a dollar cap is refused as unenforceable (which it is — a dollar cap on a free model is meaningless), and cost readouts render **nothing at all** rather than `$0.00`, which is this project's standing rule that a figure is reported or absent, never inferred.

**Identify free by the id, never by the price being zero.** In the live catalogue the two sets do not coincide: a small number of zero-priced ids are not free-tier models at all, and one of them is a router whose real price is unknown until it has routed. Treating "price is 0" as "free" would admit exactly that.

**Rate limits, and why this is a product fact rather than a footnote.** Free models carry a daily request cap, which rises once credits have been purchased on the account. This document deliberately **does not print the figures** — they are the provider's to change, and they could not be independently verified from the provider's own published documentation, whose table renders its values dynamically. Instead the app reads what the provider reports **about the user's own key** — whether it is on the free tier, its limit, how much remains and how much has been used — through a key-check that costs nothing and consumes no tokens, and shows those. That is the same rule as everywhere else in this app: reported or absent, never inferred, and never a number this project invented.

The consequence, though, is worth stating plainly because a user who does not know it will read the resulting error as the app being broken: **a large multi-phase ingest is 40+ LLM calls** — one measured run in this repo's history was 42. A daily cap counted in requests therefore limits how many large ingests a free-tier user gets per day, possibly to a very small number. Free models are viable; they are not unlimited.

**A negative balance refuses free models too.** This is confirmed from the provider's own documentation, and it is counter-intuitive enough to be worth naming: an account in arrears gets errors *including* on free models. Free is not unconditional.

**Availability is per-request, and it is uneven — measured, not assumed.** Free ids draw on a **shared upstream pool**, so whether one answers is not a property of your account alone. Over a ten-minute availability poll during the measurement pass, the free model this app offers answered **8 of 8** attempts — while **three of its free siblings answered 0 of 8**, returning *"temporarily rate-limited upstream"* throughout. Same account, same moment, same tier; entirely different outcomes per model.

That is why the free model is offered as a **deliberate pick and never as a default or a fallback rung**. A default is what runs when the user has chosen nothing, and a 40-call multi-phase ingest cannot rest on a shared queue that may stall partway. A free model is a real option, not a guaranteed one — nothing is billed, and nothing is promised.

### Free models and privacy — an open question, stated rather than answered

An aggregator routes your prompt to some upstream vendor, and your prompt here contains your own notes and your own wiki. The provider documents an account-level setting governing whether requests may be routed to providers that may train on the data, with separate controls for paid and free models.

**Two things about that could not be verified, and are therefore not asserted in either direction:** whether free models *require* that permission to be granted, and what the provider's own data-retention policy is. This documentation will not tell you free models are private, and it will not tell you they are not. If your sources are sensitive, treat that as an open question to settle against the provider's current policy before pointing the build lane — or a chat about those sources — at a free model.

What the app does do on every request is refuse provider substitution, so a request is served by the provider you selected the model from rather than one chosen for you at routing time.

**The app does not send a data-collection preference, and there is a measured reason it cannot simply be switched on.** The provider accepts a per-request flag that refuses upstreams which may train on the data. Sending it unconditionally looks like free privacy hardening; it is not. Measured during this release's live pass: the flag is accepted on paid models, but a **free** model returns `HTTP 404 — "No endpoints found matching your data policy"`. A 404 is worse here than a plain failure, because the app's own model-not-found classifier fires on it and would **walk the fallback chain** — spending additional calls — over a policy flag the app sent itself.

So the honest statement is a conjunction, not a reassurance: **the strict data policy and free models are not combinable on this route.** A paid-only conditional form would be safe in principle and is deliberately not built, because it changes the request shape on every call to solve a problem better solved by the user choosing a paid model when the data matters. Relatedly, and worth knowing before reading a 404 as a retired model: an **account-level** data policy can already make a catalogued free model unreachable with nothing sent at all.

### What was measured before any OpenRouter model was admitted

A build-lane model writes a whole wiki, so none was admitted on catalogue metadata. Every candidate was probed with **this repo's real `buildOutlinePrompt`**, assembled read-only from the real `articles` domain — a 127,666-char index, 607 entity and 2,685 concept filenames, plus a real source document truncated to ingest's own 80,000-char cap. The assembled prompt was **341,005 chars (~77–80k provider-counted tokens)** and was **byte-identical across every model**, which is what makes the numbers below comparable to each other rather than to a toy benchmark. Requests went through the production adapter, carrying the same routing refusal, `require_parameters`, and JSON response format a real ingest sends, at the same 24,576 output budget.

**Nine runs per candidate.** One run cannot distinguish a model that emits clean JSON from one that got lucky, and the defect this measurement exists to catch — unrepairable structured output — showed up in the Gemini catalogue at a rate of 2 in 9.

**Admitted:**

| Model | Runs raw-parseable | Median outline pages | Price (in/out per 1M) |
|---|---|---|---|
| `upstage/solar-pro4` — **pinned default** | 9 of 9, no repair pass | **23** (range 14–36) | $0.03 / $0.12 |
| `ibm-granite/granite-4.0-h-micro` — **fallback rung** | 9 of 9, no repair pass | **9** (range 7–13) | $0.017 / $0.112 |
| `minimax/minimax-m3:free` — **free, chat-oriented** | 8 of 9 raw, 1 needed the repair pass, 0 unrepairable | **21** (range 15–40) | free — no price recorded |

`solar-pro4` is the default because it was the only candidate that was simultaneously clean, richly covering and reliably reachable. It is worth noting that its JSON is **stricter than this app's own Anthropic default**, which fences its outline 3 times out of 3 and depends entirely on the repair path.

**Rejected, and the list is short for measured reasons rather than by accident:**

- **`nex-agi/nex-n2-mini` — 3 of 3 runs unrepairable.** It spent its *entire* 24,576-token output budget on hidden reasoning and returned no parseable outline at all, at roughly 160 seconds per attempt. Nothing in its catalogue metadata could have predicted that **in either direction**: it reads `{"mandatory": false}` — byte-identical to `upstage/solar-pro4`, which measured 9 of 9 clean — and `default_enabled`, the field that would signal reasoning-on-by-default, is **absent on both** rather than `false` (74 of the 380 catalogued models carry that exact shape). An absent field is not a "no". Only a real probe could have found this — which is the whole argument for probing rather than reading a spec sheet.
- **`openai/gpt-oss-20b` — 18 of 18 runs rate-limited (HTTP 429)**, across both 1.5-second and 45-second spacings, while a trivial prompt to the same id succeeded. That is a throughput limit that makes it unmeasurable on a real ingest prompt, and **a model that could not be measured may not be offered.**
- **`liquid/lfm-2.5-2.6b:free` — output ceiling of 8,192**, below the 24,576 the outline requests. Structurally unable to serve the lane.
- **`dots-studio/dots-3-note-preview:free` — carries a retirement date inside this release's own lifetime.** Offering a model due to disappear before the next release is offering a future failure.
- **`ibm-granite/granite-4.1-8b` — measured clean (9 of 9 raw JSON) and still not admitted**, which is the most instructive rejection here. It lost on comparison rather than on defect: `solar-pro4` is cheaper on input, plans wider outlines, and is equally clean. A catalogue is more useful when every entry earns its place against the others.

### The state of the build lane in this release

**OpenRouter is a full build-lane provider.** Models have been measured and admitted against the real ingest prompt, and `upstage/solar-pro4` is pinned as the default. Since v3.16.0 a user can also promote an eligible chat-only route themselves, by measuring it against their own wiki — see [On-wiki qualification](#on-wiki-qualification--measuring-a-model-against-your-own-pages). That is a **third lane state**, badged apart from the hand-measured one, and it is invalidated the moment the model leaves the eligible catalogue. Every consequence below is a *change* from the previous release, where the lane was empty:

- **OpenRouter can run ingest, Health and Compile.** There is a pinned model id to send, and a one-rung fallback chain behind it.
- **It can be made the active provider**, from **Settings → Providers & keys → Set active**, like any other provider.
- **Saving an OpenRouter key makes it the active provider** — ordinary *last-saved-wins*, with no exception any more. This is the change most likely to catch someone out, and it has its own section immediately below.

The guard that produced the previous behaviour has **not** been removed, and it is worth being precise about what it does now. The app still refuses to activate a provider that cannot serve the build lane — that rule was always written as a **class**, not as a special case for OpenRouter, which is exactly why it needed no edit when OpenRouter gained models. It simply no longer *fires* for OpenRouter, because the predicate it asks now answers yes. It remains load-bearing for the next provider added the same way.

#### Saving a key changes which model builds your wiki

The Curator has used **last-saved-wins** since v2.4.2: whenever you save a provider key, that provider becomes the active one, and the active provider is what runs **ingest, Health and Compile**. That rule is not new. What is new is that it now applies to OpenRouter, and that makes it consequential in a way it was not before.

Concretely: if you have been happily ingesting on Gemini and you paste an OpenRouter key to try a model in chat, **your next ingest will be built by `upstage/solar-pro4`, not by `gemini-2.5-flash-lite`** — a different model, from a different vendor, at a different price. Nothing is broken and nothing is lost; the wiki still builds. But it is built by something you did not consciously choose, and if you are comparing wiki quality across ingests it is the sort of change that is very hard to spot after the fact.

Two things follow, and both are worth knowing *before* you save the key rather than after:

- **The active provider is always visible.** The word `active` beside a row in **Settings → Providers & keys** is the truth about which provider is live. If you did not intend the switch, click **Set active** on the row you did want — it moves the build lane back without re-pasting or deleting anything.
- **Chat is a separate lane and is not affected.** Chat sends an explicit per-call model, so it never reads the pinned default. Changing your active provider does not change what answers your chat messages, and picking an OpenRouter model in the chat composer does not change what builds your wiki.

The previous behaviour — save the key, *don't* activate — existed only because activating a provider with no build model was a reproduced P0 that silently broke ingest. That hazard is gone now that a model resolves. Keeping the exception would mean OpenRouter behaved differently from the other two providers for no remaining reason, which is its own kind of surprise.

### `/old` does not support OpenRouter

The legacy interface at `/old` offers Gemini and Anthropic only. This is a **documented limit, not a gap**: its four frontend files are frozen, and this release does not touch them. A user whose only key is an OpenRouter key should use the primary interface.

One known consequence is worth recording, because it is the kind of thing that reads as a bug: `/old`'s first-run overlay checks only for the two original providers' keys, so an OpenRouter-only user who navigates there is shown setup guidance for a key they already have — and that overlay has no Escape, no backdrop close, no close control, and no skip on its first step. It strengthens the existing case for retiring `/old`; it is not a reason to unfreeze it.

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

   ⚠ **A user's on-wiki qualification is not a substitute for this step.** It grants the build lane for that one user, on their own evidence, under its own badge — it never writes an `OFFERABLE_MODELS` entry, never sets `jsonRaw`, and cannot promote a model whose `jsonRaw` we have already measured. Hand-measuring a route later is what turns it from *the user measured this* into *we measured this*, and at that point the hand-measured verdict governs and the local record stops being consulted.
6. **Bump `package.json` version** and push. End users pull via the existing auto-updater.
7. Note the model change in [`CLAUDE.md`](../CLAUDE.md) "Git History of Major Fixes" table.

**Promoting an OpenRouter model into the build lane** follows step 5's rule and adds two constraints of its own, both of which come from [the section above](#openrouter--a-third-provider-whose-catalogue-moves-without-us):

- **Measure it the same way, and record the run count.** Nine runs against the real ingest outline prompt is the target and five is the floor; the `note` states the count observed (`"7/7 clean JSON, 14 pages"`), never an extrapolation from it. A model whose output *any* run cannot recover — neither a raw parse nor the repair pass — does not enter the build lane at all. Build the prompt from a real domain's index and inventory, read-only, writing nothing.
- **The free-tier daily cap constrains the measurement itself.** Nine runs each across every free candidate can exceed the cap. Measure a **small** set thoroughly rather than every candidate thinly — a thin measurement is the coin-flip the standard exists to refuse. Paid candidates are not subject to that cap, and the cheapest eligible ones cost cents for a full pass.

Note that an OpenRouter entry's **price and output ceiling come from the provider's API, not from the static tables**, so steps 3 and 4 do not apply to it in the same way — a catalogue entry carries its own. What is hand-written is what was measured: `jsonRaw`, `suitability`, and the `note`.

> **The provider selector requires no change here.** The chat *provider* selector (Gemini / Claude) reads the current `DEFAULTS[provider]` from the backend (`getDefaultModel` → `GET /api/config/api-keys` `models`), so bumping `DEFAULTS` updates its label automatically.
>
> **The model picker is different, and does need step 5.** It reads `OFFERABLE_MODELS` (served additively as `offerable` on the same endpoint), so a new model appears there only when you add a measured entry for it — deliberately, because that entry is where its price, its ceiling and its trade-off come from. Bumping `DEFAULTS` alone changes what a user who has picked **nothing** runs; it does not change what is *available*, and it does not move a user who has pinned a model.
>
> **Removing an `OFFERABLE_MODELS` entry silently un-pins everyone who chose it.** Their stored id stops passing `isOfferableModel`, so `applyModelOverride` drops them to `DEFAULTS[provider]` on the next call — no error, no banner, and `selectedModels` still reports the id they picked while `models` reports the default they are actually getting (the picker renders nothing as "your choice" in that state, which is the honest outcome). That is the deliberate fail-safe direction — it can only ever spend *less* — but it is a real user-visible consequence of a pull, so pull a model only for a measured reason and say so in the release notes.

When a model is retired without a direct successor (rare):

1. Pick a sensible substitute from the current generation.
2. **Before changing `DEFAULTS`**, verify the new model works on a test account for both free-tier and paid quotas.
3. Ideally release the fallback-chain update first and the `DEFAULTS` bump second, so users have at least a week of the old primary still working as the new fallback.

## Overriding the default locally (developers only)

Set `LLM_MODEL=<model-id>` in `.env` to override for the running provider. The Curator treats this the same as a pinned default — fallback still activates if the override itself is rejected.

**It is unrestricted and it outranks the user's Settings choice.** `LLM_MODEL` deliberately bypasses the `OFFERABLE_MODELS` allow-list — that is the whole point of an escape hatch, and it is how an unprobed model gets probed in the first place. It beats the stored selection because the two occupy the same slot (both reshape the provider default), and letting a Settings click silently override it would remove the escape hatch and make it untestable. It does **not** beat a per-call choice: the chat composer's model dropdown is applied last and wins, on the reasoning that a developer who set an env var would be more surprised to find it overriding a selection they just made in the UI than the reverse. Full precedence: [architecture.md → Model selection](architecture.md#model-selection-the-router-v3120--v3130).

Useful for:

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

   | Call site | Requested output budget | Above the SDK's **forced**-streaming threshold? |
   |---|---|---|
   | Chat / query | the per-style budgets in `RESPONSE_STYLES` (`src/brain/chat.js`) — **read them there, they move on their own cycle** | No, at every style shipped so far. Re-check this cell if any style is ever raised above ~21,333. |
   | Multi-phase ingest — Phase 2 batch (`MULTI_PHASE_BATCH_TOKENS`) | 16,384 | No |
   | Multi-phase ingest — **Phase 1 outline** (`MULTI_PHASE_OUTLINE_TOKENS`) | **24,576** | **Yes** — this call depends on the streaming transport |
   | Single-pass ingest · Compile-to-Wiki | 65,536 (clamped per model) | Yes |

   Note the Phase 1 outline call: at 24,576 it is **above** the guard, so it is not exempt — an earlier version of this note wrongly grouped all of multi-phase ingest as "always under both thresholds". It works because the Anthropic branch streams unconditionally, not because its budget is small.

   ⚠ **That column is about the SDK forcing a transport, not about whether a turn streams to the user.** Read as the latter it now says the wrong thing: a chat turn *does* stream, on **all three** providers, and it does so because the caller passed `opts.onDelta` — not because of any budget. The two mechanisms are unrelated and both are live on the Anthropic path at once. See the next note, and [chat-streaming.md](chat-streaming.md).

4. **A reply can arrive in several content blocks, and the first one is not always the answer (v3.9.1).** An Anthropic response body is an array of typed blocks, not a single string. Until v3.9.1 both extraction points in `callProvider` read `content[0].text`. A `thinking` block carries a `.thinking` field and **no** `.text` field, so the moment a model put one first, `content[0].text` was `undefined` and the call threw:

   > ⚠ Claude returned no text content (stop_reason: end_turn). This is rare and usually transient — try again.

   The message was wrong on both counts: it was neither rare nor transient. **Why it only hit some models.** The Curator sends no `thinking` parameter at all. Omitting it means *adaptive* thinking on `claude-sonnet-5` (the model decides per prompt), and *no* thinking on `claude-sonnet-4-6` and `claude-haiku-4-5`. Measured over three trials each with a real ingest-shaped prompt: `claude-sonnet-5` returned `[thinking, text]` 3/3, while `claude-sonnet-4-6` and `claude-haiku-4-5` returned `[text]` 3/3.

   **That made it a fallback-chain failure, not a curiosity.** `claude-sonnet-5` is the *first* rung of `FALLBACK_CHAINS.anthropic`. The chain's whole promise is to keep you working on the day your pinned default is retired — and rung 1 failed 100% of the time, on exactly that day. Same shape as the v3.6.0 finding where four of five Anthropic rungs returned 404: **a safety net is untested by definition until it is needed.**

   The fix (`extractAnthropicText` in `src/brain/llm.js`) concatenates **every** `type: 'text'` block regardless of position or count, and returns `null` only when there is no text block at all — which is still a real failure and still throws. It concatenates rather than taking the first text block because one reply can legitimately carry several: citations split a response into multiple text blocks, and a server-side refusal fallback can interleave a block between them. The truncation path (`stop_reason: 'max_tokens'`) had the same defect and is fixed the same way — before, a cut-off but perfectly useful chat answer on Sonnet 5 arrived as nothing but the truncation note.

   **The honest cost note.** Because the reply now extracts correctly, a fallback onto `claude-sonnet-5` succeeds — but the thinking tokens it spends are billed as output tokens and the reasoning itself is discarded unread. Nothing in the code suppresses or uses it. So a Sonnet 5 fallback can cost somewhat more per call than its $2/$10 headline rate implies, on top of already being pricier than the Haiku default. This is recorded rather than compensated for, the same way the Gemini reasoning-token note below is.

   **Do not verify this path with a toy prompt.** Adaptive thinking is prompt-dependent: `Return {"ok":true}` comes back as `[text]` and passes green while a real ingest prompt fails. `scripts/test-anthropic-content-blocks.js` therefore asserts a class invariant over generated content arrays rather than a list of remembered shapes.

If your usage patterns make Haiku's quality insufficient (rare for wiki ingest but possible for dense academic PDFs), the supported route is **Settings → Providers & keys**, which offers six Anthropic alternatives with their measured trade-offs on screen. `claude-sonnet-5` measured the strongest value of the seven; `claude-opus-5` the richest outlines, at a large multiple.

Developers can still bypass the catalogue entirely:

```bash
# in .env — unrestricted, bypasses the OFFERABLE_MODELS allow-list,
# and outranks whatever the user picked in Settings.
LLM_MODEL=claude-sonnet-4-5
```

Any model ID Anthropic accepts works there. The fallback chain still applies on top of the override.

---

5. **The thinking listener is wired and delivers nothing — measured, not assumed.** Since chat gained streaming, the Anthropic branch attaches `.on('text')` and `.on('thinking')` listeners to the stream it was already using (only when the caller passed `opts.onDelta`; otherwise the call is byte-identical to before). The `text` listener works. The `thinking` one, in practice, does not deliver: measured live against `claude-sonnet-5` with an ingest-shaped prompt over 4 runs, every one returning content blocks `["thinking", "text"]`, **`delta.thinking` is the empty string** and the assembled block carries only a `signature`. **Anthropic returns the deliberation encrypted, not as plaintext**, for the body this app sends — so **zero** reasoning deltas arrived across all 4 runs, with the ground-truth block types confirming a thinking block existed each time.

   Two consequences worth carrying forward. First, `makeDeltaEmitter`'s empty-delta drop is **load-bearing, not defensive**: without it every Anthropic call carrying a thinking block would emit a zero-length reasoning delta that shows nothing *and* commits the call, disabling the retry ladder and the fallback walk on this provider's main path. **Do not "fix" that drop to make reasoning appear.** Second, the listener stays because it costs nothing and starts working the day Anthropic surfaces summarised thinking text. Emitting a synthetic "the model is thinking" delta in its place was considered and rejected — an indicator must never be advanced to look busy. Note this is orthogonal to note 3: Anthropic has streamed its *transport* since v3.0.1-beta.14 for a timeout reason, and streams to the *user* only when `opts.onDelta` is present. See [chat-streaming.md](chat-streaming.md).

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
| `claude-opus-4-5` | 64,000 |
| `claude-opus-4-8` | **128,000** |
| `claude-opus-5` | **128,000** |
| *anything unrecognised* | 64,000 |

Note the caps are **not monotonic with recency** — Sonnet 4.5 is 64k while the newer 4.6 is 128k — so a cap can never be inferred from a version number. The pattern that *does* hold across the table is **generational**: everything in the 4.5 generation caps at 64,000 and everything 4.6-and-later at 128,000, which is why `claude-opus-4-5` sits at 64,000 while the numerically-adjacent `claude-opus-4-8` doubles it. That is an observation about today's data, **not** a rule the code uses — every id is still keyed exactly, because the moment a cap is inferred from a family word it is a heuristic, and this repo has been bitten twice by exactly that (the retired price-tier heuristic, and the pre-2026-08-24 flat 64,000 clamp that silently halved Sonnet's ceiling).

Gemini is not clamped at all. Its models each carry a **65,536** ceiling in `GEMINI_MODEL_MAX_OUTPUT_TOKENS`, but that map is **declarative data for the catalogue only** — Gemini clamps an over-large `maxOutputTokens` server-side rather than rejecting it, so a client-side clamp would be a behaviour change with no failure to fix. The map exists so the UI can tell a user what ceiling a model has, and so `defineOfferableModel` can refuse a Gemini model whose ceiling is unknown.

An unknown id resolves to the **conservative** value on purpose: guessing high produces a hard API rejection, while guessing low merely truncates, and chat degrades gracefully on truncation (v3.0.7).

**OpenRouter's cap map is empty, and empty on purpose.** The provider publishes a per-model output ceiling for nearly every id, so a ceiling is *readable* for most of them — it is simply not frozen into our source, because an aggregator id routes over upstream hosts that can change, which makes a value hardcoded here a snapshot of a fact that can move **without the id changing**. A catalogue entry therefore carries its own ceiling, read at admission time, and a model with no published ceiling is refused rather than given a guessed one. The lookup that selects a provider's cap map is a `switch` returning nothing for a provider we do not dispatch to — it replaced a two-armed ternary that silently resolved every unknown provider to Anthropic's map, which was harmless only while a third provider was unreachable.

**Release-checklist addition:** when adding a rung, record its **output cap** as well as its price. A test now fails on a shipped id with no cap entry, mirroring the existing price invariant.

## Gemini reasoning tokens draw from the same output budget

`gemini-2.5-flash` — currently the last Gemini rung — spends hidden reasoning tokens from the **same** budget as visible output. A probed request with a 30-token budget returned `finishReason: MAX_TOKENS` after **zero visible tokens**, with 26 consumed by `thoughtsTokenCount`. The flash-lite models showed 0–2.

Nothing in the code compensates for this, deliberately. It is recorded so that a truncated answer on that rung is recognised for what it is rather than investigated as a bug.

Gemini's reasoning is also **hidden in a second sense**: it can never be streamed to the user. `@google/generative-ai` 0.24.1 has no notion of a thought part — the string `thought` appears **zero times** in its distributed bundle, and its text accessor concatenates every part carrying `.text` with no discriminator. So Gemini streams **content only**, and the tokens described above are paid for and never seen.

## Reasoning models spend the output budget before the answer starts

The same effect, on the models where it decides whether an answer completes at all. On a reasoning model, `max_tokens` is a **ceiling on reasoning plus answer** — not an answer-length control. Reasoning tokens are billed as output and drawn from the same budget.

Measured on `z-ai/glm-5.3-flash`, same prompt, budget varied:

| Output budget | Reasoning tokens | Outcome |
|---|---|---|
| 4,096 | ~3,400–3,600 (**~87% of the budget**) | Answer **truncated** — `finish_reason: length` |
| 8,192 | ~3,400–3,600 | Completed naturally at ~4,790 tokens |

Reasoning is roughly **constant** across budgets on that model — it does not scale down to leave room for the answer. So a budget sized against a non-reasoning model is spent before the answer begins. A non-reasoning model, by contrast, stops on its own and leaves the ceiling unused: `moonshotai/kimi-k2-0905` used **913 of 4,096** on the same shape of prompt.

**Read the shipping budgets from `RESPONSE_STYLES` in `src/brain/chat.js`, not from this table.** The figures above are a measurement of the mechanism, not a record of the current configuration, and the per-style budgets move on their own release cycle.

A truncation here is not a hard failure on the chat path: in text mode `handleOutputTokenLimit` returns the partial answer **plus** a "this was cut off" note. That note exists only in the return value and is never emitted as a delta, which is why a streaming consumer must *replace* its draft with the returned answer rather than append to it — see [chat-streaming.md](chat-streaming.md#5-the-authoritative-return-rule).

### Rejected: capping reasoning through OpenRouter's own knobs

Recorded so nobody reaches for these. **The adapter sends no `reasoning` key at all** (`_buildBody` in `src/brain/openrouter-adapter.js`), and these are the reasons to keep it that way. Measured against `z-ai/glm-5.3-flash`:

| Knob | What it actually did |
|---|---|
| `reasoning.max_tokens` | Did **not** cap reasoning — **disabled it entirely** (0 reasoning tokens). |
| `reasoning.effort: 'low'` | Same: disabled entirely, not reduced. |
| `reasoning.exclude: true` | **Strictly worse than doing nothing.** Still burns the full reasoning budget, still truncates the answer — and merely hides the stream, so the dead air returns with the cost unchanged. |

The behaviour of these parameters is upstream and per-model. Treat the table as a measurement of one model on one date, not as a general law: if any of them is ever adopted, it needs its own measurement, and the free/paid and model-family distinctions matter.
