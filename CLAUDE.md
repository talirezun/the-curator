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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **211 rows**, back
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
| `v3.80.0` | **"+ Add a tool" made usable — the two-line model-picker row, a way to remove a tool, and a setup guide per tool.** **Why.** The maintainer, 28 September: the menu was a full-width list with long monospace descriptions floating right; an added tool — Windsurf — could not be removed; and nothing said what to do after adding one. **Cause.** Both menus are built on `shared/listbox.js`, but the tool menu used the plain row — a label plus a `flex:none` mono `detail` pinned right, no width cap — while the chat model picker passes its own two-line row body plus `lb-rich mr-menu`, a 360px `minWidth` and a foot line; the tool menu had none of that. **The fixes.** `setupToolPickerCfg` (`src/public/next/views/setup-step.js`) now builds each option with `listRowBodyHtml` (`shared/model-row.js`), reusing the model picker's `.mr-*` classes plus one new class, `.mr-fact`, for a right-aligned "not measured" flag; `toolMenuMeta()` renders what the tool reads and, via `shortConfigPlace()`, its MCP settings' location shortened to a folder. A row trash (the Handoffs row-act pattern) on the Tools fold and "Remove from this list" in the reader take a tool off this computer's list, gated on a new `removable: {ok, why}` the backend computes per tool (`saved` | `configured` | not added) — never a client guess, and never offered for a tool that has saved this project or whose MCP settings here already name The Curator. Adding a tool now auto-opens its reader; a tool that isn't ready opens on a numbered four-step guide (① connect the MCP, with the exact file, format, Copy MCP entry and Reveal ② install the two skills, or skip/optional/can't-check-here ③ put the Curator instructions in the file it reads, with Copy instructions and the commit-and-push command — "not checked yet" until the repository folder is set ④ let it save once from this computer), each step carrying its own state and its own to-fix lines. Additive backend fields: `addable[].reads`/`configPaths` (`src/routes/setup.js`'s `addableFor()`); tool rows gain `reads`, `userAdded`, `removable`, `mcpTarget`, `skillsTarget`, `instructionFixes` (`src/brain/setup-check.js`, ~line 1206). **PROCESS.** Builder Opus 5.5, 10 mutations, 9 red, 1 survived undetected: `.mr-fact` in the selected-row CSS rule, unguarded, because the tool menu never carries a selected value. **Orchestrator hand mutation**, restored by copy and shasum-verified: a saved tool made removable → `test-setup-check` red ("a tool that has SAVED stays"). Docs Sonnet. **KNOWN AND UNFIXED.** At 1100px the Tools table scrolls sideways and the trash column sits off-screen until scrolled; Windsurf's instruction file is listed as unknown, unverified; the Antigravity `Stop` hook remains unobserved; there is still no repository writer. **VERIFICATION: 274 offline suites, 274 passed / 0 failed** — the orchestrator re-checks. |
| `v3.79.0` | **Setup made understandable — after the maintainer fixed his own warnings on two projects only with long explanations: every to-fix line now says what is wrong, why it matters and exactly what to do (naming the file, the computer and the date); each fold shows how its things travel between computers (Personal Sync · the project's own git · set up on each computer); repository files and computers open in the right-side reader; and Session start's "Harness" becomes "Your tool's share".** **Why.** On 28 September the maintainer cleared curator's and conduit's warnings step by step with the orchestrator — "Antigravity saved under “main”", ".curator-project is not committed" — and said the multi-harness setup was "really hard to understand": two sync channels (the app's Personal Sync for handoffs and the brief; the project's git for CLAUDE.md, AGENTS.md and the marker) looked like one, a Copy block was offered for instructions that were already current, and files could be revealed in Finder but not read. **Audit (Opus 5.5, read-only)** rewrote every to-fix kind and found a real bug: the block-cap line (setup-check.js) fired on `overCap` — any long file — while `blockPastCap` was computed and never used, so "move the block to the top" fired on a block already at the top (verified by the orchestrator). **Backend (Opus 5.5).** Every to-fix item carries `fixes: [{kind, label, …}]` in button order (`fix` = `fixes[0]` for a v3.78 view) and `text` + `detail` in one pattern; no to-fix copy says "scope" (tested). The wrong-name save is decided AFTER the block check: when the tool's block is missing/wrong/outdated it joins that line ("That is why its 25 Sep save went under “main”."); when the block is current it gets its own buttonless line naming date and computer and saying it clears on the tool's next save (+ "after that computer runs git pull" for another computer's save; a save from this Mac newer than the file's mtime is hedged — the check reads only this Mac's checkout and cannot see when the session started). Block-cap fires only when the block's END is past the cap. Git commands run in the set folder and commit only that file, and now push (`git add -- F && git commit -m … -- F && git push`); marker-missing offers `git pull` first when another computer has saved this project; sync-incoming is one line per computer. `travels` (`personal-sync` / `project-git` / `this-computer`) on every row. New `GET /api/setup/projects/:d/:p/file?name=` with its OWN allow-list (`.curator-project` + instruction files of listed tools) — never the reveal set, which holds `~/.claude.json` and MCP configs; folder only from `getProjectRepo`, realpath both, file must resolve inside the folder AND to an allowed name (a symlink to `.claude.json` in a folder set to `~` is refused), regular files, 256 KB cap; returns block offsets/state, the smallest cap among listed tools, git state. `groupComputers` rows gain `saves[]`; the primary machine name is now deterministic (newest save, then a current id on this Mac, then lexical) after a one-off unexplained §9 failure that 60 re-runs could not reproduce — the check was split into three named assertions so a recurrence names its cause. **Frontend (Opus 5.5).** To-fix notes render as two lines with labelled buttons (copy-command toasts name the folder: "Copied — run it in Terminal in ~/x"); the repository-not-set note asks "Where is ‹project›'s code on this Mac?"; each fold's meta carries a greyscale travels-by pill (colour stays reserved for domain identity) and one count line saying how its things travel; `context.setup` ⓘ is now a travels-by table (the marks table moved to the user guide); a Repository file row opens the file read-only in the reader (rendered through the escape-first `renderMarkdown`, hard-wrapped paragraphs joined by a file-reader-only `softWrap`, the Curator block framed with its state and "Copy current instructions", a "‹tool› reads up to here" rule); a Computers row opens installs, aliases, each tool's newest save with date and the name it saved under (flagged only when `wrongScope` — a session-named scope is this project's convention, not an error), and sync state. Session start: "Your tool's share" with plain option texts and "The Curator can't measure this. It only changes the meter; nothing is sent." Degrades cleanly against a v3.78.0 server. **Docs (Sonnet).** User guide §13e: a table of every warning (what it means · what to do · which computer), the three-ways-things-travel table + mermaid diagram, the marks table, the two readers, the block-cap fix; §7 "Your tool's share"; "this computer only" row in the two-computers table; four dated bullets in decisions-app.md; llm-docs "Harness" label corrected (at 99.4% of budget — the travels-by table did not fit). **PROCESS.** Audit Opus 5.5; backend and frontend Opus 5.5 in separate worktrees against an orchestrator-written contract (backend appended four amendments); docs Sonnet. Builder mutations: backend 14, frontend 13, all red. **Orchestrator hand mutation**, restored by copy and shasum-verified: the file route's inside-folder check disabled → `test-setup-routes` red ("GEMINI.md → a file OUTSIDE the folder: refused"). **Orchestrator screen review** on an isolated copy of the real `projects` domain with the real HOME and the real v3.79 payload: the route served AGENTS.md with block offsets and refused `../.zshrc` and `.claude.json`; found two frontend defects before release — hard-wrapped files read ragged in the reader, and the computer reader flagged a session-named scope as "not its own name" — both fixed in `edae193` and re-checked on screen. Same day, outside the app: the maintainer's curator CLAUDE.md block replaced and AGENTS.md added (`510e594`), and conduit-agent's `.curator-project` and AGENTS.md committed and pushed (in that repository). **KNOWN AND UNFIXED.** The "saved after the instructions changed" hedge is a heuristic (mtime, this Mac only); llm-docs has no room for the travels-by table; Antigravity's `Stop` hook still unobserved; still no repository writer. **VERIFICATION: 274 offline suites, 274 passed / 0 failed** — the orchestrator re-checks. |
| `v3.78.0` | **The Setup check, made legible and truthful — after the maintainer's 28 September review of v3.77.0's step 5: an Antigravity "could not be read" that only an app restart cleared, "3 computers" on a one-Mac project, a repository field nobody could explain, a Sync button whose scope was unstated, no way to add DeepSeek Harness or a custom tool, and a summary card and two wide tables that matched nothing else in the app.** **Root causes (research Opus 5.5, verified by the orchestrator on disk).** (1) "a config file could not be read" fired for a config file that EXISTS but fails JSON parse — a 0-byte or half-written `mcp_config.json` (probed) — and `files.some(f => f.parseError && !f.named)` outranked the tool's other, working files; a file that could not be opened (EACCES/TCC) was silently read as absent. Nothing was cached server-side; the page simply never re-checked (client `state.setup` refetched only on project switch/reload/Check again), so the restart "fixed" it by reloading. A harness need not be running. (2) All three "computers" were ONE MacBook: the Mac app (`…-acb035`), a source checkout with its own `.curator-machine-id` (`…-17d23c`), and that checkout's pre-D10 hostname alias (`mac-17d23c`); the maintainer's second Mac had never saved this project. (3) Sync now = `pull()`+`push()` of the WHOLE domains folder, and "N changes not on GitHub" counted every domain. (4) DeepSeek Harness existed as adapter `dsh` but was hidden from the menu (no verified paths). **Backend (Opus 5.5).** Every config file now reports `status` missing / unopenable / empty / invalid / ok with a `~/…` display; an empty or broken file flags a tool ONLY when no other file of that tool names my-curator (otherwise a reader note); `unopenable` is surfaced; a bridge to-fix names the file and offers Reveal (allow-listed). Computers are grouped by INSTALL ID (`installIdOf`, exported from tray-summary.js, never copied) into physical computers — installs on this Mac are proven by `.curator-machine-id` in the app's user-data folder, the set repository or an auto-detected candidate folder that is a Curator checkout, and the install behind each my-curator MCP entry — so the maintainer's project reads "1 computer · 2 installs · 3 names" with or without a repository set; on-disk `<machine>` layout unchanged. Repository candidates, in order: `~/.claude.json` project keys, reachable foundation folders, the hook log, a git-remote match (from `.git/config`, no subprocess) — each offered only if it exists here and its `.curator-project` names this project, max 5, under `$HOME`; no config value ever leaves (privacy test extended). The hook activity log's session-start lines now record `repo` — the folder whose `.curator-project` resolved the project (maintainer-approved 2026-09-28; local, never synced; still no payload values; the payload `cwd` is never recorded). `sync.scope = 'all-domains'`, `sync.incomingCapped`. `addable` lists every adapter with an MCP entry plus `Custom tool…`; `PUT /api/setup/tools {custom:{name}}` / `{removeCustom}` (per machine, never synced, max 12, validated; a known name joins the known ids); custom rows get a generic `mcpServers` snippet, AGENTS.md as an ASSUMED instruction file (block cell `unmeasured`, never a to-fix) and the skill .zips, and turn ready only after saving under their own name. Each tool row gains `status`, `parts` (mcp · skills · block · hooks) and `evidence` for the reader. **DeepSeek Harness, verified from its source** (deepseek-ai/deepseek-harness at 21638c56; orchestrator re-checked `docs/user/guide/mcp-memory.md`): the MCP entry goes in `$DSH_HOME/cordis.patch.yml` (default `~/.dsh`) or a profile's `cordis.patch.yml` as an `insert` patch — NOT `cordis.yml`, which dsh rewrites on every launch (the research pass's first answer, and the contract, were wrong here); line-scan check, no YAML dependency; reads AGENTS.md and CLAUDE.md; skills `.dsh/skills`, `.agents/skills`, `~/.dsh/skills`, `~/.agents/skills`; clientInfo `dsh-mcp-client`; hooks location unverified. **Frontend (Opus 5.5), built only from existing parts.** No summary card — nothing shows when nothing is wrong; every to-fix is a step-4-style note line with its own fix buttons (Reveal, Copy block, Copy command, Sync now, Use ~/…, Open Tools on this Mac, skills .zip); "checked N ago · Re-check", plus an automatic re-check on window focus/visibility when the reading is >10 s old; Tools / Repository on this computer / Computers are Handoffs-table folds (`mem-ws-table`); a tool row opens its evidence in the right-side reader (new additive `hideBacklinks` reader option); "+ Add a tool" is the shared listbox (Known tools / Other › Custom tool…); Computers show one row per physical computer with installs on a secondary line and state the sync scope; SETUP tile ready / N to fix / repository not set; `context.setup` ⓘ rewritten to answer the maintainer's questions; `context.overview` now says six readings; Settings › MCP bridge › Tools on this Mac shows each file's state; dead CSS removed. Degrades cleanly against a v3.77.0 server shape. **Docs (Sonnet).** User guide §13e rewritten (FAQ: must a tool be running, what Re-check does, why a repository folder, why more computers than I own, what Sync now syncs, how to add an unlisted tool), DeepSeek Harness in §13c/§13d, `docs/working-state.md` (hook log `repo`), dated decisions in decisions-app.md and decisions-agents.md. `llm-docs/curator-agent-memory.md` unchanged — at 99% of its 30,000-token budget, and none of its claims went false. **PROCESS.** Research + design Opus 5.5 (read-only, with an HTML acceptance picture built from the app's real stylesheets); DeepSeek facts Sonnet; backend and frontend Opus 5.5 in separate worktrees against an orchestrator-written contract (backend appended two amendments); docs Sonnet. Builder mutations: backend 8, frontend 7, all red. **Orchestrator hand mutations, each restored by copy and shasum-verified, both red:** backend — the bad-file guard reverted to "any broken file flags the tool" (`test-setup-check`, 6 red); frontend — the to-fix notes dropped from the step body (`test-next-setup-step`). **Orchestrator screen review** on an isolated copy of the real `projects` domain with the real HOME: layout matched the picture; it found one defect — with no repository set the source checkout still read as a second computer — fixed in `16bfff3` (candidate folders prove local installs) and re-checked (1 computer · 2 installs). The review also surfaced two true findings in this repository itself: its CLAUDE.md working-state paragraph is not the current Copy-agent-instructions block, and there is no AGENTS.md — left for the maintainer. **KNOWN AND UNFIXED.** dsh hooks location unverified; `$DSH_HOME` set only in the user's shell is invisible to the app (the default is read); the llm-docs file has no room to describe the Setup step; the Antigravity `Stop` hook is still unobserved; there is still no repository writer. **VERIFICATION: 274 offline suites, 274 passed / 0 failed** — the orchestrator re-checks. |

- **Version:** 3.79.0
