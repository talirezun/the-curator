# The Curator — Development Guide

This file exists so any new Claude session can immediately understand the project state, architecture, known issues, and active design decisions without re-reading git history or debugging from scratch.

---

## What This Project Is

The Curator is a local Node.js web application that ingests text sources (PDF, MD, TXT) and automatically builds an interconnected knowledge wiki. The wiki is stored as plain markdown files, readable by Obsidian as a visual knowledge graph.

**Core loop:**
1. User drops in a source → LLM reads it → writes wiki pages (entities, concepts, summary)
2. Each subsequent ingest updates existing pages instead of duplicating them
3. Obsidian reads the same files → renders a graph where nodes are entities/concepts, edges are `[[wikilinks]]`

**Philosophy:** Compiled knowledge (persistent wiki), not retrieval (RAG). The wiki compounds with every ingest.

---

## Directory Structure

```
src/
  brain/
    ingest.js     — main ingest pipeline (single-pass + multi-phase for large docs)
    files.js      — all filesystem logic: writePage (returns change records v2.5.0+), mergeWikiPage, syncSummaryEntities, injectSummaryBacklinks
    compile.js    — conversation compilation (v2.5.0): turns a chat thread into wiki pages via the same writePage pipeline
    llm.js        — LLM abstraction (Gemini or Claude, auto-detected via config.js)
    chat.js       — multi-turn chat against the wiki
    sync.js       — GitHub sync (git --git-dir / --work-tree)
    health.js     — wiki health scanner + auto-fix (broken links, orphans, folder-prefix, cross-folder dedup, hyphen variants, missing backlinks)
    config.js     — persistent config (.curator-config.json): getApiKeys, setApiKeys, getEffectiveKey, getDomainsDir
  routes/
    ingest.js     — POST /api/ingest (SSE streaming)
    compile.js    — POST /api/compile/conversation (SSE streaming, v2.5.0)
    domains.js    — domain CRUD
    chat.js       — chat endpoints
    wiki.js       — GET /api/wiki/:domain
    health.js     — GET /api/health/:domain, POST /api/health/:domain/fix[-all]
    sync.js       — sync endpoints
    config.js     — Settings/config endpoints (API keys, updates, domains path)
    mcp.js        — My Curator MCP wizard endpoints (config, claude-config, self-test, reveal-config)
  public/         — vanilla JS frontend (no build step; Settings tab hosts the MCP wizard, Health tab, onboarding wizard)
mcp/              — My Curator: local read-only MCP server that bridges the wiki to Claude Desktop
  server.js       — stdio-transport entry point (spawned by Claude Desktop as a child process)
  graph.js        — wiki parser: frontmatter, [[wikilinks]], backlinks, tag inventory (cached in-process)
  storage/
    local.js      — filesystem adapter; resolves domains path from arg/env/.curator-config.json/default
  util.js         — shared helpers: isValidDomain, isValidSlug, normaliseSlug, resolveNodeSlug
  tools/
    index.js      — tool registration hub + response-size guard (900 KB cap with progressive trim)
    domains.js, index-tool.js, search.js, nodes.js, connected.js,
    summary.js, cross.js, overview.js, tags.js, backlinks.js  — 10 tool modules
scripts/
  inject-summary-backlinks.js   — retroactive backlink repair for existing summaries
  fix-wiki-duplicates.js        — one-time entity/concept deduplication
  fix-wiki-structure.js         — one-time migration from non-canonical folders
  bulk-reingest.js              — re-ingest all raw files in a domain
  repair-wiki.js                — comprehensive wiki repair (cross-folder dedup, link normalization, backlinks)
  build-app.sh                  — rebuild The Curator.app from the AppleScript template
domains/
  <domain>/
    CLAUDE.md         — domain schema (system prompt for LLM)
    raw/              — uploaded source files (gitignored, local only)
    wiki/
      entities/       — people, tools, companies, frameworks
      concepts/       — ideas, techniques, principles
      summaries/      — one page per ingested source
      index.md        — master page catalog
      log.md          — chronological ingest history
    conversations/    — saved chat threads (gitignored)
docs/               — user-facing documentation
```

---

## Key Functions (files.js)

| Function | Purpose |
|---|---|
| `writePage(domain, relativePath, content)` | Normalise path → dedup passes A+B → cross-folder dedup (3b) → inject frontmatter → capture pre-write state → merge with existing → strip blanks → dedup bullets → strip folder-prefix links → normalize variant links (5c: entities + concepts + summaries, prefix-tolerant) → write → call injectSummaryBacklinks if summary → return `{canonPath, status, bytesBefore, bytesAfter, sectionsChanged, bulletsAdded}` (v2.5.0+; null on invalid input) |
| `compileConversation(domain, conversationId, onProgress)` | v2.5.0 conversation compile: load conversation → refuse if <2 user msgs → compute deterministic summary slug `<title>-YYYY-MM-DD-<4hex>` → refuse if file already exists at slug (idempotency guard) → single LLM call (system prompt = schema; user prompt = transcript + existing files + index) → write all pages via the same writePage pipeline → syncSummaryEntities → programmatic mergeIntoIndex (no LLM-driven index regen) → appendLog → return `{ok, title, pagesWritten, changes}` |
| `syncSummaryEntities(domain, summaryPath, writtenPaths)` | Post-ingest reconciliation: injects ALL written entity AND concept slugs into summary's "Entities Mentioned", then re-fires injectSummaryBacklinks with the complete list |
| `injectSummaryBacklinks(summarySlug, content, wikiDir)` | For each entity in "Entities Mentioned", injects `[[summaries/slug]]` into that entity's Related section; checks entities/ first, falls back to concepts/; creates the section if it doesn't exist |
| `deduplicateBulletSections(content)` | Safety net: removes duplicate bullets from all ACCUMULATE sections using dedupKey; runs after every write and after syncSummaryEntities |
| `mergeWikiPage(existing, incoming)` | Union merge: incoming is base, bullets from existing sections are injected (Key Facts, Related, Entities Mentioned, etc.) |
| `injectBulletsIntoSection(content, sectionName, bullets)` | Dedup-aware bullet injection: compares by link target; creates the section if it doesn't exist (uses 'im' multiline regex for existence check) |
| `stripBlanksInBulletSections(content)` | Removes blank lines inside bullet sections (LLM artifact) |
| `normalizePath(relativePath)` | Redirects non-canonical folders → entities/ or concepts/ |
| `injectFrontmatter(content, path, today)` | Extracts inline Tags/Type/Source → builds YAML frontmatter block |

## Key Functions (config.js)

| Function | Purpose |
|---|---|
| `getApiKeys()` | Read API keys from `.curator-config.json` (not `.env`) |
| `setApiKeys({ geminiApiKey, anthropicApiKey })` | Save API keys to `.curator-config.json` (partial update) |
| `getEffectiveKey(provider)` | Returns the active key for a provider: `.curator-config.json` → `.env` → null |
| `getDomainsDir()` | Resolved absolute path to the domains folder (config → env → default) |
| `getConfig()` | Returns `{ domainsPath, domainsPathSource }` for the UI |

---

## Ingest Pipeline Flow

```
POST /api/ingest
  → ingestFile(domain, filePath, originalName)
      1. Save to raw/
      2. Extract text (pdf-parse or readFile), cap at 80k chars
      3. Load domain CLAUDE.md schema + current index.md
      4. Read existing entity/concept filenames → pass to LLM prompt
         (prevents LLM creating lumina.md when lumina-ai.md exists)
      5. Single-pass LLM call (< 15k chars input)
         OR multi-phase for large docs:
           Phase 1: outline → [{path, summary}]
           Phase 2: batched content (BATCH_SIZE=4 pages/call)
           Phase 3: index update
      5.5 Deduplicate result.pages — multi-phase can return the same path in
           multiple batches; keep last occurrence per path (Map dedup)
      6. writePage() for each page:
           a. normalizePath() — canonical folder enforcement
           a2. Underscore → hyphen slug normalisation — two_worlds_of_code.md → two-worlds-of-code.md
           b. Pass A: title-prefix strip — dr-tali-rezun.md → tali-rezun.md
           c. Pass B: hyphen-normalised dedup — talirezun.md → tali-rezun.md
           c2. Step 3b: cross-folder dedup — concepts/google.md → entities/google.md
               (prevents duplicate files when LLM misclassifies entity as concept)
           d. injectFrontmatter()
           e. mergeWikiPage() if file exists
           f. stripBlanksInBulletSections()
           g. deduplicateBulletSections() — safety net for merge edge cases
           h. Strip [[entities/...]] and [[concepts/...]] folder-prefix links
           i. Step 5c: normalize [[variant]] links using Pass A+B+C logic
              Pass A: [[dr-tali-rezun]] → [[tali-rezun]]
              Pass B: hyphen-normalised match against entities + concepts
              Pass C: prefix-tolerant match across all wiki files (entities, concepts, summaries)
              Catches [[energy-and-water-footprint-of-generative-ai]] →
              [[summaries/the-energy-and-water-footprint-of-generative-ai]]
           j. writeFile()
           k. If summary page: injectSummaryBacklinks() (entities/ + concepts/ fallback)
           l. Return canonPath — the actual path written to disk (may differ from input)
      7. syncSummaryEntities() ← THE KEY POST-WRITE STEP
           Uses canonicalPaths (returned by writePage), NOT original LLM paths.
           This ensures redirected slugs (dr-tali-rezun → tali-rezun) appear
           correctly in the summary. Injects ALL entity AND concept slugs into
           summary's "Entities Mentioned" → deduplicates → re-fires
           injectSummaryBacklinks() with the complete list →
           ALL entities/concepts get bidirectional backlinks
      8. writePage(index.md)
      9. appendLog()
```

