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
- Find duplicate pages remembers answers per domain outside `domains/` (`duplicate-checks.js`), bound to pages, model, prompt and openings; batch merge is server-checked: a remembered high-confidence answer AND `isSpellingVariant`; `isMergeableSlug` is the one test for candidates and merge.
- Every merge that deletes a page composes through `page-merge.js`: the kept page is the base, the rest moves verbatim under `## Merged from <slug>`, and `findLostLines` refuses a delete that would lose a line.
- Wiki health keeps its nodes across a paint (`shared/morph.js`) and follows the press rule: the pressed control answers, a question and an outcome appear on the row, nothing above moves, focus never lands on `body`; `scripts/e2e-wiki-health.mjs` holds the thresholds. Free repairs that delete nothing run on press.
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

**This table is this project's memory.** The **3 newest releases** are below in full. Every earlier release — **233 rows**, back
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
| `v3.92.0` | **Wiki health answers when you press: the button responds, the result appears on that row, and the page stays still.** **Why.** The maintainer, 2026-11-05, on v3.91.0: "you don't know if something broke, everything moves around, you don't know where you are". This is the first release of a redesign approved as Direction A (three lanes and a review desk), staged because `main` auto-updates real machines. It changes behaviour on today's layout; lanes, the desk and new labels come next. **Measured root causes (read-only study, demo domain).** Every paint replaced the whole section (focus on `body` after 22 of 22 actions; one merge was 7 paints); questions and outcomes had fixed slots (a confirm 641 px away and off-screen, a banner at y=-68, 0 live regions); Health is the last section, so shrinking clamped scroll. **Stage 0.** `shared/morph.js`, a keyed patch inside `.dm-health`, plus event delegation, degrading to full replacement on failure. Across 41 mouse actions: whole-section replacements 145 → 0, nodes kept 2% → 94%, 7.6 ms for 1,257 nodes; pixel-compared against the old build. `overflow-anchor: none` because surviving nodes enabled browser scroll anchoring (250 px at 375). **Stage 1, the press rule.** The pressed control answers in its own label, width locked; a question opens under the row with focus in it; the outcome is on the row and the Health banner is gone; rows hold, then collapse; counts change in place; focus goes to a named target; a failure stays on the row with Try again; one polite live region, `aria-busy`. Skip, Dismiss and Restore are real buttons. **Owner decision:** free repairs that delete nothing run on press, reversing "every Fix all is gated"; `crossFolderDupes`, `hyphenVariants` and a deleting Fix-safe still ask. **Harness.** `scripts/e2e-wiki-health.mjs` (LIVE_LOCAL), a per-frame sampler with a recorded baseline and per-stage thresholds; the browser's `layout-shift` read 0 on a 640 px move, so it is not used. Worst case, before → after, across 1280, 375, 800, light, reduced motion and a 4,634-page domain: pressed control changes never → 71 ms; landmarks above the row 307 → 0 px; scroll 99 → 0 px; outcome distance 1,053 → 194 px; focus on body yes → no; overflow 247 → 0 px. **An independent reviewer on a copy of real domains** found what the suites could not, all fixed: an outcome shown on the wrong domain after switching at once (`takeHealthNote` used activeSlug); a stale delete warning after leaving and returning ("4 pages will be deleted", server 0); lost focus on Discard; a stale check time; one link listed twice; a keyboard ring hidden by `.btn-secondary`'s shadow; a truncated trace. Paint on the real copy 17-33 ms. **Also.** `writeFileAtomic`'s temp name is fixed length (`.tmp-<pid>-<counter>-<8 hex>`), so a 244-character page name no longer fails (`scripts/test-atomic-write-long-names.js`, 35 assertions). **KNOWN AND UNFIXED.** The reviewer's single harness run with 13 failures was never reproduced (two related causes fixed; 3 clean runs since, cause unconfirmed). The fixes after review had no second pass on real data before the maintainer's try-out. Choosing a file in Ingest still shifts the page. Not run with VoiceOver or Safari or Firefox; not driven in the Electron app. No Undo on a leaving row. The preview gate is still browser-only (Stage 3), the badge and old words remain (Stages 2-3), recount after merge stays slow (Stage 4), Compare all and families are Stages 5-6. Other temp-name builders (`mcp-install.js`, `write-registry.js`, `instance-probe.js`) do not touch page names and were left. **VERIFICATION: 306 offline suites, 306 passed / 0 failed**; keyed-patch 77/0 and harness 1811/0 at their last runs before the combined build; CI at release. |
| `v3.91.1` | **A merge no longer loses text: the page you keep really is kept, and everything the other page said moves onto it.** **Why.** The Wiki health design study, 2026-11-05, reproduced by the orchestrator: `fixSemanticDuplicate` based the result on the LONGER page and added only the other page's bullets, so the shorter page's opening and every non-bullet section vanished, and when the removed page was longer the kept page's own title, frontmatter and prose went too. "Keeps X" chose a file name, not the text, and Flip only changed the name. An old defect (no archived row gives a reason for longer-wins; it dates from the v2.2.0 draft), not new in v3.91.0. **What.** `src/brain/page-merge.js` is the one composer for every delete-after-merge path: `fixSemanticDuplicate`, `fixHyphenVariant`, `fixCrossFolderDupe`, batch merge, the MCP's `fix_wiki_issue` and the repair scripts (`repair-wiki.js`, `fix-wiki-duplicates.js`, `fix-wiki-structure.js`). `mergeBulletSections` is removed; all its callers were deleting merges. The kept page is the base: frontmatter, title and opening stay; tags union; bullets go into same-named sections; everything else moves verbatim under `## Merged from <removed-slug>`, headings one level down (the one non-verbatim edit, because an incoming `## X` would replace an existing section). A same-first-link bullet that `dedupKey` would have dropped also moves there. The removed page's `created`/`updated` are dropped; other conflicting frontmatter is kept as text. `findLostLines` refuses the delete at run time (`merge-would-lose-text`); `isSameFile` refuses a crafted keep equal to remove (`merge-same-file`), which deleted the only copy. Type normalising touches frontmatter only. Preview uses the same composer. **Tests.** `scripts/test-merge-keeps-all-text.js`: property test over generated page pairs through each deleting path, a spawned MCP server, and a hand-written cross-check; 17 mutations red. **Orchestrator, on a copy of a real 3,407-page domain:** 300 random pairs, 299 merged, 9,934 body lines compared, 0 lost, and on one merge through the real routes the preview equalled the written file. **KNOWN AND UNFIXED.** The 300th pair failed with ENAMETOOLONG before deleting anything: `writeFileAtomic`'s temp name overflows on a 244-character page name, an older defect left out of a hotfix because that helper writes every file (credentials included). Text lost by merges on EARLIER versions is not restored; it is recoverable only through git history with GitHub Sync. Merged pages may need tidying. The preview stops at 4,000 characters, so moved text on a long page can fall past it (the review desk stage shows both pages). A refusal shows the generic "failed validation on disk". Later ingests can still replace a kept opening, `deduplicateBulletSections` still drops same-first-link bullets on later writes, and `extractSectionMap` ignores fences. The preview gate is still browser-only: a direct `POST /fix` with no preview deleted a page in the study (Stage 3 adds the server check). Not clicked through in a browser; no on-screen wording changed. **VERIFICATION: 303 offline suites, 303 passed / 0 failed**; CI at release. |
| `v3.91.0` | **"Find duplicate pages" now finishes: it remembers its answers, shows how far it has got, asks the AI a much stricter question, and bulk merge is limited to spelling variants.** **Why.** A community user with a very large wiki, 2026-11-05: fixing every pair and scanning again finds more, for ever. Measured read-only on a 3,407-page domain: 36,333 candidate pairs, the 500-pair cap checks 1.4%, every answer was forgotten (merging 15 pages brings 40 new pairs into the next 500; 460 are re-judged and paid for again), and two scans of the unchanged wiki agreed on only 11 of 15. Worse, wrong pairs came back high confidence, the class offered for a page-deleting batch merge. The user guide's `rag` example could never become a candidate, and `neural-network` / `neural-networks` scored 0.735, under that domain's 0.927 cutoff. **What.** `src/brain/duplicate-checks.js`: one cache file per domain at `getDuplicateChecksDir()`, OUTSIDE `domains/`, so a scan still writes nothing to the wiki. An answer applies only to the same two pages (folder + slug), provider + model, prompt and reply format (hashed) and page openings, saved after each batch. A scan sends the top N UNANSWERED pairs; found pairs return free; nothing to send means no call and no spend; estimate, ceiling and confirm count only what is sent. Coverage (`totalPairs`, `checkedPairs`, `leftPairs`) on estimate, start, done and the MCP reply; new routes `GET …/semantic-dupes/status` (`?quick=1` skips the candidate pass) and `POST …/semantic-dupes/forget` (dismissals stay). Ranking: spelling variants first, a linear acronym pass. The golden fingerprint moved deliberately. **Prompt, chosen by measurement.** On 100 sampled real pairs, Opus 5.5 as a reference (not ground truth) said 30 same: old prompt on Flash Lite 61-68 same, 31-38 extra, 0 missed; relation prompt on Flash Lite 19-25, 4-6 extra, 9-17 missed, 20 flips between runs; on Haiku 5.5 32, 6 extra, 4 missed. Only relation `same` is a yes. Output limit 2048 → 6000 (Haiku overflowed 2048). **Bulk merge is deterministic.** Button "Merge N spelling variants": the SERVER requires a remembered high-confidence answer on unchanged openings AND `isSpellingVariant` (separators, case, a narrow plural), ignoring the client's fields; a lost cache refuses, the safe direction. **Live found what offline could not.** (1) The first prompt accepted about 40%. (2) A model naming a THIRD page as canonical remembered nothing, so one pair stayed unchecked and paid every scan: such an answer now counts, keeping the longer opening, then longer slug, then slugA. (3) 6 of 125 batches failed (output limit, bad JSON, wrong shape): those split in half, at most 2 levels; auth, quota, rate-limit and network do not. (4) `SLUG_RE` could not merge real names with underscores: `isMergeableSlug` is now the one test for candidates and merge, and a pair never shows a Merge it cannot perform. **View.** One state walk first (first scan → partial → previewed → merging → return → second scan → refused → failed → all checked → nothing found → corrupt file → mirror), one primary action by a fixed order, a status line and Check the next, 50 cards then Show more, saved pairs at once and "Counting the pairs…" while it counts, two sentences above the cards (the rest in the ⓘ), Check everything again as a real small button. The title counts open pairs. **Tests.** New `scripts/test-duplicate-checks.js` (337 checks) and extended view suites; about 80 mutations red across the rounds, several first green and exposing a weak test. Browser walk 169/169 at 1280 and 375, light and dark, on the commit before the title change; MCP walk over stdio. **Live on a COPY of real domains, Flash Lite:** per-scan acceptance 1.2-13.2% (was about 40%); a 944-pair domain reached "All 944" with 35 found; 4,615 of 36,332 checked on the largest, 0 failed batches over the last 2,000 pairs (106 calls, $0.08). The orchestrator reviewed the running app on that copy: Preview, single merge, a batch of 11, Show more, reload; 18 s recount, app responsive. Cache at 36,000 records: one save 61 ms, load 32 ms. Real wiki and config fingerprint unchanged. **KNOWN AND UNFIXED.** A recount of about 18 s after each merge on a 3,500-page domain (non-blocking; could filter incrementally). A merge leaves its row in `index.md`: pre-existing, reported by Health, repaired by Rebuild index. With every pair handled, the title still counts handled pairs. Flash Lite misses more and flips more than Haiku (docs say so; no model hidden). An index missing from a reply, or an unknown relation, re-bills that pair next scan. The estimate stays at 400 tokens per pair; on Haiku counts its token figure runs about 10-15% low, and the price is not measured. Only the configured model is recorded, not a fallback that answered. A full pass on the largest domain means about 70 scans at the default cap (about 100 minutes, about $1.70): Check all remaining and review by groups are the next release; stopping duplicates at ingest is a separate project. The "Preview rebuild" chip may overflow at 375, predating this. Not run on real Windows filenames. `test-beta15-production.js` (live) edited, not run. **VERIFICATION: 302 offline suites, 302 passed / 0 failed**; CI at release. |

- **Version:** 3.91.1
