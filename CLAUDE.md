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
`get_project_context` with project "curator" (no `max_bytes` — the owner's reading budget is the
default) and read the standing brief before acting; open any other document by name with `slugs`.
SAVE with `save_working_state` under project "curator", in ONE scope per
session named `session-YYYY-MM-DD-topic` (the standing brief's rule; `scope: "latest"` opens the
newest), after every material decision and at least every ten tool calls, and ALWAYS
before you stop; a save overwrites, so send the complete state each time.
Record the `seen` map `get_project_context` returned as `foundations_read` on each save.

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
- The six design rules bind every view: one overview card (`renderOverview`), one heading rule, the step-body rule, the monitor (`renderMonitor`), continuity by identity (`identityDotClass`), the depth bar (`renderDepthCell`). One sidebar component everywhere.
- A warning, a cost or an outcome never sits behind a chevron (v3.16.1).
- JSON mode for ingest, text mode for chat. UI auto-refreshes after every mutation.
- First run is a non-blocking, dismissible two-door panel (`views/onboarding.js`), never a wizard; its trigger reads config keys only, never `.env`.
- No `--text-dim` token; use `--text-2`. Undefined `var(--x)` fails silently — `test-css-tokens.js` guards it.
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

### Security, credentials and paths → [decisions-app.md#security-credentials-and-user-data-paths](docs/dev/decisions-app.md#security-credentials-and-user-data-paths)
- The server binds 127.0.0.1 only, with a cross-origin guard on mutating requests and a Host-header guard on all.
- Credential files are written 0600 and atomically; any new secret file joins the startup sweep.
- Every user-data path resolves through `src/brain/paths.js`; bundle detection is POSITIVE and fail-safe (unrecognised ⇒ repo mode).

### Tests and CI → [decisions-app.md#tests-and-ci](docs/dev/decisions-app.md#tests-and-ci)
- `npm test` = offline suites only (manifest: `scripts/run-tests.js`); every new suite goes in its OFFLINE or LIVE array. Live suites retry once and report transient provider errors as inconclusive.
- Isolate a suite's domains dir with `__setDomainsDirOverride()`; anything that spawns a server uses `CURATOR_TEST_USER_DATA_DIR`. `npm test` never touches a real credential file.
- Assert behaviour, not the presence of a line of source; give a clever test a dumb cross-check; prove a guard by MUTATION.
- System Check is read-only with respect to user data.

### Wiki write pipeline and Health → [decisions-knowledge.md#wiki-write-pipeline-and-health](docs/dev/decisions-knowledge.md#wiki-write-pipeline-and-health)
- Ingest, compile and the MCP's `compile_to_wiki` share ONE page-composition path, `writePage`; `health.js` is a SECOND, independently guarded write surface (`resolveInsideWiki`).
- `writePage()` returns change records; `syncSummaryEntities` and `deduplicateBulletSections` are idempotent and always safe; `normalizePath` special-cases `index.md` and `log.md`.
- Compile is deterministic and idempotent by slug, and never regenerates `index.md` through the LLM.
- AI Health is READ-ONLY; the semantic-duplicate scan is opt-in, cost-gated and capped; a merge that DELETES requires a preview first. There is NO in-app revert.
- Health dismissals are persistent, synced, and offered only on review-only rows. Domains are siloed by default.

