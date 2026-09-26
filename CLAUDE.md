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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **208 rows**, back
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
| `v3.77.0` | **The Setup check — the app now shows, per project and per computer, whether multi-tool, multi-computer work is ready (tools, skills, hooks, the instruction block in CLAUDE.md/AGENTS.md, `.curator-project`, computers) — after the maintainer's 25–26 September live tests showed it works only when a list of preconditions holds; plus a hook activity log, doctor made truthful, four known defects fixed, and the older research articles brought up to date.** **C — the Setup check.** `src/brain/setup-check.js` (new), shared by the app and `doctor`: reads Claude Code's MCP entry from `projects[<repo>]` in `~/.claude.json` (with a `readAlso` note when it's configured only through Claude Desktop's config) and Antigravity's three config files; parses `opencode.jsonc` tolerant of comments; Claude's account-held skills read "can't check here" rather than guessing; every config read returns yes/no facts only, proven by a planted-fake-key privacy test. `src/routes/setup.js` (mounted at `/api/setup`): per-machine tools, per-project checks, a per-machine repository path (`PUT .../repo`, never synced), a reveal endpoint restricted to a path a check actually listed, and skill `.zip` downloads. Context gains a sixth overview card, **SETUP**, and a numbered step 5 "Setup": every to-fix line is loud outside any fold, each with its own one-click fix (copy the block, open the config entry, add the marker, run the git command, reveal in Finder, download the skill `.zip`, Sync now); folds for Tools, Repository on this computer, and Computers (which tool, which version it last saved with, this Mac's sync state, a handoff waiting on GitHub). Settings › MCP bridge gains block 5, "Tools on this Mac," with the same evidence-first detail. States are `ok` / `to fix` / `can't check here` / `not checked` / `unmeasured` — never a score; a tool turns `ok` only when it has actually saved from this Mac under its own scope. The instruction-block check is whitespace-insensitive and word-exact, so a re-wrapped current block still reads current, while an older block from any earlier era reads "outdated"; the tile and the step share one wording rule so they never disagree. **The hook activity log** (`src/brain/hook-log.js`, `<user data>/.hook-activity.jsonl`, content-free — key names only, never payload values — rotated, never synced) records every `my-curator hook` invocation; `my-curator hook-log` prints it; `doctor` reads it before falling back to its old temp-dir markers. `Stop` now matches on `conversationId`/`trajectoryId`/`cascadeId`, and falls back to the tool's own logged session start (12 h window) when none match. `install-hooks` for Antigravity defaults to project scope with a `--git-exclude` option. A working-state save now records `Curator: X.Y.Z` as the last field of its provenance line (the public spec updated to match), so the Setup check's Computers fold can say which version another Mac saved with. `skills/**` now ships inside the Mac app's DMG so an install can compare its skills and hand out a current `.zip` with no checkout. Docs: user guide §13e. **B — Chat composer pills + doctor's hook claim.** Pills now wrap instead of clipping (measured at 1400/1280/1100/900/700; a new LIVE_LOCAL suite, `test-chat-composer-pills.js`, checks each value's full width against its element, since sub-pixel clipping doesn't show in an integer `scrollWidth`). `doctor` no longer prints "hooks: verified" for a harness — a harness row now states the hook FORMAT (documented / unmeasured / cannot carry the ask / no mechanism) and, separately, RUN evidence read from the hook activity log's own markers, so a row can no longer be read as a claim that hooks were actually observed running when only their shape was checked. **A — four known defects.** OpenRouter's model-gone 400 is now a typed `OpenRouterError` with `.status` (live suite 59/59, unchanged friendly wording); the Pages list shows each page's real title (frontmatter or heading, cached by mtime+size — 1,229 of 3,452 titles changed on the maintainer's own `projects` domain; ~127 ms cold, ~25 ms warm); the ingest estimate lists files largest-first, matching the run's own order; the Wiki health summary is now persisted per domain in user data with a `scannedAt` stamp and goes stale only when `log.md` changed after the scan, so "checked N ago" survives a restart. **F — six older research articles updated.** Each gets a dated "Update, 26 September 2026" note tying its original claim to what's true now: the MCP is read+write with 24 tools, not read-only with 17; Shared Brain is built on GitHub, not Cloudflare R2; the LM Studio "air-gapped" claim is corrected; a dead Karpathy link is replaced; personal example-repo links are removed. New OFFLINE suite `test-research-links.js` checks every relative link and anchor in `research/` resolves. **Live evidence this release rests on.** Antigravity's session-start hook was observed injecting from a project-level `.agents/hooks.json` (2026-09-26); a marker showed the user-level hook command also ran, but its injection was not the one used; the `Stop` reminder has still not been observed. **PROCESS.** Design Opus 5.5 (C, read-only first; maintainer decisions: build it, stamp the version, ship skills in the DMG, no repo-writer yet). Builders Opus 5.5: A, B, C, F, each in its own worktree. This row Sonnet. **Orchestrator hand mutations, each restored by copy and shasum-verified, all red:** A — the estimate's largest-first sort removed (`test-ingest-queue`); B — doctor reverted to printing "hooks: verified" (`test-cli-curator`); C — the reveal allow-list removed (`test-setup-routes`, "a path no check listed is refused"). **Orchestrator screen review**, on an isolated copy of the real `projects` domain with the real `ott-framework` repository, found two defects before release, both fixed in `bc4e70d` and re-checked: the instruction-block check compared exact bytes and flagged the maintainer's current, merely re-wrapped block as "not the current text"; and before a repository was set, the SETUP tile said "not checked" while step 5 said "Nothing to fix," disagreeing with each other — the tile now reads "nothing to fix here · Antigravity · Claude Code · 2 computers" and the step reads "Nothing to fix on this computer." **KNOWN AND UNFIXED.** The Antigravity `Stop` hook remains unobserved on any machine (the maintainer re-runs with `my-curator hook-log`); `test-next-memory-projects.js` failed once under load across two full runs and passed alone since — worth watching; there is still no repository writer, only a copy path; scan results are recorded only by the app's own scan route, not by MCP or ingest; and an edit made outside the app does not mark a Wiki-health result stale. **VERIFICATION: 273 offline suites, 273 passed / 0 failed; 296 total (273 OFFLINE + 15 LIVE_CI + 8 LIVE_LOCAL)** — the orchestrator re-checks. |
| `v3.76.2` | **Docs only — the multi-tool, multi-computer setup checklist (user guide §13d), a guide to writing a standing brief, the "one handoff or new ones?" FAQ, research articles brought up to the 25–26 September live tests, and a new research article, "The Context Engine" (Article 10).** **§13d — the setup checklist.** A 10-row table (latest app on every Mac; the Curator MCP in every harness including Antigravity's three config files and opencode; both skills current in every harness; the Copy-agent-instructions block at the top of BOTH `CLAUDE.md` and `AGENTS.md`; commit `.curator-project`; Personal Sync before and after; pull/push the code repository; a new conversation or "continue"; optional hooks; `my-curator doctor`), each row with how to do it and how to check it, plus a mermaid diagram of the two repositories (the private knowledge repo for working state, the project's own repo for code) and a worked-through detail section. **"Writing a standing brief."** A table separating the brief from a handoff from a document (holds / written by / changes / read / size), a template walk-through, and three worked examples (a solo coding project, a long research project, two tools on two computers). **FAQ.** "Do I keep one handoff or make new ones?" — a table of when to keep one scope versus start a new one, and what each choice costs and buys. **llm-docs condensed:** `llm-docs/curator-agent-memory.md` gains the checklist and the FAQ as Q&As; measured at 98% of its 30,000-token budget (`scripts/test-public-knowledge.js`). **Dated update notes**, each headed "Update, 26 September 2026," land in `research/articles/the-handoff-writes-itself.md` and `research/articles/where-your-context-lives.md`, tying each article's original claim to what the 25–26 September live multi-harness tests actually found. **The new article, `research/articles/the-context-engine.md` (Article 10).** The maintainer's 20 September article, adapted: 25 sections including a new "Two tools, two Macs: what the live tests found" table; 14 claims updated to v3.76.1 with dated notes rather than silently rewritten; 134 relative links, all verified to resolve; five new illustrations in a new `research/images/` folder (metadata stripped, 43–207 KB each); two of the maintainer's own screenshots left out because they showed a personal machine name and personal domains; the Context screenshot uses the synthetic demo image already in `docs/images/` instead. **Evidence behind the article's claims** — live tests run 2026-09-25/26: Claude Code and Antigravity handed one project back and forth on one Mac, both ways; two Macs handed a project back and forth through Personal Sync, both directions (Mac A's new session opened Mac B's newest Antigravity handoff; Mac B's new session opened the newest by the agents' own clocks); the failures those tests found were fixed in v3.74.0, v3.76.0 and v3.76.1, and the article dates each fix rather than presenting the current behaviour as though it always worked this way. **Fixups found while preparing this release, on top of the two source commits (`977e7e3`, `aebe6e8`).** (a) `the-context-engine.md` said the checklist "joins the user guide as §13d in v3.77.0" in two places; both now link the real anchor and say v3.76.2, since §13d ships in this release, not the next one. Two more "New in v3.77.0" labels (the standing-brief section, and §13d's own dateline) were the same stale forward-reference and are now "New in v3.76.2." (b) `where-your-context-lives.md` carried two stale anchors into `docs/working-state.md` — `#6-the-in-app-view-is-read-only-and-what-is-not-built-at-all` and `#3-the-two-mcp-tools` — pointing at headings renamed since; both now resolve (`#6-what-the-app-writes-and-what-it-does-not`, `#3-the-six-mcp-tools`). The same two stale anchors were also found in `the-handoff-writes-itself.md` and fixed there too. A written link checker (file exists + anchor matches a real heading's GitHub slug) now confirms all 499 relative links across `research/articles/*.md` resolve. (c) Antigravity hook status corrected, precisely and dated, in three places that had drifted behind the facts: the §13d checklist's own measured box, `docs/working-state.md`'s Antigravity hooks row (both the summary table and its own "Hooks" row in the Antigravity section) and `llm-docs/curator-agent-memory.md` — all now say the session-start hook was seen running once, 2026-09-26, from a project-level `.agents/hooks.json` (with a CLI hook-marker note that the command separately ran once under only a user-level `~/.gemini/config/hooks.json`, without that run's injection being used), and that the `Stop` save ask has not been observed. `docs/user-guide.md`'s §13c hooks table (a different, already-conservative "not measured" entry) was deliberately left alone. (d) `research/README.md`'s "Example Knowledge Base" link, which pointed at the maintainer's own personal `github.com/talirezun/my-brain` repository, now links `scripts/demo-domain.mjs` and describes it as the synthetic demo workspace every doc screenshot is taken from (`node scripts/demo-domain.mjs <empty-dir>`, per `CONTRIBUTING.md`'s "Regenerating screenshots"). The same personal-repo link is still present in two OLDER, dated articles — `research/articles/knowledge-immortality-second-brain.md` (line 294) and `research/articles/the-second-brain-that-grows-smarter.md` (line 173) — left untouched this release and flagged for the maintainer to decide, since they are historical pieces rather than the live reference README. **CLAUDE.md changelog at cap.** `v3.75.0` moved byte-for-byte to the top of `CHANGELOG-ARCHIVE.md`'s table, its one-line index entry added at the top of `docs/dev/release-index.md`, both counts 206 → 207. **PROCESS.** Docs Opus 5.5 (the checklist, the standing-brief guide, the FAQ, and the dated research-article claims); the article itself Opus 5.5; this row, the anchor fixups, the hook-status corrections and the changelog archive move, Sonnet. The orchestrator merged both source commits onto `main` as a docs-only release so the new article could ship ahead of v3.77.0's code changes. **KNOWN AND UNFIXED.** The Antigravity `Stop` (end-of-session save ask) hook has still not been observed running, on any machine. `my-curator doctor` in v3.76.x still prints "hooks: verified" for Antigravity and misreads Claude Code's desktop-only MCP entry and `opencode.jsonc` — both fixed in the coming v3.77.0, not this release. `research/README.md`'s two older sibling articles still link the maintainer's personal knowledge-base repository (see (d) above) — a call for the maintainer, not fixed here. **VERIFICATION: 266 offline suites, 266 passed / 0 failed; 288 total (266 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |
| `v3.76.1` | **An agent conversation that is already open now re-reads the project context on "continue" — the maintainer's two-Mac test (S5, 2026-09-26) caught an open Antigravity conversation continuing from stale context after the other Mac had saved and synced.** **Evidence.** Mac A (Claude Code) saved `ott/claude-code` "S5 token: fig-3" and synced; Mac B (`talis-mac-mini`, v3.76.0) — an Antigravity conversation opened earlier to clone the repo, told "continue", made no `get_project_context` call (the block said only "At the START of every session") and worked from its own earlier context (it committed and pushed README/CLAUDE.md edits to the project repo); a NEW conversation did call `get_project_context` first and opened the newest handoff by the agents' clocks (its own Mac B save) — the v3.74.0 `writtenAt` ordering, per-machine copies and the "Newer state" notice all held across two Macs. **Change.** Paragraph 1 of Copy agent instructions gains, after "...before acting.": "When the user says continue or resume, or you come back after a pause, call `get_project_context` again before acting — another tool or computer may have saved since." (972 → 1,141 bytes, re-pinned, sha `a19c9f24…`); the curator-continuity skill §2 carries it verbatim (a test pins block ≡ skill); `get_project_context`'s description gains the short form "; AGAIN on 'continue' or after a pause" (3,196/3,200 B; the reason clause didn't fit — commented). **Measurement** (Claude Code 2.1.281 headless, isolated, two turns: turn 1 does a task, then a newer handoff is saved by the store under scope `antigravity` with a unique token + new next step, turn 2 `--resume` "continue"): `claude-sonnet-5` control (v3.76.0 text) turn-2 re-read first 0/8, saw the new handoff 0/8; v3.76.1 text 8/8 re-read, 8/8 saw it, 4/8 quoted the token, none acted on the other tool's step unasked; `haiku-4-5` N=4: control 3/4 re-read, new 2/4 (turn 1 mostly failed to reach the tool — not comparable at N=4); ~$6.18. The skill and tool-description changes were not in the measured runs. Also: the maintainer's three project repos (ott, field-notes, conduit) carry the sentence in CLAUDE.md + AGENTS.md (outside this repo). Docs: user guide §13b + several-computers/several-tools, `docs/working-state.md` campaign, `llm-docs/curator-agent-memory.md`, `decisions-agents.md`. **PROCESS.** Builder Opus 5.5 (5 mutations, all red). Orchestrator hand mutation: the skill's "again before acting" removed → `test-agent-instructions` red ("the continuity skill carries the SAME re-read rule as the block"), restored by copy, shasum-verified. This row Sonnet. **KNOWN AND UNFIXED.** Haiku 4.5 not shown to improve; an agent cannot see saves made elsewhere unless it calls the tool (no push notification exists); `test-openrouter-live.js` 2 failures since v3.72.1; the reverse S5 step (Mac A opens Mac B's handoff) pending. **VERIFICATION: 266 offline suites, 266 passed / 0 failed; 288 total (266 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |

- **Version:** 3.77.0
