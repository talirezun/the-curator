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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **219 rows**, back
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
| `v3.84.0` | **Summaries stop piling up Key Takeaways, link lists sort themselves by folder, and a broken summary says so — after a user's report on a Flash-Lite curation domain.** **Why.** A user ingesting with Gemini Flash-Lite 2.5 reported summaries with dozens of near-identical takeaways, concept pages listed under "Entities Mentioned", and summaries that read as broken with no warning. Investigated read-only by Opus 5.5 with a live reproduction; the real symptom, measured read-only on the maintainer's wikis: `projects` `summaries/curator-overview-1.md` held **935 Key Takeaways from ONE ingest**; summaries with more than 30 takeaways: articles 11, posts 19, projects 12, lectures 4. **(1) Takeaway pile-up (the root cause).** Every Phase-2 batch prompt lists ALL planned pages (that block must stay in the byte-stable prefix) and its JSON example began with a summary page; nothing filtered a batch's reply to the pages that batch requested, so a model that answered with every planned page wrote the summary once per batch, `reconcileGeneratedPages` folded the copies together, and `mergeWikiPage` unioned their Key Takeaways (reworded bullets survive the exact-text dedup). Every other page was paid for up to five times and all but the last copy thrown away. **Fix.** `filterBatchReply` (`src/brain/ingest.js`) keeps only the pages each batch was asked for: a page planned for another batch, or a summary a batch was not asked for, is set aside; a page planned by no batch is kept unchanged (today's handling); a set-aside copy is held as a reserve and used only where the owning batch returned nothing or only a stub, so the filter can never turn "written from a stray copy" into "missing". No user-visible warning for set-aside copies (stderr only — the warn-on-drop rule is about losing what the model produced, and the page IS written by the batch asked for it). The batch prompt SUFFIX (after the cache breakpoint) now states the exact page count, says every other page is written in a separate request, and its JSON example is the batch's own first path; the stable prefix is byte-identical (pinned in `test-ingest-coverage-v381.js` to its v3.80.0 digest). **Live, the same 40,939-char document.** Flash-Lite 2.5: before 33 takeaways, 29,258 output tokens, 4 of 5 batches returned the summary (and every page) unasked; after 5 takeaways, 10,489 output tokens, 0 of 7 batches. Haiku 4.5: 0 of 5 batches unasked, 7 takeaways, 11,987 output tokens, the prefix cached on batches 2-5 (12,628 tokens read each), $0.096. Haiku 5.5: 0 of 6, 8 takeaways, 16,265 output tokens, cached on batches 2-6, $0.013. **(2) Trunk pages and stubs.** The trunk-page injector ran after a single-pass ingest (under 15,000 chars) had already written its content, so it produced an empty stub, and its warning blamed the "originator-hint validator". Now: no stub after single-pass (a warning says the parent was not created), none when the parent already exists on disk as an entity or concept, a content-less plan-only page whose file exists is left as is, and the stub warning names the check that added the page. A stub SUMMARY now carries `Source: <file>` and is tagged `type/summary` (was `type/concept`, no source). **(3) Summary shape warning.** `summaryShapeWarning` reads the summary back from disk after the write and, when it lacks a `# Title`, a recorded `source:` or a Key Takeaways section with at least one bullet, adds one user-visible warning ("the AI did not follow the summary layout") that lands in "For review"; stubs are skipped (they carry their own). When the model wrote no `Source:` line at all, the uploaded filename is supplied. **(4) Summary slug collision.** `computeSummarySlugFromSource` is lossy (80-char cut, non-ASCII dropped, extension stripped), so two different files could merge silently into one summary. `resolveSummaryPath` now gives a DIFFERENT source the slug `<slug>-<first 6 hex of sha256(filename)>` with a "keeping both" warning, on positive evidence only (the raw manifest records that summary path for another filename and never this one, or — with no manifest record — the existing summary's `source:` is a filename with an extension that maps to the same slug); re-ingesting the SAME file still merges. **(5) Summary link sections (`src/brain/files.js`).** `syncSummaryEntities` now files each written page under the section its FOLDER names (entities under "Entities Mentioned", concepts under "Concepts Introduced or Referenced"); `injectSummaryBacklinks` and the scan's `missingBacklinks` read BOTH sections; `writePage` de-duplicates bullets AGAIN after its link rewrites (the first dedup ran before the folder-prefix / `.md` / variant rewrites that create identical lines), and `[[x]]` and `[[x|Alias]]` are one link for link-only bullets; Health's rewriters (`fixBrokenLink`, the AI broken-link apply, the merge repoint) go through `dedupRewrittenBullets` so a rewrite never leaves an identical line; `injectFrontmatter` matches `Source:` case-insensitively on summaries (and `**Source:**`). **(6) New Wiki Health category "Summary link lists" (`summaryLinkSections`).** One row per summary (`{ summary, duplicateLines, conceptsToMove, entitiesToMove, sampleConcepts, sampleEntities }`): a page listed twice, concepts under Entities Mentioned, entities under Concepts. Safe, deterministic, free, idempotent; in `AUTO_FIXABLE`, so "Fix N safe issues", `/fix`, `/fix-all` and MCP `fix_wiki_issue` all handle it (it runs LAST in fix-all-safe); NOT dismissible; empty on `shared-*` mirrors; added to `HEALTH_ISSUE_KEYS`. HARD GUARD (`summaryTidyGuard`): nothing is written unless the page's set of link targets and every line outside the two sections are exactly unchanged (`link-guard` otherwise); refusal reasons `summary-invalid`, `summary-not-found`, `already-tidy`, `link-guard`. Measured on COPIES of the maintainer's domains: articles 88 of 95 summaries / 1,034 lines removed, projects 64 of 65 / 2,407, **0 pages with a changed link set**, no non-summary page touched, second run finds nothing; scan 882 ms / 615 ms including the new check. **Side effect users WILL see.** After updating, "Missing backlinks" jumps (articles 4 → 338, projects 0 → 512) because concept pages listed under the concepts section now get their backlink from the summary, as the writer does; they are auto-fixable and "Fix N safe issues" clears them (both copies rescanned clean). UI: `views/domains.js` category "Summary link lists", row text `path` plus counts, in `countSafeFixable` and the Fix-safe confirm; the Ingest "For review" classifier recognises the layout warning. **PROCESS.** Opus 5.5 investigation with a live reproduction; builders PA (Opus, ingest), PB (Opus, links + Health + MCP + skill) and PC (Sonnet, UI) in disjoint file sets; builder mutations PA 6/6, PB 8/8, PC 4/4 red; orchestrator hand mutations and screen review on an isolated copy of the real data; docs by Sonnet. **KNOWN AND UNFIXED.** A planned page that NO batch returns (and no reserve copy exists) still vanishes silently. The prompt change is measured n=1 per model, on Flash-Lite 2.5, Haiku 4.5 and Haiku 5.5 only; `filterBatchReply` is what enforces the rule, the prompt only makes the model stop paying for pages it is told to drop. Slug-collision detection ignores summaries created by Compile and treats a title-valued `source:` as no evidence (those still merge). Only the FIRST section with each of the two headings is tidied. Differently titled sections ("Key Concepts") are not recognised. `syncSummaryEntities` moving a line shows no warning. NOT in this release: a duplicate source detected by content hash, a cross-type semantic-merge guard, merging already-duplicate summaries, condensing already-bloated Key Takeaways (existing piles stay until re-ingested or edited), and keeping source URLs / PDF links. **VERIFICATION: 286 offline suites, 286 passed / 0 failed** — the orchestrator re-checks. |
| `v3.83.2` | **Electron 43.5.0 → 43.8.3 in the desktop shell — the one advisory v3.83.1 recorded as KNOWN AND UNFIXED.** **Why.** `npm audit` in `desktop/` reported `electron` 43.0.0-alpha.1 – 43.8.0 as HIGH: eight advisories fixed in 43.8.3 — HID/USB permission checks attributed to the wrong origin (GHSA-fw47-9c62-h3vw), SameSite cookie restrictions not applied to windows opened from links (GHSA-2p8c-gr87-2676), pointer-lock permission requests attributed to the wrong frame (GHSA-x562-297c-g43g), extension `tabs.query` returning tab URLs and titles without the `tabs` permission (GHSA-98mx-cjp9-gchm), frame subscription and macOS off-screen rendering trusting GPU-supplied frame geometry (GHSA-3qxv-5xgr-q7w9, GHSA-h3v5-h239-pg29), `openExternal` permission requests attributed to the wrong origin (GHSA-997q-gvvc-jwmx), and a mitigation for compromised eMudhra intermediate certificates (GHSA-jr5w-w6x2-84p9). **Fix (Sonnet).** `desktop/package.json` `electron` 43.5.0 → 43.8.3 (exact pin, the minimal fix `npm audit` named; electron-builder stays 26.15.3, no semver-major); `desktop/package-lock.json` regenerated by `npm install`. `desktop` `npm audit` after: 0 vulnerabilities (the moderate electron-builder findings v3.83.1 listed are no longer reported). `desktop/README.md`'s install table and `scripts/test-desktop-packaging.js`'s exact-pin assertion now say 43.8.3; the 43.5.0 mentions in comments, the README's sample About panel, the version-identity fixtures and the docs record what was MEASURED on 43.5.0 and are left as history. **Build and isolated launch evidence.** Built as CI does (`npm run dist` with `CSC_IDENTITY_AUTO_DISCOVERY=false`, root `npm ci --omit=dev` first): `The Curator-3.83.1-arm64.dmg` (144 MB) and a 368 MB `.app` whose `Electron Framework` Info.plist reads CFBundleVersion 43.8.3 and whose app Info.plist reads 3.83.1; the afterPack version/ad-hoc-signature guard passed. The app was launched from its own binary with HOME, `CURATOR_TEST_USER_DATA_DIR`, `CURATOR_TEST_DOMAINS_DIR` and `--user-data-dir` all pointing at scratch directories (the shell picks its own free port and overwrites `PORT`): it listened on 127.0.0.1 only, `/` 200, `/api/config` 200, `/api/domains` listed the two demo domains, stderr held only the punycode deprecation warning and the expected no-API-key notice, and a kill of that one PID exited cleanly. **KNOWN AND UNFIXED.** The x64 DMG did not build locally (a network timeout fetching the x64 Electron; CI builds both architectures, and this change moves only the Electron version); the builder's screenshots came back black (no screen-capture permission), so the orchestrator rebuilt arm64, launched it isolated with --remote-debugging-port and captured the page through the DevTools protocol: one page, title "The Curator", user agent Electron/43.8.3, the demo workspace's Domains view rendered with no boot error; the audit job can still redden the badge when a new advisory lands (by design). **VERIFICATION: 283 offline suites, 283 passed / 0 failed** — the orchestrator re-checks. |
| `v3.83.1` | **Dependency security updates — nine packages, three of them HIGH-severity runtime dependencies, bumped the same way as v3.82.1 and v3.81.1; the audit job and the README's Tests badge had gone red again with every test green.** **The advisories (root `npm audit`, before: 6 vulnerabilities, 3 high / 3 moderate).** `body-parser` (HIGH, GHSA-27r3-jxmh-p828: denial of service via trailing bytes after a compressed request body), `multer` (HIGH, GHSA-q7qp-rjg7-q26m: denial of service via a pending asynchronous `fileFilter` after request teardown), `zod` (HIGH, GHSA-mrhx-c7xc-m3w5: memory exhaustion validating oversized constrained collections), `fast-uri` (moderate: four advisories — scheme spoofing via percent-encoded scheme decoding, improper path equivalence, host confusion via unchecked WHATWG host canonicalization, scheme injection via an unescaped first-segment colon), `hono` (moderate, GHSA-5r4p-p66f-jhc7: `serveStatic` decodes the path a second time, bypassing middleware), `ip-address` (moderate, GHSA-rxp7-6hxx-x8q5: `Address6` zone identifier matched in quadratic time). **Fix (Sonnet).** `npm audit fix`, no `--force`, `package.json` untouched (the diff shows only lockfiles): body-parser 1.20.8→1.20.9 and its nested copy under `@modelcontextprotocol/sdk` 2.3.0→2.4.0, iconv-lite (nested) 0.7.2→0.7.3, fast-uri 3.1.8→3.1.9, hono 4.13.7→4.13.14, ip-address 10.7.2→10.7.5, multer 2.4.0→2.5.0 (minor, runtime), qs 6.16.0→6.16.1, zod 4.3.6→4.6.7 (minor; reached only through `@modelcontextprotocol/sdk`). Root `npm audit` after: 0. `desktop/package-lock.json` (`--package-lock-only`): fast-uri 3.1.8→3.1.9, undici 7.30.0→7.30.1, node-gyp's nested undici 6.29.0→6.29.1. **Exposure, checked.** multer: `src/routes/ingest-queue.js` uses it with a `fileFilter` (.txt/.md/.pdf) behind the 127.0.0.1-only, cross-origin-guarded server, so the denial of service needs a local client to abort an upload mid-request — a local process could in principle stall the app, not a remote attacker. zod: no `src/`, `mcp/` or `bin/` code imports it; it arrives only inside `@modelcontextprotocol/sdk`, which validates the stdio tool-call messages of the user's own MCP client, so no user-controlled oversized collection reaches it from the network. body-parser/qs/hono/fast-uri/ip-address: nothing sets `trust proxy` and the server binds 127.0.0.1; hono is only the SDK's HTTP-transport helper, which the stdio server does not serve. Realistic exposure was low; the bumps remove the findings, not a demonstrated hole. **KNOWN AND UNFIXED.** `desktop/` keeps 1 HIGH finding: `electron` is pinned at 43.5.0 in `desktop/package.json` (eight advisories, fixed in 43.8.3 — wrong-origin permission attribution, SameSite not applied to link-opened windows, GPU-supplied frame geometry, and others) and clearing it needs a `package.json` edit plus a rebuilt, tested Mac app, so it is its own release; the audit job still shares the Tests workflow, so a new advisory can redden the badge with every test green (by design). **VERIFICATION: 283 offline suites, 283 passed / 0 failed** — the orchestrator re-checks. |

- **Version:** 3.83.2