---

## Known LLM Compliance Failures (and how they're handled)

The LLM produces structurally valid but consistently incomplete output. These patterns recur across every ingest regardless of model:

| Failure | Frequency | Code fix |
|---|---|---|
| "Entities Mentioned" lists 5–7 entities while 20–30 entity pages are written | Every ingest | `syncSummaryEntities()` in post-write step |
| Entity slug hyphen variation: `talirezun` vs `tali-rezun` | Common | Pass B dedup in `writePage()` (filename) + Pass B in `injectSummaryBacklinks()` |
| Title prefix ghost files: `dr-tali-rezun.md` | Occasional | Pass A strip + redirect in `writePage()` |
| `[[dr-tali-rezun]]` written as a link in page content | Occasional | Step 5c in `writePage()` normalizes all variant links at write time |
| Folder-prefix links: `[[concepts/rag]]` instead of `[[rag]]` | Common | `writePage()` step h strips `entities/` and `concepts/` prefixes |
| Multi-phase returns same page path in multiple batches | Occasional | `result.pages` deduped in `ingest.js` before the write loop |
| Duplicate bullets in sections (from multi-write edge cases) | Occasional | `deduplicateBulletSections()` safety net on every write |
| Entity has no Related section — backlinks silently dropped | New entities | `injectBulletsIntoSection()` now creates the section if it doesn't exist |
| Summary truncated — missing "Entities Mentioned" section entirely | Occasional (large docs) | `syncSummaryEntities()` adds the section if missing |
| Blank lines between bullets in a section | Common | `stripBlanksInBulletSections()` runs on every write |
| Underscore filename from PDF name: `two_worlds_of_code.md` | Occasional | Step 1a in `writePage()` converts `_` → `-` in the filename |
| Cross-folder duplicates: `concepts/google.md` when `entities/google.md` exists | Common | Step 3b cross-folder dedup redirects to existing file |
| Slug mismatch: `[[international-energy-agency]]` but file is `iea.md` | Occasional | Prompt strengthened + Step 5c Pass C prefix-tolerant matching |
| Missing article prefix in link: `[[energy-and-water...]]` vs `the-energy-and-water...` | Occasional | Step 5c Pass C strips `the-`/`a-`/`an-` prefixes for matching |
| Semantic near-duplicates in Key Facts ("25 years" vs "30 years") | Common | NOT fixed — requires LLM or manual curation |
| Concepts filed as entities (llm.md, cli.md, open-source.md) | Occasional | Caught by manual review; no automated fix |

---

## Post-Ingest Quality Checklist

Run these after any ingest where results look wrong:

```bash
# 1. Ghost author links (LLM uses "talirezun" or "dr-tali-rezun")
grep -rl "\[\[talirezun\]\]\|\[\[dr-tali-rezun\]\]" domains/articles/wiki/

# 2. Folder-prefix link violations
grep -rl "\[\[concepts/\|\[\[entities/" domains/articles/wiki/ | grep -v index.md

# 3. Duplicate bullets in any section
python3 -c "
import os, re
wiki = 'domains/articles/wiki'
for root, dirs, fnames in os.walk(wiki):
    for f in fnames:
        if not f.endswith('.md'): continue
        path = os.path.join(root, f)
        c = open(path).read()
        if len(re.findall(r'^## Related\s*$', c, re.M)) > 1:
            print('DUPLICATE RELATED:', path)
"

# 4. Duplicate Related sections (created by buggy section injection)
grep -rl "^## Related" domains/articles/wiki/ | xargs python3 -c "
import sys, re
for p in sys.argv[1:]:
    c = open(p).read()
    if len(re.findall(r'^## Related\s*\$', c, re.M)) > 1: print(p)
" 2>/dev/null

# 5. Run retroactive backlink repair if needed
node scripts/inject-summary-backlinks.js --domain=articles
# or all domains:
node scripts/inject-summary-backlinks.js
```

**Fix ghost links globally:**
```bash
find domains/articles/wiki -name "*.md" | xargs sed -i '' \
  's/\[\[talirezun\]\]/[[tali-rezun]]/g' \
  -e 's/\[\[dr-tali-rezun\]\]/[[tali-rezun]]/g'
```

---

## Wiki File Conventions

**Three canonical folders only** — the code enforces this:
- `entities/` — specific people, tools, companies, frameworks, datasets
- `concepts/` — ideas, techniques, methodologies, principles
- `summaries/` — one page per ingested source document

**Link syntax** — always `[[page-name]]` without folder prefix, EXCEPT summaries which use `[[summaries/slug]]` because they live in a subfolder Obsidian needs for routing.

**YAML frontmatter** — every page gets it injected automatically by `injectFrontmatter()`. The LLM is instructed NOT to produce frontmatter. Type tags drive Obsidian graph coloring:
- `type/entity` → Blue nodes
- `type/concept` → Green nodes
- `type/summary` → Purple nodes

**Merge strategy** — bullet-accumulating sections (Key Facts, Related, Entities Mentioned, etc.) grow with every ingest. Prose sections (Summary, Definition) use the incoming LLM version (it had full document context).

---

## Obsidian Graph Setup

In Graph View → ⚙ → Groups:
| Group | Query | Color |
|---|---|---|
| Entities | `tag:#type/entity` | Blue |
| Concepts | `tag:#type/concept` | Green |
| Summaries | `tag:#type/summary` | Purple |

The vault root should point to `domains/<domain>/wiki/` (or a parent folder covering multiple domains). Use the Knowledge Base Location shown in the Domains tab.

**To check connections for a specific entity** (e.g. the author):
- Filter graph for the entity name
- Enable Orphans toggle to show unconnected nodes
- Every summary the author wrote should show as a purple node connected to the entity

---

## Git History of Major Fixes

