# Wiki pipeline — key functions, ingest flow, LLM failures, checklists

> Moved out of the auto-loaded `CLAUDE.md` on 2026-09-23 **verbatim** — each bullet, table and code block below is the text `CLAUDE.md` carried, copied by line range; only root-relative link targets were rebased by `../../` because this file lives two folders down. Nothing was reworded or shortened. `CLAUDE.md` keeps a one-line rule per bullet that points here.

## Key Functions (files.js)

| Function | Purpose |
|---|---|
| `writePage(domain, relativePath, content)` | Normalise path → dedup passes A+B → cross-folder dedup (3b) → inject frontmatter → capture pre-write state → merge with existing → strip blanks → dedup bullets → strip folder-prefix links → normalize variant links (5c: entities + concepts + summaries, prefix-tolerant) → write → call injectSummaryBacklinks if summary → return `{canonPath, status, bytesBefore, bytesAfter, sectionsChanged, bulletsAdded}` (v2.5.0+; null on invalid input) |
| `compileConversation(domain, conversationId, onProgress, opts)` | Conversation compile: load conversation → refuse if fewer than `MIN_USER_MESSAGES` user turns (**1** since v3.0.1-beta.15, was 2) → compute deterministic summary slug `<title>-YYYY-MM-DD-<4hex>` → refuse if file already exists at slug (idempotency guard) → **3-step LLM ladder `full → concise → summary-only`** (v3.0.1-beta.27), escalating ONLY on `isOutputTokenLimit(err)` or a JSON parse failure; any other LLM error (503/429/auth/network) surfaces immediately → write all pages via the same writePage pipeline → syncSummaryEntities → programmatic mergeIntoIndex (no LLM-driven index regen) → appendLog → return `{ok, title, pagesWritten, changes, warnings}`. `opts.generateText` is a **test-only** seam (defaults to the real one) for driving the ladder offline. |
| `syncSummaryEntities(domain, summaryPath, writtenPaths)` | Post-ingest reconciliation: injects ALL written entity AND concept slugs into summary's "Entities Mentioned", then re-fires injectSummaryBacklinks with the complete list |
| `injectSummaryBacklinks(summarySlug, content, wikiDir)` | For each entity in "Entities Mentioned", injects `[[summaries/slug]]` into that entity's Related section; checks entities/ first, falls back to concepts/; creates the section if it doesn't exist |
| `deduplicateBulletSections(content)` | Safety net: removes duplicate bullets from all ACCUMULATE sections using dedupKey; runs after every write and after syncSummaryEntities |
| `mergeWikiPage(existing, incoming)` | Union merge: incoming is base, bullets from existing ACCUMULATE sections are injected (Key Facts, Related, Entities Mentioned, etc.). **Prose preservation (v3.0.1-beta.15):** any `## ` PROSE section present in `existing` but ENTIRELY ABSENT from `incoming` is preserved (case-insensitive match), so a thin Compile/Curate edit can't wipe an existing page's Definition / Summary / Why It Matters. If `incoming` includes the heading, incoming wins (no duplication). Exported for unit testing. |
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
# NOTE: every substitution needs its own -e. The first script cannot be bare
# when a second -e follows — BSD sed then reads "-e" as a FILENAME and exits 1
# having changed nothing (silent no-op; verified).
find domains/articles/wiki -name "*.md" -print0 | xargs -0 sed -i '' \
  -e 's/\[\[talirezun\]\]/[[tali-rezun]]/g' \
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
