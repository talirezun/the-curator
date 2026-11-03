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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **230 rows**, back
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
| `v3.90.1` | **The website assistant shows the Windows one-liner, and llm-docs describe the website's new Windows install tab (docs only; no app behaviour changes).** **Why.** The maintainer, 2026-11-03: asked "how can I install on Windows?", the assistant on mycurator.xyz (Lumina) sometimes showed the command as garbage — an empty code box swallowing the rest of the answer — and sometimes correctly. **Root cause (measured live, not in this repo).** Lumina's widget has no fenced-code support: it pairs single backticks naively, so a fence the model indents inside a numbered list comes out as ``<code>lang<br>code</code>` and every later code span is out of phase; the site's bridge then collapsed newlines inside <code>, so the page's renderer opened a fence that never closed. It varies per answer (inline code rendered fine), which is why it looked like the re-uploaded docs broke. **Fixed in the website repo** (private, deployed 2026-11-03): the bridge re-emits each <code> raw (the widget only removed delimiters, so this reconstructs the model's Markdown, fence included; ordinary inline code byte-identical), the renderer accepts indented fences, a language tag and unclosed fences and keeps list numbering after a block; an offline check of 28 assertions against the captured live reply, red under both mutations (renderer, bridge). The Install section's Windows tab now carries the one-line PowerShell installer with Copy, the Start/Stop icons and `docs/install-windows.md`; the coding-agent prompt runs the installer on Windows. Verified on the live site: three fresh answers each render one code block holding exactly the `irm … \| iex` line. **This repo.** `llm-docs/curator-site-map.md`: the Quick start row names the Windows installer tab, and the Windows link goes to `docs/install-windows.md` (Linux keeps the manual-setup anchor). `llm-docs/curator-user-guide.md`: the command also given once as inline code, a form the widget always renders. **KNOWN AND UNFIXED.** The site still depends on Lumina's widget markup; if Lumina changes how it renders, the bridge needs re-measuring. The maintainer re-uploads every llm-docs file to Lumina. **VERIFICATION: 301 offline suites, 301 passed / 0 failed**; CI at release. |
| `v3.90.0` | **Settings › MCP bridge in plain words, and a sync now keeps running when you leave the Sync page.** **Why (MCP page).** The maintainer, on v3.89.0: "totally non-understandable". A long line ran outside its card; buttons looked like plain text; skills were never called skills, repeated in every app, and nothing said they never update themselves; each app's fold listed every path, including missing ones; "Agent use" and "Across projects" meant nothing. Root cause recorded: the builders wrote the words; the review checked layout, never whether a newcomer understands. **Process change.** The orchestrator wrote a COPY DECK, every visible string on the page, and the builder implemented it word for word. A word audit extracted every visible string from the running DOM and diffed it against the deck: 125 distinct strings, 119 match, 5 are data, 1 is the shared "configuration" eyebrow; 22 cases where the deck's wording did not fit a state are listed rather than improvised. **What.** A lede ("connects your AI apps… and shows whether the connection works"). The overview: CONNECTED · NEEDS ATTENTION · TOOLS WORKING · LAST USED. ① **Your AI apps**: a Next step card only when something needs doing ("{App} isn't connected yet", "{App}'s {skill} skill is out of date", a launch-file-missing reason), with Install for me ("Already set up" when nothing is installable) and Copy the setup text; one fold row per app with ONE sentence ("Connected. {App} last used My Curator {age}.") and at most one button (Test connection); a nested Details fold listing only files that exist (or the one Install for me would create), with Remove (danger) / Restore original and automatic saves. ② **Skills**, NEW and shown once: "instruction files that teach an AI app how to use My Curator well… **They don't update on their own.**" Per skill: Download .zip, the Claude upload path (Customize → Skills, from Anthropic's help; the repo docs had none), and the per-app state with Show the folder. ③ **Connection test** (was Bridge): Test connection, Test all 24 tools, Details, Default domain for writes. ④ **Tool activity** (was Agent use): the top tools, "All 24 tools" with each tool's plain purpose line. The Handoffs/Across projects block was REMOVED, decided with the maintainer: it is project memory, which Context already shows (an across-projects overview for Context is backlog). Backend: additive only (`skills[]` on `GET /api/setup/machine`, `path` on check-entry refusals). The section kit gained renderFoldLine (wrapping text), a section lede and a sentence-case eyebrow. **Page contract, extended and proved by mutation:** every clickable element is a real button (a ghost button, a bare Download link and an action span → red); banned mechanism words in visible text ("Copy entry", a section titled "Bridge", "launcher" → red); no ALL-CAPS outside the overview (→ red); in the browser, nothing wider than its card at 1280/375 (the v3.89.0 `flex:none` → red), no CSS uppercase, no pointer on a non-button. The orchestrator's review renamed "Default project for writes" → "Default domain for writes" (it chooses a domain; the deck's own error). **Sync (Opus).** Leaving the Sync page never stopped a sync: on an isolated rig with a slow bare remote, the commit always landed. `views/sync.js` kept the run in per-mount state and dropped it on navigation, so the return showed an idle page; a click there started a SECOND sync, which failed with "Another sync check was running at the same time": the "cancelled" the maintainer saw. Fix: `src/brain/sync-job.js` (one at a time; a second start gets 409 `sync_running`; read-only `GET /api/sync/job`), `shared/sync-run.js` (the run belongs to the shell; two clicks send one request; it follows a sync it did not start), the rail Sync icon spins while running, a toast shows the result elsewhere, and a return shows "Syncing…" then the result. Suite `test-sync-run-survives-navigation.js` (38 assertions, real git), red on the old route. **E2E.** MCP 56/56 (Install → preview → Apply → Check again → Test connection → Remove → Restore byte-identical, Skills, Details, widths). Sync in a browser: press, leave at once, the commit lands, toast, and the page shows the result on return. Real config files fingerprinted (Claude Desktop rewrote its own file once mid-run: same size, our entry unchanged). **Bookkeeping.** v3.89.0 and v3.89.1 archived v3.88.0 and v3.88.1 instead of the oldest row, v3.87.1. This release archives v3.87.1 into its chronological place, so CLAUDE.md again holds the 3 newest. **KNOWN AND UNFIXED.** The Claude skill upload path is from Anthropic's help, not verified in the app. "Last 7 days" is shown even when the usage log is younger. Tool purpose lines are terse and partly technical. The monitor is mono throughout. **VERIFICATION: 301 offline suites, 301 passed / 0 failed**; CI at release. |
| `v3.89.1` | **"Use existing folder" on Linux opens the desktop's own folder dialog (zenity, kdialog or yad), and never shows macOS advice off a Mac.** **Why.** The maintainer asked, 2026-11-01, whether the folder picker is agnostic. Read in code: on Linux the picker fell through to osascript, failed, and returned a 500 telling the user to check macOS System Settings; only the v3.87.1 paste-a-path box made it usable. **What.** `src/brain/linux-folder-dialog.js` (`pickFolderLinux`): zenity → kdialog → yad, each by ABSOLUTE path from `findOnPath()` (only absolute PATH entries holding an executable regular file; empty and relative entries are skipped), execFile with an argv array and no shell. Nothing is spawned without DISPLAY or WAYLAND_DISPLAY. A 10-minute timeout kills with SIGKILL and is read as a cancel; exit 1 or 252 with no output is a cancel unless stderr says the display could not be opened. `src/routes/config.js`: a linux arm in pick-folder (through the same `accept()`) and pick-path (the path only), before the osascript fallthrough. No tool or no display gives 501 `no-dialog` ("This computer has no folder dialog The Curator can open — paste the folder's full path instead."), so the paste box shows. darwin and win32 are byte-identical. **Tests.** `scripts/test-linux-folder-picker.js` (45 assertions); 5 mutations red (no-display guard, shell on, relative PATH allowed (the suite chdirs so a planted relative binary really resolves), timeout as failure, linux arm off). Docs: user guide, API reference, llm-docs user guide. **KNOWN AND UNFIXED.** Not run on a real Linux desktop: real zenity/kdialog/yad exit codes, yad's trailing `|`, Wayland focus, the display-error regex in other locales, kdialog's start folder, Flatpak/sandboxed PATH. **VERIFICATION: 300 offline suites, 300 passed / 0 failed**; CI at release. |

- **Version:** 3.90.0
