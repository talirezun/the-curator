# The Curator — Development Guide

This file exists so any new Claude session can immediately understand the project state, architecture, known issues, and active design decisions without re-reading git history or debugging from scratch.

**It is deliberately short** (2026-09-23: 196,197 bytes → about 31,600). It is auto-loaded into every Claude Code session in this repo, so it carries what a session needs at the START — what the project is, where state lives, the map, one line per standing rule — and points to the full text of everything else. Nothing was deleted: the full text moved **verbatim** into [`docs/dev/`](docs/dev/README.md) and [CHANGELOG-ARCHIVE.md](CHANGELOG-ARCHIVE.md). **Before you change anything a rule below names, open the file it points to and read the whole paragraph** — the one-liners are pointers, never the record.

---

## What This Project Is

The Curator is a local Node.js web application that ingests text sources (PDF, MD, TXT) and automatically builds an interconnected knowledge wiki. The wiki is stored as plain markdown files, readable by Obsidian as a visual knowledge graph.

**Core loop:**
1. User drops in a source → LLM reads it → writes wiki pages (entities, concepts, summary)
2. Each subsequent ingest updates existing pages instead of duplicating them
3. Obsidian reads the same files → renders a graph where nodes are entities/concepts, edges are `[[wikilinks]]`

**Philosophy:** Compiled knowledge (persistent wiki), not retrieval (RAG). The wiki compounds with every ingest.

## Working state

This repository's working state lives in The Curator (project `projects/curator`, see
`.curator-project`). At the START of every session call the my-curator MCP tool
`get_project_context` with project "curator" and read the standing brief and latest
handoff before acting. When the user says continue or resume, or you come back after a
pause, call `get_project_context` again before acting — another tool or computer may have
saved since. SAVE with `save_working_state` under project "curator" with the
`scope` argument set to your tool's name — "claude-code" if you are Claude Code,
"antigravity" if you are Antigravity, "opencode" if you are opencode, otherwise your
tool's own name, lowercase and hyphenated. Pass `scope` explicitly every time, and never
save under another tool's scope. Save after every material
decision, at least every ten tool calls, and ALWAYS before you stop; a save overwrites,
so send the complete state each time. Pass `harness` as that same name and `model` as
your exact model id if you know it (omit it otherwise — never search files for it), and
record the `seen` map as `foundations_read`.

This project also keeps foundations — canonical documents such as its architecture and firm
decisions — that travel with it. `get_project_context` is the call that returns them with
the brief and handoff, so make it your first action of the session, before you read code
or run anything. Its `seen` map holds their hashes: passing that back as `foundations_read`
on every save is how the next session learns which of them changed.

Some foundations may be skeletons — prompts, not facts; the document says so
at the top. As you learn the project, fill each one and save it with
`save_foundation` (`commissioned_by_owner: true` — this block is the owner's
commission). If the project has a repository, export the filled
foundations into its `docs/` folder on the first commit.

Foundations marked "read first" arrive with their text; the rest arrive as an index.
Open any of them by name with `get_project_context` and `slugs` when the work calls
for it — the brief's "Read before you…" section says which. An index entry with no
text is a document waiting to be asked for, not one that is missing.

## Model tiers for delegated work

- **Fable 5.2** (`claude-fable-5-2`, Agent tool `model: "fable"`): truly complex audits — independent reviews, security and data-safety audits, proven repros. Replaces Fable 5.1 from 2026-11-14.
- **Newest Opus** (Opus 5.5, `model: "opus"`): complex builds and read-only design passes. **Sonnet**: mechanical work.

## Where the rest lives — open by name, on demand

| File | What it holds |
|---|---|
| [docs/dev/decisions-app.md](docs/dev/decisions-app.md) | Full text: product shape and UI (the six design rules), app lifecycle, models/keys/money, security and paths, tests and CI, the Shared Brain workstream, the Chat-modes roadmap pointer, benign GitHub behaviours |
| [docs/dev/decisions-knowledge.md](docs/dev/decisions-knowledge.md) | Full text: wiki write pipeline and Health, ingest, chat and compile, sync and Shared Brain invariants |
| [docs/dev/decisions-agents.md](docs/dev/decisions-agents.md) | Full text: the My Curator MCP and the memory layer (working state) invariants |
| [docs/dev/wiki-pipeline.md](docs/dev/wiki-pipeline.md) | Key functions (`files.js`, `config.js`), the ingest pipeline flow, known LLM compliance failures, the post-ingest checklist, wiki file conventions, Obsidian graph setup |
| [docs/dev/directory-map.md](docs/dev/directory-map.md) | The full annotated directory map |
| [docs/dev/operations.md](docs/dev/operations.md) | Environment & config (keys, provider selection, default models) and the scripts reference (tests, repair scripts, `build-app.sh`) |
| [docs/dev/release-index.md](docs/dev/release-index.md) | One line per archived release; the full rows are in [CHANGELOG-ARCHIVE.md](CHANGELOG-ARCHIVE.md) |