### Ingest → [decisions-knowledge.md#ingest](docs/dev/decisions-knowledge.md#ingest)
- The batch prompt's stable prefix must be byte-identical across batches, or caching silently costs more.
- If the pipeline drops, redirects or renames anything the model produced, a user-visible warning says so; repeated warnings aggregate at one chokepoint (except near-duplicates and trunk pages).
- `parseJSON` is lenient — validate its output, never truth-test it; fix a shape bug on every path that consumes it, the first-running one first.
- A broken-link rate from one run is noise, not a gate.
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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **189 rows**, back
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
| `v3.67.1` | **v3.67.0 reached `main` and got tagged although its own release-branch CI had failed — the release chain printed the run's conclusion but never gated on it.** The one red suite was `test-reading-budget.js` §1, a byte-identity digest of `getProjectContext` for an untouched project: `biDigest` replaces the machine name inside the handoff TEXT with `<machine>`, but `current.bytes` still counts the real hostname's length, so a CI runner's 13-character hostname moved the digest at an identical total length (330198 bytes) — proven environment-only, not a product regression: the already-released v3.66.0 (`1568d2a`), run under a runner-style hostname, reproduces CI's own digest (`b916d0f5…`) exactly, v3.66.0 and v3.67.0 outputs are byte-identical under the same hostname, and readdir order, timezone, locale and `TMPDIR` all leave it unmoved. **Fix (test only):** the suite now pins `os.hostname()` before the store loads; the baseline is re-derived against `1568d2a` (`de81b987…`), passes under four different hostnames, and a same-length mutation of the untouched default still reds. No product code changed. **The standing rule, going forward:** the release chain's ff/push/tag step runs only when `gh run view <id> --json conclusion --jq .conclusion` prints `success` — a printed conclusion is no longer enough on its own. **PROCESS.** One builder (Opus 5.5), no merge — `v3671/fix` fixes the suite in place on top of the already-tagged `main`; this row by Sonnet. **VERIFICATION: 236 offline suites, 236 passed / 0 failed; 258 total (236 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL).** |
| `v3.67.0` | **"The right context, not all of it" — the maintainer's own principle, and the release's governing rule for every screen and every doc sentence: at the start of a session an agent gets its foundations, the last state and the standing brief; everything else is on demand; the magic is just enough.** A per-project reading budget, one AI model behind every job's before-and-after cost line, and a free-and-AI reading-plan helper, off a contract read by seven disjoint packages branching from `main = 1568d2a`, wave 2 (H, R, SD, CI, V) after wave 1 (S, J) had landed, all merged through `v367/integration`. **(S) THE READING BUDGET.** `project.json` gains `readingBudgetBytes` (0 "Index only," or 8,192–204,800) — owner-written only, no MCP tool, CLI flag or hook writes it, four spellings planted and each still leaves the file byte-identical. Five presets, Index only · Lean 32 KB · Standard 64 KB (recommended) · Deep 120 KB · Max 200 KB. A third per-document start state, **not at start** (manifest `hidden`, exclusive with `readFirst` in one write), joins read-first and on-request. Setting a budget turns on PLANNED mode: only the read-first set is sent as text and everything else is listed and opened by name; an untouched project stays byte-identical to v3.66.0, pinned to its own digest. Honoured everywhere a session starts: `get_project_context`'s `max_bytes` default, the CLI's session-start Markdown (moved to `src/brain/context-markdown.js`), the hook, and Chat, which gets a new `maxBytesCeiling` (40,000) instead of `maxBytes` so its footer and its keyword-matched second call both follow the effective budget — at 0 it reads no document text. `GET …/session-start` measures all five presets' real MCP and hook bytes in one answer; `POST …/session-start/preview` simulates a what-if budget or plan with nothing written. Measured on the maintainer's own curator project: 149 KB → **~28 KB** of MCP bytes at Standard, because its one unflagged 116 KB roadmap moves to "on request." **(J) ONE MODEL, ONE ESTIMATE SHAPE.** `shared/ai-jobs.js` is the registry — `AI_JOBS` (seven jobs: ingest, compile, wiki-health, shared-brain, reading-plan, system-check, chat) and `AI_UNROUTED` (three modules that import `generateText` but serve no live job) — walked by a CENSUS across `src/`, `mcp/` and `bin/` that fails on any unmapped caller (eight planted import shapes caught first). `describeRun()` is the one `runsOn` shape every AI route now carries — priced, free, unpriced ("price not published," and it still runs), latency, or `{needsKey:true}` with no key — and `spentFromUsage()` the one `spent` shape every finished run carries, proven equal to the batch queue's own `chargeForItem` on a 30-case grid. `shared/ai-run.js` renders both as one unfolded line under every AI action — "Runs on Flash Lite 2.5 · ≈6k tokens · ≈$0.0012 · Change model," and after a run, "Ran on … · 5,812 in / 640 out · $0.0008" — with the Providers & keys door injected, never imported, wired once per root. **(H) SUGGEST A READING PLAN.** `src/brain/reading-plan.js` reads tiers 0–2 and writes nothing. The free arm proposes a start state from the brief's "Read before you…" list, each document's role, size and skeleton flag, and the budget, filling greedily by role priority then reading order. The AI arm sends titles, roles, sizes and the first 600 characters of each document's opening — never a whole document — framed as untrusted data; every returned slug and state is checked against the on-disk index, and anything it doesn't recognise is **dropped and named**, never applied silently. Neither arm changes anything: Apply is its own step. A run under a cent runs directly; at or above it, the run line becomes a confirm gate first. H's own live-connectivity check, run against a real key, made one real, refused (401, unbilled) call to Anthropic with its own dummy key inside an isolated config — caught, reported, and the config reset before the next press. **(R) THE ROUTES ADOPT THE RUN.** `runsOn` on `ai-available`, the three Health estimates, Compile's estimate and the new ingest-queue estimate; `spent` on Compile's `done` (summed across the whole fallback ladder) AND on a billed-then-failed `error` event, on the Health plan/scan streams' `done`, and on a finished single-file or batch ingest — every field additive, no existing status code or body moved. Along the way R found and closed a real crash: a static `import` of `ai-run.js` inside `compile.js` or `health-ai.js` crashed any process whose first import was `ingest.js` (`ingest → compile → ai-run → compile-estimate → ingest-queue`, which reads ingest's own `__testing` mid-evaluation) — fixed with a call-time, lazy `import()`, guarded by a new suite that loads the whole cycle as the first import of a fresh process. **(SD) "YOUR AI MODEL."** Settings block 2 is retitled **Your AI model**, its lede derived from the registry ("Every AI job runs on this one model: ingest, compile, wiki health, Shared Brain and reading plans"), with a new **Used by · 6 jobs** fold row, one row per build-lane job. Wiki health's three ✨ actions are always shown; with no key they're disabled via the kit's `aria-describedby`, never hidden, behind a door to Providers & keys, and the AI-health privacy disclosure now names all three providers — Gemini, Anthropic **or OpenRouter**. System check's "Verify AI connection" drops its hardcoded $0.0001 for the real estimate. A screen review caught the Used by table naming a future version on screen ("after (v3.67.1)" on Shared Brain's row) — fixed at the view level to read "not yet," a pattern rule for any future-annotated registry row, not a special case. **(CI) CHAT + INGEST SHOW THEIR COST.** Compile's confirm now leads with the run line, placed into the dialog's own body before first paint, plus a clause — "Compile uses your AI model, **not the model this chat is on**" — only when the chat's picked model differs from the one that will actually run Compile; the result card shows `spent` even when a billed compile then failed. Single-file ingest gets a before-the-run line (metadata only, no bytes sent) and an after-run `spent` line; the batch estimate carries the same run line beside its existing readouts. Everywhere: disabled, never hidden, with no key. **(V) SESSION START.** Context step ④, **Session start**, is new: the reading-budget picker in its own head row, a **"what an agent receives"** monitor (brief, handoff, journal, index, read-first text, each against its own limit, the total against the browser's own context-window setting), and the cost line with a "Set a reading budget" action when nothing is chosen yet — plus a matching SESSION START tile on the overview and the teaching copy the governing principle asks for, in the header ⓘ and each step's own opener. Step ①'s per-document tri-state gets a real control; **Suggest a reading plan** / **✨ Suggest with AI** sit in ①'s head row, and Apply writes the ticked rows plus, when offered, the budget. Two pre-existing defects were closed in passing: Context now keeps the selected project across a view change (it used to fall back to the most-recently-touched one), and a refused start-state toggle's stale "Another write is in progress" note now clears on the next success instead of persisting forever. CI's own screen review caught a join CI does not own: V's Providers & keys door was wired on the inner column instead of `#view-root`, so it would fire twice once another view had already wired the shell root — fixed in V before merge. **MAINTAINER DECISIONS (all 9 approved as written).** An untouched project keeps today's behaviour byte for byte, with an unfolded cost line and a "Set a reading budget" action; the five presets above, Standard preselected; the third per-document state "not at start"; the free suggester for everyone, the AI suggester behind a saved key; the CLAUDE.md slimming ships separately; **one AI model runs every job** (Chat keeps its per-message picker) — the helper runs on that same one model; block 2 renamed "Your AI model" with "Used by · N jobs"; AI buttons shown disabled with no key, never hidden; actual cost shown after every run for Compile, Health, the helper and single-file ingest this release, Shared Brain following in v3.67.1. **PROCESS.** Three read-only design passes (the context budget, ai-jobs, team context) plus the contract itself, all Opus 5.5; seven builders — S, J, H, R, SD, CI, V — on Opus 5.5, each in its own worktree; this row on Sonnet. The orchestrator ran one hand mutation per package, each restore shasum-verified: J's estimate priced from the input half alone (red 3), S's budget parse moved below the `knowledgeDomains` early return so the budget was never actually read (red 2), H kept an unknown slug instead of dropping and naming it (red 3), R dropped `runsOn` from a route (red 2), SD hid the three AI buttons instead of disabling them with no key (red 2), CI removed the run line from Compile's confirm (red 3), V sent a "not at start" write as `{readFirst:false}` instead of `{atStart}` (red 3). Two screen reviews landed mid-merge: SD's Used-by table was sent back once for naming a future version on screen; CI's own review caught V's door-wiring double-navigate, fixed in V. The builders' own mutation campaigns tally **180** (S 25, J 34, H 27, R 24 — 23 red, 1 equivalent mutant — SD 24, CI 26, V 20), every one restored by copy with a printed anchor count and a shasum-verified restore. Twelve PATCH files, each written by a builder for a suite it did not own and applied by the orchestrator at merge: S's two (`test-next-memory-view`, `test-next-memory-projects`, for the three new routes), J's one (`test-build-model`'s no-key sentence), SD's three (`test-api-keys-contract`, `test-next-domains-text`, `test-next-sharedbrain-ui-parity`), CI's one (`test-next-compile-estimate`'s stubbed `compileConfirmLead`), and V's five (`test-agent-instructions`, `test-next-overview-kit`, `test-next-listbox`, `test-ui-state`, `test-next-memory-ingest-text`). **KNOWN AND UNFIXED.** Docs (user guide, architecture.md, mcp-user-guide.md, working-state.md, the skills) are deliberately not updated this release, on the maintainer's own instruction — a single documentation sync is planned after v3.67.1; every package recorded its exact doc sentences in its own report. There is no way to clear a reading budget back to "not set" from the app yet, though the route accepts `null`. Apply/Dismiss sit in step ①'s head row, per the contract, rather than the acceptance picture's own bar between the panel and the table. The ingest estimate carries no token figures for a free or unpriced model — the batch queue's own token sums stay null there, by that module's own choice, not R's. A single ingest that throws after spending reports no `spent` — the usage never reaches the route. The model label on every run line is the catalogue's own label ("Flash Lite 2.5"), not "Gemini 2.5 Flash Lite" — the maintainer's call. J's `AI_JOBS` should carry its own "not yet" plus a `plannedIn` field for a job whose cost reporting hasn't shipped, instead of a view remapping the registry's copy at render time. A static `ai-run.js` import anywhere inside `ingest.js`'s own import graph re-opens R's load-order crash — the root cause is `ingest-queue.js`'s top-level destructure, not any one package's file. Next: v3.67.1 ships team context Phase 1 and Shared Brain's own cost line, then the CLAUDE.md slimming and the full documentation sync. **VERIFICATION: 236 offline suites, 236 passed / 0 failed; 258 total (236 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL).** |
| `v3.66.1` | **The menubar widget gets its own depth bars, held out of v3.66.0 until the maintainer could photograph the real menu.** Three still 28×13pt colour PNGs sit in the icon gutter, one per row kind: each **project header** now an enabled item, showing sessions that saved a handoff in the last 30 days against the **busiest project** (`Settings › MCP bridge` "Across projects" is its app twin); a new **`Domains · pages`** section, at most 4 lines (a 5th collapses to "…and N more"), each domain's page count against the largest domain, in that domain's own identity colour from the kit's pure-data palette (`Settings › Knowledge base` "Domains in this folder" is its twin); and the open project's **documents bar**, under the app's own rule — 120 KB read-first once any document is flagged, else 200 KB stored (Context's Documents monitor is its twin) — danger-toned and the word "over" only on an over-run, and an over-run bar runs past its own track, so it reads without colour. The label budget stays 38 characters and the menu's measured width is unchanged at 363.5pt. **The maintainer's photo review** (light theme, real data) accepted the three bars and asked for two changes: the documents line moved OUT from under the headline and INTO the open project's own group, first under its heading, so the Save pulse keeps its place at the top; and the zero-session header changed from a bare "no sessions" — which read as a contradiction beside a handoff saved a week earlier through a bridge that had logged no session line — to **"no logged sessions · 30 d"**, appended as the last, atomic, cuttable clause (the tooltip keeps the full sentence). **PROCESS.** Builder Opus 5.5 (22 mutations round 1, 6 round 2, all red, restored by copy with sha256 verified); this row by Sonnet. The orchestrator built the branch against the installed app's real data for the photograph, then ran one hand mutation — dropping the word "over" from an over-run label — red 3× in `test-tray-menu-bars`, restore shasum-verified. **KNOWN AND UNFIXED.** Dark-mode and a highlighted-row photograph were not taken; a domain line opens Settings, not Domains — the tray has no Domains route; the user-guide and architecture sentences are deferred to the next docs sync. **VERIFICATION: 232 offline suites, 232 passed / 0 failed; 254 total (232 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL).** |

- **Version:** 3.67.1
