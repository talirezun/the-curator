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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **205 rows**, back
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
| `v3.76.0` | **Seven improvements after the two-harness test plus a fresh app-wide truth audit (15 findings, 1 high — all fixed): per-tool agent instructions (measured), a save with no scope goes to the tool's own scope, first-class Antigravity support, stable domain colours and a "not checked" health mark, Settings › Trash with Restore, a responsive shell, and every docs screenshot regenerated from synthetic demo data.** **W1/W1b — the frozen paragraph, re-measured twice.** Paragraph 1 of the agent-instructions block now tells each tool to read with `get_project_context` and save under a scope named for itself (`claude-code` / `antigravity` / `opencode` / its own name), `harness` the same name; paragraph 2 drops the now-false "instead of `get_working_state`" and keeps a first-action imperative. Measured 2026-09-25 (Claude Code 2.1.281 headless, isolated store, whole Copy output in `CLAUDE.md`, N=8): Haiku 4.5 **old text 7/8 saved, 0/7 in a tool scope; shipped text 7/8 saved, 2/7 in scope `claude-code`, 7/7 harness `claude-code`**. The store then changed (W8a, same release) so a save with no `scope` but a `harness` lands under the normalised harness id (no harness → `main`), an explicit scope always wins — which made the shipped text's own parenthetical false, so paragraph 1 was re-measured a second time (W1b) on the integrated code: **Sonnet 5 read 8/8, saved 8/8, 8/8 under `claude-code` all named, $0.98; Haiku 4.5 read 5/8, saved 5/8, final scope `claude-code` 3 (1 named, 2 by the default) and `main` 2 (NAMED explicitly), harness `claude-code` 5/5, $0.49**. Maintainer decisions: the default scope is the harness id, not `"main"`; F13 a reopened chat restores its own recorded project; all seven improvements below are approved. **W2 — Antigravity, first-class.** `harness-adapters.js` gets an `antigravity` row built from the vendor's own docs (`AGENTS.md` + `GEMINI.md`, never `CLAUDE.md`; three MCP config files; a named-hooks shape) — UNMEASURED, two dated single-session observations carried verbatim, maintainer test pending; PreInvocation injects once per `conversationId`, Stop asks only on `terminationReason: model_stop`; `install-hooks.js` writes the named-hooks files; `doctor.js` gets an Antigravity row (MCP files, hook file, installed skills compared by sha256); the client name is unobserved and logs as other. **W3 — stable domain colours + a "not checked" mark.** A domain's identity slot is RECORDED once in `domains/<slug>/.curator-identity.json`, deterministic lowest-free-slot by name, no hash and no list-position mapping — adding, deleting or renaming a domain no longer recolours the others; every view paints through `identitySlotClass`/`domainIdentityClass`, never the position-keyed `identityDotClass`. The sidebar health mark gains a third state — a hollow ring for "not checked yet" — so an unscanned domain no longer reads the same as a clean one; scan results reset on restart (unpersisted, known gap). **W4 — Settings › Trash.** `trash-items.js` (list / restore / restore-as / delete-forever) never overwrites or merges (409 + `<name>-restored`), refuses a missing parent, matches ids against the real listing before building any path; each delete now writes an `origin.json` beside the trash folder so restore is exact even for names containing `--`; Settings gains a sixth section, Trash; Context's delete-handoff outcome now points there. No empty-all, by design. **W5 — a responsive shell.** Three width bands (≥1100 / 800–1099 / <800), a sidebar drawer below 800px, the first-run guide docks on top below 1100px; usable content width at 800px went 197px → 421px, at 568px 74px → 440px; the Electron `MIN_WIDTH` (960) is unchanged. **W6/W9 — every doc screenshot from synthetic data.** New `scripts/demo-domain.mjs --workspace` builds a demo project through the app's own store functions (a brief, two documents, handoffs from Claude Code and Antigravity with a kept `previous.md`, journals, a content-free usage log, trashed items, a Personal Sync repo labelled `github.com/example/my-brain`) on machine `demo-mac-4d3e2f`; `scripts/screenshots.mjs` re-shoots 15 shots (19 images, light + dark where applicable) against an isolated server with a leak guard on host name, user name, home and checkout paths; the personal machine name and personal repo URL are gone from the docs and the demo GIF is no longer referenced. **W8a/W8b — the truth audit, F1–F15 (1 HIGH, all fixed).** **F1 HIGH:** the MCP reported "saved `<file date>`" — after the 2026-09-25 restore every handoff looked written today; now "written `<writtenAt>`" plus "arrived on this disk" only when the two clocks differ. F2 the brief's own recorded time is shown, file mtime only as a labelled fallback, in both the app and the tray widget. F3 the widget's dead "by an agent" clause now fires from the store's real provenance kind. F4 Context ages now tick on the shared clock instead of freezing at paint. F5 "N more in Project Context…" counts against the project's true scope count. F6 the sidebar's health mark distinguishes "not checked" from merely stale. F7 an overwritten tool is still named, read from the journal. F8/F12 Settings' connection bars and "bar scaled to" figure are corrected. F9 Chat's Sources count only citations that actually resolve to a wiki page ("6 PAGES" read as high as 6 when only 2 were real pages; now "2 pages" plus unverified mentions counted separately). F10 tool labels are normalised everywhere they're shown (journal lines, the Handoffs byline), raw spelling kept as screen-reader text. F11 a context-window figure read 128k where the meter's own bytes/4 figure said 131k. F13 reopening a conversation restores its own last-recorded project rather than falling back to the pin. F14 `save_foundation`'s size is derived, not hand-set. F15 the delete preview names machine folders that share one install id, so two folders are not mistaken for two computers. **W10 — loose ends.** The Stop/pre-compact hook now asks for the harness's own default scope (or a configured `--scope`), never the project's newest; the CLI's usage text states the default; a journal line and the handoff byline show the normalised tool name; the reading-budget meter carries `≈`; a sweep of now-false "stays `main`"/"latest by mtime"/"Agent sessions" claims across the skill, `working-state.js`, `llm-docs`, the user guide, the roadmap and route comments; personal machine names scrubbed from code comments and test fixtures (this release, the public-repo pass). **PROCESS.** Design/audit/build Opus 5.5, 10 worktrees; docs and changelog rows Sonnet; conflicts resolved by the orchestrator (`decisions-app.md`, `views/memory.js` — W8a's helpers against W3's identity signature, the user guide's One-stream paragraph, `run-tests.js`, `CONTRIBUTING.md`'s suite counts). Orchestrator hand mutations, each restored by copy and shasum-verified, all red: W2 — the hook's `terminationReason` filter disabled (`test-antigravity-adapter`); W4 — the restore parent check removed (`test-trash-restore`); W8a — the MCP report reverted to "saved `<file date>`" (`test-truth-v376`); W3 — the identity sort reversed (`test-domain-identity`); W5 — the drawer breakpoint moved to 1099 (`test-next-sidebar-drawer`); W8b — the brief's provenance kind ignored (`test-tray-summary`); W10 — the hook's scope forced null (`test-cli-curator`); W1b's own four pin mutations. **KNOWN AND UNFIXED.** The Antigravity hooks are unmeasured pending the maintainer's own test. A small model can still name `main` explicitly even under the new default — the warning and `previous.md` cover the consequence, not the cause. The per-session-scope brief rule now needs `--scope` added to a hook command for each installed tool. Domain scan results are not persisted across a restart. Pages-list titles still come from file names (e.g. "Eniac"). The ingest "largest first" list was seen misordered once. Chat's composer pills clip at 1280px. The "Bridge sessions" strip heading is kept as-is. Some meter-layer labels still lack `≈`. S5 (two Macs) has not yet been run. **THE GATE REFUSED THE FIRST CUT.** CI (Linux) failed one assertion in `test-next-memory-view.js` §11d twice, never locally: "an age that ticked without changing the WORDS re-renders nothing — got 1, expected 0". Cause: the truth-audit F4 fix derives ages from the real clock at paint time, while the fixture was stamped once at suite start (`LIVE_NOW`), so on the slower runner 52 s aged past the 60 s "just now" boundary. Reproduced locally by inserting a 10 s pause (red with the old fixture, green with the fix); fixed by stamping the fixture when the poll reads it and re-taking `LIVE_NOW` for that block — a test-clock bug, not an app bug. The runner could not show the failing line (it printed only the suite's tail), so `scripts/run-tests.js` now lists every failed assertion of a failing suite. Paid live suites run locally before tagging: chat live regression 5/5 scenarios on a copy of the articles domain, chat-model and chat-truncation green, compile-fallback green; `test-openrouter-live.js` 57/2 — the SAME two failures on main (a nonexistent model id surfaces as a friendly Error, not a typed OpenRouterError; since v3.72.1), KNOWN AND UNFIXED. **VERIFICATION: 266 offline suites, 266 passed / 0 failed; 288 total (266 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |
| `v3.75.0` | **Delete one handoff (work-stream) from the app — typed, previewed, trashed, never by an agent — the maintainer had to dig through folders to remove two test scopes after the two-harness test.** Store `deleteWorkStream` + `previewWorkStreamDelete` (`working-state.js`); `DELETE /api/memory/:domain/:project/scopes/:scope {confirm}` and `GET …/delete-preview`; the confirm must equal the scope folder name exactly (route AND store); `latest` taken literally; refuses traversal, `foundations`, a folder that is (or may be) a separate project, Shared Brain mirrors; takes the domain's cross-process lock + the route's in-flight check (409) — `saveWorkingState` itself is lockless by design, so a save landing in the same instant is not excluded; the move is one atomic rename (trash copy always whole) and a save that re-creates the scope afterwards is reported as `recreated: true`, not a clean delete (that race is untested); moved to `<user data>/.curator-trash/scopes/<domain>--<project>--<scope>--<UTC stamp>/`; no MCP tool (a suite checks nothing in `mcp/` reaches it); a narrow, recorded exception to "the app never writes tiers 2–3" (`decisions-agents.md`). On screen the word is "handoff" (the v3.65.1 vocabulary test bans "work-stream" in the Context view): the neutral row trash on each Handoffs row → an inline card "Delete handoff <scope>?" listing every machine's saved copy with its headline, age and tool, an amber line when copies from other computers are included ("Sync will remove it on your other computers too"), where it goes and how to restore, type-to-confirm, button disabled until exact; outcome line "Deleted handoff "X" — N saved copies (machines). It was moved to The Curator's trash, at <path>. To restore it…" until dismissed. Docs, same release: `api-reference`, `decisions-agents`, `working-state`, `user-guide` ("Deleting a handoff"), `llm-docs/curator-agent-memory`; the "delete its folder by hand" sentences replaced. New suite `scripts/test-work-stream-delete.js` (155 assertions). **PROCESS.** Builder Opus 5.5 (14 mutations, all red; route guards double-covered by the store, proven with a recording stub store). The builder's `pkill -f "node src/server.js"` to stop its demo server also killed its own `npm test` run and would have stopped any checkout server of the user's — the installed app (Electron) was unaffected; re-run clean. Rebase onto v3.74.0 conflicted in `decisions-agents.md` and `llm-docs/curator-agent-memory.md` — resolved keeping both (v3.74.0's latest-by-`writtenAt` sentence + v3.75.0's delete sentence). Orchestrator hand mutation: `deleteWorkStream` `rm` instead of `moveToTrash` → `test-work-stream-delete` red (trashPath not under `.curator-trash/scopes`, trash copy ABSENT vs every machine folder, journal and `previous.md`), restored by copy, shasum-verified. Screen review on an isolated copy of the real projects domain (port 3482): ott's `antigravity` handoff — card listed the one saved copy with its headline, age and "Antigravity"; the other-computers line appeared because the isolated server has its own install id (true in that setup); Delete stayed disabled for "Antigravity", enabled only for "antigravity"; after delete the row left the table, the outcome line named the trash path, and the trash copy diffed identical to the real handoff (the real data untouched). This row Sonnet. **KNOWN AND UNFIXED.** No Restore button (manual move back); nothing empties the trash; the save-vs-delete same-instant race is untested; no bulk delete by design. **VERIFICATION: 261 offline suites, 261 passed / 0 failed; 283 total (261 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |
| `v3.74.0` | **Two agent tools on one Mac, made followable and safe — the maintainer's live Claude Code + Antigravity test (2026-09-25) drove a new menubar widget, one tool identity, a truthful "latest", and a warning plus a kept copy when one tool's save replaces another's.** **Evidence** (live test on the maintainer's machine, projects ott / field-notes / conduit): S0 Antigravity listed 24 my-curator tools; S1 handover Claude Code → Antigravity → Claude Code on ott with per-tool scopes worked unprompted (Antigravity read AGENTS.md, called `get_project_context` on "Continue.", saved under `antigravity`); S2 a deliberate A-B-A-B collision on a throwaway scope was flagged in the app, but the v3.73 widget showed the notice twice, greyed and truncated, and said "4 tools"/"5 tools" for 2; S3 with no AGENTS.md on conduit Antigravity read and saved unprompted — to scope `main`, silently overwriting Claude Code's handoff (3.8 KB → 2.4 KB, text lost; the save reply only said "OVERWROTE the previous save"); Antigravity saved `model: null` unless told, and when told searched env vars, transcripts and settings for its id. **Built:** (a) widget Layout A (`desktop/lib`): pulse on top with a "Saves by tool" submenu (one strip per tool); "Active · last 24 h" rows, one per project × tool ("ott · Claude Code · 8 min ago" / "opus-5.5 — headline"), Other work-streams nested; Idle folded ("Idle · N projects"); domains folded ("Knowledge · N domains"); one collision notice per work-stream under Active, clickable, "Two tools are writing <project> / <scope>" with its own 48-char cap (rows keep 42; measured +33 pt); the app's freshness dot replaces the pie (app's scale); model names keep the minor version (opus-5.5, not opus-5); REMOVED from the menu (kept in the app): the "Working on" headline + grey line, Session start, Documents line, "N of M saved" bars (they counted MCP bridge processes, not sessions, and claimed 30 days over 5 days of log); stale docs a notice for active projects. (b) data: `src/brain/harness-names.js` normaliser — spellings of one tool are one tool (claude-desktop stays distinct; alias-collision guard), used by the pulse, `journalFacts` (no false collision from spelling drift), tray and app; `latest` and every "newest" ordered by the agent's recorded `writtenAt`, file mtime only as fallback (a Personal Sync pull no longer makes an older handoff "latest"); `getTraySummary` no longer runs `get_project_context` on every tray refresh. (c) a save that replaces a handoff last written by a DIFFERENT tool still succeeds (maintainer: warn only; default scope stays `main`) but the MCP reply, the CLI and a Journal note say whose handoff was replaced, when and its headline, and the replaced text is kept once as `previous.md` beside `current.md` (readable via `get_working_state { previous: true }`; the app's handoff reader shows "Previous handoff by <tool> · <age> — open"); `docs/spec/working-state-v1.md` §6b + readers ignore unknown files. Tool descriptions + curator-continuity skill: model id only if known, never search files for it; one spelling of the tool name; if another tool saved last in a scope with no brief rule, save under your own tool-named scope. (d) app parity: Context sidebar Active (24 h) / Idle with the tool(s) per project ("Antigravity + Claude Code"); "Saves by tool, last 7 days" in Memory step ② and Settings › Across projects; "Agent sessions" → "Agent connections" with the true window ("last 5 days — the log begins 20 Sep"); Across-projects rows "2 of 2 connections saved · bar scaled to curator's 6"; the Journal fold names its work-stream; harness estimate names "instruction files such as CLAUDE.md or AGENTS.md". (e) docs: user guide widget section rewritten, latest rule corrected (the v3.72.3 mtime caveat is gone), API reference (and an older section's wrong field names fixed), llm-docs x2, architecture/roadmap/decisions/mac-app/product-overview (old widget walkthroughs marked as pre-v3.74.0 history), README. **PROCESS.** Design Opus 5.5 (read-only; two layouts, the maintainer picked A); a read-only two-harness audit Opus 5.5 (G1–G10 + test plan S0–S5); builders Opus 5.5 — data (19 + 9 + 6 mutations), menu (20 + 5 + 1 mutations), parity (14 + 4 + 1 mutations), each in its own worktree; docs Sonnet (four sub-writers; the coordinator stalled and the orchestrator committed). Orchestrator hand mutations, each restored by copy and shasum-verified: data — the cross-tool check disabled → test-cli-curator red (warning, previous.md byte-identity, `previous` read); menu — `familyOfModel` dropping the minor version → test-tray-shell red ("opus-5" for opus-5.5); parity — the route dropping `?previous=1` → test-next-memory-projects red. Screen review on an isolated copy (port 3481) of the real projects domain: sidebar Active curator/conduit/field-notes/ott ("Antigravity + Claude Code"), Idle lumina/projects/posts; ott Memory "AGENT CONNECTIONS · last 5 days · log begins 20 Sep", "Saves by tool: Antigravity 2 · Claude Code 2", "Journal · antigravity"; Settings wording defect found and fixed ("2 of 6 connections saved, the busiest project" read as if conduit were busiest). Real-menu photographs on the maintainer's menubar (dev build from the integration worktree, isolated copy, separate Electron user-data dir; the notch hid the icon until the installed app was quit): light and dark, approved ("much more clean and clear"). This row Sonnet. **KNOWN AND UNFIXED.** The warning arrives after the loss — prevention lives in the skill rule, which only works when the skill loads (v3.52.0 measured skill-only activation 0/4 on Claude Code; Antigravity activated unprompted in S3 but still chose `main`); a save with no harness named gets no warning; the Copy-agent-instructions template still says `main` (frozen, measured); no Antigravity hook adapter / doctor row / harness-table entry; the handover line repeats the tool name (`Antigravity ← Claude Code`) because a disclosure test requires both; nested tray submenus beyond one level were not photographed; the 60-pair index cap is still applied by mtime before the `writtenAt` sort; S5 (two Macs) not yet run; three long docs keep the old widget walkthrough as marked history rather than rewritten. **VERIFICATION: 260 offline suites, 260 passed / 0 failed; 282 total (260 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |

- **Version:** 3.76.0
