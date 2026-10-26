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
- AI Health is READ-ONLY; the semantic-duplicate scan is opt-in, cost-gated and capped; a merge that DELETES requires a preview first. There is NO in-app revert.
- Health dismissals are persistent, synced, and offered only on review-only rows. Domains are siloed by default.

### Ingest → [decisions-knowledge.md#ingest](docs/dev/decisions-knowledge.md#ingest)
- The batch prompt's stable prefix must be byte-identical across batches, or caching silently costs more.
- The `index.md` embedded in the outline and single-pass prompts is capped at `INDEX_PROMPT_BUDGET_CHARS` (150,000) by `indexForPrompt`, INSIDE the builders; under the cap the prompt is byte-identical, over it the rows most related to the source are kept, and it logs to stderr only (nothing the model produced is dropped). A complete index without this cap overflows Haiku 4.5's window.
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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **216 rows**, back
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
| `v3.83.0` | **A complete index.md, kept complete — and a way for agents to read it at any size.** **Why.** On the maintainer's real wikis `index.md` had fallen far behind the files on disk: it was only ever appended to with CREATED pages, so every page an ingest, compile or `compile_to_wiki` merely UPDATED (or that predated the merge, or that Personal Sync's `-X theirs` pull dropped) stayed unlisted, and nothing ever removed a row whose page was deleted. Measured read-only on 2026-10-26, matching rows to files by CANONICAL path (a bare `[[x]]` resolves to `entities/` then `concepts/`, the Health rule — the old basename matching hid projects' gaps behind 11 cross-folder slug collisions): articles **2,705 pages missing / 39 stale rows** (only 53 of its 94 summaries listed), lectures 348 missing + 5 unlinkable / 5 stale, posts 43 + 1 unlinkable / 20 stale, projects 11 missing / 14 stale, research **64 of 64 missing**, business 4. An agent that called `get_index` to ground a link or list sources saw a catalogue that silently omitted most of the wiki. **The trap the investigation found (Opus 5.5).** The obvious fix — rebuild the index — is a production regression on its own: the FULL `index.md` is pasted verbatim into the ingest OUTLINE and SINGLE-PASS prompts. A complete articles index (614 KB as actually rebuilt) is ≈205k tokens at the 3 chars/token the code assumes for it, on top of a ≈51k-token slug inventory and the source — over Haiku 4.5's 200k window, so every articles ingest would have hard-failed. The prompt cap shipped WITH the rebuild, not after. **(A) Wiki Health "Index gaps" + a user-triggered rebuild.** New issue type `indexDrift`: pages missing from `index.md`, stale rows, duplicate rows and repointable rows, counted as ONE issue; not auto-fixable (`AUTO_FIXABLE` unchanged, so "Fix N safe issues", `/fix-all-safe` and MCP `fix_wiki_issue` can never touch `index.md`) and not dismissible; skipped on read-only `shared-*` mirrors (whose `index.md` is the creation stub and is never maintained). `index.md` joined the scan-cache signature — without it a successful rebuild, which writes only `index.md`, would have left the cached "N missing" on screen. Quick maintenance gains **Rebuild index** (free, no sparkles, no cost badge) → preview card "Plan ready — nothing written yet" → Apply; routes `POST /api/health/:domain/index/plan` (read-only) and `/index/apply` (body `{basis}`; the server re-plans from disk and never writes client-supplied text; 409 `INDEX_PLAN_STALE` when the wiki changed since the preview). Deterministic, no AI, no cost: existing descriptions kept byte-for-byte, missing ones derived from the page's H1 or first body line (Curator pages have NO `title:` frontmatter, so the contract's "frontmatter title" was corrected to this), rows sorted by code unit into Summaries / Entities / Concepts. On the maintainer's articles copy: **2,705 pages added, 39 stale rows removed, 767 descriptions kept, index 146 KB → 614 KB**. Pages with names that cannot be linked (leading or trailing space, or `| [ ] #`) and concepts that collide with an entity name are reported and left out, never silently dropped. **(B) Drift prevention at every write path.** Ingest, app Compile and MCP `compile_to_wiki` now route through one helper, `ensurePagesInIndex` (`src/brain/wiki-index.js`): it adds a row for EVERY page the write touched that is missing from `index.md` (was: created pages only) and re-reads `index.md` at merge time, so a write between an ingest's start and its end is no longer overwritten. `mergeIntoIndex` in `compile.js` survives as a thin compatibility wrapper. **(C) The ingest-prompt cap.** `indexForPrompt` / `INDEX_PROMPT_BUDGET_CHARS = 150,000` inside both prompt builders: at or under the cap the prompt is BYTE-IDENTICAL to v3.82.1 (all 42 of 42 real-domain prompts measured identical — projects, the largest index, is 146,744 chars); over it, every non-row line is kept and the rows most related to the source (token overlap, coverage first, then match count, then original order) fill the budget, with one trailing notice line. Because the cap lives in the builders, ingest, its strict retries, the queue's cost estimate, the OpenRouter qualifier and the dev scripts all price and send the same prompt. Articles' outline prompt after a rebuild: ≈90.7k tokens capped vs ≈221.6k uncapped (over Haiku 4.5's window). One stderr line per ingest, NO user-visible warning (nothing the MODEL produced is dropped — the warn-on-drop rule is about model output). **(D) MCP `get_index` reads at any size.** `view: "index"` (default) or `"pages"` (built from the files on disk, collision-complete, with created/date/source where the page records them), a `type` filter, `page`/`continuation` paging at ≤ 60 KB per reply (≈20.5k tokens at 3 B/token — not `get_project_context`'s 80 KB, which is sized at 4 B/token), and `slugs: [...]` (≤ 200) as an existence check returning the pages that exist plus `not_found` with up to 3 `near` variants. A small index requested with no arguments returns BYTE-IDENTICAL markdown. `scan_wiki_health` reports `indexDrift` as app-only; `fix_wiki_issue` refuses it (reason `app-only`). **No new tool** — options on an existing one, so the tool count did not change (~20 files quote it). The skill and tool descriptions changed together. Measured: MCP articles summaries list, 94 pages, one reply, 28,985 B; grounding Step 2 on articles ≈17–22k tokens vs ≈36–49k before. Summary frontmatter `created` / `date` are INGEST dates, now stated everywhere they are described. **Side effects, documented.** `largestDomainByIndex` (the qualifier's default domain) will flip from projects to articles after a rebuild — articles is the larger wiki, so it is more correct; a rebuilt `index.md` is an Obsidian hub linked to every page, so the Graph filter should exclude it (`-file:index`) — Health remains the orphan authority. **PROCESS.** Contract by Opus 5.5 (read-only measurements on the real domains); three builders in disjoint file sets (brain + Health backend + ingest cap; Health UI; MCP + skills); builder mutations red; **orchestrator hand mutations 5/5 red**, each restored by copy and shasum-verified; docs package by Sonnet. **Orchestrator screen review** on an isolated copy of the articles domain found two defects, both fixed before merge: the Index-gaps row's prose wrapped inside the monospace column, and the preview showed counts only. **KNOWN AND UNFIXED.** Whether a capped index changes the broken-link rate was not measured (same measurement-power problem as the slug-inventory cap) — it is a no-op on every domain until the index grows past 150,000 chars or is rebuilt. Personal Sync's pull uses `-X theirs`, so two machines appending rows at the same table end can still drop rows; Health reports it and the user rebuilds. The pages list rides the graph cache's 10-minute TTL. `get_node` / `search_wiki` still collapse cross-folder slug collisions (graph nodes are keyed by basename); only `get_index` `view: "pages"` is collision-complete. The `slugs` grounding probe costs one ≈61 KB entity page on large wikis; non-ASCII slugs cannot be checked with `slugs`. Mirrors' `index.md` stays the stub (a Pull-side rebuild is a follow-up). **VERIFICATION: 283 offline suites, 283 passed / 0 failed** — the orchestrator re-checks. |
| `v3.82.1` | **Dependency security updates — two advisories published the day v3.82.0 shipped turned the audit job (and the README's Tests badge) red while every test was green.** **The advisories.** `proxy-addr` (CRITICAL: IP spoofing via an IPv4-mapped IPv6 trust subnet) and `@modelcontextprotocol/sdk` (HIGH: an OAuth client could send credentials to an authorization server chosen by the MCP server); in `desktop/`, `http-cache-semantics` (HIGH). **Fix (Sonnet).** `npm audit fix`, no `--force`, `package.json` untouched: proxy-addr 2.0.7→2.0.8, @modelcontextprotocol/sdk 1.29.0→1.32.1 (minor; every MCP suite green); `desktop/package-lock.json` (`--package-lock-only`): http-cache-semantics 4.2.0→4.3.0. Root `npm audit` 0; desktop 0 high/critical. **Exposure, checked.** Nothing in `src/`, `mcp/` or `bin/` sets `trust proxy` and the server binds 127.0.0.1, so `proxy-addr` never evaluated a user trust list — negligible in practice; the MCP server is a stdio server and does not act as an OAuth client. **KNOWN AND UNFIXED.** `desktop/` keeps 8 MODERATE findings in the electron-builder / app-builder-lib / dmg-builder / @electron/get / global-agent chain that only a semver-major electron-builder bump (`--force`) clears — packaging-time tooling, not shipped runtime code; worth its own tested release. The audit job still shares the Tests workflow, so a new advisory can redden the badge with every test green (by design). **VERIFICATION: 277 offline suites, 277 passed / 0 failed** — the orchestrator re-checks. |
| `v3.82.0` | **The Claude 5.5 generation, a tier-aware money path, two-generation-old Claude models retired with a forward migration — and Chat's domain and model choices made honest after a user's second report.** **Why.** A user (Robin) set Chat's sidebar dropdown to a new domain, pressed New chat and got an answer from another domain; and Settings said Flash Lite while Chat answered with Haiku 4.5. Anthropic released Claude Haiku 5.5 (2026-10-07) beside Sonnet 5.5 and Opus 5.5. **Chat (Opus 5.5, reproduced by POST interception on isolated data).** The sidebar dropdown (`domainFilterCfg`) only FILTERED the list and `startNewChat` kept the active domain, so the question went to `/api/chat/<previous domain>` while the filter hid the new conversation. Now New chat follows the filter (`newChatDomain`), a filter change with nothing open moves the empty chat, the Domain pill and a boot handoff carry a set filter with them (`followFilterTo` — otherwise "Ask this domain" and "pick in the pill, then New chat" would be undone by a lingering filter, which the builder caught), an OPEN conversation is never re-scoped (`conversationOpen()` also covers a first question in flight), and a mismatch line "Open chat is in ● A · New chat in ● B" (recorded identity slots) sits in the list head. The model pick lives in localStorage `curator-next-chat-model` and persists across chats; Settings block 3 now says "New chats start on X until you pick a model in the composer; the composer remembers your pick on this computer" and shows "Now: ‹pick› (your pick)" read-only; the model menu foot says the same. Replayed: before → `POST /api/chat/early-computing`; after → `/api/chat/newsradar`. **Models (Opus 5.5; ids, dates, limits and prices verified via `GET /v1/models` with the app's key and the live pricing page; orchestrator re-checked Haiku 5.5).** Haiku 5.5 ($0.10/$0.50 per 1M ≤100k prompt tokens, $0.50/$2.50 above; 1M context; adaptive thinking), Sonnet 5.5 ($2/$10), Opus 5.5 ($4/$20, cheaper than Opus 5) added, each MEASURED on the real ingest path (announced-product entity 4/4, 4/4, 2/2; Haiku 5.5 ≈ $0.014 vs Haiku 4.5 ≈ $0.085 per 34k-char ingest; on a 3,300-page wiki Haiku 5.5's 120,820-token outline call crossed the tier and cost $0.093–0.097, inside the $0.056–0.113 estimate — a flat lower-tier price would have under-stated it ~2.5×) and in chat; live spend ≈ $3.60. **Tier-aware money path** (`src/brain/llm.js`): `priceUsageUsd` prices every call by its own prompt size (input + cache read + cache write vs the threshold); `chargeForItem`, `chargePartialSpend`, ai-run's `spentFromUsage` and chat's `priceServedAnswer` go through it; `makeUsageAccumulator` records `aboveTier`; a multi-call total without that split is priced at the upper tier; estimates (`estimateCallRates`/`estimateRates`: batch, compile, `describeRun`, Health, `compareModelCost`) quote the upper tier whenever a call COULD cross (× tokenizer factor × 1.5, unknown size = upper); the browser's `messageCostUsd` mirrors it. The structural refusal became a guarantee: `defineOfferableModel` prices one call at and one just over the threshold at module load and refuses to load if the tiers aren't applied; an OpenRouter `tiered: true` entry without a schedule stays chat-only. **Retirement (maintainer: Anthropic only; keep the 5.5 generation and the one before).** Offered now: Haiku 5.5/4.5, Sonnet 5.5/5, Opus 5.5/5. `RETIRED_MODELS`: Sonnet 4.6/4.5 → Sonnet 5.5; Opus 4.8/4.7/4.6/4.5 → Opus 5.5. A saved build pick resolves forward on read, is rewritten once at start with a persisted note (`GET /api/config/model-retirement`, `POST …/dismiss`); Chat's localStorage pick migrates in the browser (`shared/model-retirement.js`); one banner shows both until Dismiss. Fallback chain `claude-haiku-5-5 → claude-sonnet-5-5 → claude-sonnet-5`, cheapest-first, every rung priced. Defaults unchanged (Gemini Flash Lite 2.5; Anthropic's default stays Haiku 4.5, which is no longer the cheapest build model — documented). **PROCESS.** Investigation + two builders Opus 5.5 in separate worktrees; builder mutations: chat 15/15 red, models 16/17 red (survivor: the successor-must-be-offered branch, unreachable with today's data). **Orchestrator hand mutation**, restored by copy and shasum-verified: an unsplit multi-call total priced at the lower tier → `test-tiered-pricing` red ("a multi-call total WITHOUT a split is priced entirely at the UPPER tier"). **Orchestrator screen review** on isolated data with a retired Opus 4.8 build pick and a Sonnet 4.6 chat pick: the banner named both moves, and the offered list held exactly the two generations; the chat fix's replay screenshots checked. **KNOWN AND UNFIXED.** The flat-price estimate path still ignores `tokenizerFactor` for non-tiered newer-tokenizer models (under-estimates Sonnet/Opus 5.x); `compileFallbackRung`'s per-1M text shows Haiku 5.5's lower rate; `docs/images/curator-model-picker.png` still shows retired models; Opus measurements are thin; the scope line wraps at sidebar width. **VERIFICATION: 277 offline suites, 277 passed / 0 failed** — the orchestrator re-checks. |

- **Version:** 3.83.0
