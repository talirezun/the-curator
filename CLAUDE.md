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
    llm.js        — LLM abstraction (Gemini or Claude, auto-detected from .env)
    chat.js       — multi-turn chat against the wiki
    sync.js       — GitHub sync (git --git-dir / --work-tree)
  routes/
    ingest.js     — POST /api/ingest (SSE streaming)
    domains.js    — domain CRUD
    chat.js       — chat endpoints
    wiki.js       — GET /api/wiki/:domain
    sync.js       — sync endpoints
  public/         — vanilla JS frontend (no build step)
scripts/
  inject-summary-backlinks.js   — retroactive backlink repair for existing summaries
  fix-wiki-duplicates.js        — one-time entity/concept deduplication
  fix-wiki-structure.js         — one-time migration from non-canonical folders
  bulk-reingest.js              — re-ingest all raw files in a domain
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
| `writePage(domain, relativePath, content)` | Normalise path → dedup passes A+B → inject frontmatter → merge with existing → strip blanks → dedup bullets → strip folder-prefix links → normalize variant links (5c) → write → call injectSummaryBacklinks if summary |
| `syncSummaryEntities(domain, summaryPath, writtenPaths)` | Post-ingest reconciliation: injects ALL written entity slugs into summary's "Entities Mentioned", then re-fires injectSummaryBacklinks with the complete list |
| `injectSummaryBacklinks(summarySlug, content, wikiDir)` | For each entity in "Entities Mentioned", injects `[[summaries/slug]]` into that entity's Related section; creates the section if it doesn't exist |
| `deduplicateBulletSections(content)` | Safety net: removes duplicate bullets from all ACCUMULATE sections using dedupKey; runs after every write and after syncSummaryEntities |
| `mergeWikiPage(existing, incoming)` | Union merge: incoming is base, bullets from existing sections are injected (Key Facts, Related, Entities Mentioned, etc.) |
| `injectBulletsIntoSection(content, sectionName, bullets)` | Dedup-aware bullet injection: compares by link target; creates the section if it doesn't exist (uses 'im' multiline regex for existence check) |
| `stripBlanksInBulletSections(content)` | Removes blank lines inside bullet sections (LLM artifact) |
| `normalizePath(relativePath)` | Redirects non-canonical folders → entities/ or concepts/ |
| `injectFrontmatter(content, path, today)` | Extracts inline Tags/Type/Source → builds YAML frontmatter block |

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
           d. injectFrontmatter()
           e. mergeWikiPage() if file exists
           f. stripBlanksInBulletSections()
           g. deduplicateBulletSections() — safety net for merge edge cases
           h. Strip [[entities/...]] and [[concepts/...]] folder-prefix links
           i. Step 5c: normalize [[variant]] links using Pass A+B logic
              (e.g. [[dr-tali-rezun]] → [[tali-rezun]] in page content)
           j. writeFile()
           k. If summary page: injectSummaryBacklinks() (fires once per write)
      7. syncSummaryEntities() ← THE KEY POST-WRITE STEP
           Reads ingest's writtenPaths → injects ALL entity slugs into
           summary's "Entities Mentioned" → deduplicates → re-fires
           injectSummaryBacklinks() with the complete list →
           ALL entities get bidirectional backlinks
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
| (next) | Underscore → hyphen slug normalization in writePage() step 1a |

---

## Environment & Config

```
.env                    — API keys (never committed)
  GEMINI_API_KEY        — Google Gemini (default, recommended)
  ANTHROPIC_API_KEY     — Anthropic Claude (alternative)
  LLM_MODEL            — optional model override
  DOMAINS_PATH         — optional custom path for domains/ folder

.sync-config.json       — GitHub sync credentials (never committed)
```

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
```

---

## Active Development Decisions

- **No vector DB / embeddings** — the wiki is small enough to fit in a single LLM context window for chat. Markdown files are human-readable and Obsidian-native.
- **No React/Vue** — three-tab UI with vanilla JS. No build step.
- **JSON mode for ingest, text mode for chat** — ingest requires structured output; chat needs free prose.
- **Conversations gitignored from app repo but synced via knowledge repo** — personal to each user's machine, not committed to source control.
- **CLAUDE.md per domain** — each domain is a specialist, not a generalist. The schema shapes how the LLM categorises knowledge for that domain.
- **syncSummaryEntities is idempotent** — safe to run multiple times; injectBulletsIntoSection deduplicates by link target.
- **deduplicateBulletSections is always safe to run** — only removes bullets whose dedupKey already appeared earlier in the same section; never drops unique content.
