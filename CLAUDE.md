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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **199 rows**, back
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
| `v3.72.1` | **The "true numbers" release — the maintainer's standing requirement that every number and state the app shows traces to true current data, checked app-wide by a read-only audit (7 slices, ~85 findings; Chat's own slice was already fixed in v3.72.0) and fixed here by the other five slices, package by package.** **ctx (Context + New-project chooser):** the explainer lead now takes the panel's full width (the maintainer's own report — 62ch cap dropped, 110ch only above 1040px); Index only no longer falls back to reading 120 KB and step ① says so with no bar; AGENT SESSIONS is stale-while-revalidate (re-asked on select, on a 60 s poll and on wake) and reads "no usage log" or "not logged" rather than a measured-looking "0 sessions"; the 200K context window shown when nobody has chosen one is labelled "200K · default" everywhere (trigger, aria, meter); a reading-plan suggestion made against an old budget or document set is marked "Outdated" with Apply disabled rather than silently reused; Chat's reply figure and the per-reply cap both come from the session-start route, not duplicated client literals; the New-project documents chooser drops the retired 200 KB/120 KB alarm and literal. **dom (Domains + Wiki health):** the page now refreshes every figure — tiles, sidebar row, Pages list, Health — as soon as a write on it releases the shell's write gate, including hosted Ingest and Shared Brain pull; the Delete-domain confirm re-reads and quotes the count at the moment it opens, never a stale row figure ("7, not the row's 4"); a duplicate scan that would exceed the cost ceiling refuses before the click, naming both figures, with no Scan button; the default scan ceiling is raised 50,000 → 200,000 tokens (the maintainer's decision — 500 pairs × 400 tokens — the confirm still prices first); "last write" is shown to the day with the log's own verb (ingest vs. compile); the Dismissed count includes every dismissal on disk, semantic-pair Skips included; a safe fix's confirm counts the pages it will delete; the PROJECTS tile uses the store's own total; the merge preview is correctly labelled "first 4,000 characters"; ages tick on the shared clock; the Shared Brain section's pull hook reloads the domain's own figures. **ing (Ingest):** a batch run on a model with no published price never reads "$0.00 spent" (new `spendUnknown`, surfaced as "price not published" or "at least $X"); a free or unpriced estimate still shows its token sums and planned AI-call count; the away/restored activity panel shows the same cost, model and tokens as the live one; the ingest log heading, `writePage`'s `created:` field and a new domain's index date now use the LOCAL calendar day (a new leaf, `src/brain/local-date.js`) — the compile summary's own file-name date is deliberately LEFT on UTC so a recompile on the day boundary still lands on the same slug and stays idempotent; the batch summary's "pages written" excludes unchanged pages; several duplicated limit/latency constants collapsed to one each. **set (Settings + model catalogue):** every hand-listed OpenRouter price and "measured" note is now dated and was re-verified live on 2026-09-25 — `minimax/minimax-m3:free` is withdrawn (a live call 404s, pointing at the paid slug) and removed, its paid sibling not added, since it measured 0 of 9 parseable on the ingest prompt on 2026-08-28; GLM 5.3 Flash is re-priced to what it actually bills ($0.045/$0.14, not the stale $0.075/$0.25); 14 Gemini/Anthropic prices re-matched against the live pricing pages and dated; the OpenRouter sync now keeps the live headline price of a hand-listed model and quotes the higher of the two, so a price rise is never missed (the maintainer accepted the money-safe direction); qualification collapses onto one latency source; false price-ratio notes fixed and every money phrase in a note now recomputed and checked by a test; prices shown exactly, never rounded; a $1–$3 price band added; the scan-limit hint reads its default from config and prices it on the build model; the chat free-model-availability claim is dated (27 Aug 2026) and no longer names a since-withdrawn model. **sync (Sync + Shared Brain + tray):** "last synced" is now the recorded time of the last successful push/pull/connect (git config), never inferred from a commit date; "pending" counts unpushed commits as well as uncommitted files, and equals exactly what the next push reports; the Shared Brain section refreshes after a partly-failed push/pull/revoke; the member list counts distinct pages, not summed deltas; every connection is listed, not just the first; the tray's "busiest project" uses the same denominator as the app; the tray's "30 d" window is read from its own payload, not typed; the tray's "Updated HH:MM" stamp is the time the figures were read, not the time it happened to render. **PROCESS.** Audit Opus 5.5 (7 slices, ~85 findings, read-only, no repo writes). Five builders, each Opus 5.5, one worktree per package, in parallel: ctx (10 mutations, all red), dom (10 mutations + 1 orchestrator follow-up for the Shared Brain pull hook, all red), ing (11 mutations + 1 for the compile.js/files.js UTC extension, all red), set (13 mutations, all red), sync (5 mutations, all red). Docs pass Sonnet; this row Sonnet. **Orchestrator hand mutations, each restored by copy and shasum-verified:** ing — `spendUnknown` never set — red; dom — the delete confirm quoting a stale count — red ("7, not the row's 4"); sync — pending ignoring unpushed commits — red 2; ctx — Index only's budget-0 case ignored — red; set — a higher live OpenRouter price ignored — red 2. **Merge note:** a fixture clash surfaced after merging the five branches (ing's FREE-model test fixture used the since-withdrawn `minimax/minimax-m3:free`) — fixed in the test fixture, not by re-adding the withdrawn model. **KNOWN AND UNFIXED.** An unscanned domain still shows no Health dot, which reads the same as "no issues" — suggested fix: a hollow "not checked" ring, not built this release. The compile summary's file-name date stays on UTC by design (idempotency by slug). The F10 ingest cache-clear test is source-level only, with no offline driver. No live browser screen review was done of every changed screen — the orchestrator reviewed the headline ones only. The README's Chat screenshot is still pre-v3.72.0. **VERIFICATION: 259 offline suites, 259 passed / 0 failed; 281 total (259 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |
| `v3.72.0` | **Chat — the section left behind for several releases — is overhauled and synced with the rest of the app, the maintainer's own spec, and every number it shows is now traced to true data.** **M1 — one list across all non-mirror domains.** `GET /api/chat` returns every conversation across every non-mirror domain; `views/chat-list.js` (new, DOM-free) renders it through the ONE sidebar component, `renderSidebarRow` — a domain identity dot via `identityDotClass`, a hollow grey square + project name shown only when the conversation's last answer actually recorded a project, and a domain filter. Rows group Today / Yesterday / Previous 7 days / Earlier by last use, re-cut at local midnight (F7); live ages tick via new `shared/age-ticker.js` (one 1s clock writing `textContent` on `[data-age-at]` targets, only on change, never a re-render); an older conversation with no recorded age reads "started … ago" from its file, never a guessed figure. **M2 — a real page header.** Chat gets a real `renderViewHeader` (title, ⓘ, Compile in the action slot) plus a live facts line, and domain / project / length / model pills on the composer; the domain locks once a conversation exists. The header ⓘ overlays the thread — it never pushes it, per the six design rules. The old scope bar, chip row and project ⓘ are retired. **M3 — row actions.** `.row-act` is a neutral, always-visible trash glyph app-wide (one glyph, one implementation), red only inside the confirm dialog; a Select mode adds bulk delete ("Delete N"); new suite `scripts/test-row-actions.js`; P5 emptied the dated Chat-only exception P3 had left, so the rule now holds with no carve-out. **M4 — citations.** `shared/answer.js` numbers citations by first appearance and renders one Sources list, styled via new `shared/page-chip.css` in page-type colours; raw file paths appear only as 1×1 clipped screen-reader text, never in the visible answer; `shared/markdown.js` gains blockquotes with attribution, `<hr>`, heading levels, one nested list level and citation splitting, escape-first with XSS test cases (an orchestrator mutation letting a blockquote unescape its text, including an `<img onerror>` payload, went red). **P1 (stored facts):** conversation `updatedAt`; each message records its `project` and whether it was `priced`; list rows carry `domain`/`updatedAt`/`lastProject`. **P4 (model picker):** new `shared/model-row.js`/`.css` — one row builder shared by Chat's model menu and the model-browse dialog; Chat's rows show only chat-relevant facts (no "caution", "out-performed" or ingest-speed language), the browse dialog keeps those facts prefixed "For building the wiki:"; prices are exact off the catalogue (not rounded); provider shown as a plain word, no colour dot; the selected row holds 4.53:1 contrast in dark and 6.57:1 in light; the composer's four pills stay on one row at 1400px. **Truth-audit fixes folded in (Chat slice, F1–F7):** F1 the page count repaints after a compile; F2 "what it cost then" is shown from the stored `priced` field, else "at today's price" — never one label for both; F3 project ages tick live and are re-read after every answer; F4 the ingest-speed clause is labelled "per ingest call"; F5 the compile confirm names the fallback model and its price; F6 token counts read "±15%", never "exact"; F7 the Today/Yesterday groups regroup at local midnight rather than staying fixed from page load. **Docs, same release (P6):** `docs/user-guide.md`'s Chat section rewritten for the new list, Select mode, the header, the composer pills and citations; `docs/api-reference.md` documents `GET /api/chat`, the new `project`/`priced`/`updatedAt` fields and `estimate.fallback`; the three lines claiming the token estimate is exact are fixed (the character count is exact, tokens are ±15%); `docs/dev/decisions-app.md` gains the row-action rule and the project mark as continuity-by-identity's companion; `docs/dev/decisions-knowledge.md` gains the citation model and the "facts recorded going forward only, never guessed for older files" rule; `llm-docs/curator-user-guide.md` and the README sync, the README's Chat screenshot captioned as pre-v3.72.0. **PROCESS.** Design Opus 5.5 (research + 2 mockups; the maintainer picked treatment A and M1–M4 as recommended); an app-wide truth audit, Opus 5.5, 7 slices, ~85 findings, Chat's folded into this release, the rest queued for the next one. Builders: P1 Opus 5.5 (16 mutations, all red); P2 Opus 5.5 (16 mutations, 15 red plus an overlapping-guard note); P3 Opus 5.5 (19 mutations, all red); P4 Opus 5.5 (12 mutations, all red); P5 Sonnet (5 mutations; its first report wrongly claimed two suites were already red on `main` — the orchestrator ran them on `main` and found them green, the failures were P5's own CSS, fixed); P6 docs Sonnet; this row Sonnet. Orchestrator hand mutations, each restored by copy and shasum-verified: P1 — letting mirror domains into the all-domains list — red; P2 — a blockquote that unescapes its text — red, including the `<img onerror>` XSS case; P5 — a red `.row-act:hover` left in place — red 2; P3 — every row given the same domain dot — red 2; P4 — the model menu showing browse-only facts — red. **Screen review** on an isolated copy of three of the maintainer's real domains (projects, articles, research): `GET /api/chat` returned a total of 17, matching 17 rows and the list head "All domains 17" across the 3 domains; an older conversation honestly read "started 4 days ago (started 2026-09-20 12:41)"; the real "10 best quotes" answer rendered a "SOURCES · 9 PAGES" numbered list with raw paths present only as clipped screen-reader text; with no API key in the copy, the answer meta showed the raw model id and no cost — identical to `main` at v3.71.1 under the same no-key condition, confirmed not a regression. **KNOWN AND UNFIXED.** The truth audit's remaining ~80 non-Chat findings are queued for the next release. Settings still rounds $0.075 to $0.08 while Chat now prints exact prices. The false price ratios in `llm.js`'s model notes (a Settings-slice finding) are untouched. Settings' "All models" table has not been moved onto `model-row.js`. The README's Chat screenshot is pre-v3.72.0 by design, captioned as such. A malformed `**"…"**` from a model still renders literally. The answer toolbar and the compile outcome card were not restyled this release. At ~568px the main column is still ~224px (predates this release). **VERIFICATION: 254 offline suites, 254 passed / 0 failed; 276 total (254 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |
| `v3.71.1` | **Every remaining ⓘ in the app now uses the v3.71.0 explainer model, through ONE implementation — the maintainer, on first seeing the model: "the ⓘ designs are truly amazing."** 36 new explainers cover the ≈41 ⓘ v3.71.0 left behind (Domains, Settings, Shared Brain + its wizard, Sync, Chat), cutting the words behind them by about half per view: Domains 793 → 420 (10 marks, including `ingest.page`), Settings ~1,821 → 886 (23 → 21 marks), Shared Brain view 93 → 58, its wizard 183 → 123, Sync 57 → 52 (2 → 1 mark), Chat ~50 → 33 — roughly 3,020 → 1,570 words app-wide. **Merges and cuts:** the Health section's block ⓘ merged into its section header (same text said twice); the Sync and Ingest sidebar-title ⓘs moved onto their MAIN headers instead, since a sidebar title may never carry one; "Why X cannot be active" and the one-button Setup-guide block ⓘ were both cut (the first is dead code behind `allowSetActive: false`, the second repeated its button's own lede). **One ⓘ implementation:** the two byte-identical copies in `settings.js` and `domains.js` (`infoMark`/`TX_INFO_GLYPH`) and Chat's hand-built project-pin button (a literal typed "ⓘ" instead of the app's SVG glyph) are gone; `shared/block.js` now takes an explainer KEY, never prose — prose is inexpressible where it used to accept HTML. A new OFFLINE suite, `test-explainer-adoption.js`, tree-walks `src/public/next` app-wide: one mark implementation, every header `info`/overview `infoText`/block ⓘ/`SECTION_INFO`/`explainerMark` call resolves to a real key, no ⓘ on a sidebar title, and a dumb cross-check (grep agrees with the walk) — the Ingest estimate-basis panel is the one named exception, since it is a server-written cost account and an explainer may never carry a cost. **Facts moved VISIBLY onto the page** (v3.16.1: a warning, cost or outcome never sits behind a chevron): the Health scan-limit refusal ("estimates its cost first and does not start when the estimate is over the ceiling"); the Shared Brain token line now reads "not checked · expires without notice" beside Access token/Check now; the wizard's attribution step states irreversibly that a name once published cannot be removed; the default-domain MCP write risk ("a mis-aimed write lands in the wrong wiki and is hard to spot"); the chat project-pin picker footer gained the "reads only the domain its chips select" state line; the new-project form's Documents field now says "saving replaces the whole document"; Sync states "The Curator has no revert control. A git client pointed at your knowledge folder can undo a sync." **False claims removed:** "Set once — a project is mirrored or kept here, never both" (untrue since v3.69.0's per-document sources) is gone from Domains' Documents chooser and its on-page note; `SECTION_INFO.mcp`'s "twenty-four tools: seventeen read, seven write" is gone (tool counts come from `mcp/tools/index.js`, never prose). **Naming:** Domains now says "the brief," not "Standing brief" (pill "Brief written"/"No brief yet", label "The brief"). Ingest's Try line reads "Drop a PDF on the drop zone, or press browse your files." **Docs, same release:** four heading retitles with no version numbers or circled numerals (`mcp-bridge--connect-a-client`, `default-domain-for-mcp-writes`, `pin-a-project-and-the-answer-reads-its-context-too`, `2--your-ai-model`); a new "Going back to an earlier version" section for the repo install; every one of the ~25 items v3.71.0's ⓘs dropped is placed or confirmed already covered in the guide, nothing deleted, only moved; ~19 prose instances of "standing brief" reworded to "the brief"; `llm-docs/curator-user-guide.md` synced. **PROCESS.** Copy builder Opus 5.5 (11 mutations, all red); wiring builder Opus 5.5 (14 mutations, all red, plus test edits by four parallel Sonnet sub-agents); docs Sonnet, sent back once — it had skipped the ~25 moved-to-guide items, against the maintainer's own rule that nothing is deleted, only moved; this row Sonnet. Orchestrator hand mutations, each restored by copy and shasum-verified: copy builder — "never a mix of sources" reinserted — red 2; wiring builder — a Domains ⓘ switched back to a direct `renderInfoMark` prose panel — red 3 in `test-explainer-adoption` (a direct call, a second implementation, an orphaned key); a first mutation attempt against a non-matching anchor applied 0 and was caught by the printed applied count before being retried correctly. Screen review on an isolated copy: Settings → General's ⓘ rendered the "Set up in this order" steps (Providers & keys → Knowledge base → MCP bridge) with the First-run guide card; all six Settings marks resolved to explainers; the Sync no-revert line sits under the connected-state actions, not visible on the unconnected copy but covered by the adoption suite. **KNOWN AND UNFIXED.** The app shell still squeezes the main column to ~170–224px at 568px, so code-chip steps (recovery) wrap letter by letter (predates this release). The Ingest estimate-basis prose panel stays outside the explainer model by design. Domains → New project still uses the retired ownership chooser. The four failure messages that vanish on a timer remain. A manual Refresh still closes an open ⓘ. Agent sessions still doesn't count hook or CLI starts. **VERIFICATION: 249 offline suites, 249 passed / 0 failed; 271 total (249 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |

- **Version:** 3.72.0