---

## Directory map (condensed — full annotated map: [docs/dev/directory-map.md](docs/dev/directory-map.md))

```
bin/curator.js       — `my-curator`, the neutral CLI (never a bare `curator`: Elastic owns that bin)
src/cli/             — CLI subcommands: context · save · hook · install-hooks · doctor · resolve.
                       A SECOND LOCAL CLIENT of the store; no route calls it
src/brain/           — all logic. ingest.js · files.js (writePage) · compile.js · llm.js · chat.js ·
                       health.js · sync.js · config.js · paths.js (every user-data path) ·
                       working-state.js (the memory-layer store) · sharedbrain*.js · mcp-*.js ·
                       context-framing.js · reading-plan.js · ai-jobs.js / ai-run.js
src/routes/          — Express endpoints, one file per area (ingest, chat, compile, wiki, health,
                       domains, sync, config, memory, mcp, diagnostics, sharedbrain, …)
src/public/next/     — vanilla-JS frontend, no build step: app.js (shell + rail), views/*,
                       shared/* (overview, sidebar, monitor, depth-bar, listbox, markdown, …)
mcp/                 — the My Curator MCP server (stdio). tools/index.js's `tools` array is the
                       authoritative tool list; storage/local.js is its path chokepoint
desktop/             — the Electron Mac app
skills/              — the Claude skills (my-curator, curator-continuity) + build.mjs
scripts/             — test suites (run-tests.js is the manifest), release.js, repair scripts
domains/<domain>/    — user data: CLAUDE.md (domain schema) · raw/ (gitignored) ·
                       wiki/{entities,concepts,summaries,index.md,log.md} · state/ (working
                       state, SYNCED) · conversations/
docs/                — user docs; docs/spec/working-state-v1.md is the PUBLIC on-disk format;
                       docs/dev/ is this guide's moved full text
llm-docs/            — self-contained markdown written for language models (the website assistant)
```

---

## Standing rules — one line each, full text behind the link

