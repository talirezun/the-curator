# Model Lifecycle & Fallback Safety Net

> **Applies from:** v2.4.0+
> **Scope:** ingest pipeline, chat, query, AI Wiki Health (broken-link suggestions v2.4.3+, orphan rescue v2.4.4+), MCP-adjacent tools
> **Audience:** every Curator user; also relevant to developers shipping new releases

The Curator uses an LLM for every text-writing task — ingest (atomising a source into entities / concepts / summary), chat, and AI-assisted Wiki Health actions (broken-link suggestions, orphan rescue). Every one of those calls flows through a single chokepoint in [`src/brain/llm.js`](../src/brain/llm.js).

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
    'gemini-2.5-flash',             // next tier up in the same family
    'gemini-1.5-flash',             // previous-gen stable
    'gemini-1.5-flash-latest',      // Google's rolling alias as last resort
  ],
  anthropic: [
    'claude-3-5-haiku-latest',      // previous Haiku gen — same cost tier, SDK-typed
    'claude-3-5-haiku-20241022',    // explicit stable version (last-resort Haiku)
    'claude-sonnet-4-5',            // upgrade tier if Haiku family is entirely gone
    'claude-3-7-sonnet-latest',     // rolling alias recognised by SDK types
    'claude-3-5-sonnet-latest',     // deep fallback — broadly-available Sonnet
  ],
};
```

The first model that responds is the one used for that call. Subsequent calls retry the primary first — when the provider restores it (or when you update), the Curator silently goes back to primary.

**Only `model-not-found` errors trigger fallback.** Rate limits (429), service-unavailable (503), and authentication failures (401) go through their existing retry / surface paths. They don't cascade through the chain.

---

## What you'll see as a user

### Normal operation

Nothing. The Settings tab shows the usual provider badge:

> 🟢 Active: Gemini — `gemini-2.5-flash-lite`

### When a fallback is in use

An amber banner appears just below the provider badge in Settings:

> ⚠ **Using fallback model.** Gemini's `gemini-2.5-flash-lite` is unavailable; currently running on `gemini-2.5-flash`. Open **Check for Updates** above to pull the latest Curator with an updated default model.

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
2. **Update `FALLBACK_CHAINS`** if the *previous* primary should now be a fallback (so users mid-update still work).
3. **Bump `package.json` version** and push. End users pull via the existing auto-updater.
4. Note the model change in [`CLAUDE.md`](../CLAUDE.md) "Git History of Major Fixes" table.

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

2. **Model ID format.** Anthropic's SDK v0.39.0 recognises up to `claude-3-7-sonnet-latest` / `claude-3-5-haiku-latest` in its TypeScript types; newer model IDs like `claude-haiku-4-5` and `claude-sonnet-4-5` are accepted as opaque strings but not validated at build time. If your primary model rejects with `404`, the fallback chain walks same-tier Haiku variants first, then escalates to Sonnet (higher cost but always available).

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
[llm] Model "gemini-nonexistent-retired" returned "not found"; trying fallback "gemini-2.5-flash"...
[llm] Primary model "gemini-nonexistent-retired" is unavailable; using fallback "gemini-2.5-flash". Please run "Check for Updates" in Settings to upgrade to a current model.
```

And the Settings provider area will show the amber banner. Remove the env override and restart — banner clears on the next successful call.
