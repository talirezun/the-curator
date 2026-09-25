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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **203 rows**, back
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
| `v3.74.0` | **Two agent tools on one Mac, made followable and safe — the maintainer's live Claude Code + Antigravity test (2026-09-25) drove a new menubar widget, one tool identity, a truthful "latest", and a warning plus a kept copy when one tool's save replaces another's.** **Evidence** (live test on the maintainer's machine, projects ott / field-notes / conduit): S0 Antigravity listed 24 my-curator tools; S1 handover Claude Code → Antigravity → Claude Code on ott with per-tool scopes worked unprompted (Antigravity read AGENTS.md, called `get_project_context` on "Continue.", saved under `antigravity`); S2 a deliberate A-B-A-B collision on a throwaway scope was flagged in the app, but the v3.73 widget showed the notice twice, greyed and truncated, and said "4 tools"/"5 tools" for 2; S3 with no AGENTS.md on conduit Antigravity read and saved unprompted — to scope `main`, silently overwriting Claude Code's handoff (3.8 KB → 2.4 KB, text lost; the save reply only said "OVERWROTE the previous save"); Antigravity saved `model: null` unless told, and when told searched env vars, transcripts and settings for its id. **Built:** (a) widget Layout A (`desktop/lib`): pulse on top with a "Saves by tool" submenu (one strip per tool); "Active · last 24 h" rows, one per project × tool ("ott · Claude Code · 8 min ago" / "opus-5.5 — headline"), Other work-streams nested; Idle folded ("Idle · N projects"); domains folded ("Knowledge · N domains"); one collision notice per work-stream under Active, clickable, "Two tools are writing <project> / <scope>" with its own 48-char cap (rows keep 42; measured +33 pt); the app's freshness dot replaces the pie (app's scale); model names keep the minor version (opus-5.5, not opus-5); REMOVED from the menu (kept in the app): the "Working on" headline + grey line, Session start, Documents line, "N of M saved" bars (they counted MCP bridge processes, not sessions, and claimed 30 days over 5 days of log); stale docs a notice for active projects. (b) data: `src/brain/harness-names.js` normaliser — spellings of one tool are one tool (claude-desktop stays distinct; alias-collision guard), used by the pulse, `journalFacts` (no false collision from spelling drift), tray and app; `latest` and every "newest" ordered by the agent's recorded `writtenAt`, file mtime only as fallback (a Personal Sync pull no longer makes an older handoff "latest"); `getTraySummary` no longer runs `get_project_context` on every tray refresh. (c) a save that replaces a handoff last written by a DIFFERENT tool still succeeds (maintainer: warn only; default scope stays `main`) but the MCP reply, the CLI and a Journal note say whose handoff was replaced, when and its headline, and the replaced text is kept once as `previous.md` beside `current.md` (readable via `get_working_state { previous: true }`; the app's handoff reader shows "Previous handoff by <tool> · <age> — open"); `docs/spec/working-state-v1.md` §6b + readers ignore unknown files. Tool descriptions + curator-continuity skill: model id only if known, never search files for it; one spelling of the tool name; if another tool saved last in a scope with no brief rule, save under your own tool-named scope. (d) app parity: Context sidebar Active (24 h) / Idle with the tool(s) per project ("Antigravity + Claude Code"); "Saves by tool, last 7 days" in Memory step ② and Settings › Across projects; "Agent sessions" → "Agent connections" with the true window ("last 5 days — the log begins 20 Sep"); Across-projects rows "2 of 2 connections saved · bar scaled to curator's 6"; the Journal fold names its work-stream; harness estimate names "instruction files such as CLAUDE.md or AGENTS.md". (e) docs: user guide widget section rewritten, latest rule corrected (the v3.72.3 mtime caveat is gone), API reference (and an older section's wrong field names fixed), llm-docs x2, architecture/roadmap/decisions/mac-app/product-overview (old widget walkthroughs marked as pre-v3.74.0 history), README. **PROCESS.** Design Opus 5.5 (read-only; two layouts, the maintainer picked A); a read-only two-harness audit Opus 5.5 (G1–G10 + test plan S0–S5); builders Opus 5.5 — data (19 + 9 + 6 mutations), menu (20 + 5 + 1 mutations), parity (14 + 4 + 1 mutations), each in its own worktree; docs Sonnet (four sub-writers; the coordinator stalled and the orchestrator committed). Orchestrator hand mutations, each restored by copy and shasum-verified: data — the cross-tool check disabled → test-cli-curator red (warning, previous.md byte-identity, `previous` read); menu — `familyOfModel` dropping the minor version → test-tray-shell red ("opus-5" for opus-5.5); parity — the route dropping `?previous=1` → test-next-memory-projects red. Screen review on an isolated copy (port 3481) of the real projects domain: sidebar Active curator/conduit/field-notes/ott ("Antigravity + Claude Code"), Idle lumina/projects/posts; ott Memory "AGENT CONNECTIONS · last 5 days · log begins 20 Sep", "Saves by tool: Antigravity 2 · Claude Code 2", "Journal · antigravity"; Settings wording defect found and fixed ("2 of 6 connections saved, the busiest project" read as if conduit were busiest). Real-menu photographs on the maintainer's menubar (dev build from the integration worktree, isolated copy, separate Electron user-data dir; the notch hid the icon until the installed app was quit): light and dark, approved ("much more clean and clear"). This row Sonnet. **KNOWN AND UNFIXED.** The warning arrives after the loss — prevention lives in the skill rule, which only works when the skill loads (v3.52.0 measured skill-only activation 0/4 on Claude Code; Antigravity activated unprompted in S3 but still chose `main`); a save with no harness named gets no warning; the Copy-agent-instructions template still says `main` (frozen, measured); no Antigravity hook adapter / doctor row / harness-table entry; the handover line repeats the tool name (`Antigravity ← Claude Code`) because a disclosure test requires both; nested tray submenus beyond one level were not photographed; the 60-pair index cap is still applied by mtime before the `writtenAt` sort; S5 (two Macs) not yet run; three long docs keep the old widget walkthrough as marked history rather than rewritten. **VERIFICATION: 260 offline suites, 260 passed / 0 failed; 282 total (260 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |
| `v3.73.0` | **Delete domain and delete project are now server-confirmed and recoverable — after the maintainer accidentally deleted the whole `projects` domain on 2026-09-25 with one click (recovered only from a GitHub sync backup; raw/ was not in it).** Before: DELETE /api/domains/:domain took no confirmation (it lived only in the view, so any other client skipped it) and deleteDomain() was rm -rf; project delete was rm -rf too. Now: the route and deleteDomain() both require `{confirm}` equal to the slug exactly (400 confirm_required, same shape as the project route; slug chosen over display name — unique, it is the folder that goes, no case/space/look-alike ambiguity); deleteDomain takes the cross-process file lock (409 file_lock while an MCP write is in flight — previously a race); the folder MOVES to <user data>/.curator-trash/domains/<slug>--<UTC stamp>/ (paths.js getTrashDir, outside domains/ so Personal Sync never sees it; also in .gitignore and DOMAINS_GITIGNORE_RULES; same-second collision gets -2; cross-volume = copy then remove, a failed copy leaves the original); project delete moves to .curator-trash/projects/<domain>--<project>--<stamp>/ and returns trashPath; the confirm card has a type-to-confirm input, button disabled until exact match, fresh counts from new GET /api/domains/:domain/delete-preview (pages, projects with Memory, conversations, raw sources — raw called out as never synced), names the trash; the success message got its own slot at the top (it used to render ~3,800px down inside the next domain's Health section, or vanish when the last domain was deleted); the typed word no longer renders uppercased (also fixed on project delete, a v3.48.0 defect). Restore is MANUAL this release (documented). No MCP/CLI path deletes a domain (checked). Tests isolated: test-next-memory-projects.js used to isolate only the domains folder (project delete would have written real trash) — fixed; seven live test-beta* suites cleaned up via deleteDomain — now remove their own fixtures. PROCESS: Builder Opus 5.5 (15 mutations, all red; one masked-by-design: the route check alone is covered by the brain re-check). Orchestrator hand mutation — deleteDomain `rm` instead of moveToTrash — red in test-route-write-guards.js (trashPath / every file in the trash byte-for-byte / trash outside domains/), restored by copy, shasum-verified. Screen review on an isolated copy of the real projects + research domains: the card read "767 pages … Memory of 6 projects … 4 saved conversations and 35 raw source files", Delete disabled for "Projects", enabled only for "projects"; after delete the trash copy diffed identical to the source (0 differences) and a manual move restored the domain. This row Sonnet. KNOWN AND UNFIXED: no Restore button; nothing empties the trash; single-document delete's confirm is auto-filled by the view (not typed); no guard stops a future suite writing real trash; domain identity colours are index-based, so deleting (or adding) a domain recolours the others (pre-existing); the uppercase-label CSS fix has no test. **VERIFICATION: 259 offline suites, 259 passed / 0 failed; 281 total (259 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |
| `v3.72.3` | **A docs-only release: the user guide, the LLM-facing memory doc and the continuity skill now explain scopes — the maintainer's own standing gap, since scopes existed since v3.65.1 with no worked explanation of how to organise them.** `docs/user-guide.md` gains "How to organise your work-streams (scopes)" inside "Memory — the brief, Handoffs and the Journal" (`#how-to-organise-your-work-streams-scopes`, with sub-anchors `#several-agent-tools-on-one-computer` and `#do-i-need-both-claudemd-and-agentsmd` and `#how-do-i-build-from-two-computers`): the five words side by side (brief, scope, machine, handoff, Journal), a mermaid diagram, what a save does in four cases, six naming patterns each with the exact line to paste into a brief (one stream, one scope per session, one scope per work-stream, several computers, several agent tools on one computer, handing a session over), the two questions the maintainer is asked most (CLAUDE.md vs. AGENTS.md for Claude Code and Antigravity; building from two computers — code travels by the project's own git remote, working state by Personal Sync), and three worked examples. `llm-docs/curator-agent-memory.md` gains the same ground as three Q&As, sized to about 83% of its token budget. `skills/curator-continuity/SKILL.md` gains one pointer line in §8 to the new guide section — no behaviour change; the maintainer re-uploads the skill by hand. **Honest labels kept:** Antigravity reading `AGENTS.md`/`GEMINI.md` is stated as vendor-documented and unmeasured by The Curator; an edited pointer block is marked unmeasured against the app's own frozen, measured copy; the **Copy agent instructions** template stays frozen and still reads `main`, unchanged by this release. **PROCESS.** Builder Opus 5.5 (docs only); the orchestrator's own draft was corrected seven times before the builder's version was accepted — scopes are also created by `my-curator save --scope`, not only by an agent's save call; the Journal is per handoff, not per project; `latest` is chosen by file mtime, not by save time; installed hooks target the newest scope, so two agent tools on one computer need `--scope` added to that tool's own hook commands; the frozen **Copy agent instructions** template clashes with an identical pointer if both are pasted; "harness" was misspelled in a heading; `latest` is the right call for a hand-over but the wrong one for parallel work. A parallel read-only two-harness audit (Opus 5.5) supplied the Antigravity facts, unmeasured and labelled as such. This row Sonnet. **KNOWN AND UNFIXED.** `latest` orders by file modification time, so after a Personal Sync pull an older handoff can be opened as the "newest" one — a fix is in progress for the next release. There is still no Antigravity hook adapter, no Antigravity row in `my-curator doctor`, and no Antigravity entry in the harness table. Harness names stay free text, so spelling drifts between sessions and tools. **VERIFICATION: 259 offline suites, 259 passed / 0 failed; 281 total (259 OFFLINE + 15 LIVE_CI + 7 LIVE_LOCAL)** — the orchestrator re-checks. |

- **Version:** 3.73.0
