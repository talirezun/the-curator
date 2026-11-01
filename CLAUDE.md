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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **224 rows**, back
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
| `v3.87.1` | **"Use existing folder" works on Windows: a native folder dialog, plus a paste-a-path fallback on every picker failure.** **Why.** The maintainer's real-PC test of v3.87.0, 2026-11-01. The installer worked flawlessly, but Domains › Use existing folder showed a red "This build cannot open a folder picker" card, so an existing knowledge folder could not be used. Root cause: v3.87.0 made `pick-folder`/`pick-path` return 501 on win32 (osascript, the repo-mode picker, never worked there), and no screen offered a typed path; the refusal pointed at a Settings field that does not exist. The earlier fix the maintainer remembered (`b80e5e9`) covered macOS only: Electron's dialog in the Mac app, osascript for repo installs. **What.** (1) `src/brain/win-folder-dialog.js`: `FolderBrowserDialog` via powershell.exe by ABSOLUTE path, `-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -EncodedCommand`, execFile with no shell. The script is a fixed constant and the prompt goes via env. The owner is a TopMost 1×1 transparent form, so the dialog comes above the browser even though the server is hidden. The reply is UTF-8 base64 (non-ASCII names survive). A 10-minute timeout kills the process and is read as a cancel. A picked folder goes through the same `accept()` as on macOS. (2) The typed-path fallback, "Paste the folder's full path" + **Use this folder**, appears on Domains and in Settings › Knowledge base on every picker refusal or failure. Settings no longer replaces the whole block with the error (a change on macOS too, but only when the picker fails). (3) `POST /api/config/domains-path` now validates through `src/brain/knowledge-folder-path.js`: one pair of quotes stripped (Explorer's Copy as path); absolute, with a drive letter or UNC on Windows; `..` resolved first; it exists, is a folder and can be listed; and it is not inside the app checkout (symlinks followed), except the checkout's own `domains/`. **Tests.** New offline suite `test-win-folder-picker.js` (93 assertions); 17 mutations red (no -STA, a bare powershell.exe, shell:true, no timeout, latin1 decoding, no TopMost, each validator check, the win32 arm skipping accept(), the route unvalidated, the dialog not wired, no typed field, Settings replacing the block). Docs: user guide, API reference, architecture, directory map, llm-docs user guide. **KNOWN AND UNFIXED.** Not yet run on a real Windows PC. It is unknown whether the dialog takes keyboard focus or only flashes the taskbar, whether FolderBrowserDialog loads under -NonInteractive from the hidden server, and whether antivirus flags -EncodedCommand; the typed field is the safety net for all three. FolderBrowserDialog is the older tree view, with no box to paste a path into. Not screen-reviewed at 1100/375 px. **VERIFICATION: 294 offline suites, 294 passed / 0 failed**; CI at release. |
| `v3.87.0` | **Install The Curator on Windows with one line, with no administrator rights, plus two desktop icons: "The Curator" (starts it and opens it) and "Stop The Curator".** **Why.** The maintainer, 2026-11-01: most users are on Windows, and a manual Windows install took over two hours even with a coding agent, mostly because of the admin prompts while installing git and Node. Students install it next week. A Windows `.exe` (Electron) was evaluated: it needs a win32 arm in `paths.js`, a Windows MCP launcher, a Windows updater and ideally signing, so it is about 2–3 weeks of work and stays the longer-term plan. **What users do.** Open Windows PowerShell and paste `irm https://raw.githubusercontent.com/talirezun/the-curator/main/install.ps1 \| iex`. **`install.ps1`.** It runs seven steps in plain words. (1) Preflight: Windows 10 1809+ / 11, 64-bit, about 500 MB free, Constrained Language Mode and company script policy named in words, and a different signed-in account refused. (2) and (3) A PRIVATE per-user runtime in `%LOCALAPPDATA%\TheCurator\runtime`: Node v24.22.2 LTS and MinGit 2.56.0.4, pinned, with each zip SHA-256-verified before use on every path, including a reused cached download and the curl fallback. Each is unpacked to `.new`, tested with `--version`, then swapped in. Nothing touches the system PATH or HKLM. (4) The checkout `%USERPROFILE%\the-curator`, cloned with `core.autocrlf=false`. On a re-run: a clean checkout fast-forwards; only deleted files or an npm-rewritten package-lock are restored; real edits are left alone with a notice; a folder that is not ours is refused. (5) `node.exe npm-cli.js ci`, never a bare `npm`. (6) Four shortcuts (Desktop, OneDrive-aware, and the Start-menu folder "The Curator") with new icons, `scripts/windows/assets/curator-{start,stop}.ico`: the app mark with a green play or red stop badge that grows at 16/24 px. (7) Start and open the browser. A running Curator is stopped only after both downloads are verified. Re-running the one-liner repairs and updates and never touches `domains\`, `.env` or `.curator-config.json`. Every failure prints a "copy from here" block with the step, error and log. **`scripts/windows/start-curator.ps1`** starts `node src\server.js` hidden. The paths travel as env vars in cmd.exe, so a `%` in a user name cannot be expanded. The output goes to `%LOCALAPPDATA%\TheCurator\logs\server.log` (rotated). It honours PORT, waits up to 45 s on `/api/version`, then opens the browser. It recognises port-in-use (naming the program), a port reserved by Windows, a missing node.exe and antivirus. **`stop-curator.ps1`** stops only node.exe processes whose command line holds THIS checkout's `src\server.js`, which also catches a server re-spawned by the in-app Restart. It is the Windows equivalent of quitting the Mac app; the app still has no Stop button and no `/api/shutdown`. **App fixes (Windows only; macOS proven byte-identical).** `src/brain/subprocess-env.js`: the subprocess PATH for Personal Sync and the updater was `':'`-joined with POSIX folders, which on Windows could hide git and npm. It is now `;`-joined with the node folder first and ONE path key. Also: browser open by argv (`rundll32 url.dll,FileProtocolHandler` on win32, localhost only); Restart is hidden on win32 and appends to `server.log`; the updater skips `build-app.sh` on win32 and recognises "'npm' is not recognized"; the folder pickers and the config/log reveals refuse on win32 in words; `paths.js` gives `%LOCALAPPDATA%\TheCurator` (and `\logs`) on win32 instead of a stray `~\Library`; the UI and the Setup check say "this PC" on Windows and "this computer" on Linux (unchanged on macOS: `shared/platform.js`, `setup-check.js`). **CI.** A new gating job, "Windows one-line install" (windows-latest), runs as follows. It parses all four scripts on PS 5.1 and 7. It installs under 5.1 into `Curator User Žiga\the curator %TEMP% x`, with LOCALAPPDATA redirected. It checks the four shortcuts' targets and icons. It runs start, `/api/version`, a second start (no second server), stop and port free, with an unrelated node process surviving, plus the port-in-use refusal. A PS 7 repair run restores a deleted node.exe, shortcut and `server.js`, and keeps a planted wiki page, `.env` and `.curator-config.json` byte-identical. **Process.** Research and evaluation by Opus 5.5 and Sonnet. The backend by Opus 5.5: 22 mutations, all red. The installer by Opus 5.5: static suite `test-windows-installer-static.js` (83 checks). The icons by Sonnet. The docs by Sonnet, including the new one-page `docs/install-windows.md` handout. A Fable audit found no supply-chain, data-loss, privilege, PS 5.1 or macOS problem; its findings were fixed (MEDIUM: cmd `%VAR%` expansion in the start line; LOW: stop only after verified downloads, the iex session tidied, fork wording, Restart logging). The first CI run caught a real bug: PowerShell variables are case-insensitive, so `$installDir = $null` wiped `-InstallDir`; it is now guarded statically. **Docs.** The README (an "On Windows?" line at the top, plus a section), the user guide §3 Windows (steps, what you will see, the icons, updating, data location, the security-messages and troubleshooting tables, uninstall), §20, the handout, llm-docs (user guide, overview, links), and decisions-app, operations and directory-map. **KNOWN AND UNFIXED.** Not yet run on a real PC by a non-technical user; the maintainer's test follows this release. There is no Windows `.exe`, no tray icon and no uninstall shortcut (the docs give the manual steps). Stop ends an in-progress ingest (the queue recovers paused). A corporate proxy that needs a sign-in, native ARM PCs, Smart App Control and Controlled Folder Access on the Desktop are unmeasured. Linux is unchanged (manual), and macOS behaviour is unchanged. **VERIFICATION: 293 offline suites, 293 passed / 0 failed**, CI green including both Windows jobs. |
| `v3.86.0` | **One-click install of the My Curator MCP into Claude Desktop on Windows, labelled "New on Windows — tell us if it works" — written only to a file the app can show is the live one.** **Why.** The owner asked for Windows ahead of the vendor-CLI tools (Claude Code, Codex, Gemini CLI, Copilot CLI, Cline), and decided to ship before a real-PC test: they test live on Windows. **The key research finding (Opus 5.5, `windows-claude-desktop.md`).** The documented `%APPDATA%\Claude\claude_desktop_config.json` is often NOT the file current Claude Desktop builds read (MSIX package / Claude-Data relocation). There are 7 candidate files. **What.** The app writes ONLY a single LIVE, verified candidate — live means the file exists and its folder has no `.user-data-left.*` marker and no `~copying.*`. It creates `%APPDATA%\Claude\…` only on a confirmed legacy .exe install with no MSIX. Otherwise the row is manual (copy-only) with the reason `config_not_found` / `config_ambiguous` (names the live candidates) / `config_unverified` / `config_unconfirmed` / `config_moving` / `appdata_unknown` / `outside_home`. **Writes.** Refused with `app_running` while Claude Desktop runs (Windows only; macOS stays warn-and-allow); the rename retries on EPERM/EACCES/EBUSY (7 attempts, about 2.75 s) with a CAS re-check before each attempt; `read_only` and `file_locked` refusals (the latter mentions a leftover `.tmp`); a BOM and CRLF are kept byte-exact on every platform (a macOS change: a BOM file used to be refused as corrupt); home containment is case-insensitive; a drive-root home is refused. **Detection.** PowerShell by absolute path (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, never a bare `powershell`): `Get-AppxPackage` for MSIX; `Get-CimInstance` `ExecutablePath` for running, matched on the install path so the Claude Code CLI never counts as Claude Desktop. A probe failure gives `checked:false` and is never read as "absent" or as a create. No probe runs under `CURATOR_TEST_INSTALL_HOME`. **No `env` in the entry:** nothing reads APPDATA / LOCALAPPDATA / USERPROFILE, and the domains folder comes from `--domains-path`. **UI.** On win32 only Claude Desktop is installable; other tools are copy-only; Linux is unchanged. Reveal is now macOS-only (it was a dead button on Linux and Windows). Windows paths wrap after `\`. The restart line reads "Quit Claude Desktop fully (system tray → Quit), reopen it, then press Check again". **CI.** A new `windows` job ("Windows installer tests", windows-latest) runs `scripts/test-mcp-install-windows.js` (264 assertions) on a real Windows file system; it gates the release (`release.js` gates every non-advisory job), and its first runs on the pushed integration branch were green. **Process.** Research by Opus 5.5; backend by Opus 5.5 with mutations red (marker ignored, retry without CAS, BOM dropped, unverified candidate writable, no-spawn guard off, `app_running` off, bare `powershell`); UI by Sonnet; the orchestrator fixed `config_ambiguous` to read the backend's row candidates (test + mutation red). **Security.** A Fable audit found no wrong-file write, no data loss, no gate hole and no crash; its seven findings were fixed: `app_running`, the absolute PowerShell path, truthful refusal text, `appdata_unknown` shown, an unlistable Claude-Data folder → manual, a drive-root home refused, and a leftover `.tmp` mentioned in `file_locked`. **Docs** by Sonnet: user guide, MCP guide, API reference, README, decisions-app, llm-docs user guide. **KNOWN AND UNFIXED (the owner's live test on Windows settles these).** Which candidate each install channel reads; whether the app keeps an externally added entry across quit, relaunch and update; how often candidates #1 and #4 both exist, which would make MSIX users `config_ambiguous`; whether spawning `C:\Program Files\nodejs\node.exe` without `env` works; whether PowerShell's `ExecutablePath` is readable without admin; Defender timing against the 2.75 s retry window; whether Claude tolerates a BOM; 8.3 short-name homes are refused as `outside_home`. Other tools on Windows, and everything on Linux, stay copy-only. Claude Code, Codex, Gemini CLI, Copilot CLI and Cline via their vendor CLIs are next. **VERIFICATION: 291 offline suites, 291 passed / 0 failed** — the orchestrator re-checks. |

- **Version:** 3.87.0