### Product shape and UI → [decisions-app.md#product-shape-and-ui](docs/dev/decisions-app.md#product-shape-and-ui)
- No vector DB / embeddings: chat retrieval is query-driven in `chat.js` within fixed budgets (60 KB content, 12 KB catalogue, 50 pages).
- No React/Vue, no build step. Three-place rail (Chat · Domains · Context); Ingest and Shared Brain are hosted sections on the domain page.
- The six design rules bind every view: one overview card (`renderOverview`), one heading rule, the step-body rule, the monitor (`renderMonitor`), continuity by identity (`identitySlotClass(slot)` / `domainIdentityClass(map, slug)` — the domain's RECORDED slot, never its list position; `identityDotClass(index)` is palette arithmetic only and no view may call it), the depth bar (`renderDepthCell`). One sidebar component everywhere.
- A warning, a cost or an outcome never sits behind a chevron (v3.16.1).
- JSON mode for ingest, text mode for chat. UI auto-refreshes after every mutation.
- First run is a non-blocking, dismissible two-door panel (`views/onboarding.js`), never a wizard; its trigger reads config keys only, never `.env`.
- No `--text-dim` token; use `--text-2`. Undefined `var(--x)` fails silently — `test-css-tokens.js` guards it.
- Settings › MCP bridge is the section kit (overview + four head·card sections) held to `scripts/test-next-page-contract.js`; no page-private class.
- The boot guard lives in `index.html`, not `app.js`.

### App lifecycle → [decisions-app.md#app-lifecycle-install-and-update](docs/dev/decisions-app.md#app-lifecycle-install-and-update)
- No Stop button and no `/api/shutdown`; the server runs until quit. Restart uses `process.execPath`.
- Auto-update = `git fetch` + `git reset --hard origin/main` + `npm install` + `build-app.sh`; `main` auto-updates real machines.
- Absolute node path embedded in the AppleScript; `install.sh` auto-provisions Node and git.
- Plain semver, no pre-release suffixes.

### Models, keys and money → [decisions-app.md#models-keys-and-money](docs/dev/decisions-app.md#models-keys-and-money)
- API keys are UI-first: `.curator-config.json` beats `.env`.
- One LLM chokepoint, `generateText()`; the build model is chosen explicitly (last-saved-wins retired, `ACTIVE_PROVIDER_DERIVED`); fallback chains escalate FORWARD in time and every rung is priced.
- `getProviderInfo` falls through to whichever provider has a key — never infer the provider from a label; assert the resolved one.
- A TIERED price (`claude-haiku-5-5`) is charged per call by `priceUsageUsd` and estimated by `estimateCallRates` — never read a flat `getModelPrice` into a cost; Anthropic offers the current generation + the one before, and a retired pick moves FORWARD (`RETIRED_MODELS`).

### Security, credentials and paths → [decisions-app.md#security-credentials-and-user-data-paths](docs/dev/decisions-app.md#security-credentials-and-user-data-paths)
- The server binds 127.0.0.1 only, with a cross-origin guard on mutating requests and a Host-header guard on all.
- Credential files are written 0600 and atomically; any new secret file joins the startup sweep.
- Every user-data path resolves through `src/brain/paths.js`; bundle detection is POSITIVE and fail-safe (unrecognised ⇒ repo mode).
- Check entry (`POST /api/mcp/install/check-entry`) runs a command from ANOTHER app's file, so only this app's launcher, or an absolute `node` + THIS install's `mcp/server.js` [+ `--domains-path <abs>`], ever runs (`vetEntry`); never the entry's `env`; body `{id}` only, the install gate.

### Tests and CI → [decisions-app.md#tests-and-ci](docs/dev/decisions-app.md#tests-and-ci)
- `npm test` = offline suites only (manifest: `scripts/run-tests.js`); every new suite goes in its OFFLINE or LIVE array. Live suites retry once and report transient provider errors as inconclusive.
- Isolate a suite's domains dir with `__setDomainsDirOverride()`; anything that spawns a server uses `CURATOR_TEST_USER_DATA_DIR`. `npm test` never touches a real credential file.
- Assert behaviour, not the presence of a line of source; give a clever test a dumb cross-check; prove a guard by MUTATION.
- System Check is read-only with respect to user data.

### Wiki write pipeline and Health → [decisions-knowledge.md#wiki-write-pipeline-and-health](docs/dev/decisions-knowledge.md#wiki-write-pipeline-and-health)
- Ingest, compile and the MCP's `compile_to_wiki` share ONE page-composition path, `writePage`; `health.js` is a SECOND, independently guarded write surface (`resolveInsideWiki`).
- `writePage()` returns change records; `syncSummaryEntities` and `deduplicateBulletSections` are idempotent and always safe; `normalizePath` special-cases `index.md` and `log.md`.
- Compile is deterministic and idempotent by slug, and never regenerates `index.md` through the LLM.
- Every write path (ingest, compile, `compile_to_wiki`) calls `ensurePagesInIndex`: EVERY page it touched that `index.md` lacks gets a row (not only created pages), re-read at merge time. Only Health's user-triggered, previewed, deterministic **Rebuild index** (`indexDrift`: not auto-fixable, not dismissible, skipped on mirrors) repairs the rest.
- AI Health is READ-ONLY; the semantic-duplicate scan is opt-in, cost-gated and capped; a merge that DELETES requires a preview first.
- Every Health write copies each file it changes first (`health-undo.js`, at `writeFileAtomic`'s recorder and the wiki `rm`; a copy that fails stops the write), outside `domains/`, never synced; Wiki health › Recent changes undoes a change all-or-nothing for 30 days on THIS computer and refuses if any file changed since (owner, 2026-11-07, reversing "no in-app revert"). No undo over the MCP.
- Find duplicate pages remembers answers per domain outside `domains/` (`duplicate-checks.js`), bound to pages, model, prompt and openings; batch merge is server-checked: a remembered high-confidence answer AND `isSpellingVariant`; `isMergeableSlug` is the one test for candidates and merge.
- Every merge that deletes a page composes through `page-merge.js`: the kept page is the base, the rest moves verbatim under `## Merged from <slug>`, and `findLostLines` refuses a delete that would lose a line.
- Wiki health keeps its nodes across a paint (`shared/morph.js`) and follows the press rule: the pressed control answers, a question and an outcome appear on the row, nothing above moves, focus never lands on `body`; `scripts/e2e-wiki-health.mjs` holds the thresholds. Free repairs that delete nothing run on press.
- Wiki health's screen is three lanes (Free repairs · Your decision · AI help), its words held to a deck by the page contract; quiet counts filter the candidate memo after a merge rather than re-run the pass.
- The review desk shows both pages by default; a merge's gate needs the comparison visible 500 ms and a matching server `basis`. Compare all is one resumable job across domains that recovers PAUSED and stops at 120% of its confirmed spend.
- A family on the desk is a walk: the page that stays, then one decision per page through the same gate; A~B and B~C never prove A~C, and the screen says when the AI never compared two pages.
- Every deleting Health route verifies its claim on disk; frontmatter is preserved byte-for-byte; repairs never edit code fences, `.trash` or `.obsidian`; Sync never pushes credential-shaped files; every server a test starts sets `CURATOR_NO_OPEN`.
- Health dismissals are persistent, synced, and offered only on review-only rows. Domains are siloed by default.
- A summary lists entities under "Entities Mentioned" and concepts under "Concepts Introduced or Referenced" — the page's FOLDER decides, `injectSummaryBacklinks` and the `missingBacklinks` scan read BOTH, and `writePage` dedups again AFTER its link rewrites. Health's `summaryLinkSections` is a safe, deterministic, free fix behind a hard guard (`summaryTidyGuard`: never writes unless the link-target set and every line outside the two sections are unchanged); Health's link rewriters go through `dedupRewrittenBullets`.

### Ingest → [decisions-knowledge.md#ingest](docs/dev/decisions-knowledge.md#ingest)
- The batch prompt's stable prefix must be byte-identical across batches, or caching silently costs more.
- An ingest fold redirects only a spelling variant (`isSpellingVariant`) and goes through the same no-lost-line guarantee; Jaccard folding is retired.
- Exact-name reuse never overwrites: old text stays and new wording is added only when mostly new (threshold 0.5, notice on drop); a source with the same sha256 already completed leaves existing pages byte-identical.
- The `index.md` embedded in the outline and single-pass prompts is capped at `INDEX_PROMPT_BUDGET_CHARS` (150,000) by `indexForPrompt`, INSIDE the builders; under the cap the prompt is byte-identical, over it the rows most related to the source are kept, and it logs to stderr only (nothing the model produced is dropped). A complete index without this cap overflows Haiku 4.5's window.
- If the pipeline drops, redirects or renames anything the model produced, a user-visible warning says so; repeated warnings aggregate at one chokepoint (except near-duplicates and trunk pages).
- `parseJSON` is lenient — validate its output, never truth-test it; fix a shape bug on every path that consumes it, the first-running one first.
- A broken-link rate from one run is noise, not a gate.
- Phase-2 batch replies are filtered to the pages that batch was asked for (`filterBatchReply`; set-aside copies are a reserve, never a warning); a summary lacking title, source or takeaways warns (`summaryShapeWarning`); a different source with the same summary slug gets a hash-suffixed slug (`resolveSummaryPath`).
- The batch queue lives outside `domains/`, runs strictly sequentially, decides duplicates at create time, and recovers PAUSED — nothing auto-starts spend.

### Chat and compile → [decisions-knowledge.md#chat-and-compile](docs/dev/decisions-knowledge.md#chat-and-compile)
- Intent routing classifies the ASK (`extractAsk`); response style is orthogonal to intent; chat truncation is graceful and the MAX_TOKENS message is context-neutral.
- Chat Markdown is escape-first, allow-list-only (`shared/markdown.js`).
- The per-chat model selector is CONFIG-scoped, never `.env`.
- Compile has a `full → concise → summary-only` ladder that escalates only on output-limit or parse failure; its outcome is a thread card, never a fixed panel.
- Conversation IDs are UUIDs validated at the route. Conversations are gitignored in the app repo but synced with the wiki — by design.

### Sync and Shared Brain → [decisions-knowledge.md#sync-and-shared-brain](docs/dev/decisions-knowledge.md#sync-and-shared-brain)
- Synthesis treats contribution payloads as a trust boundary; identity comes from the storage path; `shared-*` mirrors are read-only everywhere.
- The admin token is shown ONCE; GitHub APIs are eventually consistent — never read-after-write on a correctness path; a truncated tree THROWS.
- A prior version is content or `null`, never `''`; pages that never reached the collective are never diffed.
- `push()`, `pull()` and `setup()` all guard their commit.

### The MCP → [decisions-agents.md#my-curator-mcp](docs/dev/decisions-agents.md#my-curator-mcp)
- The MCP is a full read+write client of the SAME brain functions; count tools from `mcp/tools/index.js`, never from prose.
- Every mutating tool calls `refuseIfReadonly()` and `invalidateGraph()` — derive the mutator list from those call sites.
- Any `src/brain/` module reachable from `mcp/` must never write to stdout (diagnostics go to stderr).
- `get_index` is paged (≤ 60 KB per reply; views `index` and `pages`, `type`, `slugs`); a small index with no arguments stays byte-identical markdown. `indexDrift` is app-only over MCP.
- Responses are budgeted in tokens (400 KB cap, progressive trim); path traversal is refused at `resolveInsideBase()` and at the tool arguments.
- The usage log is content-free, outside `domains/`, and nothing branches on `clientInfo`.
- The agent-instructions block is four separately pinned paragraphs; the first is frozen (sha-pinned).
- The skill and the tool descriptions are the two canonical sources of MCP behaviour rules — change both; no `<placeholder>` in a skill description.

### The memory layer → [decisions-agents.md#memory-layer-working-state](docs/dev/decisions-agents.md#memory-layer-working-state)
- State SUPERSEDES, knowledge ACCUMULATES: `state/` never goes through `writePage`.
- The `<machine>` path segment is load-bearing for sync safety; one writer per FILE, with matching provenance. The app never writes tiers 2–3; the brief (tier 1), curator-owned documents (tier 0), `readFirst` and `knowledgeDomains` are the app's legitimate writes.
- Saves are complete, overwrite, and are trimmed-and-disclosed rather than refused. A hook never composes a handoff.
- A GitHub read token is read from a FILE the caller names, never from a request body; freshness is never compared over the network on a read.

---

## Ship discipline

- The app is in production and `main` auto-updates real machines: every offline suite green before every commit, and technical + user docs change in the same release as the behaviour.
- The repo is PUBLIC: no credentials, no personal data, no internal working documents (the `.githooks/` pre-commit refuses them), no absolute home paths.
- Releases go through `scripts/release.js` (see [CONTRIBUTING.md](CONTRIBUTING.md)): land the work on `main`, write the release's FULL row at the top of the table below, leave the `- **Version:**` line alone, then `node scripts/release.js X.Y.Z --dry-run` and `--yes`.

---

## Git History of Major Fixes

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **243 rows**, back
to `v2.4.2` — is preserved
**byte-for-byte** in **[CHANGELOG-ARCHIVE.md](CHANGELOG-ARCHIVE.md)**, and indexed one line each in
**[docs/dev/release-index.md](docs/dev/release-index.md)**. Nothing has been deleted or
shortened; the older rows have only moved out of the auto-loaded file.

**The row cap is 3** (`const CAP` in `scripts/test-changelog-completeness.js`; lowered from 6 on 2026-09-23 because six rows alone measured 39 KB). A release adds its own row; when the table is AT the cap, the release first moves the OLDEST row to the top of CHANGELOG-ARCHIVE.md's table byte-for-byte, adds that row's one-line index entry at the top of `docs/dev/release-index.md`, and updates the three counts (here and in the archive's header). `npm test` and `release.js` both refuse a fourth row.

**Read the newest rows first** — they carry the measurements and the *KNOWN AND
UNFIXED* items most likely to still be live. Then, before you change anything
with a history (a guard, a prompt, a fallback chain, a money or write path),
find it in the index and **open its full row in the archive**. An index line is
a pointer, never the record: a row that reads like noise is very often the only
surviving explanation of why something is the way it is.

| Commit | What it fixed |
|---|---|
| `v3.98.0` | **Ingest keeps a source's hard data: a Key Facts section with exact figures, technical identifiers and their period, and chat finds it.** **Why.** Owner report, 2026-11-14: a 7 KB pricing strategy ingested with Gemini 3.5 Flash Lite became 3 summary bullets and 3 generic concept stubs; the list price, the simulation table, the deadlines and the cancellation fee were on no page, so chat could not answer "how much do I earn with 14 participants". Cause: every page prompt asked for "3 to 8 concise bullet points" and nothing asked for numbers. Owner: a personal or shared brain must compound numbers over years and a product's technical documentation, not only articles. **What.** (1) `KEY_FACTS_RULE` (ingest.js): the summary gets `## Key Facts` after Key Takeaways (figures exactly as written, with unit, condition and period or version; identifiers in backticks; at most 40 bullets, tables at most 15 rows, no nested bullets), and entity and concept pages keep the figures that belong to them. It is sent on single pass, the strict retry, the batch prefix (still byte-identical across batches) and the concise retry, and ONLY when `sourceHasHardData` (one pure module, `src/public/next/shared/hard-data.js`, used by server and browser) passes: at least 6 items and 7 per 1,000 characters, or 20+ code spans, or 8+ table rows. Labelled on 122 real sources: 57 of 66 data or technical sources pass (was 25 under the first threshold), 10 of 78 prose. Below the gate the prompt is byte-identical to v3.97.1. The domain template is unchanged. The single-pass reply limit is 24,000 characters when the rule is sent. A source with more than 40 table rows warns that the wiki keeps a selection. (2) Write path: Key Facts bullets dedup on the whole line; a reused line whose figure changed counts as new (compared with the line it most resembles); a template heading that swallowed its first sentence is split, only on fresh ingest output (`opts.splitHeadings`); the link tidy leaves inline code and fences alone; hub linkify skips table rows. (3) Chat: `keyFactsScore` scores a summary's Key Facts section past the 600-character head, once per token, at most 6,000 characters; summaries only, because scoring entity pages that already carry the section changed loaded pages for 47 of 60 sampled questions on a real 3,511-page domain (summaries only: 0 of 60 on five real domains). (4) Owner decision: re-ingesting a data source with the SAME model makes ONE reading when its last completed ingest predates Key Facts (no `keyFacts` marker), with the reason and the price shown first in the single-ingest dialog and the batch queue; the gate reads the uploaded bytes, a raw copy is trusted only when its sha256 matches; one reading whatever it writes, with an honest notice; dates come from the last record that made a reading. Estimates carry the rule's input and a measured output allowance (Gemini +2,400, Haiku +6,400, solar +3,800 tokens). **Measured,** 3 runs per model, before → after, Gemini 3.5 Flash Lite / Haiku 5.5 / solar-pro4, facts captured: SIQ pricing (29) 5.7/16.0/12.0 → 18.7/26.3/25.0; synthetic 62 KB operating plan (64) 14.3/50.3/49.0 → 37.7/60.3/63.7; synthetic 32 KB architecture document (47) 4.7/35.0/43.7 → 34.7/47/46.7. Chat, standalone SIQ 3/9, 7/9, 8/9 → 9/9, 8/9, 8/9. Three prose fixtures: prompts byte-identical; pages, slugs, links and cost within run spread; no Key Facts section in 27 runs. Single-pass data billed ÷ quoted high 0.50–0.99 (n=31). On an isolated copy of the owner's domain without the raw file: dialog showed about $0.01, billed $0.0125, summary 949 → 2,330 bytes, every old line kept, next press no call; the owner's own follow-up question answered €11,200, correct. **Review.** Three independent Fable 5.2 audits on copies of a real domain; every finding fixed (legitimate headings split, existing pages rewritten by write-backs, facts collapsed by first link, a changed figure dropped beside a sibling, gate misses, a $0 quote then spend on a reused file name, Anthropic under-quotes, a second reading, a false no-call promise, prose estimates widened); the last found no path that spends without a price shown first. 58 mutations red. **KNOWN AND UNFIXED.** Compounding: a follow-up document's changed values reached the product's entity page in 1 of 9 runs; they land on its own summary and the old values stay (needs ingest to read existing page bodies; next update). Sync's `git pull -X theirs` drops the other computer's appended `.raw-manifest.jsonl` lines (pre-existing, every record; reproduced; separate fix); a lost marker costs one re-offer with the price shown. The base estimator under-quotes some single-pass sources on Haiku and solar (pre-existing). A technical document written as plain prose stays below the gate; an essay dense with dates or citations can pass it. Tables are allowed but rarely written (0 of 9 runs). Shared Brain carries facts as one-line extractions, so a table cannot cross as a table. The MCP `compile_to_wiki` description and the skill do not mention Key Facts. Matching in chat is exact (no stemming). **VERIFICATION: 325 offline suites, 325 passed / 0 failed**; CI at release. |
| `v3.97.1` | **A follow-up ingest no longer silently skips updating existing pages: one retry, then Gemini 3.1 Flash Lite for that step, with a notice.** **Why.** `test-ingest-deep` failed on main after v3.97.0 (Q6-pre: no entity or concept page written; Q5, SYN-2, SYN-10). Cause, with every call asserted as `gemini-3.5-flash-lite`: on a follow-up source covering topics the wiki already has, the model often returned only the summary (273 output tokens, valid JSON, nothing filtered): 5 of 11 runs on main, 4 of 9 on v3.96.1 code; Gemini 3.1 Flash Lite 0 of 6. A first ingest wrote pages 16 of 16, so new users were not hit. Affected since v3.96.2 made 3.5 Lite the default: follow-up sources got no page updates, only the existing warning. SYN-2's CI broken-link rate (45.8%) did not reproduce in 19 local runs. **What, owner's choice.** A follow-up reply with no entity or concept pages, when the source names an existing page twice in 800+ characters, is retried once on the same model, then once on `gemini-3.1-flash-lite` (model asserted first; never loops). One notice names both models and the extra cost, priced per model. The live suite treats Q6-pre as inconclusive only when the evidence shows the code behaved correctly; Q5 still fails normally. **Proof.** New suite red on v3.97.0; 11 mutations red; live: SYN-10 wrote pages 10 of 10 (4 by the retry), a forced 3.1 run confirmed, the deep suite green; about $0.60. **KNOWN AND UNFIXED.** No separate review. The trigger rule is a heuristic: a follow-up source that does not name an existing page twice gets no retry. 3.5 Lite's behaviour may change on Google's side. **VERIFICATION: 323 offline suites, 323 passed / 0 failed**; CI at release. |
| `v3.97.0` | **Health changes can be undone: every page a Health action changes is copied first, and Wiki health › Recent changes has Undo.** **Why.** Owner decision, 2026-11-07, reversing the long-standing rule that the app has no in-app revert: people are adopting The Curator to maintain valuable second brains, including ones built elsewhere, and "read carefully, it cannot be reversed" was not an acceptable promise. **What.** Every Health write (all fix types, batch merge, family walk, cross-folder and hyphen merges, Rebuild index, AI broken-link and orphan fixes, and the MCP's `fix_wiki_issue`) copies each file before writing it, at the single write chokepoint (`writeFileAtomic` plus the wiki `rm`), into `.health-undo/` under the user-data folder: outside `domains/`, gitignored, never synced. A failed copy stops the write. Recent changes lists the last 30 days in plain words, with Undo on each. Undo is all-or-nothing in effect: it refuses and names the page when a file changed since (an edit, a later ingest, a sync), and names a later change to undo first when one blocks it; a kill mid-undo finishes cleanly on restart. Copies expire after 30 days, also at start-up, within a 256 MB cap that never removes the newest. Undo works only on the computer that made the change, and says so; the MCP mentions it but cannot undo. Every "no Undo button" and "no in-app revert" statement on screen, in docs, llm-docs, the MCP descriptions and the skill was replaced. **Also.** `test-ingest-deep` SYN-8 updated for v3.96.2's no-call same-model re-ingest (live 18/18), which turned main's live suite red at v3.96.2. **Independent review on copies of two real domains:** desk and family pairs, a 5-variant batch, cross-folder x3, hyphen x2, free repairs, Rebuild x3 and an AI link fix with a stub; every undo, newest first and out of order, byte-identical to its before-snapshot; both domains ended identical to before any action; originals and configs unchanged. About 1 MB for 14 actions; up to about 15 MB for one action touching every page of a 3,500-page domain. Fixed from it: a 5 px shift (the Recent changes row first appeared on the first change; it is now always drawn), Rebuild undo wording ("0 pages"), same-name merges naming both folders, a stale refusal under a new confirm, expiry at start-up. **KNOWN AND UNFIXED.** Not covered: other computers, pages changed since, ingest and compile writes, the repair scripts. Copying is per write, so a copy that fails mid-action leaves the earlier files changed (those stay undoable). A completed cross-folder merge moves rows above it by 26 px (older). The fixes after review had no second independent review. Foreign-vault defects remain for the next release. **VERIFICATION: 322 offline suites, 322 passed / 0 failed**; Health walk 3,395/0; CI at release. |

- **Version:** 3.97.1
