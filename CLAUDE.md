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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **227 rows**, back
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
| `v3.89.0` | **Settings › MCP bridge rebuilt from the Domain page's own components, and made fully functional: overview, four sections, one card each, Install for me end to end, and a new Check entry that launches the exact command from an app's config file.** **Why.** The maintainer, 2026-11-01, on v3.88.0: "not the look of a mature app… vibe coded… not in sync with our system design". The Domain page is the reference. The maintainer stressed function: Install for me is "very very key, because nobody knows how to add a JSON block to an MCP config". **Design (Opus 5.5, read-only).** An app-wide survey (APP-SURVEY.md backlog), an element → component mapping for every element, a 12-rule page contract, and an acceptance picture rendered from the app's real CSS and renderers beside the Domain page at the same scale. The maintainer approved direction A, with green/amber overview figures and Default domain inside ② Bridge; the Domain page's own inconsistencies are deferred. **Step 1: the section kit (Opus).** The Domain page's building blocks were promoted to `shared/section.js` (DOM-free: renderSectionHead/Title, renderCard, renderControlRow, renderFoldRows/Row/Item, actionChip, renderActionCard, renderStatusLine) and `shared/section.css`, with `alias:'dm'|'sb'` keeping the old classes. The Domain page and Shared Brain use them. Pixel diff of 8 shots (1280/375 × dark/light × folds closed/open): 7 at 0 px, 1 with 24 px in one 6 px dot, which varies the same between two baseline runs (re-checked by the orchestrator). The guard: `scripts/test-helpers/page-contract.js` (a per-page class allow/forbid list; structure: every button inside a card, footnotes only as a card's last line, every details a cur-fold, no monitor head, no inline style) with `scripts/test-next-page-contract.js`, now ENFORCED on the MCP page. **Step 2: the page (Opus).** OVERVIEW (connected · to fix · tools answer · saves · last save, each jumping to its section). ① Agent apps: Check again; a tinted Next step / Connect card (Install for me: the plan with the exact entry, the other servers kept and the dated backup → Apply → one result line per file with restart guidance); one closed fold row per app (a health line "<App> last started it…" / "hasn't started My Curator since the entry was written", **Check entry**, one line per file with its state + Copy entry / Reveal, skills/hooks, Remove / Restore original); Not on this Mac. ② Bridge: Run self-test, Test all 24 tools, Bridge answers, Default domain for writes. ③ Agent use: a monitor with the top tools, "All 24 tools" closed. ④ Across projects. All `.mcpi-*`/`.mcp-*` CSS removed. **Check entry** (`src/brain/mcp-check-entry.js`, `POST /api/mcp/install/check-entry`): the install routes' gates (Origin required, body exactly `{id}` from INSTALL_IDS, one at a time, macOS/Windows). The command is read from the file the server resolves, and ONLY two shapes run: (a) this app's own launcher by realpath, with no args; (b) an absolute node/node.exe (basename AND realpath basename) whose args[0] is THIS install's `mcp/server.js`, plus only `--domains-path <abs>`. `node -e`/`--require`/`--inspect`, a renamed or symlinked shell, another server.js, a bare command and missing files are refused in words without running. The entry's env is never passed (an allow-listed env + CURATOR_MCP_VIA=self-test); execFile, shell:false, 8 s timeout, 2 MB / 16 KB caps, the child killed after. **E2E.** `scripts/e2e-mcp-bridge.mjs` (LIVE_LOCAL), 33/33 in a real browser on an isolated demo workspace and fake home: Install for me → preview → Apply → on-disk entry + other server + backup → Check again connected → Check entry "starts · 24 tools" → Remove (byte-identical) → install → Restore original (byte-identical) → Restore refused after a change → Copy entry payload → Run self-test → Test all 24 (24/24) → one row per file → no horizontal overflow. The real config files were fingerprinted; Claude Desktop rewrote its own file mid-run (same size, no `.curator-backup` sibling, all five servers and the my-curator entry intact, re-checked by the orchestrator). **Mutations.** Page contract 6, Check entry 4, the kit and guard 10, all red. **Orchestrator screen review** found duplicate per-file rows and a two-line mono footnote; both fixed. **Docs.** decisions-app (Security: the Check entry rule; Product shape), api-reference, user guide, MCP user guide, README, product overview, llm-docs user guide. **KNOWN AND UNFIXED.** Check entry and the health line are macOS/Windows only; Linux rows stay copy-only. The light-theme overview figures measure 4.05 and 3.58 contrast (large text). The Domain page's own inconsistencies (right meta on only ① and ④, two card styles) are deferred, as are APP-SURVEY.md's per-view items. The user-guide bridge screenshots predate it. **VERIFICATION: 299 offline suites, 299 passed / 0 failed**; e2e 33/33; CI at release. |
| `v3.88.1` | **An MCP entry whose launch files are gone now reads "needs an update" with the reason in words, never "connected"; Windows CI starts the bridge the way Claude Desktop does.** **Why.** The maintainer's Windows PC, 2026-11-01: after updating, Claude Desktop said My Curator could not start, and the app offered no fix; removing the entry by hand and running Install for me again fixed it. **Root cause (measured).** It was NOT v3.88.0. A temporary CI job installed v3.87.1 on windows-latest through install.ps1, started the bridge exactly as Claude Desktop does (the runtime node.exe, an absolute server.js, cwd System32, the MCP SDK stdio client), ran the real in-app update to v3.88.0 while a client held a bridge open, then started it again: CONNECTED, 24 tools, with no stderr, both times. The maintainer's entry had been written by v3.86.0 from a manual install, so it named the SYSTEM node.exe and the old checkout; both were later uninstalled for the v3.87.0 test (a read-only report by Claude Code on that PC: the backups and the manifest postdate the removal, and Claude Desktop wrote no my-curator log). Two defects let it go unreported: `setup-check.js` judged a missing command only if it began with `/` (a Windows path never counted) and never checked the server.js argument; the install status judged the entry by its text alone, and the row carried no reason. **Fix.** `missingLaunchFiles()` (setup-check.js) checks the absolute command and the `mcp/server.js` argument with either slash; a bare `node` is never judged. An entry with a missing launch file is never a match in `mcp-install.js`. The row reason `launch_file_missing` reads "Its entry points at C:\…\node.exe, which is no longer on this PC.", ticked for Install for me, on every platform. **CI.** "Windows one-line install" gains a permanent step, "MCP bridge starts as Claude Desktop starts it" (initialize answered by my-curator; tools/list 24). PowerShell 5.1 prepends a BOM to a child's stdin, so the step runs under PowerShell 7 and writes raw UTF-8. **Tests.** The maintainer's case runs through the real route in `test-mcp-install-windows.js` §4; `test-setup-check.js` gains §12; 3 mutations red. **KNOWN AND UNFIXED.** "Connected" still means the entry matches, not that the app has started it; a per-row "Claude Desktop last started it <age>" and a Check entry action that launches the config's own command are proposed for v3.89.0. In repo mode the manifest `.mcp-installs.json` lives in the checkout, so deleting the checkout loses the install record (proposed: %LOCALAPPDATA%\TheCurator). **VERIFICATION: 296 offline suites, 296 passed / 0 failed**; CI run 41321816459 green, including both Windows jobs. |
| `v3.87.1` | **"Use existing folder" works on Windows: a native folder dialog, plus a paste-a-path fallback on every picker failure.** **Why.** The maintainer's real-PC test of v3.87.0, 2026-11-01. The installer worked flawlessly, but Domains › Use existing folder showed a red "This build cannot open a folder picker" card, so an existing knowledge folder could not be used. Root cause: v3.87.0 made `pick-folder`/`pick-path` return 501 on win32 (osascript, the repo-mode picker, never worked there), and no screen offered a typed path; the refusal pointed at a Settings field that does not exist. The earlier fix the maintainer remembered (`b80e5e9`) covered macOS only: Electron's dialog in the Mac app, osascript for repo installs. **What.** (1) `src/brain/win-folder-dialog.js`: `FolderBrowserDialog` via powershell.exe by ABSOLUTE path, `-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -EncodedCommand`, execFile with no shell. The script is a fixed constant and the prompt goes via env. The owner is a TopMost 1×1 transparent form, so the dialog comes above the browser even though the server is hidden. The reply is UTF-8 base64 (non-ASCII names survive). A 10-minute timeout kills the process and is read as a cancel. A picked folder goes through the same `accept()` as on macOS. (2) The typed-path fallback, "Paste the folder's full path" + **Use this folder**, appears on Domains and in Settings › Knowledge base on every picker refusal or failure. Settings no longer replaces the whole block with the error (a change on macOS too, but only when the picker fails). (3) `POST /api/config/domains-path` now validates through `src/brain/knowledge-folder-path.js`: one pair of quotes stripped (Explorer's Copy as path); absolute, with a drive letter or UNC on Windows; `..` resolved first; it exists, is a folder and can be listed; and it is not inside the app checkout (symlinks followed), except the checkout's own `domains/`. **Tests.** New offline suite `test-win-folder-picker.js` (93 assertions); 17 mutations red (no -STA, a bare powershell.exe, shell:true, no timeout, latin1 decoding, no TopMost, each validator check, the win32 arm skipping accept(), the route unvalidated, the dialog not wired, no typed field, Settings replacing the block). Docs: user guide, API reference, architecture, directory map, llm-docs user guide. **KNOWN AND UNFIXED.** Not yet run on a real Windows PC. It is unknown whether the dialog takes keyboard focus or only flashes the taskbar, whether FolderBrowserDialog loads under -NonInteractive from the hidden server, and whether antivirus flags -EncodedCommand; the typed field is the safety net for all three. FolderBrowserDialog is the older tree view, with no box to paste a path into. Not screen-reviewed at 1100/375 px. **VERIFICATION: 294 offline suites, 294 passed / 0 failed**; CI at release. |

- **Version:** 3.89.0
