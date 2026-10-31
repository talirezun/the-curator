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
- A summary lists entities under "Entities Mentioned" and concepts under "Concepts Introduced or Referenced" — the page's FOLDER decides, `injectSummaryBacklinks` and the `missingBacklinks` scan read BOTH, and `writePage` dedups again AFTER its link rewrites. Health's `summaryLinkSections` is a safe, deterministic, free fix behind a hard guard (`summaryTidyGuard`: never writes unless the link-target set and every line outside the two sections are unchanged); Health's link rewriters go through `dedupRewrittenBullets`.

### Ingest → [decisions-knowledge.md#ingest](docs/dev/decisions-knowledge.md#ingest)
- The batch prompt's stable prefix must be byte-identical across batches, or caching silently costs more.
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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **222 rows**, back
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
| `v3.86.0` | **One-click install of the My Curator MCP into Claude Desktop on Windows, labelled "New on Windows — tell us if it works" — written only to a file the app can show is the live one.** **Why.** The owner asked for Windows ahead of the vendor-CLI tools (Claude Code, Codex, Gemini CLI, Copilot CLI, Cline), and decided to ship before a real-PC test: they test live on Windows. **The key research finding (Opus 5.5, `windows-claude-desktop.md`).** The documented `%APPDATA%\Claude\claude_desktop_config.json` is often NOT the file current Claude Desktop builds read (MSIX package / Claude-Data relocation). There are 7 candidate files. **What.** The app writes ONLY a single LIVE, verified candidate — live means the file exists and its folder has no `.user-data-left.*` marker and no `~copying.*`. It creates `%APPDATA%\Claude\…` only on a confirmed legacy .exe install with no MSIX. Otherwise the row is manual (copy-only) with the reason `config_not_found` / `config_ambiguous` (names the live candidates) / `config_unverified` / `config_unconfirmed` / `config_moving` / `appdata_unknown` / `outside_home`. **Writes.** Refused with `app_running` while Claude Desktop runs (Windows only; macOS stays warn-and-allow); the rename retries on EPERM/EACCES/EBUSY (7 attempts, about 2.75 s) with a CAS re-check before each attempt; `read_only` and `file_locked` refusals (the latter mentions a leftover `.tmp`); a BOM and CRLF are kept byte-exact on every platform (a macOS change: a BOM file used to be refused as corrupt); home containment is case-insensitive; a drive-root home is refused. **Detection.** PowerShell by absolute path (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, never a bare `powershell`): `Get-AppxPackage` for MSIX; `Get-CimInstance` `ExecutablePath` for running, matched on the install path so the Claude Code CLI never counts as Claude Desktop. A probe failure gives `checked:false` and is never read as "absent" or as a create. No probe runs under `CURATOR_TEST_INSTALL_HOME`. **No `env` in the entry:** nothing reads APPDATA / LOCALAPPDATA / USERPROFILE, and the domains folder comes from `--domains-path`. **UI.** On win32 only Claude Desktop is installable; other tools are copy-only; Linux is unchanged. Reveal is now macOS-only (it was a dead button on Linux and Windows). Windows paths wrap after `\`. The restart line reads "Quit Claude Desktop fully (system tray → Quit), reopen it, then press Check again". **CI.** A new `windows` job ("Windows installer tests", windows-latest) runs `scripts/test-mcp-install-windows.js` (264 assertions) on a real Windows file system; it gates the release (`release.js` gates every non-advisory job), and its first runs on the pushed integration branch were green. **Process.** Research by Opus 5.5; backend by Opus 5.5 with mutations red (marker ignored, retry without CAS, BOM dropped, unverified candidate writable, no-spawn guard off, `app_running` off, bare `powershell`); UI by Sonnet; the orchestrator fixed `config_ambiguous` to read the backend's row candidates (test + mutation red). **Security.** A Fable audit found no wrong-file write, no data loss, no gate hole and no crash; its seven findings were fixed: `app_running`, the absolute PowerShell path, truthful refusal text, `appdata_unknown` shown, an unlistable Claude-Data folder → manual, a drive-root home refused, and a leftover `.tmp` mentioned in `file_locked`. **Docs** by Sonnet: user guide, MCP guide, API reference, README, decisions-app, llm-docs user guide. **KNOWN AND UNFIXED (the owner's live test on Windows settles these).** Which candidate each install channel reads; whether the app keeps an externally added entry across quit, relaunch and update; how often candidates #1 and #4 both exist, which would make MSIX users `config_ambiguous`; whether spawning `C:\Program Files\nodejs\node.exe` without `env` works; whether PowerShell's `ExecutablePath` is readable without admin; Defender timing against the 2.75 s retry window; whether Claude tolerates a BOM; 8.3 short-name homes are refused as `outside_home`. Other tools on Windows, and everything on Linux, stay copy-only. Claude Code, Codex, Gemini CLI, Copilot CLI and Cline via their vendor CLIs are next. **VERIFICATION: 291 offline suites, 291 passed / 0 failed** — the orchestrator re-checks. |
| `v3.85.0` | **One-click install of the My Curator MCP into your tools (macOS) — a status check first, then "Install for me" with a preview, a backup and one-click Remove / Restore; the MCP wizard is retired.** **Why.** The maintainer, 2026-10-31: the biggest blocker to adoption is that users do not know how to add a JSON entry to a tool's MCP config. **The decision this reverses, narrowed and recorded (`docs/dev/decisions-app.md` § Security).** "The app never writes another tool's config" becomes: the app writes another tool's config ONLY to add / update / remove its OWN `my-curator` entry, only in a verified user-level file (adapter `installer: 'file'` — Claude Desktop, Cursor, Antigravity in this release), only on an explicit click after a preview of the exact entry, always with a backup of the original bytes and a structural check that nothing else changed; never instruction files, skills, hooks, project files or another key; the Setup check stays read-only. (The app already wrote one foreign file — Claude Desktop's, via the v3.30.0 wizard route `POST /api/mcp/write-config` — which stays for API compatibility but no screen calls it any more.) **What users see (Settings › MCP bridge › 5 "Tools on this Mac").** An overview "My Curator in your tools — N connected · N need an update · N can be added", then one two-line row per tool found on this Mac: **connected** (optionally "used <age>" from the content-free usage log — a label only, never a decision) · **needs an update** (missing launcher, other knowledge folder, repo-mode entry on an app install, wrong shape, or absent from one of Antigravity's files) · **can be added** · **can't read** (corrupt, comments/JSONC, symlink, duplicate keys, numbers beyond 2^53 — reason shown in words, Reveal + Copy) · **copy-only** (every tool not yet install-capable, with "Paste into <file> inside "mcpServers"" or "Save as <file>"). Needs-update and can-be-added rows are ticked; connected rows are never rewritten. **Install for me** → "Plan ready — nothing written yet" (per file: the exact entry text, the NAMES of the other servers that stay unchanged — never their values — and the dated backup copy) → Apply → one always-visible result line per file with restart guidance ("quit and reopen Cursor") → Check again. **Remove** deletes only our key; **Restore original** puts back the exact earlier bytes only while the file is unchanged since our write (otherwise refused, "Remove the entry instead"), keeping a new copy of the current file first. Block 1 "Connect a client" is now a compact status card with **Install in your tools** (scrolls to block 5, focusing Claude Desktop when it is not connected) and **Run self-test**; the MCP wizard (`views/mcp-wizard.js`, its CSS and suite) is deleted, and Re-connect / View config / Copy snippet are gone. Context › Setup bridge to-fix lines for the three tools gain "Install for me". **How it is built.** `src/brain/mcp-install.js` (pure planner + executor with injected IO), `src/brain/harness-detect.js` (installed: an app bundle, a vendor CLI on the login-shell PATH, or an existing user config file — never a bare shared folder like `~/.gemini`; running: one `ps -axo pid=,comm=` matched on `/<App>.app/Contents/MacOS/`, `checked:false` never read as "not running"), `src/routes/mcp-install.js` (`GET /api/mcp/install/status`, `POST /plan`, `POST /apply`). The entry comes ONLY from `buildCuratorEntry` (the launch line) shaped by `mcpEntryFor`; Claude Desktop, Cursor and Antigravity always carry `args` (`[]` in launcher mode — the shape `write-config` has written for months). Write order per file: re-read + CAS on the plan's sha256 → structural re-check → backup first, exclusive, `<file>.curator-backup-<UTC>` 0600 (a same-second second backup gets `-2`, never overwrites) → re-read + CAS → atomic replace keeping the file's mode (new files 0600) → manifest row in `<user data>/.mcp-installs.json` (0600, newest 200, gitignored). Antigravity: the documented `~/.gemini/config/mcp_config.json` always, the two observed files only when they exist; project files never. **Security.** The three POSTs require a same-origin `Origin` header (a MISSING Origin is refused here, unlike the global guard), a single-use plan token (10 min), an allow-listed body (ids only — no path, entry or command from the client); the server re-plans from disk on apply; one apply in flight; non-macOS → 409 `platform_unsupported`. Tests resolve every target against `CURATOR_TEST_INSTALL_HOME`, and the module FAILS CLOSED (no home at all) under `CURATOR_TEST_USER_DATA_DIR` without one; every install suite fingerprints the real user's three config files before and after. **Verification (orchestrator double-test, at the owner's request).** (1) `npm test` 290/290. (2) Mutations red, restored by copy + shasum: builders — backup ordering, structural check, Origin requirement, CAS (both checks), the route's apply-time basis, the restore `backupWillBe`, Cursor `alwaysArgs`; orchestrator — backup skipped (write + routes red), home fail-closed removed (plan red). (3) LIVE_LOCAL: chat-composer-pills and desktop-update-macos pass; visual-regression, info-panel-reachability and checkbox-visual fail IDENTICALLY on origin/main 25aa1a1 (diffed, same assertions and the same two visual regressions) — pre-existing. (4) Screen review on an isolated copy (demo workspace, fake HOME) at 1280 / 1100 / 375 px — two rounds found and fixed: names and paths breaking mid-word at 1100 px (→ two-line rows wrapping at "/"), a footer still saying "Nothing here writes a file", a second vocabulary in the same block (→ "Each tool in detail" heading), the restore preview naming the source backup as the new copy (backend), the raw placeholder "<UTC time of apply>", "NEEDS RE-CONNECT", "not connected" vs "can be added". (5) The Mac app built from the integration branch (arm64 + x64 DMGs, Electron 43.8.3) and launched from its own binary with every isolation variable: `launcher-script` entry written, other servers and preferences kept, backup 0600, the launcher answers `initialize` as my-curator, missing/foreign Origin 403; the real config files byte-identical before and after. (6) Real end to end on the maintainer's Mac (with consent): the new code installed into all three REAL Antigravity files (other servers kept — agentlink, firebase, mv-travel, github; modes 0600/0644 kept; backups first), the exact command written there was launched as Antigravity launches it and `list_domains` answered from the entry's knowledge folder, then **Restore original** put all three files back byte-identical (content, mode, size), and the test's backup files were removed. (7) CI runs at release. (8) Docs: user guide §13 ("Connecting your tools: Install for me" with status and write/undo tables), §13d/§13e, MCP user guide, API reference (install routes, refusal codes, legacy routes marked), decisions-app (the narrowed rule), decisions-agents, architecture, directory map, README, mac-app, product overview, llm-docs (user guide, overview, agent-memory read-only claim) — test-docs-links 192/192, test-public-knowledge green. **KNOWN AND UNFIXED.** macOS only: Linux and Windows show copy-only until per-OS paths are verified there (planned). Claude Code, Codex, Gemini CLI, Copilot CLI and Cline install through their own `mcp add` commands in a later release (v3.86.0); goose, opencode, Kilo, Windsurf/Devin, DeepSeek Harness and Zed stay copy-only. A vendor rewriting its own file in the milliseconds between our last re-read and the rename can still lose that edit (Claude Desktop rewrites its file itself; the backup covers it). A rewrite re-lays out a JSON file (values identical; indent, line endings and trailing newline kept; compact inline objects expanded) — the original bytes are in the backup. "used <age>" depends on the client's self-reported name (label only). `llm-docs/curator-agent-memory.md` is at 100% of its budget. The bridge screenshots in the user guide predate this release (captioned so). The real-tool check launched the written command directly; the maintainer will repeat it inside Antigravity itself. **VERIFICATION: 290 offline suites, 290 passed / 0 failed** — the orchestrator re-checks. |
| `v3.84.1` | **The per-harness MCP registry corrected against each vendor's own source — the groundwork for a one-click MCP installer, and a fix for goose's copy-paste entry, which goose could not load.** **Why.** The maintainer approved (2026-10-31) a plan for an app-side installer that writes the `my-curator` entry into each tool's MCP config (v3.85.0+). That installer will trust `src/brain/harness-adapters.js` as its write authority, so every row was re-checked first. A read-only Opus 5.5 pass checked 13 claims against vendor source at pinned tags or official docs (goose v1.57.0, codex rust-v0.166.0, gemini-cli v0.66.0, cline v4.1.26, opencode v1.19.5, kilocode v7.8.18, zed v1.26.2, deepseek-harness @ce7073d, github/docs, antigravity.google, docs.devin.ai, code.claude.com): 11 confirmed, 2 partial. The orchestrator re-read the two most consequential (goose `cmd`, Codex `env`) in the source itself. **Fixes (Sonnet builder).** **goose**: `mcpEntryFor` emitted `command:` and no `name`/`enabled`; goose's `ExtensionConfig::Stdio` accepts only `cmd`, and `args` and `enabled` are required, so the snippet users copied was BROKEN. It now emits `{enabled: true, type: stdio, name, cmd, args (always, [] when empty), timeout: 300, envs: {}}` via a new `cmd+args` argv shape. **Copilot CLI**: the entry now carries the required `tools: ["*"]` and always `args`. **Codex**: `envKey` `env_vars` → `env` (`env_vars` is a pass-through list of names); the comment calling `startup_timeout_ms` a silent mis-write was wrong (it is still accepted as a fallback). The rendered TOML and `addCommand` are byte-identical. **Paths**: Cline's `~/.cline/mcp.json` removed (refuted; only a plugin-root file has that name; the legacy VS Code globalStorage file is noted, never a target); Antigravity gains the documented project file `.agents/mcp_config.json`; opencode gains `~/.config/opencode/config.json` (it merges config.json → opencode.json → opencode.jsonc); Kilo moves from unverified/no paths to docs with `~/.config/kilo/kilo.json(c)` and project `kilo.json` / `.kilo/kilo.json`; Windsurf/Devin reads `~/.config/devin/config.json` and `mcp_config.json` beside the legacy codeium file (the vendor's own pages disagree, so it stays manual); Claude Desktop's `~/.config/Claude/…` is commented as the Linux path (read, never a macOS write target). **Notes**: dsh scrubs only INHERITED credential-shaped/`DSH_*` variables — an explicit `env` reaches the child (the "argv only" note and the `CURATOR_MCP_VIA` comment were wrong); Gemini CLI's settings are JSONC, with its system file named in the note. **New DATA-ONLY fields** (nothing renders or runs them yet): `installer: 'file' \| 'cli' \| 'manual'` on every row (file: Claude Desktop, Cursor, Antigravity; cli: Claude Code, Codex, Gemini CLI, Copilot CLI, Cline; manual: the rest), `cli: {add, remove, scopeFlag?}` on the five cli rows, `verifiedOn: '2026-10-31'` only on the 12 rows re-checked that day (never invented), and `jsonc: true` (Gemini CLI, opencode, Kilo, Zed) — a future writer must not re-serialise such a file. `format` stays `'json'` so Setup keeps reading them. **A regression caught before it shipped (builder).** Adding Antigravity's project file would have turned a working setup red ("not in 1 of 4 files") whenever a workspace's own `.agents/mcp_config.json` named only other servers; `setup-check.js` now holds only USER files to "every file has the entry". **Docs**: user guide §13d's MCP table corrected (Antigravity project file, opencode's three files, dsh env). **Evidence.** Setup check run read-only on the maintainer's real files before and after: every existing tool's status word unchanged; the only differences are the added/removed paths above (all absent on this Mac) and a new Kilo row ("no config file found"). **Mutations: 5/5 red** for the named behavioural reason (goose back to `command`; Copilot `tools` removed; Cline `mcp.json` re-added; Codex `envKey` back to `env_vars`, alone; the Antigravity project-file exemption removed), each restored by copy and shasum-verified. **KNOWN AND UNFIXED.** Nothing writes any tool's config in this release; the installer (v3.85.0) and vendor-CLI installs (v3.86.0) are planned, macOS first, Linux/Windows per tool once each path is verified there (the table is still macOS-shaped and never exercised on Windows). Windsurf/Devin's real location is unmeasured. goose's config stays opaque to Setup (no YAML parser), so a user who pasted the old broken goose entry is not told — re-copying the entry fixes it. Gemini CLI's `mcp add` needs `--` before server arguments that start with `-` (our repo-mode `--domains-path`); not exercised, since nothing runs it yet. **VERIFICATION: 286 offline suites, 286 passed / 0 failed** — the orchestrator re-checks. |

- **Version:** 3.86.0
