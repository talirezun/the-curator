# Operations — environment, config and scripts

> Moved out of the auto-loaded `CLAUDE.md` on 2026-09-23 **verbatim** — each bullet, table and code block below is the text `CLAUDE.md` carried, copied by line range; only root-relative link targets were rebased by `../../` because this file lives two folders down. Nothing was reworded or shortened. `CLAUDE.md` keeps a one-line rule per bullet that points here.

## Environment & Config

```
.curator-config.json    — UI-managed config (API keys, domains path) — never committed
  geminiApiKey          — Google Gemini key (set via Settings tab / onboarding wizard)
  anthropicApiKey       — Anthropic Claude key (set via Settings tab)
  domainsPath           — custom path for domains/ folder (set via UI)

.env                    — developer fallback for API keys (never committed)
  GEMINI_API_KEY        — Google Gemini (default, recommended)
  ANTHROPIC_API_KEY     — Anthropic Claude (alternative)
  LLM_MODEL            — optional model override
  DOMAINS_PATH         — optional custom path for domains/ folder

.sync-config.json       — GitHub sync credentials (never committed)
```

**Key priority:** `.curator-config.json` (Settings UI) takes precedence over `.env` for API keys.
**LLM selection:** dispatch is still on `getActiveProvider()`, but **last-saved-wins is retired** (v3.45.0, "Option B"). Saving a key sets the active provider **only when nothing is active yet** — i.e. on the first key of a fresh install; after that the key is saved and the build lane does not move, and the save reports the deferral rather than performing it. **Choosing the build model is the writer from then on**: `POST /api-keys/build-model` sets both the model and, with it, the provider — one gesture, at the surface whose whole subject is what builds your wiki. **Disconnecting the ACTIVE provider falls to the cheapest measured connected provider** (`clearApiKey` takes a `rank` and a `canActivate`, verifies the ranked proposal is the same SET before trusting it, and records `null` — the decision — when every candidate is refused, because an ABSENT field is what the legacy ladder re-infers from). Set **`ACTIVE_PROVIDER_DERIVED = false`** in [src/brain/config.js](../../src/brain/config.js) to restore last-saved-wins wholesale. `getProviderInfo()` in `llm.js` honours the resolved provider, falling back to whichever provider still has a usable key if the active one's key is missing. Gemini-first-if-both applies only to **legacy configs with no `activeProvider` field**. The cost is stated rather than hidden: a user pasting a key in order to SWITCH now needs one more click — taken knowingly, because the silent version moved the build lane and the bill without asking.
**Default models:** pinned in `DEFAULTS` in [src/brain/llm.js](../../src/brain/llm.js) — currently `gemini-2.5-flash-lite` / `claude-haiku-4-5` (Haiku is the low-cost tier chosen to match Flash Lite's cost profile; opt into Sonnet with `LLM_MODEL` in `.env`).

---

## Scripts Reference

```bash
# Run the test suite (v3.0.1-beta.21+)
npm test            # OFFLINE suites only — fast, free, no network, no API key.
                    # The suite list is the OFFLINE array in scripts/run-tests.js
                    # — read it there; the count moves nearly every release.
                    # Safe to run anytime / in CI.
                    # Children are spawned with API/network credentials stripped,
                    # so a mis-classified suite can never make a paid call.
npm run test:live   # OFFLINE + LIVE suites. LIVE suites hit real
                    # Gemini/Anthropic/GitHub and need keys in .env; each one
                    # self-skips (exit 0) if its key is missing. Costs a few cents.
                    # Live suites get transient-error tolerance (v3.0.1-beta.26):
                    # a provider 503 / dropped stream is reported "inconclusive",
                    # not a failure. See ci-flake.js + CONTRIBUTING.md.
# Manifest of which suites are offline vs live lives in scripts/run-tests.js.

# Retroactive backlink injection (all domains)
node scripts/inject-summary-backlinks.js

# Single domain
node scripts/inject-summary-backlinks.js --domain=articles

# Dry run
node scripts/inject-summary-backlinks.js --dry-run

# ── The three DESTRUCTIVE wiki scripts share ONE argument contract (v3.6.1+) ──
# Name a domain, positionally or with --domain= (interchangeable; they must agree
# if both are given). --dry-run reports every change and writes nothing. --help
# exits 0. There is NO default domain and NO implicit all-domains mode: a bare
# invocation is REFUSED with usage text rather than guessing, because each of
# these rewrites and DELETES wiki files. An unrecognised -/-- token is a hard
# error, never silently skipped — silently skipping `--domain=X` is exactly how
# these scripts came to act on a domain the user never named (they fell back to
# a hardcoded `articles`, so `--domain=business` deleted files in `articles`).
# Domain names are validated as a single safe path segment.

# Deduplicate near-duplicate entity/concept files
node scripts/fix-wiki-duplicates.js articles
node scripts/fix-wiki-duplicates.js --domain=articles --dry-run

# Migrate non-canonical folders (people/, tools/) → entities/
node scripts/fix-wiki-structure.js articles
node scripts/fix-wiki-structure.js --all           # every domain — must be EXPLICIT
node scripts/fix-wiki-structure.js --all --dry-run

# Comprehensive wiki repair (cross-folder dedup, link normalization, backlinks)
node scripts/repair-wiki.js articles
node scripts/repair-wiki.js --domain=articles --dry-run

# Re-ingest all raw files in a domain (NOTE: positional only — this script does
# NOT accept --domain=, and costs real API spend)
node scripts/bulk-reingest.js articles
node scripts/bulk-reingest.js articles --delay=5000  # slower, for rate limits

# Rebuild The Curator.app (called automatically by update, or run manually)
bash scripts/build-app.sh
```