| Commit | What it fixed |
|---|---|
| `7b54fa2` | normalizePath catches any non-canonical folder |
| `a998741` | EISDIR crash + entity title-prefix deduplication (Pass A) |
| `7f0213d` | Existing filenames injected into LLM prompt + deduplication at scale |
| `147d113` | Related dedup by link target + blank-line injection fix |
| `643d3c5` | stripBlanksInBulletSections runs on every write, not just merges |
| `8f77d33` | injectSummaryBacklinks() added — bidirectional backlinks for all entities |
| `c1b6567` | Hyphen-slug dedup Pass B + folder-prefix auto-cleanup + truncation warning |
| `b56b2d3` | Hyphen-normalised resolution in injectSummaryBacklinks (talirezun → tali-rezun) |
| `f4cb825` | syncSummaryEntities() + CLAUDE.md dev guide |
| `7589a15` | Step 5c: normalize [[variant]] links in page content at write time |
| `132b769` | deduplicateBulletSections() safety net + result.pages dedup for multi-phase |
| `b2fa124` | injectBulletsIntoSection creates missing section; multiline regex fix |
| `181157f` | Underscore → hyphen slug normalization in writePage() step 1a |
| `f9665b3` | Cross-folder dedup (3b), expanded step 5c (Pass C prefix-tolerant), backlinks cover concepts/, writePage returns canonPath, ingest uses canonical paths for sync |
| `1f11c25` | Settings tab, onboarding wizard, auto-update, stop/restart fix, .curator-config.json |
| `v2.1.0` | Remove Stop button + /api/shutdown; server runs until quit; update rebuilds .app; build-app.sh |
| `f80b2db` | Absolute node path in AppleScript — fixes "node: No such file or directory"; process.execPath in restart; CURATOR_NO_OPEN prevents double browser tabs |
| `c5eddef` | Auto-refresh UI state after ingest, sync, and tab switches — domain stats, wiki tab, and dropdowns update without manual browser reload |
| `v2.3.0`  | My Curator MCP — local stdio MCP server exposes 10 tools to Claude Desktop (7 retrieval + 3 graph-native: graph_overview, tags, backlinks). `mcp/` directory, `/api/mcp` routes, Settings-tab wizard with visual diff + self-test button. Existing wikis work as-is; no re-ingest required. Scalable-by-default responses (compact summaries + size guard); path-traversal hardening via `resolveInsideBase()` + slug/domain validators in `mcp/util.js`; `execFile` for reveal-config. Added optional step 4 to the onboarding overlay. |
| `v2.3.1`  | MCP response-budget correction. Dropped `MAX_RESPONSE_BYTES` 900 KB → 400 KB (~100 k tokens) so multi-turn conversations don't blow the context window on a single tool call. Reworked `get_connected_nodes` with `max_nodes` default 60, ranked by hop+degree, shorter previews, max depth 2: on the real 2116-node articles domain, depth-2 response dropped 575 KB → 39 KB. All other tools unchanged. See `docs/audits/2026-04-20.md` addendum. |
| `v2.3.2`  | Auto-updater made crash-resilient. Replaced `git pull origin main` with `git fetch origin main` + `git reset --hard origin/main` — plain pull aborted on end-user machines whenever `npm install` had regenerated `package-lock.json` with a machine-specific diff. Tracked files hard-sync to remote; gitignored user data (`domains/`, `.curator-config.json`, `.sync-config.json`) is untouched. Response now returns `from`/`to` short SHAs so the UI can show exactly what moved. |
| `v2.3.3`  | "Restart needed" detection across the UI. `/api/version` now returns `{version, onDiskVersion, restartRequired}` — compares the version cached at server startup with the current on-disk `package.json`. When these diverge (user ran the manual `git reset --hard` recovery but didn't relaunch the .app), three places surface it clearly: header badge turns amber and shows "v2.2.2 · restart" on hover; **Check for Updates** button displays "Files are updated (vX) but running app is still vY — please quit and relaunch"; the MCP section detects HTML coming back from missing `/api/mcp/*` routes (SPA fallthrough) and replaces the cryptic `Unexpected token '<'` JSON parse error with a plain-English restart prompt. |
| `v2.3.4`  | Ghost-domain fix after sync-delete. When another machine deletes a domain via sync, git-pull removes every tracked file but leaves empty directories behind (git doesn't track empty dirs), so the deleted domain's shell (`conversations/`, `raw/`, `wiki/`) appeared as a ghost in the Domains list. Fix: `listDomains()` in both `src/brain/files.js` and `mcp/storage/local.js` now requires a `CLAUDE.md` schema for a directory to count as a domain — ghosts and unrelated files (`Untitled.base`, stray `.md`) are filtered out. `sync.pull()` additionally prunes ghost directories after every pull by recursively removing any `domains/<name>/` that has no schema — sync-delete is now end-to-end. |
| `v2.3.5`  | Subprocess-PATH fix for auto-updater and sync. When The Curator is launched via the `.app` wrapper, AppleScript's `do shell script` starts the Node process with a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — enough to find `git` (in `/usr/bin` from Xcode CLT) but not `npm`, which lives next to Node in `/usr/local/bin` or `/opt/homebrew/bin`. Every subprocess spawned by the updater inherited this bare PATH, so `npm install` failed with `npm: command not found`. Fix: `SUBPROCESS_ENV` prepends the Node binary's directory plus common Homebrew/system prefixes to every `execAsync` call in `src/routes/config.js` (update + pick-folder + update-check) and `src/brain/sync.js` (all git operations). Same fix pattern as the absolute-node-path trick used in `scripts/build-app.sh`. |
| `v2.3.6`  | Updater partial-success recovery. Resolves the catch-22 where users on a pre-v2.3.5 running app couldn't install v2.3.5 because the npm-not-found bug was in the very updater trying to apply the fix. Now when `npm install` fails specifically with `npm: command not found` AND the `git reset` already succeeded, the endpoint returns `{ok:true, partial:true, from, to, warning}` instead of an error. The frontend surfaces the warning in the restart banner and proceeds with the auto-restart — which loads the fixed updater in the new process. Any OTHER npm error (real dependency issues) still re-throws and is reported normally, so we never auto-restart into a broken-deps state. |
| `v2.3.7`  | Accurate sync file counts in UI. Bug: after a big ingest, push reported "6 files synced" when ~200 had actually moved. Root cause: the fallback count used `git diff --stat --name-only origin/main~1..origin/main` AFTER the push, which only counted files in the most recent commit (typically a merge commit with a tiny delta) instead of the union of files across all unpushed commits. Fix: `push()` now counts `git diff --name-only origin/main..HEAD` BEFORE the push (union across every unpushed commit); `pull()` counts `HEAD..origin/main` after fetch-but-before-merge. Both return `{filesChanged, commitsAhead/Pulled, files: [preview]}`. Frontend now shows per-direction counts in bidirectional sync (e.g. "Pulled 5 files from GitHub, pushed 197 files to GitHub") and the pruned-domain list explicitly when a sync-delete propagated. |
| `v2.3.8`  | Onboarding fixes. (1) `install.sh` was calling `bash start.sh` on a file that was removed in commit `6b0889c` ("app lifecycle redesign") — fresh installs since then fell back to the "taking longer than expected" yellow warning instead of auto-launching. Replaced with `nohup "${NODE_PATH}" src/server.js ... &` using the absolute node path we already resolve at line 141. (2) `${INSTALL_CHOICE,,}` lowercasing syntax needs bash 4+; macOS ships bash 3.2. Replaced with `tr '[:upper:]' '[:lower:]'` so the interactive prompt works on clean Macs that don't have Homebrew's bash. (3) README version badge switched from `github/v/release/...` (reads GitHub Releases — stale at v2.1.0 because we push commits, not tagged releases) to `github/package-json/v/...` which reads `package.json` on `main` — auto-updates with every version bump. |
| `v2.3.9`  | Wiki Health "Fix" for missing backlinks now actually writes. Bug: clicking Fix returned `{ok:true, fixed:1}` but the flagged file was unchanged. Two root causes: (a) `injectSummaryBacklinks` only did hyphen-normalised resolution after the exact-entities check, so when both `concepts/email.md` and `concepts/e-mail.md` existed, `[[email]]` fuzzy-matched `e-mail.md` first (alphabetical `Array.find`) and the backlink went to the wrong file; (b) `fixMissingBacklink` was re-running the whole bulk-resolve machinery instead of using the scan's already-resolved `issue.entity`. Fixes: resolution order in `injectSummaryBacklinks` is now `entities/exact → concepts/exact → hyphen-normalised (entities then concepts)` — matching the scan's own logic; added `injectSingleBacklink(path, slug, title)` that trusts the caller-provided path; `fixMissingBacklink` now uses it with `issue.entity`. Verified end-to-end on the real articles domain: scan → Fix → rescan returns 0 missing. |
| `v2.4.0`  | Model-lifecycle safety net. Phase 0 of the AI Wiki Health roadmap. When a provider retires the pinned default model, every call would otherwise 404. Fix: `llm.js` now wraps `callProvider()` in a chain — primary → `FALLBACK_CHAINS[provider]` — triggered only on model-not-found errors (429/503 still go through the existing retry path). Module-level `_activeFallback` tracks which fallback is in use and is exposed via `getFallbackStatus()`. `/api/config/api-keys` response grows a `fallback` field; Settings UI renders an amber "Using fallback model — run Check for Updates" banner when populated. Verified end-to-end with `LLM_MODEL=gemini-nonexistent` override: chat, ingest, MCP, health, sync all still work; fallback logged + surfaced; clears automatically when primary returns. Full user-facing guide: `docs/model-lifecycle.md`. |
| `v2.4.1`  | Anthropic default switched from `claude-sonnet-4-6` to **`claude-haiku-4-5`** — Anthropic's low-cost tier, matching the cost profile of Gemini's `gemini-2.5-flash-lite`. Users who want higher quality can opt in via `LLM_MODEL=claude-sonnet-4-5` in `.env`. Anthropic fallback chain reordered: Haiku variants first (same cost tier), then escalates to Sonnet only if the entire Haiku family is gone: `claude-3-5-haiku-latest → claude-3-5-haiku-20241022 → claude-sonnet-4-5 → claude-3-7-sonnet-latest → claude-3-5-sonnet-latest`. |
| `v2.5.8`  | **Skill upload hotfix — strip XML-shaped placeholder from description.** First real install attempt on Claude Desktop surfaced a validator error: *"SKILL.md description cannot contain XML tags"*. The v2.5.7 frontmatter description included the trigger phrase `"put this in my <name> domain"` — Claude Desktop's skill-upload validator treated `<name>` as an XML tag and refused the file. (Claude Code's docs don't mention this constraint; Claude Desktop's upload UI is stricter.) Fix: replace `<name>` with the concrete example `projects`, and change `(entities/concepts/summaries)` separator from slashes to commas to be safe. Body left untouched — the validator only checks the description field, and the body's angle-bracket placeholders (`domains/<name>/wiki/`, `summaries/<title>-<hash>.md`) sit inside paragraphs and code blocks where they're not interpreted as XML. Users who hit the v2.5.7 error should re-download `claude-skills/my-curator/SKILL.md` and retry the upload. |
| `v2.5.7`  | **My Curator Claude skill — packaged playbook for the MCP.** Real-world MCP usage proved that detailed prompt-engineering produces dramatically better results: ground wikilinks before composing, use `broken_link_policy: 'refuse'` on fresh domains, three-tier Health flow, etc. Asking users to type that into every conversation is unsustainable. v2.5.7 packages the playbook into a downloadable Claude skill — `claude-skills/my-curator/SKILL.md` (~270 lines, 9 sections covering domain awareness, reading workflow, writing workflow with the v2.5.5 grounding playbook, Health maintenance with three-tier model, full tool reference, quality rules) plus `claude-skills/my-curator/examples.md` (4 worked sample dialogues — deep-research, fresh-domain compile, compound-into-existing, maintenance cleanup). Frontmatter `description` (within the 1,536-char cap) front-loads natural-language triggers covering both READ and WRITE intents. `allowed-tools: mcp__my-curator__*` pre-approves all 17 MCP tools. Install paths: `~/.claude/skills/my-curator/` for Claude Code (skills are first-class); upload to "Project knowledge" in any Claude Desktop project for the same effect. Documented in `docs/mcp-user-guide.md` (new section), `docs/user-guide.md` §13 (pointer), root `README.md` (callout). Format follows the [Agent Skills](https://agentskills.io) open standard so it works across MCP-aware tools, not just Claude. |
| `v2.5.6`  | **Documentation consolidation.** Two domain-related files (`adding-domains.md` + `domain-schemas.md`, ~480 lines combined) merged into one canonical `docs/domains.md` (~440 lines) covering: what a domain is, managing them via the UI + manual setup, the CLAUDE.md schema anatomy + iteration patterns, **how domains relate to each other** (siloed-by-default with the four-level model: in-domain full graph → Curator-tools no cross-domain links → MCP read-only cross-domain reasoning via `search_cross_domain` → Obsidian's accidental edges), and custom templates for History / Health / Legal. Three audit files (`audit-2026-04-14.md`, `audit-2026-04-20.md`, `audit-2026-04-21.md`) moved into `docs/audits/` subdir to clean the docs root. User-guide §10 shrunk from 60 lines to 12 (summary + link to `domains.md`), §21 Further Reading collapses the two domain rows into one. Root `README.md` and `docs/README.md` link tables updated; `docs/README.md` table also fixed (was missing 3 docs — mcp-user-guide, ai-health, model-lifecycle). All 8 cross-references across the repo updated. CLAUDE.md v2.3.1 history entry's `audit-2026-04-20.md` link path corrected. No information loss — every paragraph from the merged-from files lives on in `domains.md` reorganised. |
| `v2.5.5`  | **MCP `compile_to_wiki` link grounding.** Fixes a real-world quality problem: when Claude composes wiki content via `compile_to_wiki`, it has no visibility into which slugs already exist in the target domain, so it invents `[[wikilinks]]` that don't resolve. User reported 84 broken links after just 3 compiles into a fresh `Projects` domain. **Three-prong fix in `mcp/tools/compile.js`:** (1) Tool description rewritten to instruct Claude to call `get_index` BEFORE composing and to ground every `[[wikilink]]` in either an existing page or one being created in this same `additional_pages`. (2) Pre-write resolution pass — `buildSlugInventory()` reads entities/concepts/summaries dirs once + unions with paths in this call; `tryResolveLink()` mirrors writePage's Pass A/B/C (title-prefix strip, hyphen-normalised match, prefix-tolerant lookup); `resolveLinksInContent()` walks every `[[X]]` and routes to one of {kept, normalized, broken}. (3) New `broken_link_policy` enum input — `'keep'` (default; write as-is + report), `'strip'` (drop brackets so prose still reads naturally), `'refuse'` (abort the whole compile if any link is broken; returns `valid_slugs_sample` for fast Claude retry). Response gains a `links` field with `{total, resolved, normalized, broken: [{in, link}], broken_count, policy}` so Claude sees the broken-link list immediately and can decide whether to retry. Audit log records the same stats. Wrong-folder prefixes (`[[summaries/foo]]` pointing at an entity/concept) get auto-corrected on `'kept'` resolution so they don't survive as broken links downstream. ReDoS-safe regex; Map-based dedup; bounded inputs (max 11 pages × 50 KB) keep the pre-pass under 5 ms even on 5K-slug domains. |
| `v2.5.4`  | **MCP serverInfo title.** Set the optional `title: '🧠 My Curator'` field on the MCP server's `serverInfo` payload (added in MCP spec 2025-06-18). The protocol has **no icon/image field** — a real custom icon for the server is not currently possible — but if Claude Desktop derives its default avatar's first character from `title` instead of `name`, this gives us the brain glyph; if it doesn't, the title still renders as a friendlier display name than the bare `my-curator` slug. SDK 1.29's `BaseMetadataSchema` already accepts the field. Single-line server.js change; no other code touched. |
| `v2.5.3`  | **MCP stdout pollution hotfix.** Real Claude Desktop usage of v2.5.2 surfaced an MCP-protocol violation: `console.log` calls in shared brain modules write to **stdout**, which the MCP protocol reserves exclusively for JSON-RPC frames. The first call that triggered `syncSummaryEntities` (line `[syncSummaryEntities] Synced N entity slugs into …`) corrupted the JSON-RPC stream and surfaced as `Unexpected token 's', "[syncSummar"... is not valid JSON` in Claude Desktop. Fix: every `console.log` in modules imported by the MCP child process (`src/brain/files.js` ×2, `src/brain/ingest.js` ×6, `src/brain/llm.js` ×1) converted to `console.error`. Defensive comments at the entry of each module explain why. Verified via stdout-purity probe — every line on stdout parses as JSON; diagnostics flow correctly to stderr where Claude Desktop ignores them. The Curator app is unaffected (its console output goes through nohup → `/tmp/the-curator.log` regardless of stream). |
| `v2.5.2`  | **MCP write tools — read+write surface for Claude Desktop.** Seven new tools turn My Curator MCP into a full read+write client, so Claude (or any MCP-supported app) can save research findings, scan/fix Health issues, and manage dismissals without ever leaving the conversation. Tool count goes 10 → 17. **`compile_to_wiki`** (`mcp/tools/compile.js`) — saves a conversation's findings as wiki pages via the same `writePage → syncSummaryEntities → mergeIntoIndex → appendLog` pipeline used by the in-app Compile button (v2.5.0). Deterministic summary slug = `slugify(title)+date+sha4(corpus)` for idempotency; existing-file refusal prevents accidental re-write inflation. Hard caps: 50 KB/page, 10 pages/call. Optional `dry_run: true` returns a plan without writing. **`scan_wiki_health` / `fix_wiki_issue` / `scan_semantic_duplicates`** (`mcp/tools/health.js`) — wrap the existing scanner + fixer + AI semantic-dupe scan. Three-tier model encoded in tool descriptions so Claude knows when to auto-fix vs. confirm vs. always-preview. `semanticDupe` merges require `preview: true` first — a per-domain in-memory token Set gates the destructive call. **`get_health_dismissed` / `dismiss_wiki_issue` / `undismiss_wiki_issue`** (`mcp/tools/dismissed.js`) — same JSONL store used by the in-app Health tab; dismissals made in Claude Desktop appear in the Curator UI and vice versa, syncing across machines via the existing wiki-folder git tracking. **Default domain config** — `defaultDomain` field in `.curator-config.json`, set via Settings dropdown; MCP tools fall back to it when the user says "my wiki" without specifying. **Audit log** — `domains/<d>/.mcp-write-log.jsonl` (gitignored, machine-private) records every MCP write with timestamp, tool, and paths. **Path-traversal hardening** — added `resolveInsideWiki(wikiDir, path)` chokepoint to all five `fixIssue()` handlers in `src/brain/health.js` so an LLM-crafted issue object cannot `rm()` outside the wiki folder via `crossFolderDupes` or `hyphenVariants`. **Pre-existing latent bug fixed**: `normalizePath('index.md')` was returning `'entities/'` (no filename), causing ingest's index update + the new MCP write tools to silently skip — now `index.md` and `log.md` are special-cased at the top of `normalizePath`. Full guide: [docs/mcp-user-guide.md](docs/mcp-user-guide.md). |
| `v2.5.1`  | **Health dismissal persistence.** Skip / "not-a-duplicate" / "leave-alone" decisions on Wiki Health issues now persist across scans and sync across machines. New module `src/brain/health-dismissed.js` stores records in `domains/<d>/wiki/.health-dismissed.jsonl` — line-oriented, append-friendly, git-tracked via the existing wiki-folder sync. Canonical `keyForIssue(type, issue)` produces order-independent keys (semantic-dupe pairs alphabetised, hyphen-variant groups sorted) so the same logical dismissal always matches itself. `loadDismissed()` runs a silent stale-record prune on every load — referenced files/slugs that no longer exist are dropped without bothering the user. New endpoints `POST /api/health/:domain/dismiss` and `/undismiss` and `GET /:domain/dismissed`. `scanWiki()` and `findSemanticCandidatePairs()` filter their results against the dismissed-key set before returning; `counts.dismissed` surfaces on every scan response. UI: every review-only Health row (orphans + broken-links without a suggested target) gets a Dismiss button alongside the Review tag; semantic-dupe pair cards' existing Skip button now persists; new collapsible **Dismissed (N)** section at the bottom of the Health tab with per-record Un-dismiss buttons; an "N dismissed" chip in the scan summary. Resolves the v2.4.5 pain where 70-pair semantic scans surfaced the same false positives every run. |
| `v2.5.0`  | **Conversation Compounding (Stage 1).** Chat conversations can be compiled into wiki pages via a new "Compile to Wiki" button in the chat tab — same `writePage → syncSummaryEntities → appendLog` pipeline as ingest, no parallel write surface. New module `src/brain/compile.js` with deterministic summary slug `<title>-YYYY-MM-DD-<4hex>` (idempotent on re-compile) and a refusal-on-existing-summary guard that prevents accidental bullet inflation across related pages — file existence at the canonical slug = "this conversation has already been compiled today." Programmatic `mergeIntoIndex()` replaces LLM-driven index regeneration: on a 2000-page domain the index alone is 20 KB, asking the LLM to rewrite that on every compile saturated the JSON output budget and broke parsing on the second click. Now the LLM never touches index.md — we read it, append rows for newly-created pages keyed by post-write canonical path (cross-folder dedup safe), sanitised against pipe/newline injection. New SSE-streamed route `POST /api/compile/conversation` mirrors ingest's progress events. **`writePage()` now returns structured change records** `{canonPath, status, bytesBefore, bytesAfter, sectionsChanged, bulletsAdded}` — surfaced through the ingest 'done' event and the compile result, rendered by a shared `renderChangeRecords()` UI helper that splits new/updated/unchanged with unchanged collapsed by default. Ingest tab retroactively benefits from the same panel. UUID-validated `conversationId` in chat + compile routes (defense in depth against path-traversal via crafted IDs). Full guide: [docs/user-guide.md § Compiling a conversation](docs/user-guide.md). |
| `v2.4.5`  | Phase 3 of AI Wiki Health — **semantic near-duplicate detection**. New opt-in "Scan for semantic duplicates" flow in the Health tab, separate from the regular structural scan. Architecture: local inverted-token pre-filter in `src/brain/health.js` (`findSemanticCandidatePairs`) runs in O(N·k) and ranks candidate pairs by a multi-signal score (token overlap + Jaro-Winkler + length ratio); hard-cap at `SEMANTIC_DUPE_MAX_DOMAIN_PAGES = 20000` pages before the scan refuses. Top N candidates (default 500, user-configurable) are sent to the LLM in batches of 20 via `scanSemanticDuplicates` in `src/brain/health-ai.js` — the model judges duplicate-or-not and picks the canonical slug; `low` confidence and non-dupe verdicts are filtered out. New `fixSemanticDuplicate` handler merges bullet sections, rewrites every `[[removeSlug]]` and `[[folder/removeSlug]]` link across the domain (including summaries — reverse-direction links must point to the new canonical), then deletes the duplicate file. `semanticDupe` added as a pseudo-fix-type to `AUTO_FIXABLE` — never emitted by `scanWiki`; batch merge is deliberately NOT offered (scale-safety). Five new endpoints: `GET/POST /api/health/ai-settings`, `GET /:domain/semantic-dupes/estimate`, `POST /:domain/semantic-dupes/scan` (SSE stream with start/progress/pair/done events), `POST /:domain/semantic-dupes/preview`. User-configurable cost ceiling (default 50k tokens) + candidate-pair cap live in `aiHealth` in `.curator-config.json` via new `getAiHealthSettings`/`setAiHealthSettings` in `src/brain/config.js`; UI surfaces them in the Settings tab. Destructive-merge safety gate: the Merge button stays disabled until the user opens the Preview diff modal (shows keep path, delete path, link-rewrite count, list of affected files, first 4 KB of merged content). Full guide: [docs/ai-health.md](docs/ai-health.md). |
| `v2.4.4`  | Phase 2 of AI Wiki Health — `✨ Ask AI` button on **orphan** rows. New export `suggestOrphanHomes(domain, issue)` in `src/brain/health-ai.js` returns up to 5 candidate pages that should link to the orphan, each with `{target, description, confidence, rationale}`. Summaries are intentionally excluded from the candidate inventory (wiki convention: summaries reference entities during ingest, not retroactively). New generic helper `injectRelatedLink(targetPath, linkSlug, description)` in `src/brain/files.js` — dedup-safe bullet injection, unlike `injectSingleBacklink` which hardcodes the `summaries/` prefix. New pseudo-fix-type `orphanLink` added to `AUTO_FIXABLE` — **never emitted by `scanWiki`**; exists only to route user-initiated AI Apply calls through the same `/api/health/:domain/fix` chokepoint. `fixOrphanLink(wikiDir, issue)` applies four defences before writing: slug-regex validation, orphan exists on disk, target exists in entities/ or concepts/ (never summaries/), and self-link rejection. `/api/health/:domain/ai-suggest` now type-dispatches: `brokenLinks` → flat `{target, rationale, confidence}`; `orphans` → `{candidates: [...]}`. UI reuses the Phase 1 disclosure modal (same data shape leaves the machine — no re-prompt). Full guide: [docs/ai-health.md](docs/ai-health.md). |
| `v2.4.3`  | Phase 1 of AI Wiki Health — `✨ Ask AI` button on review-only broken-link rows. New module `src/brain/health-ai.js` (export: `suggestBrokenLinkTarget(domain, issue)` — READ-ONLY; never writes). New endpoints: `GET /api/health/ai-available` (frontend probe for a configured API key) and `POST /api/health/:domain/ai-suggest {type, issue}` (Phase 1 supports only `type: 'brokenLinks'`). Prompt sends the full slug inventory (~15 KB on a 2000-page domain ≈ 3–4k tokens) plus a ~4 KB excerpt around the broken link; LLM returns `{target, rationale, confidence}`. Hallucinated slugs are coerced to `target: null` with confidence `low` — validated against the on-disk slug set before the UI sees it. Apply reuses the existing `POST /api/health/:domain/fix` endpoint with `issue.suggestedTarget` patched in — no new write code. One-time privacy disclosure modal (localStorage `curator-ai-health-disclosure-seen-v1`) describes what leaves the machine. Provider-agnostic via `generateText()`; automatically inherits the v2.4.0 fallback chain. Full guide: [docs/ai-health.md](docs/ai-health.md). |
| `v2.4.2`  | API-key UX: last-saved-wins + per-field Disconnect. Before: when both keys were stored, Gemini always won, and there was no way to clear a key from the UI (saving an empty value was silently ignored). Now: saving a non-empty key also marks that provider as active (`config.activeProvider = 'gemini'\|'anthropic'`), so pasting an Anthropic key and clicking Save instantly switches to Anthropic. A new **Disconnect** button next to each saved key clears just that one — backed by `POST /api/config/api-keys/disconnect {provider}` and `clearApiKey()` in `brain/config.js`; if the cleared key was active, active moves to the other provider (if it has a key) or becomes null. Legacy configs (no `activeProvider` field) fall back to Gemini-first priority, preserving behaviour for existing installs until the user explicitly saves a different key. `getProviderInfo()` in `llm.js` now honours `activeProvider` with a defensive fallback if the active provider's key is somehow missing. |

---

## Environment & Config

```
.curator-config.json    — UI-managed config (API keys, domains path) — never committed
  geminiApiKey          — Google Gemini key (set via Settings tab / onboarding wizard)
  anthropicApiKey       — Anthropic Claude key (set via Settings tab)
  domainsPath           — custom path for domains/ folder (set via UI)

.env                    — developer fallback for API keys (never committed)
  GEMINI_API_KEY        — Google Gemini (default, recommended)
  ANTHROPIC_API_KEY     — Anthropic Claude (alternative)
  LLM_MODEL            — optional model override
  DOMAINS_PATH         — optional custom path for domains/ folder

.sync-config.json       — GitHub sync credentials (never committed)
```

**Key priority:** `.curator-config.json` (Settings UI) takes precedence over `.env` for API keys.
**LLM selection:** `GEMINI_API_KEY` takes priority. If both keys are set, Gemini is used.
**Default models:** Gemini 2.5 Flash Lite / Claude Sonnet 4.6

---

## Scripts Reference

```bash
# Retroactive backlink injection (all domains)
node scripts/inject-summary-backlinks.js

# Single domain
node scripts/inject-summary-backlinks.js --domain=articles

# Dry run
node scripts/inject-summary-backlinks.js --dry-run

# Deduplicate near-duplicate entity/concept files
node scripts/fix-wiki-duplicates.js

# Migrate non-canonical folders (people/, tools/) → entities/
node scripts/fix-wiki-structure.js

# Re-ingest all raw files in a domain
node scripts/bulk-reingest.js --domain=articles
node scripts/bulk-reingest.js --domain=articles --delay=5000  # slower, for rate limits

# Comprehensive wiki repair (cross-folder dedup, link normalization, backlinks)
node scripts/repair-wiki.js --domain=articles
node scripts/repair-wiki.js  # all domains

# Rebuild The Curator.app (called automatically by update, or run manually)
bash scripts/build-app.sh
```

---

## Active Development Decisions

- **No vector DB / embeddings** — the wiki is small enough to fit in a single LLM context window for chat. Markdown files are human-readable and Obsidian-native.
- **No React/Vue** — six-tab UI with vanilla JS. No build step.
- **JSON mode for ingest, text mode for chat** — ingest requires structured output; chat needs free prose.
- **Conversations gitignored from app repo but synced via knowledge repo** — personal to each user's machine, not committed to source control.
- **CLAUDE.md per domain** — each domain is a specialist, not a generalist. The schema shapes how the LLM categorises knowledge for that domain.
- **syncSummaryEntities is idempotent** — safe to run multiple times; injectBulletsIntoSection deduplicates by link target.
- **deduplicateBulletSections is always safe to run** — only removes bullets whose dedupKey already appeared earlier in the same section; never drops unique content.
- **API keys UI-first** — `.curator-config.json` (set via Settings tab / onboarding wizard) takes priority over `.env`. The `.env` file remains as a developer fallback.
- **install.sh auto-provisions** — detects and installs Node.js (via Homebrew or nodejs.org .pkg) and git (via Xcode CLI tools); no longer asks for API key during install (onboarding wizard handles it); auto-opens the app on completion.
- **No Stop button** — removed entirely because AppleScript's `on reopen` handler is broken on modern macOS and caused unrecoverable crashes. Closing the browser tab leaves the server running in the background (uses ~0 CPU). Clicking the Dock icon re-opens the browser if the server is running, or starts the server if it is not. To fully quit: right-click the Dock icon → Quit.
- **No /api/shutdown endpoint** — the server runs until the process is explicitly killed (Dock → Quit, or terminal Ctrl+C). No heartbeat or auto-shutdown.
- **Auto-update via Settings** — compares local `package.json` version with GitHub's `main` branch; runs `git fetch origin main` + `git reset --hard origin/main` + `npm install` + `bash scripts/build-app.sh` (rebuilds the .app); returns `{from, to}` short SHAs; frontend then calls `/api/restart` which spawns a new process and exits the old one. Browser auto-reloads. The hard-reset (instead of `git pull`) means the app directory is always forced to match `main` exactly — `package-lock.json` regenerated by local `npm install` runs no longer blocks the update.
- **Server auto-opens browser** — `exec('open http://localhost:3333')` runs on startup, unless `CURATOR_NO_OPEN=1` is set (used by the restart endpoint to prevent double browser tabs — the frontend reloads itself via polling).
- **Absolute node path in AppleScript** — `build-app.sh` and `install.sh` resolve the full path to `node` (via `which node`) at build time and embed it as `property nodeBin` in the AppleScript. This avoids the "node: No such file or directory" failure caused by AppleScript's `do shell script` running in a bare `/bin/sh` environment without the user's PATH. A `export PATH=...` with common node locations (`/usr/local/bin`, `/opt/homebrew/bin`) is also added as a fallback. If the user upgrades or moves Node.js, `bash scripts/build-app.sh` re-resolves the path.
- **Restart uses `process.execPath`** — the `/api/restart` endpoint uses the absolute path to the currently running Node binary (`process.execPath`) instead of bare `node`, ensuring the restarted server finds the same Node regardless of shell environment.
- **UI auto-refreshes after mutations** — after ingest, domain stats (page count, conversation count) update automatically; after sync down/both, domain dropdowns and stats also refresh; switching to the Domains or Wiki tab reloads their data. No manual browser reload needed.
- **Onboarding wizard** — 3-step modal on first run (API keys → create domain → sync setup); appears when no API keys are configured in either `.curator-config.json` or `.env`.
- **My Curator MCP (v2.3.0)** — a local read-only MCP server (`mcp/server.js`) that Claude Desktop spawns as a child process via stdio. Reads markdown directly from `getDomainsDir()`; does NOT require the Curator web server to be running. Exposes 10 tools: 7 retrieval (list_domains, get_index, search_wiki, get_node, get_connected_nodes, get_summary, search_cross_domain) and 3 graph-native (get_graph_overview, get_tags, get_backlinks). The graph tools are the reason MCP exists — they expose frontmatter, tags, [[wikilink]] edges (section-labeled), and bidirectional backlinks as structured data, so a frontier model can reason about topology, not just fetch pages. The generated `claude_desktop_config.json` entry uses absolute paths (`process.execPath` + `mcp/server.js` + `--domains-path <absolute>`); moving the domains folder makes it stale — the wizard detects staleness and shows a banner.
- **MCP wizard lives in Settings** — not a top-level tab. Section uses the sync-tab three-state pattern: **landing** (hero + what/privacy grid + "Set Up My Curator" CTA), **wizard** (3 numbered steps with progress pips: Copy snippet · Paste into config · Restart & verify), **connected** (status card + Self-test / View & Edit Config cards + runtime note). The wizard also joins the onboarding overlay as step 4 ("Connect to Claude Desktop", optional, skippable). Re-entering the Settings tab always refreshes the MCP status via `refreshMcpSection()` so stale UI can't persist after closing the wizard.
- **MCP response budget is in tokens, not bytes** — 1 MB of JSON ≈ 250 k tokens, which alone saturates Claude Opus's 200 k context window. `enforceSizeLimit()` in `mcp/tools/index.js` caps at **400 KB (~100 k tokens)** so a conversation can sustain multiple tool calls plus reasoning. The guard trims heavy arrays (edges → nodes → results → tags → backlinks → outgoing_from_start → backlinks_to_start) and appends `_truncated`. `get_graph_overview` default = compact summary (stats + top 20 hubs + orphan sample + top 10 tags, ~4 KB at any scale); `include_nodes: true` / `include_edges: true` are opt-in and size-guarded. `get_tags` default = top 50 tags with 50-page samples each. `get_connected_nodes` caps at `max_nodes: 60` (ranked by hop + degree), max depth 2, 120-char previews — enough to keep even hub-entity traversals under budget (e.g. `tali-rezun` at depth 2: 39 KB on the 2116-node articles domain).
- **MCP security** — defense in depth against LLM-driven path traversal. `storage/local.js` has a single `resolveInsideBase()` chokepoint that rejects absolute paths, `..` segments, and anything resolving outside the domains folder. Tools additionally validate their `domain`/`slug` args via `isValidDomain` / `isValidSlug` from `mcp/util.js` (strict alphanum+hyphen+underscore) for clean error messages. The `/api/mcp/reveal-config` endpoint uses `execFile` (not `exec`) so no shell interpretation. The MCP is read-only — there is no write/mutate tool.
- **MCP graph cache** — `buildGraph()` caches per-domain with a 10-minute TTL and a file-count check for invalidation. An ingest that changes the file count forces a rebuild on the next tool call; otherwise graph re-use is safe for the life of one Claude Desktop conversation.
- **Model-lifecycle policy (v2.4.0)** — single chokepoint for all LLM calls is `generateText()` in `src/brain/llm.js`, which dispatches to whichever provider the user configured (Gemini or Anthropic). Default models are pinned in `DEFAULTS`; `FALLBACK_CHAINS` provides an ordered next-best list per provider. On model-not-found errors (and ONLY those — 429/503 still retry) the chain is walked in order; the successful model is recorded in a module-level `_activeFallback` and surfaced to the UI via `getFallbackStatus()`. When a provider retires a model: bump the `DEFAULTS` constant, optionally add the old primary to `FALLBACK_CHAINS`, push a release. Users on older versions keep working via the chain until they Check for Updates. Full user/developer guide: `docs/model-lifecycle.md`.
- **Self-test isolation** — `POST /api/mcp/self-test` spawns `mcp/server.js` locally, sends initialize + tools/list + list_domains over stdio, and reports round-trip results. If this passes but Claude Desktop still can't see the tool, the issue is in `claude_desktop_config.json`, not the bridge.
- **Semantic-duplicate scan is opt-in, cost-gated, and scale-capped (v2.4.5+)** — never runs as part of the regular Health scan. The flow is: estimate → confirm dialog → SSE-streamed real scan → per-pair Preview → Merge. Three hard caps in code: `SEMANTIC_DUPE_MAX_DOMAIN_PAGES = 20000` (refuses larger domains), user-configurable candidate-pair cap (default 500), user-configurable cost ceiling (default 50k tokens). Batch merges are **deliberately not offered at any scale** — a wrong batch merge across thousands of pages is the most expensive mistake in The Curator, so the design refuses to expose it.
- **Destructive-merge safety gate (v2.4.5+)** — Phase 3 is the first and only feature that DELETES files. The Merge button is disabled until the user opens the Preview-diff modal for that specific pair, which shows exactly which files will change, how many links will be rewritten, and what the merged content will look like. The frontend tracks previewed pairs per session; new sessions require re-preview.
- **AI Health is READ-ONLY (v2.4.3+)** — `src/brain/health-ai.js` proposes fixes, it never writes. All mutations still go through the existing `fixIssue()` in `src/brain/health.js` via `POST /api/health/:domain/fix`, so the AI layer cannot corrupt the wiki even if the LLM hallucinates. AI suggestions are additionally validated against the on-disk slug set before being returned to the UI; unknown slugs are coerced to `target: null`. This invariant must be preserved for Phase 2 (orphan rescue) and Phase 3 (semantic duplicates).
- **Conversation compile reuses the ingest write pipeline (v2.5.0+)** — `src/brain/compile.js` imports `writePage`, `syncSummaryEntities`, `appendLog` from `files.js` and runs the same Pass A/B/C link normalisation, cross-folder dedup, hyphen-variant resolution, and summary-backlink injection that ingest gets. There is exactly **one** wiki-write code path in the app, used by both surfaces. v2.5.1's MCP `compile_to_wiki` tool will reuse the same module via direct import — no parallel write logic anywhere in the codebase.
- **Compile slug is deterministic and idempotent (v2.5.0+)** — summary path = `summaries/<slugify(title)>-<YYYY-MM-DD>-<4hex(corpus)>.md`. Same conversation, same date, same content → same slug → file existence check refuses re-compile with a clear message ("Already compiled to X. Send another message to extend it, or delete that file to start over"). Adding a turn changes the corpus hash → new slug → no collision → compile proceeds normally. This file-existence-as-state design avoids any side state in the conversation JSON and carries cleanly into the v2.5.1 MCP tool.
- **Compile does NOT regenerate index.md via the LLM (v2.5.0+)** — on a 2000-page domain the index is 20 KB of markdown table; asking the LLM to rewrite it on every compile saturated the JSON output budget and broke parsing on the second click against `articles`. `mergeIntoIndex()` in `compile.js` reads the existing index, appends rows for any pages this compile actually CREATED (not updates), and writes back. Sanitised against pipe/newline injection in cell content. Pages are paired with their summary by post-write canonical path so cross-folder dedup redirects don't drop the description column.
- **`writePage()` returns structured change records (v2.5.0+)** — `{canonPath, status, bytesBefore, bytesAfter, sectionsChanged, bulletsAdded}` (or `null` on invalid input). Status is `created` / `updated` / `unchanged`. The `sectionsChanged` heuristic flags section names whose bullet count grew (good enough — byte-level `bytesBefore !== bytesAfter` plus the status flag still accurately tells the user "something changed"; deep diff is overkill). The shared `renderChangeRecords()` helper in `app.js` is used by both ingest and compile result panels — splits new/updated/unchanged with unchanged collapsed by default. Future MCP write tools (v2.5.1+) will return the same shape so Claude renders the same panel in chat.
- **Conversation IDs are UUIDs and validated at the route boundary (v2.5.0+)** — `src/routes/chat.js` and `src/routes/compile.js` reject any `conversationId` that doesn't match `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` before reaching the filesystem layer. Defense in depth — `readConversation` would otherwise build `path.join(conversationsPath, '<id>.json')` from arbitrary client input.
- **Health dismissals are persistent and synced (v2.5.1+)** — `domains/<d>/wiki/.health-dismissed.jsonl` lives inside the wiki folder (already git-tracked), so dismissals propagate across machines via the existing GitHub sync without any sync-config tweaks. Format is one JSON object per line so concurrent dismissals on different machines append cleanly through git's standard 3-way merge. Order-insensitive identities (semantic-dupe pairs, hyphen-variant groups) are canonicalised on write — `{a, b}` and `{b, a}` produce the same `keyForIssue()` and one stored record. `loadDismissed()` runs a silent stale-record prune on every load (drops records whose referenced files/slugs no longer exist) so renames and merges don't pollute the file forever.
- **Health dismissal scope (v2.5.1+)** — Dismiss buttons appear ONLY on review-only Health rows (orphans, broken links without a suggested target) and on semantic-dupe pair cards. Auto-fixable issues (`brokenLinks` with `suggestedTarget`, `folderPrefixLinks`, `crossFolderDupes`, `hyphenVariants`, `missingBacklinks`) intentionally don't get a Dismiss button — the right action is Apply, not skip. If a user really wants to suppress one of those, they can dismiss it after the fact from the Dismissed section. This keeps the UI focused on "fix or skip" and prevents the auto-fix surface from becoming cluttered with skip-style affordances.
- **MCP is a full read+write client (v2.5.2+)** — `mcp/server.js` and its tool modules import the brain's `writePage`, `syncSummaryEntities`, `appendLog`, `scanWiki`, `fixIssue`, `addDismissal`, `removeDismissal`, `listDismissed` directly from `src/brain/*`. There is exactly one wiki-write code path in the codebase, used by both the in-app surface (Compile button, Health tab) and the MCP. No HTTP delegation, no parallel logic, no re-implementation in `mcp/`. The Curator app is the install + wizard + manual fallback UI; the MCP is the live conversational surface — they are equally-capable clients to the same data.
- **MCP write-tool boundaries (v2.5.2+)** — every MCP write tool funnels through `resolveDomainArg(args, storage, getDefaultDomain)` in `mcp/util.js`: explicit `domain` argument → user's configured `defaultDomain` → error. Domain validated via `isValidDomain` AND `storage.listDomains().includes()`. Per-tool guards layered on top: `compile_to_wiki` enforces 50 KB/page + 10 pages/call hard caps + `validateAdditionalPath` (folder allowlist, slug regex, `.md` suffix, `REFUSED_FILES`); `fix_wiki_issue` requires `type ∈ AUTO_FIXABLE`; `semanticDupe` requires `preview: true` first via a per-domain in-memory token Set in `mcp/tools/health.js`.
- **Path-traversal hardening in fixIssue handlers (v2.5.2+)** — Adding `fix_wiki_issue` to the MCP exposed `fixIssue()` to LLM-crafted input for the first time. New `resolveInsideWiki(wikiDir, candidate)` helper at the top of `src/brain/health.js` resolves the path and refuses anything outside `wikiDir` (rejects absolute paths, parent-traversal, empty input). All five fix handlers (`fixBrokenLink`, `fixFolderPrefixLink`, `fixCrossFolderDupe`, `fixHyphenVariant`, `fixMissingBacklink`) now route their issue-derived paths through this gate before reaching `writeFile` / `rm`. Defense in depth alongside the existing slug-regex validators in `fixOrphanLink` and `fixSemanticDuplicate`.
- **MCP audit log is local-only (v2.5.2+)** — `domains/<d>/.mcp-write-log.jsonl` records every MCP write (timestamp, tool, paths, byte count). Sibling to `wiki/`, NOT inside it, gitignored via the `*/.mcp-write-log.jsonl` rule added by `ensureDomainsGitignore()`. Write history is intentionally machine-private — you don't want it spilling to GitHub. Best-effort: a failed audit-log append never blocks the actual write.
- **MCP idempotency = file-existence on disk (v2.5.2+)** — `compile_to_wiki` re-uses the v2.5.0 file-existence guard inherited via shared module: same conversation+title+date → same hash → same slug → second call is refused. The summary file IS the state; no separate tracking. Concurrent calls within milliseconds can race the `existsSync` check, but real Claude Desktop usage is sequential. Documented as a known limitation rather than engineered around — adding a lockfile would complicate the standalone-MCP property without solving a real-world problem.
- **MCP discoverability is description-driven (v2.5.2+)** — MCP has no separate "keywords" field; tool selection is driven by tool names + descriptions. Each new write tool's description is rich plain-English with the natural phrases users actually use ("save to my second brain", "compile our findings", "check my wiki", "find broken links", "clean up the knowledge base"). Tool ordering also matters slightly — read tools registered before write tools so Claude reaches for read first when the intent is exploration.
- **`normalizePath` special-cases index.md and log.md (v2.5.2+)** — pre-existing latent bug: `normalizePath('index.md')` returned `'entities/'` (no filename) because the second branch treated `'index.md'` as an unknown-folder name. The basename guard then refused the write silently. This had been masking ingest's index updates since v2.0; only surfaced when v2.5.2's MCP write path (which calls `writePage(domain, 'index.md', mergedIndex)` directly) made the symptom impossible to ignore. Fix: explicit early-return for `index.md` and `log.md` at the top of `normalizePath`.
- **MCP stdout discipline (v2.5.3+)** — `src/brain/files.js`, `src/brain/ingest.js`, `src/brain/llm.js` are imported by the MCP child process. The MCP protocol reserves **stdout** for JSON-RPC frames; any `console.log` in a shared module poisons the stream and surfaces in Claude Desktop as `Unexpected token … is not valid JSON`. Rule: ALL diagnostics in shared brain modules use `console.error` (stderr). Defensive comments at the entry point of each module make this explicit so future contributors don't reintroduce the bug. Verified by a stdout-purity probe (`/tmp/mcp-stdout-purity.mjs`-style) that asserts every line on stdout parses as JSON.
- **MCP `compile_to_wiki` link grounding (v2.5.5+)** — `mcp/tools/compile.js` runs a pre-write resolution pass over every `[[wikilink]]` in the inputs and resolves against the union of (existing slugs on disk + slugs being created in this call). Mirrors `writePage` Pass A/B/C exactly so writePage's own pass runs as a no-op on already-resolved content. The `broken_link_policy` parameter (`keep`/`strip`/`refuse`) gives users + Claude a strict mode for fresh domains where a single broken link is worth aborting the whole compile to fix at the source. The `links` response field is the actionable signal — Claude sees broken links immediately and can decide whether to retry with corrections. Without this v2.5.5 grounding, fresh domains reliably accumulated 20+ broken links per compile.
- **Domains are siloed by default (v2.5.6+ documented; behaviour is implicit since v2.0)** — `compile_to_wiki` writes to one domain per call, ingest's slug inventory is per-domain, link grounding (v2.5.5+) only resolves against the current domain. Cross-domain reasoning happens at the MCP-read layer (`search_cross_domain`) — a Claude conversation can synthesise across domains without persistent cross-domain links being created on disk. Obsidian, when its vault root covers multiple domains, may surface accidental edges where slugs collide across domains; Health is per-domain so those show as broken in the source domain even though Obsidian shows them connected. Documented in full at [`docs/domains.md` § 4](docs/domains.md#4-how-domains-relate-to-each-other). Intentional cross-domain linking (e.g. `[[business:openai]]` syntax) is not currently supported — would require parser/scanner work in `health.js`, `compile.js`, and the MCP tools.
- **My Curator Claude skill is the canonical playbook (v2.5.7+)** — `claude-skills/my-curator/` ships the same prompt-engineering rules that, used inconsistently, produce broken links / duplicate pages / cross-domain confusion. Standard install (drop in `~/.claude/skills/`) makes every Claude conversation that uses the my-curator MCP automatically follow them. The skill is the SECOND canonical source-of-truth for MCP behaviour rules (the FIRST is the tool descriptions in `mcp/tools/*.js` — read by Claude during `tools/list`). When the rules change, both must be updated. The skill body is intentionally a duplicate of the discipline already encoded in tool descriptions — but the descriptions are 1-paragraph triggers; the skill is the full playbook with examples. Skill format follows the Agent Skills open standard so it works in Claude Code, Claude Desktop projects, and any other MCP-aware host that supports the standard.
- **Skill description must avoid XML-shaped placeholders (v2.5.8+)** — Claude Desktop's skill-upload validator rejects any `<word>` pattern in the YAML `description` field as a malformed XML tag. Claude Code is more permissive, but the conservative path is: never use `<placeholder>` syntax in skill descriptions; use `[placeholder]` or concrete examples instead. The body of the skill is fine — the validator only checks the description.
- **Version:** 2.5.8

## Roadmap — Chat UI Modes 3 & 4 (planned, not yet implemented)

> This section is the **persistent design context** for a future session that
> will implement Modes 3 (Dictate) and 4 (Curate) of the Chat tab. It captures
> what we've decided so the implementing session can start coding without
> re-deriving the architecture. Update this section as decisions firm up.

### The four-mode model

The Chat tab is evolving from a single-purpose Q&A surface into a four-mode
authoring environment that mirrors the natural lifecycle of working with a
second brain:

| Mode | Status | What it does | Direction |
|------|--------|--------------|-----------|
| 1. **Discover** | ✅ shipped (v1.0) | Multi-turn Q&A against the wiki — answers cite specific pages. | read |
| 2. **Compile** | ✅ shipped (v2.5.0) | After a Discover conversation, click "Compile to Wiki" to turn it into a permanent summary + new entity/concept pages. | read → write |
| 3. **Dictate** | 🔮 planned | Stream-of-thought capture. User types or speaks raw thoughts; the chat UI structures them and writes to the wiki immediately without requiring a multi-turn conversation. | write-first |
| 4. **Curate** | 🔮 planned | Review-and-refine an existing wiki page or batch of pages in the chat UI. Conversational editorial dialogue (different from Health, which is rule-based). | rewrite |

The progression reads coherently: **Discover (read) → Compile (write a summary
of a thought process) → Dictate (capture raw thought directly) → Curate (refine
what's already in the wiki).**

### Mode 3 — Dictate

**Use case.** *"I just had an idea I want to capture quickly. I don't want a
conversation, I just want to dump what I'm thinking and have it land in the
wiki properly structured."*

Compile (Mode 2) requires a multi-turn conversation first. Dictate is for the
single-shot case — paste a paragraph, click Save, done.

**Proposed UI.**
- Mode-switcher in the chat-tab header (segmented control: `Discover · Compile · Dictate · Curate`).
- In Dictate mode, the chat input becomes a "Dictate" box with a **Save to wiki** button instead of Send.
- Optional **target page hint** (entity / concept / summary auto-detected from content, user can override).
- After save: the existing v2.5.0 change-record panel renders the result.

**Backend reuse.**
- `compileConversation()` is too multi-turn-shaped — Dictate gets its own thin wrapper:
  `dictateNote(domain, { text, kind?, hint? })` → builds a one-shot LLM prompt that asks for *one* page (entity / concept / summary) with proper structure, then runs through `writePage` + `syncSummaryEntities` + index merge — same chokepoint.
- Lives in `src/brain/dictate.js` (new), parallels `src/brain/compile.js`.
- Route: `POST /api/dictate/note` (SSE-streamed, mirrors compile route).
- File-existence idempotency guard like compile uses.
- v2.5.5 link grounding inherited automatically (same pre-write resolution path used by `compile_to_wiki`).

**Open design questions.**
1. Voice input — should the input box accept speech-to-text via Web Speech API, or stay text-only? The user mentioned "dictate" literally; voice is the headline UX win.
2. Auto-detection of page type (entity vs concept vs summary) — is the LLM reliable enough to pick automatically, or always show a chooser?
3. Should Dictate write directly, or always show a preview / confirm step first? Compile has dry-run; Dictate probably doesn't need one because the input is the user's own raw text — they wrote it, they can re-read it.

### Mode 4 — Curate

**Use case.** *"I'm looking at this entity page and it's a mess. Let me chat
with Claude to clean it up — restructure sections, merge with a related page,
suggest what's missing — without leaving the chat tab."*

Health is rule-based. Curate is editorial. Different action, different surface.

**Proposed UI.**
- Mode 4 surfaces a **page picker** alongside the message thread: pick an entity, concept, or summary; its content loads into a side panel.
- Dialogue with Claude is grounded in that page (and optionally its connected pages — pulled via the existing `get_connected_nodes` MCP-style logic but inline in the app).
- Suggested actions Claude can offer:
  - "Restructure this page into Summary / Key Facts / Related"
  - "Pull bullets from these three related pages and consolidate them here"
  - "Suggest five concept pages this entity should link to"
  - "Rewrite the Definition section to be clearer"
- Apply button on each suggestion → routes through `writePage` (additive merge handles non-destructive updates) or `fixIssue` for structural ones.

**Backend reuse.**
- Probably no new tools required — composes existing primitives: `readWikiPage`, `writePage`, the chat pipeline, and (if AI-suggested edits target other pages) `injectRelatedLink` from `files.js`.
- New module if needed: `src/brain/curate.js` — but might just live inside the chat route as additional context-injection logic.
- Route: extend `POST /api/chat/:domain` with an optional `curateContext: { pagePath }` field, OR a separate `POST /api/curate/:domain/:pagePath`. Decision pending.

**Open design questions.**
1. Should Curate mode lock the user into editing **one page at a time**, or support multi-page sessions (e.g. merging two entities)? The risk with multi-page is destructive edits — merge has the v2.4.5 preview-gate pattern that we'd need to mirror.
2. Diff visualisation — should every Claude-suggested edit show a before/after diff before the user clicks Apply? Probably yes for prose changes; bullet additions can apply silently.
3. Cross-domain Curate — refuse (consistent with the v2.5.6 siloing principle), or special-case for users who want to refactor across domains? Default: refuse.
4. AI Health overlap — at what point does "Curate suggested merging these two pages" become "use the v2.4.5 semantic-dupe scan instead"? Probably the line is: Curate is for one-page authoring, semantic-dupe is for cross-domain detection. Document the boundary.

### Files that would change (rough estimate)

```
NEW:
  src/brain/dictate.js                — single-shot note capture
  src/brain/curate.js (maybe)         — only if logic outgrows chat route
  src/routes/dictate.js               — POST /api/dictate/note (SSE)
  docs/chat-modes.md (maybe)          — single-page deep-dive on the four modes

MODIFIED:
  src/public/index.html               — mode-switcher segmented control + page-picker for Curate
  src/public/app.js                   — mode state machine + per-mode UI logic
  src/public/styles.css               — mode-switcher styles
  src/server.js                       — register dictate route
  src/routes/chat.js                  — optional curate-context support
  docs/user-guide.md §9               — describe all four modes
  docs/mcp-user-guide.md              — note that compile_to_wiki is the MCP equivalent of Mode 2
  CLAUDE.md                           — version history entry, design decisions
```

### Reusable primitives already in place

- v2.5.0 change-record shape (used by ingest, compile, MCP writes) — Dictate + Curate inherit.
- v2.5.5 link grounding (`buildSlugInventory`, `tryResolveLink`) — Dictate's writes pass through it for free; Curate's edits should too.
- v2.5.1 dismissal store — irrelevant to Modes 3/4 directly, but Curate could surface "you previously dismissed this issue, want to un-dismiss?" prompts.
- v2.5.2 default-domain config — Dictate should respect it (just like MCP `compile_to_wiki` does).

### Pre-implementation checklist

Before the implementing session starts coding:
1. Confirm whether voice (Web Speech API) is in scope for Dictate v1, or text-only.
2. Decide page-type auto-detection vs explicit chooser for Dictate.
3. Decide single-page vs multi-page scope for Curate v1.
4. Decide per-suggestion diff vs silent-apply for Curate prose edits.
5. Mode-switcher UI: segmented control vs tab-row vs sidebar — small visual decision.

---

## Known benign GitHub behaviours

- **"Sorry, we had to truncate this directory to 1000 files"** on GitHub's web UI when browsing `domains/articles/wiki/concepts/` (or similarly busy folders) is a **GitHub rendering limit, not a sync issue**. Git itself handles millions of files per directory; the truncation only affects the file-listing view on `github.com`. Clone the repo locally, or use `git log` / `git ls-files`, and you see everything. Sync push/pull transfers all files correctly regardless of this UI limit.
