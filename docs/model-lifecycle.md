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

The hand-measured catalogue holds **17 models — 7 Gemini, 7 Anthropic and 3 OpenRouter**. Gemini Pro is deliberately absent (a different price class again, and nothing in the list measured coverage-starved), as are `claude-opus-4-7` and `claude-opus-4-6` (real and documented, but never probed — see `AWAITING_MEASUREMENT` below). **OpenRouter** is additionally described in [its own section](#openrouter--a-third-provider-whose-catalogue-moves-without-us), because the design there provides for a *second*, larger chat-lane list read from the provider's live catalogue rather than hand-typed here. **That overlay is not populated in this release** — `setOpenRouterCatalogue()` has no caller outside its own tests, so `listOfferableModels('openrouter')` returns exactly the three hand-measured entries above and 17 is the whole offer on both lanes. Those three were admitted the same way every other entry was, by measurement against the real ingest prompt.

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

> **Status in this release: the chat lane's live-catalogue overlay is BUILT BUT NOT POPULATED.** Everything in this section describes the admission design and the structural filters it applies — all of it real code, all of it exercised by tests. What does not exist yet is a **caller**: `setOpenRouterCatalogue()` is invoked nowhere outside its own test suites, so no live catalogue is ever fetched at runtime and `listOfferableModels('openrouter')` returns the three hand-measured build-lane entries and nothing else. Both lanes therefore offer the same three models today. Read what follows as **the contract a future catalogue fetch must satisfy**, not as a description of models a user can pick right now.

### Why the standards differ: the consequence is asymmetric

A bad chat answer costs one answer, and **you can see it** — it is prose, on your screen, and you can ask again on a different model for the price of another question. A bad ingest is not like that. It writes pages into the wiki permanently, it does so across a document you will not re-read, and you have already paid for it. The wiki is the thing this whole app exists to protect, and ingest is by far the largest token consumer in it.

So the lanes are not "strict" and "lax". They are two different bets with two different downsides, priced accordingly.

### What the app refuses structurally, before anyone measures anything

From the live catalogue, four classes are refused by construction rather than by judgement, because in each case the refusal follows from something the app cannot do rather than from a preference:

- **No JSON mode at all.** Ingest asks for structured output. A model whose published parameters include no way to request it cannot serve the build lane, and the app will not pretend otherwise. (This is candidacy, not a guarantee — see below.)
- **Router ids whose price is published as unknown.** An aggregator can offer meta-models that decide *at request time* which real model serves you, and whose price is therefore unknowable until after the call. Every cost surface in this app quotes a price **before** you choose. A model whose price cannot be stated before the call is incompatible with that, so it is refused rather than displayed with a blank.
- **Moving aliases.** Some ids are pointers that resolve to whatever the vendor currently considers newest. Pinning one means what you picked can change underneath you with no signal — the exact silent-swap the app refuses one layer down by forbidding provider substitution on every request.
- **No published output ceiling.** The Phase-1 ingest outline requests a large output budget, and a model whose ceiling is below it is structurally unable to serve one however well it scores on anything else. Real examples exist in the live catalogue at 4,000 and 7,372 tokens — both pass every other filter.

**Tiered (long-context) pricing is a fifth refusal, and only for the build lane.** Some models change their rate above a prompt-size threshold — one common case doubles both rates above 200,000 prompt tokens. The Curator's price model is a single `{input, output}` pair, and every consumer of it assumes one rate per model. A flat entry would therefore quote **half the real rate on exactly the largest ingests**, which is where a user spends most — and no ordering assertion would notice, because array order survives a doubling. Such a model is admitted **chat-only, structurally**: the factory refuses to build it as anything else. That is safe for the specific reason that chat's prompt is bounded and small — on the order of 20k tokens against a threshold an order of magnitude higher — so the flat rate quoted for chat is the rate actually billed. The build lane, the only lane that can cross a threshold, cannot reach these models at all.

**What the filters narrow to, and what they do not decide.** They are a large reduction and still leave hundreds of candidates. The API narrows the field; it does not choose. That is the point of the next section.

### Why measurement cannot be automated — the load-bearing argument

The obvious idea is to qualify a model on demand: the user picks one, the app probes it, and if the probe passes it enters the build lane. It was considered and **rejected**, for reasons that are worth stating in full because they are the reason the build lane is small.

**Metadata says a model ACCEPTS JSON mode. It cannot say the JSON PARSES.** Those are different claims, and this project's own catalogue is the proof. `gemini-3.5-flash-lite` advertises structured output and honours the request — and in 2 of 9 live runs against the real ingest prompt it returned JSON that neither `JSON.parse` nor the `jsonrepair` fallback could recover: a dropped object key, unrecoverable because repair would have to invent it. In an aggregator's metadata that model looks fully JSON-capable, because it is. The defect is in what comes back, not in what is supported.

**A probe a new user could run would be a toy probe.** A realistic ingest outline prompt measured about **285,000 characters**, of which roughly **90% is the user's own index and slug inventory**. A fresh install has neither, so the only prompt it could probe with is the small synthetic one [this document already forbids](#verify-a-chain-against-the-live-api-not-against-memory) — and forbids for a measured reason: a trivial prompt returns a shape that passes green while a real prompt returns one that fails. That is not hypothetical here; it is how a 100%-reproducible failure survived a release.

**One probe cannot see a 2-in-9 defect.** At roughly a 22% failure rate, a single run passes a broken model about **78%** of the time. Catching it reliably takes on the order of nine runs — on a prompt of that size, before the user has ingested anything.

**And two of the recorded fields are comparative by nature.** `suitability` and `note` say things like *"a same-priced sibling measured better on every axis"* — a claim about a relationship between models, which no single model's probe can produce. A machine can honestly emit *"7/7 clean JSON, 14 pages planned"*. It cannot write the verdict.

**One more, specific to an aggregator:** an OpenRouter id routes over upstream hosts that can change. A measurement can therefore go stale **without the id changing** — so even a measurement taken correctly is a statement about a moment, which is another reason the build lane is entered deliberately and by hand rather than automatically.

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

**OpenRouter is now a full build-lane provider.** Three models were measured and admitted, and `upstage/solar-pro4` is pinned as the default. Every consequence below is a *change* from the previous release, where the lane was empty:

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

If your usage patterns make Haiku's quality insufficient (rare for wiki ingest but possible for dense academic PDFs), the supported route is **Settings → Providers & keys**, which offers six Anthropic alternatives with their measured trade-offs on screen. `claude-sonnet-5` measured the strongest value of the seven; `claude-opus-5` the richest outlines, at a large multiple.

Developers can still bypass the catalogue entirely:

```bash
# in .env — unrestricted, bypasses the OFFERABLE_MODELS allow-list,
# and outranks whatever the user picked in Settings.
LLM_MODEL=claude-sonnet-4-5
```

Any model ID Anthropic accepts works there. The fallback chain still applies on top of the override.

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
