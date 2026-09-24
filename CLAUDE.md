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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **195 rows**, back
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
| `v3.70.1` | **The per-document planner for the context-window meter, deferred out of v3.70.0 — each read-first document now its own segment on the meter, and a "Documents at start" fold that previews start-state changes before Apply.** `session-start.js`'s `readFirst` layer gains `entries: [{slug, title, bytes, tokens, page, readFirst}]` in delivery order, `page` taken from the delivery plan and checked against the reply each document actually arrives in; the meter's `read` layer gains matching `parts`. Additive only — no v3.70.0 field changed, and a layer with no parts renders byte-identical to v3.70.0, pinned by a digest computed from the v3.70.0 kit. `shared/bucket.js`/`.css` split such a layer into one segment per document — same violet step, thin separators, labels only where they fit, every document named in the legend with its tokens, a 3px gap and a thin "reply N" strip marking where a later MCP reply begins, and a text alternative naming every document and where each reply starts. Step ④ gains the fold: closed by default, one row per document (title, role · size, a saved-state tint, tokens as a depth-bar share of the budget, never danger there), a three-way native-radio start-state control, and a totals line that IS allowed to turn danger. Changing a row previews through `POST …/session-start/preview` (debounced 150 ms, sharing step ①'s `budgetPreviewCache`; stale answers dropped) as "Preview, not saved · ≈Xk tokens · Y% of window · N MCP replies"; Apply attempts every changed row through step ①'s own `writeStartState`, does not stop at a refusal (refused rows stay listed with the route's own words, no timer), fires one toast counting what actually landed, then re-reads the project so step ① and the meter both reflect the store; Discard drops the draft, which is never persisted and is dropped on a project switch. **Builder's departures from the design, each justified:** hovering a reading budget now previews that budget together with any pending draft, since without it the owner's own plan would vanish from the meter on hover; the "every budget sends the same — nothing is read first" line stands down while the draft previews a document as read first, since it would otherwise contradict the meter; "What an agent receives" gains an "if applied" line reusing the reading-plan helper's own pattern; "Choose read-first documents" now opens and focuses the planner (falling back to step ① if there is no planner); the narrow layout is keyed to the table's own width via a container query, not a media query, because at 568px the column is ~170px and a media query cannot see that; there is no combined "Apply 4 changes" across documents and budget together, since the budget remains its own immediate-write picker and the planner holds only start states — one write path per field. **PROCESS.** Builder Opus 5.5, 16 mutations, all red (3 only after the suite's own assertions were added first, then confirmed red); this row Sonnet; no docs sync this release, per the maintainer's own two-release documentation cadence — sync follows v3.71.0. Orchestrator hand mutation emptied `bucket.js`'s pages list, removing the reply-boundary strip — red in `test-next-bucket-kit.js`, restored by copy, shasum-verified. Screen review on an isolated copy of the maintainer's own projects domain: the builder's own 2-reply preview screenshot matched the design's concept C; on real data, marking "Development decisions — the app" read first in the planner showed "Preview, not saved · ≈16.3k tokens · 8.1% of 200k · 1 MCP reply" and "Apply 1 change"; Apply produced the toast "1 document updated — Saved. Step 1 shows the same start states.", the project's stored state then listed `decisions-app.md` as read first, and the preview cleared. **KNOWN AND UNFIXED.** Each planner preview runs the full session-start report (all seven presets plus the hook, ~100–200 ms) rather than a scoped call. The "reply N" strip's position is approximate — the framing layer includes later pages' envelopes, so it marks the bar's start up to the first page-2 document; the token figures themselves are exact. The overview tiles don't mention a pending planner draft. The narrow app shell still squeezes the step column at 568px (predates this release). The 1px white separator between segments is faint in the light theme; names on the bar, the legend and the aria text carry the distinction instead. Older follow-ups remain open: the four failure messages that vanish on a timer, the agent-instructions block's unreconciled first paragraph, Domains → New project's retired chooser, a manual Refresh still closing an open ⓘ, Agent sessions not counting hook or CLI starts, and preset "16k" reading against the meter's own "16.4k". **VERIFICATION: 246 offline suites, 246 passed / 0 failed; 268 total (246 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |
| `v3.70.0` | **The context-window meter becomes the control panel of project context — the maintainer's own "key element that makes this app truly useful": people pick their window size, and a bar to scale shows the harness (their own estimate, hatched), The Curator's share, and free space, with The Curator's part enlarged layer by layer in tokens.** A design pass produced three concepts as finished mockups; the maintainer picked the horizontal meter, concept A — "amazing design" — over the vertical tank ("takes too much space"); the shipped A+ keeps the "Preview, not saved · N MCP replies" line and the dashed budget-left room. **DECISIONS:** the per-document planner fold is deferred to v3.70.1; the harness figure is owner-entered (Not set by default, never added to any measured figure); seven token presets (Index only 0 · Lean 8k · Standard 16k · Deep 32k · Large 64k · Extra large 128k · Max 200k), a cap of 800 KB, a stored 120/200 KB budget shows as Custom plus its nearest preset; window and harness are saved per computer in config (`GET`/`PUT /api/config/context-window`, `409 harness_exceeds_window`, `config_unreadable` never rewritten, the old per-browser setting migrated once). **THE LIVE BUG IT FIXES:** Claude Code shows at most ~25k tokens of one MCP reply and saves the rest to a file, so Deep/Max (and any untouched project over ~75 KB) were measured "in the window" but actually landed in a file — `get_project_context` replies are now ≤80 KB (≈20k tokens) WHOLE replies (P1's correction: the cap covers the whole reply, since page 1 alone carries ~27 KB of brief/handoff/journal/index), whole documents only, with a `page` argument and `continuation`; a reply that already fit stays byte-identical to v3.69.0; the skill and the tool description were both updated (3,163 B). **P2** moved `sessionStartReport` to `src/brain/session-start.js`, one measurement shared by the app, the MCP's report and the tray — layers, budget, all seven presets (with `sameAsPrevious`), `presetsSummary` (`allEqual` plus its reason), delivery and the meter model; it counts every page. **P3** built `shared/bucket.js` plus `bucket.css` and `tokens/layer.css` (`renderBucket` and friends), one violet hue scaled by lightness, with the mock's label contrast fixed (3.05:1 → ≥4.5:1) and never colour-only, amending rule 6. **P4** rebuilt step ④ around the meter: a head row of Window / Reading budget / Harness; a debounced (~180 ms) live preview on hover; the "every budget sends the same — nothing is read first" line with a door back to step ①; a SESSION START tile in tokens; Capture relabelled "Agent sessions" with its zero-count line; and the 200 KB project alarm is dropped (`FOUNDATIONS_BUDGET_BYTES` itself stays 200 KB — it only ever warned, is stored per manifest, and raising it would break byte-identity: P1's pushback, accepted). **P5** gave the menubar widget the line "Session start ≈Nk tok · N% of 1M" within a 38-character budget, a 28×13 two-lane gutter PNG, a tooltip equal to the app's own `bucketText`, a documents line measured against the reading budget, with the menu's width unchanged. **Capture finding (P2):** neither the hook nor `my-curator context` ever writes the usage log; no hooks are installed on the maintainer's machine; the real logs hold 5 curator sessions in 30 days — the earlier reading of 0 was likely because the installed app's own log only starts 2026-09-20; options were offered, none built. **PROCESS.** Design pass Opus 5.5; builders P1–P5 Opus 5.5 (mutations: P1 12, P2 12, P3 13, P4 14, P5 11 — all red); docs Sonnet; this row Sonnet. Orchestrator hand mutations, each restored by copy and shasum-verified: P3 — the empty-room label removed — red; P1 — the page size lowered from 80 KB to nothing checked at 800 KB — red on 32 assertions (a first attempt against a non-matching anchor reported green, caught only by printing the applied count); P2 — lowering the window below the harness allowed — red 2; P5 — a failed measurement hidden — red by a crash at the right assertion, weaker than a named failure and noted as such; P4 — the "every budget sends the same" line hidden — red 2. Screen review on an isolated copy of the maintainer's own projects domain: the curator project's stored 200 KB budget read "Custom ≈51.2k, nearest Large"; with nothing read first, the dashed room read "reading budget 51.2k — unused: nothing is read first" alongside the explanation line and its door; after `PUT` window 1M + harness 120k: "≈129k in use · 12.9% · of which The Curator ≈8.7k (0.9%)", layers framing 3.1k / brief 3.4k / handoff 0.5k / journal 0.5k / document list 1.1k / read first 0, free 871k, on demand 47.8k · 9 documents; the tile read "≈8.7k tokens · 1 reply". **KNOWN AND UNFIXED.** The per-document planner fold is v3.70.1. Preset names use 1,024-token units ("16k") while the meter itself prints 16.4k. Each later page re-reads its source, so an edit between calls can shift a page's contents — `continuation.slugs` lets an agent notice. A preview costs 1 + pages + 7 handler runs. The menu bar was not photographed on a real screen. At 1x the smallest widget layers are under a pixel wide (the tooltip carries the real figures). At ~584px the app shell still squeezes step ④ (predates this release). Agent sessions still doesn't count hook or CLI starts. The skills changed again, so the maintainer must re-upload both. **VERIFICATION: 246 offline suites, 246 passed / 0 failed; 268 total (246 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |
| `v3.69.0` | **One project can now hold documents written here, copied from a folder, mirrored from a folder and mirrored from GitHub — up to 8 sources, any mix — the maintainer's own decision after v3.68.0 ("we definitely need an option so we can add sources from local and from GitHub").** Manifest version 2 is written only when version 1 cannot express the mix (the lowest-version rule); an untouched project stays byte-identical, and a project that stops mixing goes back to v1; both directions round-trip. The frozen v3.68.0 validator fixture proves an older app refuses every v2 manifest and accepts every v1 manifest, across 400 random models. **D1: v3.68.1 shipped first** so a machine one version behind reads "made by a newer version of The Curator — update the app," never "fix or remove," before this release's writer exists anywhere. **D2:** "Add from this computer" defaults to Keep in sync when the picked folder is inside a git checkout, else Copy once, both options visible. **D3:** up to 8 source groups per project, including several GitHub repositories. **D4:** `save_foundation` may create a NEW document in any project; it is refused only on a slug that is a mirror, naming the source via `mirrored`. Per-group refresh runs under one lock — every group read first, a failing group left byte-identical, the manifest written once, last. Folder groups are now rooted at the checkout's top level, fixing the subfolder-over-GitHub defect (a second machine's checkout refresh is guarded by origin + folder name, case a'), and a latent v3.68 bug — a subfolder mirror read against the checkout root and silently overwrote `repo.root` — is fixed alongside it. A slug collision across sources lands under a readable suffix, shown as "lands as" before the commit. Every document row gets a delete icon; the pencil stays kept-documents-only; one confirm, shared by the row and the editor, names the untouched original; a deleted mirrored document does not return on the next refresh (no tombstone); deleting a source's last document removes that source in the same write. Routes: new `POST …/foundations/add-remote`; `repo-scan` takes `mode`/`domain`/`project`; `refresh` takes `{group}`; `DELETE` takes `{confirm}`; refresh no longer defaults `tokenSource` to `'config'` (an unknown value is now 400); a `token` field in any body is refused by name. MCP tool count is unchanged; three tool descriptions were re-fitted under the 3,200-byte cap (3190/3189/3191 B); both skills and the public spec (manifest v2) were updated. The view's unified documents table was cut to 6 columns, not the contract's 8, because 8 hid the trash icon behind a scrollbar at 1400px. **PROCESS.** Design pass Opus 5.5 (the contract); three builders, all Opus 5.5 — A the store (18 mutations, all red), B routes/MCP/skills/spec (13 mutations, all red), C the view (12 mutations, all red); docs Sonnet; this row Sonnet. Orchestrator hand mutations, each restored by copy and shasum-verified: C — the GitHub delete confirm's wording dropped "is not touched" — red; A — a mixed model written as v1 — red on 17 assertions including "an OLDER app refuses the v2 rewrite"; B — letting a `token` field through `add-remote` — red 3. Screen review on an isolated copy of the maintainer's own projects domain (a curator project with 8 copied documents): the GitHub door was enabled on a kept-only project; "Add from this computer" on the checkout's own `docs/spec` defaulted to Keep in sync; mirroring one document moved the manifest to version 2 with 1 source; the sources strip and per-row trash icon both rendered; the mirrored row correctly had no pencil; the delete confirm read exactly "Only this project's copy is removed. The original, `docs/spec/working-state-v1.md` in the folder `second-brain`, is not touched. A refresh will not bring it back… This was the last document from `second-brain`, so that source is removed from the project too."; after the delete the manifest returned to version 1 (8 documents, ownership `curator`) and the original file's sha was unchanged; no horizontal overflow at 568px. The GitHub door was not exercised live in the screen review (no token in the isolated copy, by design); B's own end-to-end suite covers it against a fake GitHub. **KNOWN AND UNFIXED.** An app OLDER than v3.68.1 still shows "Fix or remove…" for a v2 manifest. `landsAs` assumes every earlier row stays ticked; the `landed` list reports the truth when one is unticked. `add-local` still returns slug strings while `add-remote` returns `{path,slug}` (both carry `addedFiles`). Orchestrator mutation 5's premise was wrong — `test-reading-budget`'s digest checks the store's `getProjectContext`, not the MCP handler; a new suite now covers the MCP handler directly. At 568px the app shell still leaves ~145px for the step (predates this release). Per-group refresh of a private repository with no recorded token source falls back to the server default. Domains → New project still uses the retired ownership chooser. The four failure messages that vanish on a timer remain. The Claude skills changed and install by MANUAL upload, so the maintainer must re-upload them. **VERIFICATION: 242 offline suites, 242 passed / 0 failed; 264 total (242 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL) — the orchestrator re-checks after the docs merge.** |

- **Version:** 3.70.1
