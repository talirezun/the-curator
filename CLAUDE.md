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
    files.js      — all filesystem logic: writePage, mergeWikiPage, syncSummaryEntities, injectSummaryBacklinks
    llm.js        — LLM abstraction (Gemini or Claude, auto-detected via config.js)
    chat.js       — multi-turn chat against the wiki
    sync.js       — GitHub sync (git --git-dir / --work-tree)
    health.js     — wiki health scanner + auto-fix (broken links, orphans, folder-prefix, cross-folder dedup, hyphen variants, missing backlinks)
    config.js     — persistent config (.curator-config.json): getApiKeys, setApiKeys, getEffectiveKey, getDomainsDir
  routes/
    ingest.js     — POST /api/ingest (SSE streaming)
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
| `writePage(domain, relativePath, content)` | Normalise path → dedup passes A+B → cross-folder dedup (3b) → inject frontmatter → merge with existing → strip blanks → dedup bullets → strip folder-prefix links → normalize variant links (5c: entities + concepts + summaries, prefix-tolerant) → write → call injectSummaryBacklinks if summary |
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
| `v2.3.1`  | MCP response-budget correction. Dropped `MAX_RESPONSE_BYTES` 900 KB → 400 KB (~100 k tokens) so multi-turn conversations don't blow the context window on a single tool call. Reworked `get_connected_nodes` with `max_nodes` default 60, ranked by hop+degree, shorter previews, max depth 2: on the real 2116-node articles domain, depth-2 response dropped 575 KB → 39 KB. All other tools unchanged. See `docs/audit-2026-04-20.md` addendum. |
| `v2.3.2`  | Auto-updater made crash-resilient. Replaced `git pull origin main` with `git fetch origin main` + `git reset --hard origin/main` — plain pull aborted on end-user machines whenever `npm install` had regenerated `package-lock.json` with a machine-specific diff. Tracked files hard-sync to remote; gitignored user data (`domains/`, `.curator-config.json`, `.sync-config.json`) is untouched. Response now returns `from`/`to` short SHAs so the UI can show exactly what moved. |
| `v2.3.3`  | "Restart needed" detection across the UI. `/api/version` now returns `{version, onDiskVersion, restartRequired}` — compares the version cached at server startup with the current on-disk `package.json`. When these diverge (user ran the manual `git reset --hard` recovery but didn't relaunch the .app), three places surface it clearly: header badge turns amber and shows "v2.2.2 · restart" on hover; **Check for Updates** button displays "Files are updated (vX) but running app is still vY — please quit and relaunch"; the MCP section detects HTML coming back from missing `/api/mcp/*` routes (SPA fallthrough) and replaces the cryptic `Unexpected token '<'` JSON parse error with a plain-English restart prompt. |
| `v2.3.4`  | Ghost-domain fix after sync-delete. When another machine deletes a domain via sync, git-pull removes every tracked file but leaves empty directories behind (git doesn't track empty dirs), so the deleted domain's shell (`conversations/`, `raw/`, `wiki/`) appeared as a ghost in the Domains list. Fix: `listDomains()` in both `src/brain/files.js` and `mcp/storage/local.js` now requires a `CLAUDE.md` schema for a directory to count as a domain — ghosts and unrelated files (`Untitled.base`, stray `.md`) are filtered out. `sync.pull()` additionally prunes ghost directories after every pull by recursively removing any `domains/<name>/` that has no schema — sync-delete is now end-to-end. |
| `v2.3.5`  | Subprocess-PATH fix for auto-updater and sync. When The Curator is launched via the `.app` wrapper, AppleScript's `do shell script` starts the Node process with a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — enough to find `git` (in `/usr/bin` from Xcode CLT) but not `npm`, which lives next to Node in `/usr/local/bin` or `/opt/homebrew/bin`. Every subprocess spawned by the updater inherited this bare PATH, so `npm install` failed with `npm: command not found`. Fix: `SUBPROCESS_ENV` prepends the Node binary's directory plus common Homebrew/system prefixes to every `execAsync` call in `src/routes/config.js` (update + pick-folder + update-check) and `src/brain/sync.js` (all git operations). Same fix pattern as the absolute-node-path trick used in `scripts/build-app.sh`. |
| `v2.3.6`  | Updater partial-success recovery. Resolves the catch-22 where users on a pre-v2.3.5 running app couldn't install v2.3.5 because the npm-not-found bug was in the very updater trying to apply the fix. Now when `npm install` fails specifically with `npm: command not found` AND the `git reset` already succeeded, the endpoint returns `{ok:true, partial:true, from, to, warning}` instead of an error. The frontend surfaces the warning in the restart banner and proceeds with the auto-restart — which loads the fixed updater in the new process. Any OTHER npm error (real dependency issues) still re-throws and is reported normally, so we never auto-restart into a broken-deps state. |
| `v2.3.7`  | Accurate sync file counts in UI. Bug: after a big ingest, push reported "6 files synced" when ~200 had actually moved. Root cause: the fallback count used `git diff --stat --name-only origin/main~1..origin/main` AFTER the push, which only counted files in the most recent commit (typically a merge commit with a tiny delta) instead of the union of files across all unpushed commits. Fix: `push()` now counts `git diff --name-only origin/main..HEAD` BEFORE the push (union across every unpushed commit); `pull()` counts `HEAD..origin/main` after fetch-but-before-merge. Both return `{filesChanged, commitsAhead/Pulled, files: [preview]}`. Frontend now shows per-direction counts in bidirectional sync (e.g. "Pulled 5 files from GitHub, pushed 197 files to GitHub") and the pruned-domain list explicitly when a sync-delete propagated. |

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
- **Self-test isolation** — `POST /api/mcp/self-test` spawns `mcp/server.js` locally, sends initialize + tools/list + list_domains over stdio, and reports round-trip results. If this passes but Claude Desktop still can't see the tool, the issue is in `claude_desktop_config.json`, not the bridge.
- **Version:** 2.3.7

## Known benign GitHub behaviours

- **"Sorry, we had to truncate this directory to 1000 files"** on GitHub's web UI when browsing `domains/articles/wiki/concepts/` (or similarly busy folders) is a **GitHub rendering limit, not a sync issue**. Git itself handles millions of files per directory; the truncation only affects the file-listing view on `github.com`. Clone the repo locally, or use `git log` / `git ls-files`, and you see everything. Sync push/pull transfers all files correctly regardless of this UI limit.
