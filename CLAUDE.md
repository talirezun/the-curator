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

## Model tiers for delegated work

- **Fable 5.2** (`claude-fable-5-2`, Agent tool `model: "fable"`): truly complex audits — independent reviews, security and data-safety audits, proven repros. Replaces Fable 5.1 from 2026-11-14.
- **Newest Opus** (Opus 5.5, `model: "opus"`): complex builds and read-only design passes. **Sonnet**: mechanical work.

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
- Windows app (v4.0.0): an NSIS per-user `.exe`; on win32 the bundle marker `.curator-bundle` is the ONLY bundle signal and the packaged app without it refuses to start; data in `%LOCALAPPDATA%\TheCurator\App`; bundled MinGit (every copyleft component's source on the release); updates by a verified silent installer, never electron-updater.

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
- AI Health is READ-ONLY; the semantic-duplicate scan is opt-in, cost-gated and capped; a merge that DELETES requires a preview first.
- Every Health write copies each file it changes first (`health-undo.js`, at `writeFileAtomic`'s recorder and the wiki `rm`; a copy that fails stops the write), outside `domains/`, never synced; Wiki health › Recent changes undoes a change all-or-nothing for 30 days on THIS computer and refuses if any file changed since (owner, 2026-11-07, reversing "no in-app revert"). No undo over the MCP.
- Find duplicate pages remembers answers per domain outside `domains/` (`duplicate-checks.js`), bound to pages, model, prompt and openings; batch merge is server-checked: a remembered high-confidence answer AND `isSpellingVariant`; `isMergeableSlug` is the one test for candidates and merge.
- Every merge that deletes a page composes through `page-merge.js`: the kept page is the base, the rest moves verbatim under `## Merged from <slug>`, and `findLostLines` refuses a delete that would lose a line.
- Wiki health keeps its nodes across a paint (`shared/morph.js`) and follows the press rule: the pressed control answers, a question and an outcome appear on the row, nothing above moves, focus never lands on `body`; `scripts/e2e-wiki-health.mjs` holds the thresholds. Free repairs that delete nothing run on press.
- Wiki health's screen is three lanes (Free repairs · Your decision · AI help), its words held to a deck by the page contract; quiet counts filter the candidate memo after a merge rather than re-run the pass.
- The review desk shows both pages by default; a merge's gate needs the comparison visible 500 ms and a matching server `basis`. Compare all is one resumable job across domains that recovers PAUSED and stops at 120% of its confirmed spend.
- A family on the desk is a walk: the page that stays, then one decision per page through the same gate; A~B and B~C never prove A~C, and the screen says when the AI never compared two pages.
- Every deleting Health route verifies its claim on disk; frontmatter is preserved byte-for-byte; repairs never edit code fences, `.trash` or `.obsidian`; Sync never pushes credential-shaped files; every server a test starts sets `CURATOR_NO_OPEN`.
- Health dismissals are persistent, synced, and offered only on review-only rows. Domains are siloed by default.
- A summary lists entities under "Entities Mentioned" and concepts under "Concepts Introduced or Referenced" — the page's FOLDER decides, `injectSummaryBacklinks` and the `missingBacklinks` scan read BOTH, and `writePage` dedups again AFTER its link rewrites. Health's `summaryLinkSections` is a safe, deterministic, free fix behind a hard guard (`summaryTidyGuard`: never writes unless the link-target set and every line outside the two sections are unchanged); Health's link rewriters go through `dedupRewrittenBullets`.

### Ingest → [decisions-knowledge.md#ingest](docs/dev/decisions-knowledge.md#ingest)
- The batch prompt's stable prefix must be byte-identical across batches, or caching silently costs more.
- An ingest checks it can write BEFORE its first paid call (`assertIngestCanWrite`; a missing `log.md`/`index.md`/page folder is created, not refused) and never throws a paid result away after it; text sources are decoded by `decodeTextBuffer` (valid UTF-8 byte-identical, 1252 by table — never Node's `TextDecoder('windows-1252')`), `raw/` keeps the original bytes.
- An ingest fold redirects only a spelling variant (`isSpellingVariant`) and goes through the same no-lost-line guarantee; Jaccard folding is retired.
- Exact-name reuse never overwrites: old text stays and new wording is added only when mostly new (threshold 0.5, notice on drop); a source with the same sha256 already completed leaves existing pages byte-identical.
- The `index.md` embedded in the outline and single-pass prompts is capped at `INDEX_PROMPT_BUDGET_CHARS` (150,000) by `indexForPrompt`, INSIDE the builders; under the cap the prompt is byte-identical, over it the rows most related to the source are kept, and it logs to stderr only (nothing the model produced is dropped). A complete index without this cap overflows Haiku 4.5's window.
- If the pipeline drops, redirects or renames anything the model produced, a user-visible warning says so; repeated warnings aggregate at one chokepoint (except near-duplicates and trunk pages).
- `parseJSON` is lenient — validate its output, never truth-test it; fix a shape bug on every path that consumes it, the first-running one first.
- A broken-link rate from one run is noise, not a gate.
- Phase-2 batch replies are filtered to the pages that batch was asked for (`filterBatchReply`; set-aside copies are a reserve, never a warning); a summary lacking title, source or takeaways warns (`summaryShapeWarning`); a different source with the same summary slug gets a hash-suffixed slug (`resolveSummaryPath`).
- The batch queue lives outside `domains/`, runs strictly sequentially, decides duplicates at create time, and recovers PAUSED — nothing auto-starts spend.
- A hard-data source that names existing pages or shares a distinctive identifier with them is shown a bounded excerpt of their current facts (`existing-facts.js`, ≤ 4,000 chars, in the batch PREFIX) and adds only new or changed facts with their version; prose, empty domains and re-readings stay byte-identical.

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
- Record files (`.raw-manifest.jsonl`, `.health-dismissed.jsonl`, `log.md`, state journals) are re-merged after git's merge as a three-way set of records (`sync-records.js`, `reconcileRecordFiles`), never `-X theirs` and never `merge=union`; wiki pages and `index.md` are never listed.

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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **253 rows**, back
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
| `v4.1.0` | **On Windows the tray widget now looks and works like the Mac one: a left-click opens a popover with the Mac widget's two-line rows, grey subtitles, captions, dots, bars and the activity strip; a right-click opens the plain Windows menu.** **Why.** The owner, on his own PC after v4.0.1 (2026-11-21), with a screenshot of the Mac menu-bar widget: "keep the widget as close to the Mac version, in the form of a widget". A native Windows menu cannot draw second lines, section captions or wide pictures (v4.0.1 folded them into long single lines). AgentLink 0.5.9 solved the same problem with a popover window. **What.** A read-only design pass, then six packages in separate worktrees and an independent audit. (1) **Model** (`desktop/lib/tray-popover-model.js`): the popover paints the SAME template the Mac menu is built from (`buildTrayMenuTemplate(…, {adaptForWindows:false})`), so parity holds by construction; a payload of pages and rows (`separator/header/statement/stamp/action/drill`), a per-build generation and an action gate (`createPopoverActionGate`) that refuses stale or unknown ids; pages carry a build-independent identity `sid` (their own `domain / project · scope` and machine lines) so a refresh never swaps the open page to another project; additive `imageScales` (crisp 1–3x pictures, `createPopoverImageCache`: first build ~20 ms, repeat ~0.7 ms, was ~115 ms) and `writtenAtText` (friendly time, Windows only; the Mac byte-identical). (2) **Page** (`src/public/next/tray-popover.html`, `views/tray-popover.{css,paint.js}`): drill-in pages with a back row (owner D2), Segoe UI, 360 px, colours only from the app's tokens, theme follows Windows (D3), opaque surface (D4), activity strip 2x (D6), details on the drill page (D7); CSP `script-src/style-src 'self'; img-src data:`; escape-first (no innerHTML); full keyboard and menu roles; a polite live region. (3) **Controller, preload, IPC** (`tray-popover.js`, `tray-popover-preload.js`, `tray-popover-ipc.js`): sandboxed, context-isolated window in its own in-memory session (permissions and downloads denied; only `data:` and `file:` inside the page folder load; navigation and new windows refused); every press checked for sender, top frame, exact page URL, visibility, generation and id; AgentLink's measured timings (toggle grace, early blur, 1 s first-paint backstop); preloaded at start; positioned by `tray-popover-position.js` for any taskbar edge, overflow, auto-hide and mixed DPI. (4) **Wiring** (`main.js`, `shell-platform.js`, `tray-popover-shell.js`): left-click publishes then toggles; right-click = the native menu (owner D1); any popover failure gives that click the native menu, two in a row switch the popover off for the session; quit only through `app.quit()` and `before-quit`; the popover handles log-off itself. (5) **Native menu tidy** (`tray-menu-win.js`): detail lines wrap at ~60 characters. (6) **CI**: an env-gated self-test of the installed app on `windows-latest` (shows the popover, checks visible, inside the work area, painted, 0 CSP violations, a request outside the page folder refused, Esc hides). Docs and `llm-docs/curator-user-guide.md` updated; the 4.0.0 → 4.0.1 in-app update confirmed on the owner's PC (no security prompt reported). (7) **Downloads made simple** (owner, 2026-11-21: "how will anybody know how to install this? I don't find an exe file nowhere"; the Releases page listed 34 files alphabetically, GPL sources first, installers hidden behind "Show all", the body only a changelog link, and the docs said to find `TheCurator-<version>-…`): every real release now also carries stable-name copies `TheCurator-Windows-Setup.exe`, `TheCurator-Mac-AppleSilicon.dmg`, `TheCurator-Mac-Intel.dmg` (`scripts/release-downloads.js` stages them byte-checked outside `desktop/dist`, uploads them only after their versioned files, and the jobs check name, size and digest), so `https://github.com/talirezun/the-curator/releases/latest/download/<name>` always downloads the newest installer; the in-app updater ignores the copies (no arch token; proven against the real `resolveInstallerRelease` on darwin arm64/x64 and win32 with the copies listed first, plus a control and a mutation); a generated release body starts with "## Download" (stable link + versioned name per installer, one plain line each, wording checked against the docs), then a note that the other files are the bundled git's GPL source, then the changelog. README, `docs/windows-app.md`, `docs/mac-app.md`, `docs/install-windows.md`, `docs/user-guide.md` and `llm-docs/` open with a Download block and three steps. **Review.** Independent Fable 5.2 audit: SHIP AFTER FIXES. Major M1: after a refresh the open drill page could become another project's work-stream (page ids are per build, stream titles carry no project), and "Copy resume prompt" then ran for the wrong project with a valid generation; reproduced with the real model and painter, fixed with `sid`, the auditor's repro re-run by the orchestrator (now runs for the viewed project). Minors fixed: failure counter now counts consecutive failures; an unchanged publish keeps its generation (no repaint, no lost click); picture cache; preload; a cancelled pending show falls back (never neither); popover log-off; a negative CI probe. Found sound: the IPC boundary, escaping, quit, fallback without loops, macOS unchanged, the CI gate. **Proven.** Offline suites for every package (position 39 checks + a 6,000-input fuzz, model 235, page 133, controller 226, shell 68, menu wrap 19), ~130 mutations across them, each red and restored with a verified sha256; macOS template, model and pictures byte-identical to v4.0.1. **KNOWN AND UNFIXED.** The stable links resolve only for a full (non-pre-) release, and if the Mac job of a release fails the two Mac links return 404 until it is re-run (pre-existing: the Windows job still marks the release Latest). A changed payload arriving while the popover is open still repaints, so a press in that instant may need repeating. No Ctrl+C copy in the popover. Symlinks or alternate data streams inside the install folder are not resolved by the request filter (needs write access to the install folder). Only a real PC shows: focus after a tray click, placement in the overflow and on mixed DPI, Windows 11 corners and shadow, Narrator, cold-start time against the 1 s backstop. As in v4.0.1. **The owner must re-upload EVERY `llm-docs/` file to Lumina.** **VERIFICATION: 357 offline suites, 357 passed / 0 failed** (before the version bump the only red is test-changelog-completeness, by design); rehearsal tag v4.0.1-wintest.1 (Desktop DMG run 44921111248, Tests run 44921111244): Windows build + install/uninstall smoke, the popover self-test on the installed app (`tray-popover-selftest: pass`: shown, inside the work area, rows painted, 0 CSP violations, an outside `file:` load cancelled, Esc hides it), the in-app update rehearsal, the gating `windows` test job, the one-line install and the offline suites all green; CI at release. |
| `v4.0.1` | **The Windows tray icon now shows the Mac widget's real state, and left-click opens the widget.** **Why.** The owner's first test on his own Windows PC (2026-11-21): the tray icon always showed a circle with a dot, where the Mac icon is an empty circle that gains the dot only while an agent has just saved; left-click opened the app window instead of the widget; and the menu read differently from the Mac widget. **What.** (1) **Icon** (`desktop/lib/tray-icon-win.js`): v4.0.0 drew a white ring on a filled violet disc, so the violet centre read as a dot at 16 px in BOTH states (the state reached Windows correctly; `desktop/build/tray.ico`/`tray.png` are never loaded, the icon is generated at runtime). The Windows icon is now the Mac `glyphMatrix` itself, pixel for pixel: idle = empty ring, live = filled centre (an agent saved on this computer within 120 s, the Mac rule); white on a dark taskbar, #1F1F1F on a light one (`nativeTheme.shouldUseDarkColorsForSystemIntegratedUI`, read on every render, redrawn when it changes via `trayIconKey`; a failed read assumes dark). macOS unchanged (its key is still the glyph state alone). (2) **Clicks** (owner decision 2026-11-21, reversing v4.0.0's "left-click = window"): `trayClickHandlers(platform)` in `shell-platform.js`; on win32 BOTH left and right click rebuild the menu from the in-memory snapshot and pop it, then re-read the index and run the remote check; "Open The Curator" stays in the menu; no double-click handler. macOS handlers unchanged. (3) **Menu** (`tray-menu-win.js`): v4.0.0 turned every leaf with a tooltip into a submenu whose first item was a generic "Open in The Curator" (which on a domain bar opened Settings) and repeated lines. Now a leaf inside a submenu stays a clickable leaf with its picture (bars, dots, pulse strip, as on the Mac); its hover facts go once at the end of the submenu (a sentence every leaf shares appears once); a top-level leaf with hover text becomes a submenu whose first item names its action ("Open Project Context…" for the pulse); section headers become disabled caption lines. (4) `scripts/test-ingest-deep.js` SYN-8 (live suite; failed on `main` run 44827728760 attempt 1): gemini-3.5-flash-lite once replied to the 1,770-byte tiny baseline with ONLY the summary (SYN-1, a real model behaviour the pipeline warns about); the summary lacked Key Takeaways, so the same-content re-ingest correctly planned ONE gap-filling reading (`planRepeatIngest` → `'gaps'`) instead of no call. SYN-8 now asks the planner first: `'gaps'` → inconclusive, checks that one reading then `'nothing'`; otherwise the original no-call assertions. No product code changed. (5) The `v3.99.2` row archived byte-for-byte (sha256 `6f7a3849…`). **Proven.** 12 mutations on the tray (idle drawing the dot, the icon key or ink ignoring the taskbar tone, left-click not popping the menu, `main.js` re-adding left-click = window, inner leaves becoming submenus, pictures dropped, the pulse wording, the shared sentence not de-duplicated, the darwin click popping a menu), each red and restored with a verified sha256; the icon pixels decoded in tests (idle centre empty at 16/24/32 px on both tones, alpha equal to the Mac glyph, contrast ≥ 3:1). SYN-8 by an offline replay through the real code (`byThisModel < 2` → `< 3` turns it red). Previews rendered from the real model (outside the repo). **KNOWN AND UNFIXED.** A native Windows menu cannot draw the Mac widget's two-line rows, grey subtitles, section headers or a full-size pulse strip: subtitles are folded into long single lines and hover facts into disabled rows, so menus can be very wide; a row's detail shows the raw ISO "written:" timestamp. The owner asked for the widget to look like the Mac one: a Windows popover window (as AgentLink 0.5.9 did) is planned for v4.0.2. Not yet seen on a real PC: the taskbar-tone detection with the app's pinned dark theme, `popUpContextMenu` from a left-click, the menu pictures at 125/150 %. An empty-domain first ingest that the model answers summary-only is warned about but not retried (owner's decision pending). As in v4.0.0. **The owner must re-upload EVERY `llm-docs/` file to Lumina.** **VERIFICATION: 351 offline suites, 351 passed / 0 failed** (before the version bump the only red is test-changelog-completeness, by design); rehearsal tag v4.0.0-wintest.1 (Desktop DMG run 44904440107, Tests run 44904440157): Windows build + install/uninstall smoke, in-app update rehearsal, the gating `windows` test job, the one-line install and the offline suites all green; CI at release. |
| `v4.0.0` | **The Curator for Windows: a normal Windows app. Download one installer, Next, Finish, and it opens in its own window, with its own git for Sync, a tray icon, one-click Claude Desktop, and updates it installs itself; your notes live outside the program folder and survive every update and uninstall.** **Why.** Windows people had only the one-line browser install (v3.87.0): PowerShell, a browser tab, Node and git in a private runtime. The owner wanted the Mac app's experience on a PC, exactly: download the `.exe`, the blue SmartScreen screen (not code-signed), More info → Run anyway, Next, Finish, the app opens; no admin rights, no terminal, nothing else to download. A read-only design pass (2026-11-20) found the plan's most dangerous fact first: on Windows a packaged build was NOT detected as a bundle (no `.app` path shape, no marker written), and a per-user NSIS program folder is WRITABLE, so the app would have run in repo mode and kept the wiki, keys and sync repo INSIDE the program folder that the next update or uninstall deletes, silently. **What.** (1) **Bundle identity** (`src/brain/paths.js`): on win32 the marker `resources\app\.curator-bundle` (written and read back by `desktop/lib/win-pack.mjs`) is the ONLY bundle signal; user data in `%LOCALAPPDATA%\TheCurator\App` (owner D1), with `instances\`, `logs\`, `updates\` at the root shared with the browser install; `mcpLaunchStyle: 'app-binary'`. The packaged app running from `…\resources\app` WITHOUT the marker refuses to start (`app-files-incomplete`: a plain box, reinstall, notes safe), the MCP server too (stderr, exit 1). (2) **Releases by platform** (`src/routes/config.js` `pickInstallableRelease(…, {platform})`, `installerAssetsFor`): `.exe` only on win32, `.dmg` everywhere else, the Mac byte-identical. (3) **MCP**: Install for me writes `{command: <The Curator.exe>, args: [<mcp\server.js>], env: {ELECTRON_RUN_AS_NODE: "1"}}` into Claude Desktop's config (classic and Store resolution from v3.86.0); Check entry gains shape (c) (owner D2): exactly THIS install's exe and server.js, same file by volume + file id, the checker setting `ELECTRON_RUN_AS_NODE` itself and never passing the entry's `env`; shape (b) is off in the Windows app; the RunAsNode fuse is read out of the built exe. (4) **Bundled git** (owner D4 changed to BUNDLE): MinGit 2.56.1 pinned by size + SHA-256 and checked BEFORE a strict zip reader unpacks it, at `resources\git`; every git caller (Sync, Shared Brain, setup check, memory layer, CLI) runs it first, with `-c credential.helper= -c core.askPass=`, schannel, `core.longpaths`, `GCM_INTERACTIVE=never`, so a rejected token is the plain `sync-token-rejected` sentence and never a sign-in window. (5) **Licences and source** (owner, late 2026-11-20): all 65 MinGit components (Git for Windows' published `package-versions-2.56.1-MinGit.txt`, digest-checked) have a decided licence and source in `desktop/lib/mingit-components.mjs`; the build refuses a MinGit whose own list differs; `THIRD-PARTY-NOTICES.txt` carries every component's licence and source and 28 pinned full licence texts; `publish-windows` attaches the exact source of every GPL/LGPL/MPL component (GitHub's archive of the git tag + 28 makepkg source packages, ~485 MB), each held to its exact size, the SHA-256 Git for Windows records where it does, and its `<pkgbase>/PKGBUILD` tree, BEFORE anything is published, then checks the release by exact name and size; a missing one fails the job. (6) **Build** (`desktop/electron-builder.yml` `win` + `nsis`, `desktop/build/installer.nsh`): assisted per-user NSIS, x64 only (D6), no folder choice, Desktop + Start-menu **The Curator**, `runAfterFinish`, `deleteAppDataOnUninstall: false`, no electron-updater feed; the installer refuses to install into or uninstall from the data folder (full and long paths, and by contents); win32 afterPack/afterSign check version, `node_modules`, MinGit file-for-file, notices, tray icons, ProductVersion and the fuse. (7) **Updating** (`desktop/lib/update-engine.js` `createUpdateInstaller(platform)`; the darwin engine moved byte-for-byte): download into `updates\`, size + GitHub SHA-256 digest + ProductVersion, a validated PowerShell helper, started through a launcher the app WAITS for (the app quits only once the helper's start marker exists, else it stays open with `helper-spawn-failed`), logs from its first line, waits for the PID, stops only the MCP bridges the person agreed to stop (**Close the connection and update**), re-checks the setup's size + SHA-256 with .NET (refusal names what differed), runs `/S --updated --force-run`, records the outcome for the next start (a terminating error is `helper-error`, the old app reopens; a success already read by the reopened app is not re-recorded); sweeps remove only the engine's own files. Never electron-updater. (8) **Shell and tray** (`desktop/lib/shell-platform.js`, owner reversed D5): coloured tray icon, left-click = window, right-click = menu rebuilt on open, same facts as the Mac widget (parity rule); close hides to tray only with a live tray, and without one the quit question comes BEFORE the window goes; `tray-only` is not offered on Windows; AUMID; Help › Check for Updates… / About. (9) **Folders** (`folder-access.js`, `knowledge-folder-path.js`): Windows' rules in catalogue words (OneDrive, Controlled folder access, MAX_PATH, reserved names, drive roots, shares, read-only, case), and the program folder and the app's working folders refused on every spelling (real path both sides, 8.3, junction, local admin share), for a folder being chosen AND the one already set. (10) **Words**: every new sentence through the v3.99.2 catalogue (`docs/errors.md`, `llm-docs/curator-errors.md` regenerated); `install.ps1` names its icons **(browser)** when the app is installed (D3). (11) **CI** (`desktop-dmg.yml`): a release is exactly `vX.Y.Z`; any other `v*` tag is a rehearsal that builds and checks Windows and publishes nothing; jobs `windows` (build, check, silent install, launch, uninstall), `windows-update` (N → a rebuilt N+1 from a local fixture, app reopens on N+1), `publish-windows` (after the Mac job, `always()`); `test.yml`'s gating `windows` job runs the Windows suites on `windows-latest`. **Proven offline.** Every Windows decision is a pure function or an injected effect, driven with `path.win32` and simulated hosts: paths and the marker (the repo, `install.ps1` and `scripts/windows/` can never create it), release picking (darwin byte-identical on the existing fixtures), Check entry shapes, the update engine end to end (digest mismatch, truncation, cancel, write-registry refusal, bridge stop, re-hash), the NSIS config and afterPack on fake trees and assembled PE files, folder rules, the tray model, the MinGit pin and zip reader, the component table and the source/release checks; every guard proved by mutation (file restored, sha-checked). macOS and repo mode byte-identical: the darwin suites unchanged and green. **Review.** Package designs by Opus; an independent Fable 5.2 data-safety audit of the whole Windows app found 4 majors (M1 a missing marker silently ran in repo mode; M2 the knowledge folder inside the program folder slipped through 8.3/junction/UNC spellings and a folder already set or relative; M3 the knowledge folder inside the app's own working folders, and update sweeps that could delete more than their own files; M4 Shared Brain, setup check, memory layer and CLI ran a different git from Sync) and 7 minors (installer guard on contents, `psQuote` and Unicode apostrophes, shape (b) in the Windows app, close during an ingest left an invisible process, `tray-only` on win32, the kept installer not re-hashed, `core.longpaths`); all fixed and mutation-tested. **KNOWN AND UNFIXED.** NSIS's own running-app check may miss a running app when the Windows profile path holds an apostrophe (in-app updates unaffected: the helper waits for the PID; by hand, quit first). A log-off, or a reinstall by hand, during a write can cut that write short. **Close the connection and update** ends Claude Desktop's bridge at once, so an MCP `compile_to_wiki` in flight can be cut mid-write. The token is on git's argv for a moment during `remote set-url` (pre-existing, every platform). An NSIS update is not atomic: a power cut mid-install can leave the program incomplete (data untouched; the kept installer or a fresh download repairs it). Not code-signed (SmartScreen on first install; Trusted Signing later). x64 only. The component table was read from Git for Windows' published list, not from inside the zip (the build refuses if they differ); repo.msys2.org sources are pinned by size and tree, not SHA-256. As in v3.99.2. **What only a real PC proves** (none of it seen yet): the SmartScreen wording and whether an in-app update shows any prompt; the real install folder, shortcuts and Apps entry; the tray icon on HiDPI and in the overflow; Claude Desktop (classic and Store) starting the exe over stdio and Check entry's 8 s on a cold slow PC; a full in-app update with a real download and relaunch, including with the bridge running; OneDrive, Controlled folder access and non-ASCII account names on a real profile; the bundled git against GitHub with Git for Windows also installed (no Credential Manager window); the x64 build on Windows on ARM. **Measured on rehearsal tags v3.99.3-wintest.1-11** (owner-approved; nothing published): wintest.3 a CI wait that returned while the uninstaller was still deleting (`waitUninstallFinished`); wintest.4 a helper started DETACHED (no console) never ran under Windows PowerShell 5.1 (a diagnostic proved it: detached = no marker, launcher = marker) and nothing was installed; wintest.5 `Get-FileHash` is not available in the helper's environment, so every update was refused as `installer-changed`; wintest.6 the reopened app read the outcome before the helper wrote `installed`, leaving a record a later start would misread; wintest.7 the full N → N+1 update passed (setup run, N+1 reopened, exe and Apps entry updated, shortcuts kept, data byte-identical); the Windows suites now run on `windows-latest` with file-URL imports (bare `D:\` paths crashed the ESM loader in 54 suites) and host-truthful assertions. The 29 real source downloads run first on the release tag. **The owner must re-upload EVERY `llm-docs/` file to Lumina.** **VERIFICATION: 351 offline suites, 351 passed / 0 failed** (before the version bump the only red is test-changelog-completeness, by design); rehearsal tag v3.99.3-wintest.11: Windows build + install/uninstall smoke, in-app update rehearsal, the gating `windows` test job and the one-line install all green; CI at release. |

- **Version:** 4.1.0
