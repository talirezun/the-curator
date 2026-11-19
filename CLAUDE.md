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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **249 rows**, back
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
| `v3.99.2` | **Every error is plain words: what happened, whether anything was lost or charged, and the one next step, with the technical text underneath for support; Sync and Shared Brain get Replace token; every message is in a published catalogue.** **Why.** A user's Sync page showed, as the whole error, `Command failed: git --git-dir="…" --work-tree="…" pull --no-rebase -X theirs origin main fatal: could not read Password for 'https://***@github.com': Device not configured` (2026-11-19). GitHub had rejected his expired token; `friendlyError` matched "could not read username" but not "…password", fell through to the raw text, and the only way to change a token was Disconnect (which deletes the sync history). The owner asked for a GLOBAL fix: non-technical people must understand every error. An inventory found 228 sites in 19 route files passing raw `err.message`, raw provider SDK text (`401 {"type":"error"…}`) on Ingest, Chat, Compile and Settings › Verify AI connection, "Failed to fetch" when the server is down, `Unexpected token '<'` when the screen is newer than the running server, fs errnos with full home paths, HTML stack pages for bad request bodies, and a stack trace in the Mac app's fatal dialog. **What.** (1) **One catalogue** (`src/public/next/shared/user-errors.js`, shared by browser and server): anchored raw-machine signatures, 3-part sentences, per-area and per-surface wording (`SURFACE_MESSAGES`, sync `context`), codes. (2) **Translate only at the exit, never change a thrown `err.message` in `src/brain`** (code branches on that text: llm.js is429/503, ingest-queue `classifyTransientError`, sync.js, sharedbrain): `src/brain/user-errors.js` (`toUserError`, `sanitizeDetail`, a per-request `res.json` wrapper `userErrorBodies` that rewrites ONLY text matching a signature, `apiNotFound` = JSON 404 `api-route-missing` for unknown `/api`, `apiErrorHandler` = JSON 400/413 for bad bodies) installed in server.js; SSE frames, job wires (ingest-queue `toWire`, the manifest on disk keeps the raw text), Verify AI connection, duplicate-job, memory/mcp-install bodies translated at their exit; the browser's `shared/net.js` (fetch rejection → "The Curator isn't responding…", HTML-as-JSON → "updated but the previous version is still running", aborts untouched) and every view converted; desktop dialogs plain, the fatal stack written to curator.log before the dialog. A deliberate sentence that embeds an fs error keeps every word ("received (and charged)", "Nothing was changed", "orphan") and only the raw fragment becomes a clause. (3) **The support line**: "Technical detail (for support): <detail> (code: <code>)", visible, smaller, never behind a chevron; `detail` scrubbed by URL credentials → `scrubSecrets` → home paths → `scrubPaths`, capped after scrubbing; only catalogue codes are shown. (4) **"Not charged" / "nothing was changed" only where the error class or the code proves it** (key/credit/too-long refusals; a timeout may still bill; an unreadable answer was charged). (5) **Sync**: `GIT_TERMINAL_PROMPT=0`; the incident text → `sync-token-rejected`; 401/403 matched only where git prints them (`returned error: N`, `HTTP N`, auth phrases), never sideband counts; **Replace token** (`POST /api/sync/token`) checks the new token BEFORE saving (github.com: `GET /repos/{owner}/{repo}` requiring `permissions.push`, following same-origin redirects for renamed repos; other hosts: `git ls-remote`), updates origin + `.sync-config.json` (0600, atomic), keeps history, rolls back honestly (`sync-token-save-partial` when it cannot). (6) **Shared Brain Replace token** (owner's decision): `POST /api/sharedbrain/:id/token`, role rule (read-only member: read; contributor/admin: push), changes only `github_pat`, registered as a write for the whole check; panel on the domain section, the mirror strip and the full card, opening itself on a rejection. Read-only members are told truthfully how to become a contributor (leave and join again with the same invite: a new member identity). (7) **Published catalogue** `docs/errors.md` and `llm-docs/curator-errors.md`, generated by `scripts/build-error-catalogue.mjs` from the app's own sentences (`--check`; `test-error-catalogue.js` fails on drift). **Measured / proven.** Census: every deliberate string literal in routes/brain/mcp/public classifies as null (46,828 in the auditor's count) plus a template fuzz (34,561 renders, 0 hits) and 1,789 templates with real EACCES/ENOSPC/ENOENT/EPERM texts keeping every money/state word; real error objects (Anthropic/Gemini SDKs against a local stub, triggered fs errnos, real git over HTTPS against a fake GitHub with Basic auth); 100+ mutations across the suites, each red for a behavioural reason. Screen check on an isolated demo rig: Robin's exact case against real github.com (plain sentence, masked detail, Replace token open with focus; a bad new token refused, both places unchanged, not logged), a fake Anthropic key on Verify AI connection, the server stopped, a Shared Brain admin with a rejected token (panel opens, bad token refused, config unchanged, 0600). **Review.** Inventory and design by Opus; two independent Fable 5.2 audits (first: SHIP after 2 majors: an fs fragment erased "(and charged)", and admin advice the app refuses; second: SHIP after 2 majors: renamed repos broke Sync's token check, and Cancel stranded a read-only member); all majors and minors fixed and re-tested. **KNOWN AND UNFIXED.** Older Sync classifications give a wrong next step: GH006 protected branch, GH013 push protection and files over 100 MB say "Pull first"; HTTP 429/500 and SSL errors say "check your internet"; an SSO-blocked push/pull gets scope advice (Replace token's own check has an SSO sentence). A folder literally named "HTTP 401 notes" can still read as a token problem. GitHub's `permissions` may reflect the user's role rather than a fine-grained token's scope (unmeasured without a real token; the next push still catches a read-only token). On non-github.com hosts the check's token is on git's argv for up to 30 s. No in-place read-only → contributor upgrade. On an adopted sync git dir the other install's `.sync-config.json` keeps its old token. Two on-screen errors with the same sentence share one remembered detail. The Electron dialogs were not seen in a running Mac app (text covered by tests; CI builds the DMG). **The owner must re-upload EVERY `llm-docs/` file to Lumina, including the NEW `curator-errors.md`.** **VERIFICATION: 345 offline suites, 345 passed / 0 failed**; CI at release. |
| `v3.99.1` | **Chat no longer lets one oversized page crowd out the small pages that hold the answer: when the reading budget is full, a long page can be read in part to make room for a page at least as relevant.** **Why.** Owner test, 2026-11-14: in a real 1,008-page domain a 50.5 KB linked overview filled 59.9 KB of chat's 60 KB budget, so the small architecture summary and concept page holding the answers were never read. Three earlier designs (reordering, deferring pages over 12 KB, relevance-ordered linked summaries) were withdrawn after independent audits proved right answers turning wrong (see v3.98.2), and so was a first digest design (an audit found 3 Gemini right-to-wrong cases, among them a 38 KB entity page shortened because "Režun" did not match `tali-rezun`). **What** (`chat.js` `withDigests`, `digestPage`). Today's whole-page pass runs unchanged; when everything fits, or nothing new would be admitted, the prompt is byte-identical. Otherwise a loaded page over 12,000 characters is read in part only to admit a skipped page scoring at least as high; nothing scoring below a shortened page is admitted; never shortened: the top-scoring page, a pivot entity page, or a page the question names (diacritics folded, possessives stripped); at most 3 per question. The shortened copy keeps the opening, the whole Key Facts, short sections, Key Takeaways, then the items best matching the question, in page order; gaps are a bare "…" and the selection note says "in part". **Measured.** Answer text present in the loaded content, 1,188 labelled questions from six real domains (kept outside the repo): 766 to 795, 0 lost. Real answers, 2 runs per side on every changed selection plus fixed cases: Gemini 3.5 Flash Lite 421 to 469 of 636 correct runs, solar-pro4 386 to 440; zero questions right in every run before and wrong in every run after, on either model (candidates re-run 6 per side). The owner's AgentLink questions (contracts, inline file size, EVM library) went wrong to right; Lumina pricing, the AgentLink v0.1.1 and v0.4.12 release numbers and the SIQ questions stayed right. Entity sweep over 1,417 entities: 0 entity pages lost. Mentions of the mechanism in answers: 0. Timing on real domains 12 to 18 ms. **Review.** Independent Fable 5.2 audit with its own 694 questions on facts deep inside the 42 pages over 12 KB: answer text 372 to 388, 0 lost (was 9 lost on the first design); target pages read in part dropped from 274 to 27, the answer line kept in all 27; 6,066 title queries, 0 budget or 50-page-cap violations; the earlier regressions now produce prompts byte-identical to v3.99.0 or answer correctly; the 50-page cap in the second pass is now guarded by a test. **KNOWN AND UNFIXED.** One AgentLink question whose answer is in no loaded text ("--harness") went from 4 of 4 to 1 of 4 on Gemini: with seven pages loaded instead of four the model more often says the option is not in the pages. Room left after the second pass is not given back to a page read in part. Chat still matches words exactly. **VERIFICATION: 333 offline suites, 333 passed / 0 failed**; CI at release. |
| `v3.99.0` | **Six fixes for wikis people rely on: Sync never drops a record written on another computer, ingest never charges for a run that cannot finish, a non-UTF-8 file is named instead of silently garbled, a follow-up document updates the existing pages it changes, Health merges repoint every link form, and very large wikis no longer freeze.** **Why.** Owner's list of urgent and important defects, 2026-11-14 (most from the v3.96.2 foreign-vault test and the v3.98.0 work). **What.** (1) **Sync** (`sync.js`, new `sync-records.js`): `git pull -X theirs` kept only the other computer's appended lines in `.raw-manifest.jsonl`, `.health-dismissed.jsonl`, `log.md` and state journals (reproduced; the same-model no-call rule then forgot a read file and charged again). After git's merge, `reconcileRecordFiles` rebuilds each record file both sides changed from base, ours and theirs (keep ours, remove what theirs deleted, add what theirs added), as raw bytes, with per-line endings and record counts kept; a `log.md` record is a whole `## ` entry (fences ignored); committed on top, no history rewrite; a crash between merge and reconcile heals on the next pull when nothing was committed on top. Wiki pages and `index.md` still take the remote version. (2) **Ingest safety** (new `ingest-preflight.js`): `assertIngestCanWrite` runs before the raw copy and any paid call, read-only, and refuses with "Nothing was sent to the AI and nothing was charged" when a folder is a file, `log.md`/`index.md`/the summary is a folder or symlink, or a folder is read-only; a missing `log.md`/`index.md`/page folder is created. After the calls nothing paid is thrown away: an unsaveable page is a named warning, link tidy, summary sync, index and log failures are warnings, and only when no page can be saved does the ingest fail, saying the calls were charged. (3) **Encoding** (`text-decode.js`): valid UTF-8 is read byte-identically; a UTF-16 BOM is decoded; anything else gets the old read (U+FFFD for bad bytes) plus a warning naming the file: save it as UTF-8 and ingest again. A statistical single-byte guesser was built and WITHDRAWN: an independent fuzz found 2,559 wrong letters in 43,742 samples (e.g. Czech "Kč" as "Kè"), and the rule is never a wrong letter where the old read gives a replacement character. raw/ keeps the original bytes. (4) **Compounding** (new `existing-facts.js`): a hard-data source that names existing pages (distinctive names, diacritics folded, headings and table cells counted, common words and number-only names never, no frontmatter, no secrets, no reads outside the wiki or through symlinks) gives the page step a bounded excerpt of those pages' facts (at most 6 pages, 8 lines each, 4,000 characters) and asks for new or changed facts with their version and the earlier value ("As of v1.5: port 7113 (was 7103)"); nothing old is removed. Only strong pages are forced into a plan; a well-formed empty reply means unchanged (no retry, no stub), an unreadable one is a named warning. Prose sources and first ingests send byte-identical prompts. Measured on a v1 to v1.5 changelog, port on the existing page before to after: Haiku 5.5 0/9 to 8/9, solar-pro4 1/9 to 7/9 then 3/3, Gemini 3.5 Flash Lite 0/9 to 3/3; timeout 9/9 and 3/3; a replaced endpoint is weak (0 to 5 of 9); 0 old lines lost. The estimate prices the excerpt, two extra batch calls and the summary-only retry; quotes stayed above every bill in independent live runs. (5) **Health links** (new `health-links.js`): a merge that deletes a page now repoints `[[x#Heading]]`, `[[x#^block]]`, aliases, table aliases `[[x\|a]]`, embeds, `[[x.md]]`, markdown links in every style (relative, root, bare, %20, angle, titled, without .md), reference definitions (only a single .md destination), canvas node files and text cards, and frontmatter property links, writing `[[folder/x]]` when a bare name would reach another folder's page (ingest's link tidy keeps that prefix); case and Unicode variants only when exactly one page matches loosely across all folders. One shared CommonMark code detector (fences, indented blocks, inline spans that never cross block boundaries) is used by the scan, the fixes and every merge: a link inside code is never counted and never rewritten (a page linked only from code may now show as an orphan, review-only). Every write goes through the Health undo copy. (6) **Large wikis**: on a 22,000-page vault a scan went from 12.6-22.9 s with a 7.9-8.7 s freeze to about 4.3 s with freezes of 65-77 ms (`hyphenVariants` was O(n^2)); Find duplicates 203-299 s to 8-12 s, bounded memory, progress on the row, capped at the 100,000 most alike pairs (the exact prefix of the uncapped list) with the wording in the Compare confirm; scan and pair output byte-identical to v3.98.3 on a 3,511-page real copy. (7) `test-next-mcp-bridge-page.js` no longer fails between 00:00 and 04:00 local. **Review.** Independent Fable 5.2 audits of every part, several rounds each with their own torture cases; each final verdict ship. **KNOWN AND UNFIXED.** Not converted: Windows-1250/1252 and other single-byte files (warned instead). Compounding: a replaced endpoint often lands only on the new summary; the same record edited differently on two computers keeps both. Sync: a crash between merge and reconcile followed by a local edit loses that computer's line, as before; a computer on an older version merges the old way until it updates; a 3 MB manifest changed on both sides takes about 4.8 s. Health: HTML `<a href>`, `x.md?query` and links in HTML comments or math are treated as text; Find duplicates still compares every name pair (about 12 s at 20,000 pages). The chat section-digest change was still in measurement at release and is not in this version. Re-upload every `llm-docs/` file to Lumina and the my-curator skill. **VERIFICATION: 332 offline suites, 332 passed / 0 failed**; CI at release. |

- **Version:** 3.99.1
