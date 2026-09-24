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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **191 rows**, back
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
| `v3.68.0` | **Answers the maintainer's own gap report: a project couldn't mirror what was already on GitHub without first adding a local copy, couldn't add a second file once it held one, and had no multi-select.** Context step ① now shows two doors, always present, side by side in the head row: **Add from this computer** and **Add from GitHub**, each opening the same checklist panel — list, tick (with select all), commit with "Add N documents" or "Mirror N documents." The local checklist walks a folder the owner picks (skipping hidden entries and `node_modules`, 4 levels deep, capped at 200 rows), shows `.md`/`.txt` only, and disables anything over 512 KB with its size shown; a live total is checked against the 200 KB project budget and warns on an over-run. A commit always appends, never replaces. New route `POST …/foundations/add-local {root, files}` calls the store's `addFoundationsFromFolder`; `repo-scan?all=1` lists every document instead of the canonical-name heuristic; the rules live DOM-free in `shared/foundations-add.js`, testable without a browser. The data model is unchanged — one source per project (keeps its own copies, mirrors a folder, or mirrors GitHub) — so the disabled door names why it can't be used; a narrow store change, `rechooseEmpty: true`, lets an EMPTY project (no documents, no unlisted files) re-pick its source. Security: `add-local` reuses the store's own guards — realpath-verified paths, regular `.md`/`.txt` files only, ≤512 KB, writes only under the project's state dir inside the lock with the manifest written last and never overwriting an existing document, body accepts only `{root, files}`, a foreign Origin gets 403, no token ever crosses a body. A copied document is labelled "copied from `<folder>`" (folder name only) via a new optional manifest field, `copiedFrom` — older manifests read "written," and editing a copied document makes it "written by you." The local door remembers the last folder added from, for the session. A one-line legend above the checklist explains read first / on request / not at start. Retired from Context: the ownership chooser ("Set up documents"), "Add from folder," "Mirror from GitHub instead" — Domains → New project still uses the old chooser (KNOWN). **MAINTAINER DECISION (2026-09-24):** per-document source, so one project can take documents from both a local folder and GitHub, is not this release — planned as v3.69.0. **PROCESS.** Builder Opus 5.5 (23 mutations, all red; a first-attempt M3 was ineffective by operator precedence — `false && a || b` still evaluates `b` — rewritten plus a new M3b, both red); docs sync (docs/, README, llm-docs for v3.67.2 + v3.68.0) Opus 5.5; this row Sonnet. Orchestrator hand mutation disabling the "already added" refusal — red 2 in `test-foundations-add.js`; a second guard (unlisted-file refusal) still blocked the overwrite; restored by copy, shasum-verified. Screen review on an isolated copy of the projects domain: both doors at empty; listed docs/dev (8 files); ticked 2 → "Add 2 documents" → toast; re-list showed them ticked and disabled; GitHub door disabled with its reason — found copied documents mislabelled "written by you" and an empty folder field on reopen, both sent back and fixed. **KNOWN AND UNFIXED.** One source per project until v3.69.0; a copy records no origin path and never refreshes; a copy named after its file collides with a same-named template; dead state branches remain in `views/memory.js`; Domains → New project still uses the retired chooser; the four failure messages that vanish on a timer (from v3.67.2) remain. **VERIFICATION: 238 offline suites, 238 passed / 0 failed; 260 total (238 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL).** |
| `v3.67.2` | **The maintainer's own v3.67.1 test feedback (2026-09-24): one app-wide toast, honest copy about where agent instructions go, a false "not on this computer" note removed from Context, and the Context ⓘ that blinked on every auto-refresh.** `shared/toast.js` + `toast.css` is the one action-feedback surface — bottom-right, `role="status"`, self-closes after 30 s (`TOAST_MS`), pauses on hover/focus, closes early on × or Escape, re-shows on a repeated action — migrated onto Context's and Domains' agent-instructions and drafting-request/marker-line copies and Shared Brain's admin/invite-token copy confirmations (the token itself stays on its card). Kept persistent, per the standing rule that a warning, cost or outcome is never hidden: every "Could not copy," every failure, every delete/merge/prune/revoke, every cost or write outcome, every busy refusal. Copy-agent-instructions now says WHERE to paste it — "at the very top of the file your agent loads every session" — naming CLAUDE.md, AGENTS.md, GEMINI.md and a `.cursor/rules` file (Codex truncates `AGENTS.md` at 32 KB, so position matters). Context → Documents drops the floating "source not on this computer" note: a project refreshed through the GitHub REMOTE arm has `repo.root` null by design, so `computeFreshness` read every repo document `unreachable` even on a machine holding the real checkout — a false reading, not a logic bug. Now `repo.root` null with a remote set reads "GitHub · not checked" with a "Refresh from GitHub" button; a recorded root that's actually missing keeps "source not here," now a button (previously hidden) whose press explains itself via the toast. The ⓘ blink's root cause: Context re-renders an open ⓘ panel as a new element on every auto-refresh (the age ticker, window focus), and the fade-in was bound to every panel, replaying it each time — now the fade plays only on the opening click, fixing Domains, Settings and Chat too; Ingest's refresh no longer closes an open ⓘ. A time bomb defused: `test-next-memory-view.js` had pinned the brief's age words to a fixed fixture date and would have gone red on its own on 2026-09-24 — the fixture is now relative to the clock. Docs: CONTRIBUTING.md and docs/README.md now name the release index, the cap of 3 and the archive step; suite count 259. **PROCESS.** Builder: UI package Opus 5.5 (12 mutations, all red, restored by copy + shasum); diagnosis and docs Sonnet; this row Sonnet. Orchestrator hand mutations — `TOAST_MS` 30000→8000 (red 2, `test-toast`) and the memory-view fixture 8→20 days (red 1) — both restored by copy, shasum-verified. Screen review on an isolated copy of the projects domain confirmed toast wording, the 30 s self-close, "GitHub · not checked," and a stable-opacity ⓘ across a re-render. **KNOWN AND UNFIXED.** Four failure messages still vanish on a timer (worst: the Shared Brain wizard's one-time "Copy blocked" on an admin token); the Domains banner and Sync results weren't migrated to the toast because they share a line with destructive text; a manual Refresh still closes an open ⓘ (an automatic refresh no longer does); the agent-instructions block's first paragraph still names `get_working_state` scope "latest" where its second names `get_project_context` — unreconciled, since the first paragraph is sha-pinned. User-guide sentences deferred to the docs sync after v3.68.0. **VERIFICATION: 237 offline suites, 237 passed / 0 failed; 259 total (237 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL).** |
| `v3.67.1` | **v3.67.0 reached `main` and got tagged although its own release-branch CI had failed — the release chain printed the run's conclusion but never gated on it.** The one red suite was `test-reading-budget.js` §1, a byte-identity digest of `getProjectContext` for an untouched project: `biDigest` replaces the machine name inside the handoff TEXT with `<machine>`, but `current.bytes` still counts the real hostname's length, so a CI runner's 13-character hostname moved the digest at an identical total length (330198 bytes) — proven environment-only, not a product regression: the already-released v3.66.0 (`1568d2a`), run under a runner-style hostname, reproduces CI's own digest (`b916d0f5…`) exactly, v3.66.0 and v3.67.0 outputs are byte-identical under the same hostname, and readdir order, timezone, locale and `TMPDIR` all leave it unmoved. **Fix (test only):** the suite now pins `os.hostname()` before the store loads; the baseline is re-derived against `1568d2a` (`de81b987…`), passes under four different hostnames, and a same-length mutation of the untouched default still reds. No product code changed. **The standing rule, going forward:** the release chain's ff/push/tag step runs only when `gh run view <id> --json conclusion --jq .conclusion` prints `success` — a printed conclusion is no longer enough on its own. **PROCESS.** One builder (Opus 5.5), no merge — `v3671/fix` fixes the suite in place on top of the already-tagged `main`; this row by Sonnet. **VERIFICATION: 236 offline suites, 236 passed / 0 failed; 258 total (236 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL).** |

- **Version:** 3.67.2
