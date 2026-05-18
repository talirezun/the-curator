import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import path from 'path';
import { jsonrepair } from 'jsonrepair';
import { generateText } from './llm.js';
import {
  readSchema,
  readIndex,
  rawPath,
  wikiPath,
  writePage,
  appendLog,
  syncSummaryEntities,
} from './files.js';
import { mergeIntoIndex } from './compile.js';

/**
 * v3.0.1-beta.1 — deterministic summary slug computed from the source filename.
 *
 * Re-ingesting the same source file MUST land on the same summaries/ path so
 * mergeWikiPage union-merges into the existing summary instead of creating a
 * second file. Previously the LLM picked the summary slug freely, so two
 * ingests of `report.pdf` could produce `summaries/report-2024.md` and
 * `summaries/report.md` — two files, fragmented backlinks.
 *
 * Mirrors the slug conventions used elsewhere: lowercase, alphanumeric +
 * hyphens, max 80 chars, no trailing hyphen. Always returns a non-empty slug.
 */
export function computeSummarySlugFromSource(originalName) {
  const base = (originalName || 'untitled').replace(/\.[^.]+$/, '');
  const slug = base
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')   // strip punctuation
    .trim()
    .replace(/\s+/g, '-')        // spaces → hyphens
    .replace(/_/g, '-')          // underscores → hyphens (wiki convention)
    .replace(/-+/g, '-')         // collapse runs
    .slice(0, 80)
    .replace(/^-+|-+$/g, '');    // strip leading + trailing hyphens
  return slug || 'untitled';
}

async function extractText(filePath) {
  if (filePath.endsWith('.pdf')) {
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const buffer = await readFile(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  }
  return readFile(filePath, 'utf8');
}

/**
 * Attempt to parse JSON from the LLM response.
 * Handles multiple failure modes in order:
 *   1. Valid JSON as-is                       → fast path
 *   2. Markdown-fenced JSON (```json … ```)   → strip fences and retry
 *   3. Bare { … } block somewhere in output  → extract and retry
 *   4. Malformed JSON (unescaped quotes etc.) → jsonrepair and retry
 */
export function parseJSON(raw) {
  // 1. Fast path — valid as-is
  try { return JSON.parse(raw); } catch { /* fall through */ }

  // 2. Strip markdown fences (```json ... ```)
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
  }

  // 3. Find the outermost { ... } block
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  const candidate = braceMatch ? braceMatch[0] : raw;
  if (braceMatch) {
    try { return JSON.parse(candidate); } catch { /* fall through */ }
  }

  // 4. jsonrepair — handles unescaped quotes, trailing commas, and other
  //    common LLM JSON mistakes (e.g. they "read" the entire source)
  try {
    return JSON.parse(jsonrepair(candidate));
  } catch (repairErr) {
    console.error('[ingest] jsonrepair also failed:', repairErr.message.slice(0, 200));
    console.error('[ingest] Response first 300 chars:', raw.slice(0, 300));
    console.error('[ingest] Response last  300 chars:', raw.slice(-300));
    throw new Error(
      `Could not parse JSON response. Response length: ${raw.length} chars. ` +
      `Last 200 chars: ${raw.slice(-200)}`
    );
  }
}

// ── Phase 1: outline ──────────────────────────────────────────────────────────

function buildOutlinePrompt(today, index, existingFiles, originalName, text, isOverwrite, summaryPath) {
  const overwriteNote = isOverwrite
    ? 'NOTE: This document has been ingested before. Update existing pages rather than duplicating content.'
    : '';

  const entityFileList = existingFiles.entities.length
    ? existingFiles.entities.map(f => `  entities/${f}`).join('\n')
    : '  (none yet)';
  const conceptFileList = existingFiles.concepts.length
    ? existingFiles.concepts.map(f => `  concepts/${f}`).join('\n')
    : '  (none yet)';

  return `Today's date: ${today}
${overwriteNote ? '\n' + overwriteNote : ''}
EXISTING WIKI FILES — reuse these exact filenames for known entities/concepts.
Do NOT invent variants (e.g. if "lumina-ai.md" exists, do NOT create "lumina.md" or "lumina-ai-platform.md").
Only create a new file for a genuinely new entity/concept not already in these lists.

Existing entity files:
${entityFileList}

Existing concept files:
${conceptFileList}

Current wiki index:
${index || '(empty — this is the first ingest)'}

--- SOURCE DOCUMENT: ${originalName} ---
${text}
--- END SOURCE DOCUMENT ---

Your task: Plan which wiki pages to create or update for this source.
Produce ONLY a JSON outline — do NOT write any page content yet.

REQUIRED COVERAGE — your outline MUST include ALL of the following:

1. EXACTLY ONE summary page at this exact path: "${summaryPath}"
   Do NOT invent a different summaries/ path. This is the canonical slug for
   this source — re-ingesting the same file must land on the same summary.

2. ORIGINATOR entity page(s) for the author(s), speaker(s), creator(s), or
   primary subject(s) of this source. If the source is an article, the author
   is an entity. If it's a talk, the speaker is an entity. If it's a company
   announcement, the company is an entity. NEVER omit the originator.

3. SUBSTANTIVE entities — people, tools, companies, frameworks, datasets,
   projects, countries, or organizations that the source discusses with
   enough substance to deserve their own page. Skip names that are only
   mentioned in passing (e.g. one-off URL, fleeting reference).

4. SUBSTANTIVE concepts — key ideas, techniques, principles, or methodologies
   the source actually develops or argues about. Skip ideas that are only
   name-dropped.

5. CONSOLIDATION RULE: when the source presents 3 or more closely related
   sub-ideas under one umbrella topic, create ONE parent concept page that
   covers the umbrella (with bullets summarising each sub-idea), rather than
   creating 3+ sibling concept pages. Sibling pages should only exist when
   each sub-idea is independently substantial and deserves its own page.

6. BUDGET: for a single source, plan around 5–30 pages total (summary +
   entities + concepts). Going above 40 indicates the page list is too
   fine-grained — apply the consolidation rule.
   Example: prefer one "prompt-engineering.md" page over separate
   "few-shot-prompting.md" + "chain-of-thought-prompting.md" +
   "role-prompting.md" pages UNLESS each is treated in depth.

CRITICAL — Valid folder prefixes for page paths:
  • summaries/  — exactly one summary page (path is fixed above)
  • entities/   — every person, tool, company, framework, dataset, project, country, organization
  • concepts/   — every idea, technique, principle, methodology
NEVER use any other folder (e.g. "people/", "tools/", "frameworks/" are INVALID).
Every path MUST start with one of the three prefixes above.

CROSS-FOLDER RULE: If a file already exists in entities/, do NOT create a concepts/ file with the same or similar name, and vice versa. Companies (Google, Microsoft), organizations (IEA), and countries (Chile, Japan) are ALWAYS entities, never concepts.

Return ONLY valid JSON in this exact shape (no markdown fences, no commentary):
{
  "title": "human-readable title of this source",
  "pages": [
    { "path": "${summaryPath}", "summary": "one-line description of the source" },
    { "path": "entities/some-author.md", "summary": "one-line description" },
    { "path": "concepts/some-concept.md", "summary": "one-line description" }
  ]
}`;
}

// ── Progress helper ───────────────────────────────────────────────────────────

/**
 * Wraps a raw progress emitter into a typed progress call.
 * onProgress signature: ({ type, pct, message }) => void
 */
function makeProgress(onProgress) {
  return (pct, message, type = 'progress') => {
    onProgress?.({ type, pct, message });
  };
}

// ── Phase 2: page content (batched) ──────────────────────────────────────────

function buildBatchPrompt(today, originalName, text, pageBatch, existingFiles = { entities: [], concepts: [] }) {
  const pageList = pageBatch
    .map(p => `  { "path": "${p.path}", "summary": "${p.summary}" }`)
    .join(',\n');

  return `Today's date: ${today}

--- SOURCE DOCUMENT: ${originalName} ---
${text}
--- END SOURCE DOCUMENT ---

Write the full markdown content for EXACTLY these wiki pages (no others):
[
${pageList}
]

Guidelines:
- Each page: 3–8 concise bullet points or sentences. No long prose.
- Do NOT include YAML frontmatter (--- blocks) — it is added automatically after generation.
- Entity pages: include a line "Type: <type>" and a line "Tags: tag1, tag2" in the body.
- Concept and summary pages: include a line "Tags: tag1, tag2" in the body.
- Links: always use [[page-name]] — NEVER include folder prefix (write [[rag]] not [[concepts/rag]]).
- LINK ACCURACY: Use the EXACT slug from existing filenames when linking. If the entity file is iea.md, write [[iea]], NOT [[international-energy-agency]]. If the summary is the-energy-and-water-footprint-of-generative-ai.md, link as [[summaries/the-energy-and-water-footprint-of-generative-ai]], not a shortened form.

EXISTING WIKI FILES — when writing content for these pages, use [[page-name]] links that match existing filenames exactly.
Existing entities: ${existingFiles.entities.map(f => f.replace('.md', '')).join(', ')}
Existing concepts: ${existingFiles.concepts.map(f => f.replace('.md', '')).join(', ')}

CRITICAL — Valid folder prefixes for page paths:
  • summaries/  — one summary page per source document
  • entities/   — every person, tool, company, framework, dataset, project, country, organization
  • concepts/   — every idea, technique, principle, methodology
NEVER use any other folder (e.g. "people/", "tools/", "frameworks/" are INVALID).
Every path MUST start with one of the three prefixes above.

CROSS-FOLDER RULE: If a file already exists in entities/, do NOT create a concepts/ file with the same or similar name, and vice versa. Companies (Google, Microsoft), organizations (IEA), and countries (Chile, Japan) are ALWAYS entities, never concepts.

Each "page.summary" is a 1-line description that will be added to the wiki
index. Keep each under 160 characters. For pages already listed above with a
summary, you may reuse that summary text verbatim.

Return ONLY valid JSON in this exact shape (no markdown fences, no commentary):
{
  "pages": [
    { "path": "summaries/example-source.md", "content": "...", "summary": "1-line description for the index" },
    { "path": "concepts/some-concept.md",    "content": "...", "summary": "1-line description" }
  ]
}`;
}

// ── Phase 3 (REMOVED in v3.0.1-beta.1) ────────────────────────────────────────
//
// The LLM-driven index regeneration that previously lived here was replaced by
// a programmatic merge (see mergeIntoIndex imported from compile.js). On large
// domains the 20+ KB markdown table saturated the output budget; pages could
// land on disk but vanish from the index. The same bug was already fixed in
// the compile pipeline (v2.5.0). Multi-phase ingest now uses the same primitive.

// ── Originator detection (v3.0.1-beta.1) ──────────────────────────────────────

/**
 * Extract likely originator names (authors, speakers) from the raw source text
 * using high-precision regex patterns. Used as a defensive layer: even with
 * the REQUIRED COVERAGE rule in the prompt, the LLM sometimes focuses on the
 * technical content of an article and silently omits the author entity. This
 * function spots explicit author markers and tells the validator "make sure
 * an entity page exists for THIS name."
 *
 * Patterns recognised (in order of confidence):
 *   1. YAML frontmatter `author: "Name"` or `author: [[Name]]`
 *   2. Inline "by Dr. Name", "by Name Surname"
 *   3. "Author: Name" / "Authors: Name"
 *
 * Returns an array of name strings (best-effort, may be empty). No LLM call.
 */
export function extractAuthorHints(text) {
  const hints = new Set();
  if (typeof text !== 'string' || !text) return [];

  // Cap to the first + last 5000 chars — bylines + bios live at edges, not
  // in the middle, and scanning the whole source is wasteful for long PDFs.
  const head = text.slice(0, 5000);
  const tail = text.length > 10000 ? text.slice(-5000) : '';
  const scan = head + '\n' + tail;

  // 1. YAML frontmatter author field — common in Obsidian-formatted MD
  //    Forms: `author: Dr Tali Rezun`, `author: "Dr Tali Rezun"`,
  //           `author:\n  - "[[Dr. Tali Rezun]]"`
  //    CAREFUL: use `[ \t]*` after the colon (NOT `\s*`) so we don't
  //    accidentally chew through `\n` and capture the multi-line list item.
  const yamlBlock = scan.match(/^---\r?\n([\s\S]{0,2000}?)\r?\n---/);
  if (yamlBlock) {
    const fm = yamlBlock[1];
    const authorLine = fm.match(/^author[s]?[ \t]*:[ \t]*(.+)$/mi);
    if (authorLine) {
      let v = authorLine[1].trim();
      if (v) {
        // Strip surrounding quotes
        v = v.replace(/^["']|["']$/g, '');
        // Strip [[wikilink]] syntax if present
        v = v.replace(/^\[\[|\]\]$/g, '');
        if (v && v.length > 1 && v.length < 80) hints.add(v);
      }
    }
    // Multi-line author list (bare `author:` key, value on following lines)
    const listMatch = fm.match(/^author[s]?[ \t]*:[ \t]*\n((?:[ \t]*-[^\n]+\n?)+)/mi);
    if (listMatch) {
      for (const line of listMatch[1].split('\n')) {
        let v = line.replace(/^[ \t]*-\s*/, '').trim();
        v = v.replace(/^["']|["']$/g, '');
        v = v.replace(/^\[\[|\]\]$/g, '');
        if (v && v.length > 1 && v.length < 80) hints.add(v);
      }
    }
  }

  // 2. "By Dr. Name" / "by Name Surname" — common in article bylines / PDFs.
  //    Restrict to lines with reasonable name shape: 2-4 capitalised words,
  //    optional honorific. Stops at line break or comma (often "by X | publication").
  const byRe = /(?:^|\n)\s*(?:By|by|BY)\s+((?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|Professor)?\s*(?:[A-Z][a-zA-ZéèžčšćŠČŽĐ.\-']+\.?\s+){1,3}[A-Z][a-zA-ZéèžčšćŠČŽĐ.\-']+)\s*(?:[,\n|]|\s+(?:on|in|at|for|—|–|-))/g;
  let m;
  while ((m = byRe.exec(scan)) !== null) {
    const name = m[1].trim().replace(/\s+/g, ' ');
    if (name.length > 3 && name.length < 80) hints.add(name);
  }

  // 3. "Author: Name" / "Authors: Name" — same-line value only.
  //    Uses horizontal whitespace [ \t]* (NOT \s*) after the colon so we
  //    don't accidentally chew through a newline and capture the next
  //    YAML list item — a bare YAML `author:` key with the value on the
  //    next line should be handled by the multi-line listMatch above.
  const authorRe = /(?:^|\n)[ \t]*Authors?[ \t]*:[ \t]*([^\n,]+)/gi;
  while ((m = authorRe.exec(scan)) !== null) {
    let v = m[1].trim();
    if (!v) continue;  // bare `author:` with no same-line value
    v = v.replace(/^["']|["']$/g, '');
    v = v.replace(/^\[\[|\]\]$/g, '');
    if (v && v.length > 1 && v.length < 80 && !v.includes('http')) hints.add(v);
  }

  return [...hints];
}

/**
 * Slugify a human name into a wiki filename slug. Mirrors the lowercase-
 * hyphenated convention enforced elsewhere. Used to translate originator
 * hints into entity slugs we can check against the outline.
 *
 * "Dr. Tali Režun" → "tali-rezun"
 * "Mr. John Q. Smith" → "john-q-smith"
 *
 * The honorific prefix is stripped because writePage's Pass A would strip
 * it anyway after writing; we use the post-strip form as the canonical key.
 */
export function slugifyName(name) {
  if (!name) return '';
  return name
    .normalize('NFKD').replace(/\p{Diacritic}/gu, '') // strip diacritics
    .replace(/^(dr|mr|mrs|ms|prof|professor)\.?\s+/i, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Outline validator (v3.0.1-beta.1) ─────────────────────────────────────────

/**
 * Validate and patch a Phase-1 outline so it satisfies the required-coverage
 * contract. The new prompt already states the rules, but model compliance is
 * never 100% — this is the belt-and-braces guarantee.
 *
 * Currently enforces ONE invariant:
 *   - Exactly one page at `summaryPath`. If missing, inject it.
 *     If present at a different summaries/ path, redirect it.
 *
 * Entity/concept coverage is *strongly* requested by the prompt but cannot be
 * machine-validated without a second LLM call (which would defeat the purpose).
 * We rely on the prompt + the LLM's compliance to handle those.
 *
 * @returns {{ outline: object, warnings: string[] }}  patched outline + any warnings
 */
export function validateOutline(outline, summaryPath, originalName, originatorHints = []) {
  const warnings = [];
  const pages = Array.isArray(outline?.pages) ? [...outline.pages] : [];

  const summaryEntries = pages.filter(p =>
    p && typeof p.path === 'string' && p.path.startsWith('summaries/')
  );

  if (summaryEntries.length === 0) {
    // No summary at all — inject one at the canonical path
    warnings.push(`Outline missing summary page — injected "${summaryPath}".`);
    pages.unshift({
      path: summaryPath,
      summary: `Summary of ${originalName}`,
    });
  } else {
    // One or more summaries; redirect the first to the canonical path, drop any others
    const canonical = summaryEntries.find(p => p.path === summaryPath);
    if (!canonical) {
      const first = summaryEntries[0];
      warnings.push(`Outline used non-canonical summary path "${first.path}" — redirected to "${summaryPath}".`);
      first.path = summaryPath;
    }
    // Drop any extra summaries beyond the first
    if (summaryEntries.length > 1) {
      const keep = summaryEntries[0];
      const extras = summaryEntries.slice(1).map(p => p.path);
      warnings.push(`Outline had ${summaryEntries.length} summary pages — kept "${keep.path}", dropped ${extras.join(', ')}.`);
      for (const extra of summaryEntries.slice(1)) {
        const idx = pages.indexOf(extra);
        if (idx >= 0) pages.splice(idx, 1);
      }
    }
  }

  // Originator-hint check (v3.0.1+): even with the REQUIRED COVERAGE rule
  // in the prompt, the LLM sometimes focuses on the technical content of an
  // article and silently omits the author entity. When the source text contains
  // explicit author markers (YAML `author:`, "by Dr X", "Author: X"), make sure
  // an entity page exists for that name. If the outline already has a variant
  // (honorific included, or hyphen drop), REDIRECT it to the canonical slug
  // rather than creating a duplicate.
  if (Array.isArray(originatorHints) && originatorHints.length > 0) {
    // Mirror writePage's Pass A regex — strip leading "dr-", "mr-", "prof-"
    // etc., AND the same patterns with an optional period ("dr.-tali-rezun"
    // produced when the LLM preserves the dot from "Dr."). Keep this in sync
    // with TITLE_PREFIX_RE in files.js — they MUST stay aligned or the
    // validator and writePage disagree on what counts as the same entity.
    const HONORIFIC_RE = /^(dr|mr|ms|mrs|prof|professor|the)\.?-/;
    // Normalisation that mirrors what writePage's Pass A + Pass B do at write
    // time: strip honorific prefix, then strip all hyphens, lowercase. Two
    // slugs that produce the same normKey are write-time equivalent.
    const normKey = (slug) => slug.replace(HONORIFIC_RE, '').replace(/-/g, '').toLowerCase();

    // Build a map from normKey → first entity page entry already in outline
    const entityByNormKey = new Map();
    for (const p of pages) {
      if (p && typeof p.path === 'string' && p.path.startsWith('entities/')) {
        const slug = p.path.replace(/^entities\//, '').replace(/\.md$/, '');
        const k = normKey(slug);
        if (!entityByNormKey.has(k)) entityByNormKey.set(k, p);
      }
    }

    for (const hint of originatorHints) {
      const canonSlug = slugifyName(hint);
      if (!canonSlug) continue;
      const canonKey = normKey(canonSlug);

      const existingEntry = entityByNormKey.get(canonKey);
      if (existingEntry) {
        // Outline has a variant (e.g. "dr-tali-rezun") that resolves to our
        // canonical slug. Rewrite it in place so Phase 2 generates content
        // for the canonical path. writePage's Pass A would have done this at
        // write time, but doing it here keeps the slug used in cross-page
        // [[wikilinks]] consistent.
        if (existingEntry.path !== `entities/${canonSlug}.md`) {
          warnings.push(`Outline used originator slug "${existingEntry.path}" — redirected to canonical "entities/${canonSlug}.md".`);
          existingEntry.path = `entities/${canonSlug}.md`;
        }
        continue;
      }

      // Truly missing — inject at the FRONT (after summary) so it's written
      // first; any later LLM-generated honorific variant will then redirect
      // into this canonical file via writePage's Pass A.
      warnings.push(`Outline omitted originator "${hint}" — injected entities/${canonSlug}.md (detected from source byline/frontmatter).`);
      const summaryIdx = pages.findIndex(p =>
        p && typeof p.path === 'string' && p.path.startsWith('summaries/')
      );
      const insertAt = summaryIdx >= 0 ? summaryIdx + 1 : 0;
      const newEntry = {
        path: `entities/${canonSlug}.md`,
        summary: `${hint} — originator of "${originalName}".`,
      };
      pages.splice(insertAt, 0, newEntry);
      entityByNormKey.set(canonKey, newEntry);
    }
  }

  return { outline: { ...outline, pages }, warnings };
}

// ── Single-pass prompt (small documents) ─────────────────────────────────────

function buildPrompt(today, index, existingFiles, originalName, text, strict, isOverwrite = false, summaryPath = null) {
  const conciseness = strict
    ? 'CRITICAL: Maximum 3 bullet points per page. No prose. The shorter the better.'
    : 'Keep each page concise — 3 to 8 bullet points or sentences max. No long prose.';

  const overwriteNote = isOverwrite
    ? 'NOTE: This document has been ingested before. Update any existing wiki pages with new or changed information rather than duplicating content. Merge carefully.'
    : '';

  const entityFileList = existingFiles.entities.length
    ? existingFiles.entities.map(f => `  entities/${f}`).join('\n')
    : '  (none yet)';
  const conceptFileList = existingFiles.concepts.length
    ? existingFiles.concepts.map(f => `  concepts/${f}`).join('\n')
    : '  (none yet)';

  return `Today's date: ${today}
${overwriteNote ? '\n' + overwriteNote : ''}
EXISTING WIKI FILES — reuse these exact filenames for known entities/concepts.
Do NOT invent variants (e.g. if "lumina-ai.md" exists, do NOT create "lumina.md" or "lumina-ai-platform.md").
Only create a new file for a genuinely new entity/concept not already in these lists.

Existing entity files:
${entityFileList}

Existing concept files:
${conceptFileList}

Current wiki index:
${index || '(empty — this is the first ingest)'}

--- SOURCE DOCUMENT: ${originalName} ---
${text}
--- END SOURCE DOCUMENT ---

Your task:

REQUIRED COVERAGE — your output MUST include ALL of the following:

1. EXACTLY ONE summary page at this exact path: "${summaryPath}"
   Do NOT invent a different summaries/ path. This is the canonical slug for
   this source — re-ingesting the same file must land on the same summary.

2. ORIGINATOR entity page(s) for the author(s), speaker(s), creator(s), or
   primary subject(s) of this source. If the source is an article, the author
   is an entity. If it's a talk, the speaker is an entity. If it's a company
   announcement, the company is an entity. NEVER omit the originator.

3. SUBSTANTIVE entities — people, tools, companies, frameworks, datasets,
   projects, countries, or organizations that the source discusses with
   enough substance to deserve their own page. Skip names that are only
   mentioned in passing (e.g. one-off URL, fleeting reference).

4. SUBSTANTIVE concepts — key ideas, techniques, principles, or methodologies
   the source actually develops or argues about. Skip ideas that are only
   name-dropped.

5. CONSOLIDATION RULE: when the source presents 3 or more closely related
   sub-ideas under one umbrella topic, create ONE parent concept page that
   covers the umbrella (with bullets summarising each sub-idea), rather than
   creating 3+ sibling concept pages. Sibling pages should only exist when
   each sub-idea is independently substantial and deserves its own page.

6. BUDGET: for a single source, plan around 5–30 pages total (summary +
   entities + concepts). Going above 40 indicates the page list is too
   fine-grained — apply the consolidation rule.

7. Add cross-references between related pages using [[page-name]] syntax.

8. DO NOT touch index.md — the application maintains it after this call.

${conciseness}

Page body rules:
- Do NOT include YAML frontmatter (--- blocks) — it is added automatically after generation.
- Entity pages: include a "Type: <entity-type>" line and a "Tags: tag1, tag2" line in the body.
- Concept and summary pages: include a "Tags: tag1, tag2" line in the body.
- Links: always write [[page-name]] — NEVER use folder prefix (write [[rag]] not [[concepts/rag]]).
- LINK ACCURACY: Use the EXACT slug from existing filenames when linking. If the entity file is iea.md, write [[iea]], NOT [[international-energy-agency]]. If the summary is the-energy-and-water-footprint-of-generative-ai.md, link as [[summaries/the-energy-and-water-footprint-of-generative-ai]], not a shortened form.

CRITICAL — Valid folder prefixes for page paths:
  • summaries/  — exactly one summary page (path is fixed above)
  • entities/   — every person, tool, company, framework, dataset, project, country, organization
  • concepts/   — every idea, technique, principle, methodology
NEVER use any other folder (e.g. "people/", "tools/", "frameworks/" are INVALID).
Every path MUST start with one of the three prefixes above.

CROSS-FOLDER RULE: If a file already exists in entities/, do NOT create a concepts/ file with the same or similar name, and vice versa. Companies (Google, Microsoft), organizations (IEA), and countries (Chile, Japan) are ALWAYS entities, never concepts.

Each "page.summary" is a 1-line description that will be added to the index.
Keep each summary under 160 characters.

Return ONLY valid JSON in this exact shape (no markdown fences, no commentary,
no index.md content — the app maintains the index itself):
{
  "title": "human-readable title of this source",
  "pages": [
    { "path": "${summaryPath}", "content": "...", "summary": "1-line description for the index" },
    { "path": "entities/some-author.md", "content": "...", "summary": "1-line description" },
    { "path": "concepts/some-concept.md", "content": "...", "summary": "1-line description" }
  ]
}`;
}

// ── Multi-phase ingest (large documents) ─────────────────────────────────────

// Smaller batches produce shorter JSON responses, dramatically reducing parse
// failures from accumulated unescaped quotes in dense documents.
const BATCH_SIZE = 4;

/**
 * Build a clearly-marked stub page body used as a last-resort fallback when
 * the LLM cannot produce content for a planned page. The stub is rendered as
 * a visible warning so the user knows the page is a placeholder rather than
 * silently shipping near-empty content (v3.0.1-beta.1).
 */
function stubPageContent(pagePath, summary, originalName) {
  const slug = pagePath.replace(/^.*\//, '').replace(/\.md$/, '');
  return `# ${slug}

> ⚠ **Stub page — AI failed to write this on ingest.**
> The planned page summary is below. Re-ingest "${originalName}" to fix this,
> or delete this file and re-ingest if you want the slug recomputed.

${summary || '(no summary captured)'}

Tags: stub, type/${pagePath.startsWith('entities/') ? 'entity' : 'concept'}
`;
}

async function ingestMultiPhase(schema, today, index, existingFiles, originalName, text, isOverwrite, progress, summaryPath, warnings, originatorHints = []) {
  // Phase 1: outline
  // Diagnostics use console.error so this module is safe to import from the
  // MCP child process (which reserves stdout for JSON-RPC) — see v2.5.2.
  console.error('[ingest] Large document — using multi-phase ingest. Phase 1: outline...');
  progress(12, 'Phase 1: planning wiki structure…');
  const outlineRaw = (await generateText(
    schema,
    buildOutlinePrompt(today, index, existingFiles, originalName, text, isOverwrite, summaryPath),
    16384,
    'json',
    (msg) => progress(12, msg, 'wait')
  )).trim();

  // v3.0.1-beta.7: retry once with a stricter JSON-only prompt if the first
  // outline response is malformed. LLM outputs are non-deterministic — a
  // second pass with explicit "no markdown, no commentary, valid JSON only"
  // guidance almost always works when the first one produces bad JSON
  // (unescaped quote in a summary, stray backtick, etc).
  let outline;
  try {
    outline = parseJSON(outlineRaw);
  } catch (firstErr) {
    console.warn(`[ingest] Phase 1 outline parse failed (${outlineRaw.length} chars). Retrying with stricter JSON prompt...`);
    warnings.push('Phase 1 outline returned malformed JSON; auto-retried with stricter prompt.');
    progress(13, 'Phase 1: retrying with stricter JSON…', 'wait');

    const strictPrompt = buildOutlinePrompt(today, index, existingFiles, originalName, text, isOverwrite, summaryPath)
      + '\n\nIMPORTANT — STRICT JSON REQUIREMENTS:\n'
      + '1. Return ONLY the JSON object. No markdown fences, no "```json" wrapper, no commentary before or after.\n'
      + '2. Inside "summary" string values: do NOT use double quotes. Use single quotes if you need quotation marks. Avoid backslashes and special characters.\n'
      + '3. Keep each "summary" under 120 characters to reduce the chance of malformed strings.\n'
      + '4. The response must parse with native JSON.parse on the first try.';

    try {
      const outlineRaw2 = (await generateText(
        schema, strictPrompt, 16384, 'json',
        (msg) => progress(13, msg, 'wait')
      )).trim();
      outline = parseJSON(outlineRaw2);
      console.error('[ingest] Phase 1 stricter retry succeeded.');
    } catch (secondErr) {
      // Both attempts failed — throw a clean, actionable error the UI can show.
      console.error('[ingest] Phase 1 retry also failed:', secondErr.message.slice(0, 200));
      throw new Error(
        `⚠ The AI returned malformed JSON for this source twice in a row — a rare ` +
        `transient issue with the AI provider (not a problem with The Curator or your file). ` +
        `What to do: (1) try Ingest again — LLM output is non-deterministic, the next attempt ` +
        `usually succeeds; (2) if the issue persists, split the source PDF into smaller parts ` +
        `(e.g. by chapter) and ingest each separately, or convert the PDF to a .md file first ` +
        `with cleaner text; (3) temporarily switch to a different AI provider in Settings ` +
        `(Anthropic Claude often handles edge cases differently from Gemini).`
      );
    }
  }

  // v3.0.1-beta.1: validate outline against required-coverage contract.
  // Injects the summary page if the LLM omitted it; redirects non-canonical
  // summary paths to the deterministic slug; injects any originator entities
  // that the LLM omitted but the source text plainly identifies.
  const validated = validateOutline(outline, summaryPath, originalName, originatorHints);
  outline = validated.outline;
  for (const w of validated.warnings) {
    console.warn(`[ingest] Outline validator: ${w}`);
    warnings.push(w);
  }

  const allPages = outline.pages; // [{path, summary}]
  const totalBatches = Math.ceil(allPages.length / BATCH_SIZE);
  console.error(`[ingest] Phase 1 complete — ${allPages.length} pages planned.`);

  // Phase 2: batched content  (20% → 78%)
  const writtenPages = []; // [{path, content, summary?}]

  for (let i = 0; i < allPages.length; i += BATCH_SIZE) {
    const batch = allPages.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batchPct = Math.round(20 + (batchNum / totalBatches) * 58);
    console.error(`[ingest] Phase 2 — batch ${batchNum}/${totalBatches} (${batch.length} pages)...`);
    progress(batchPct, `Phase 2: writing content, batch ${batchNum} of ${totalBatches}…`);

    const batchRaw = (await generateText(
      schema,
      buildBatchPrompt(today, originalName, text, batch, existingFiles),
      16384,
      'json',
      (msg) => progress(batchPct, msg, 'wait')
    )).trim();

    let batchResult;
    try {
      batchResult = parseJSON(batchRaw);
    } catch (batchErr) {
      // Batch parse failed — fall back to writing one page at a time.
      // A 1-page response is only ~300–800 chars: essentially impossible to fail.
      console.warn(`[ingest] Batch ${batchNum} parse failed (${batchRaw.length} chars) — retrying page-by-page...`);
      batchResult = { pages: [] };
      for (const singlePage of batch) {
        try {
          const singleRaw = (await generateText(
            schema,
            buildBatchPrompt(today, originalName, text, [singlePage], existingFiles),
            4096,
            'json',
            (msg) => progress(batchPct, msg, 'wait')
          )).trim();
          const singleResult = parseJSON(singleRaw);
          batchResult.pages.push(...singleResult.pages);
          console.error(`[ingest]   ✓ ${singlePage.path}`);
        } catch (singleErr) {
          // Absolute last resort — create a clearly-marked stub page so the
          // ingest completes; the user can see and re-ingest to fix.
          console.warn(`[ingest]   ✗ ${singlePage.path} — stub created.`);
          warnings.push(`Stub page created for "${singlePage.path}" — LLM could not generate content. Re-ingest to fix.`);
          batchResult.pages.push({
            path: singlePage.path,
            content: stubPageContent(singlePage.path, singlePage.summary, originalName),
            summary: singlePage.summary,
          });
        }
      }
    }

    // Preserve the outline-planned summary on each page if the batch response
    // didn't include one (some models omit the field even when prompted).
    for (const p of batchResult.pages) {
      if (p && !p.summary) {
        const planned = batch.find(b => b.path === p.path);
        if (planned && planned.summary) p.summary = planned.summary;
      }
    }
    writtenPages.push(...batchResult.pages);
  }

  // No Phase 3 — index is merged programmatically by the caller.
  return {
    title: outline.title,
    pages: writtenPages,
    // outlinePages carries the LLM's per-page `summary` strings so the
    // programmatic index merge can populate the description column even if a
    // page-content response omitted the summary field.
    outlinePages: allPages,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

// If the single-pass response exceeds this size AND parsing fails, skip the
// strict-brevity retry (which would produce a similarly long, similarly broken
// response) and go straight to multi-phase.  Empirically, responses > 8 000
// chars contain enough quoted terms and special characters that even jsonrepair
// cannot reliably reconstruct them.
const SINGLE_PASS_RESPONSE_LIMIT = 8_000;

// Skip single-pass entirely for medium-to-large input documents.
// Single-pass for a 20 k+ char source produces 10 000–20 000 chars of JSON —
// enough for accumulated unescaped quotes to break parsing. Multi-phase keeps
// each batch to ~10 pages / ~3 000 chars of JSON, which is far more reliable.
const MULTI_PHASE_INPUT_THRESHOLD = 15_000;

export async function ingestFile(domain, filePath, originalName, isOverwrite = false, onProgress = null) {
  const progress = makeProgress(onProgress);

  // Warnings accumulated across the pipeline (surfaced to the UI + result panel)
  const warnings = [];

  // v3.0.1-beta.1: deterministic summary slug from source filename. Re-ingesting
  // the same file always lands on the same summary path → mergeWikiPage union-
  // merges into the existing summary instead of creating a duplicate file.
  const summarySlug = computeSummarySlugFromSource(originalName);
  const summaryPath = `summaries/${summarySlug}.md`;

  // Save to raw/
  progress(4, 'Saving source file…');
  const rawDir = rawPath(domain);
  await mkdir(rawDir, { recursive: true });
  const destPath = path.join(rawDir, originalName);
  const buffer = await readFile(filePath);
  await writeFile(destPath, buffer);

  // Extract text — cap at 80 000 chars to stay within input limits.
  // v3.0.1-beta.1: when truncation kicks in, surface a warning in the result
  // and in the progress stream so the user knows information was dropped.
  progress(8, 'Extracting text from document…');
  const fullText = await extractText(destPath);
  const TEXT_CAP = 80_000;
  const truncated = fullText.length > TEXT_CAP;
  const text = fullText.slice(0, TEXT_CAP);
  if (truncated) {
    const msg = `Source was ${fullText.length.toLocaleString()} chars; only the first ${TEXT_CAP.toLocaleString()} were processed. Information past that point was not seen by the AI.`;
    console.warn(`[ingest] ⚠ ${msg}`);
    warnings.push(msg);
    progress(8, `⚠ Source truncated to ${TEXT_CAP.toLocaleString()} chars — see warnings.`);
  }

  // v3.0.1-beta.1: scan the source for explicit author markers. The LLM's
  // REQUIRED COVERAGE rule asks it to include the originator, but real LLM
  // runs sometimes omit the author when the source is heavily technical and
  // the byline is buried in YAML frontmatter or a bio paragraph. This
  // heuristic-based fallback runs against the raw text + the original
  // filename and ensures the validator can inject any missing originator
  // entity pages. Best-effort: empty array if nothing detected.
  const originatorHints = extractAuthorHints(fullText);
  if (originatorHints.length > 0) {
    console.error(`[ingest] Detected originator hints: ${originatorHints.join(', ')}`);
  }

  // Load schema and current index
  const schema = await readSchema(domain);
  const index = await readIndex(domain);
  const today = new Date().toISOString().slice(0, 10);

  // Read existing entity/concept filenames — passed to LLM prompts so it reuses
  // existing pages rather than creating near-duplicate files on every ingest.
  const wikiDir = wikiPath(domain);
  const existingFiles = {
    entities: await readdir(path.join(wikiDir, 'entities')).then(f => f.filter(x => x.endsWith('.md'))).catch(() => []),
    concepts:  await readdir(path.join(wikiDir, 'concepts')).then(f => f.filter(x => x.endsWith('.md'))).catch(() => []),
  };

  let result;

  // ── Single-pass attempt (works for most documents) ─────────────────────────
  let usedMultiPhase = false;
  let singlePassFailed = false;

  // Large inputs reliably overflow the output token window in single-pass.
  // Skip straight to multi-phase to avoid two wasted API calls.
  if (text.length > MULTI_PHASE_INPUT_THRESHOLD) {
    console.error(`[ingest] Input text ${text.length} chars — skipping single-pass, going straight to multi-phase.`);
    singlePassFailed = true;
  }

  if (!singlePassFailed) try {
    progress(15, 'AI is analyzing the document…');
    const raw = (await generateText(
      schema,
      buildPrompt(today, index, existingFiles, originalName, text, false, isOverwrite, summaryPath),
      65536,
      'json',
      (msg) => progress(15, msg, 'wait')
    )).trim();

    try {
      result = parseJSON(raw);
    } catch (firstErr) {
      console.warn(`[ingest] First parse failed — response ${raw.length} chars. ${firstErr.message.slice(0, 120)}`);

      // If the response is already large, a strict-brevity retry will produce a
      // similarly large (and similarly broken) response — skip it and go straight
      // to multi-phase, which handles content in small, reliable batches.
      if (raw.length > SINGLE_PASS_RESPONSE_LIMIT) {
        console.warn(`[ingest] Response ${raw.length} chars > ${SINGLE_PASS_RESPONSE_LIMIT} limit — skipping retry, switching to multi-phase.`);
        singlePassFailed = true;
      } else {
        // Short response that failed to parse — retry with maximum brevity
        console.warn(`[ingest] Retrying with strict brevity…`);
        progress(15, 'Retrying with brevity constraints…');

        const raw2 = (await generateText(
          schema,
          buildPrompt(today, index, existingFiles, originalName, text, true, isOverwrite, summaryPath),
          65536,
          'json',
          (msg) => progress(15, msg, 'wait')
        )).trim();

        try {
          result = parseJSON(raw2);
        } catch (secondErr) {
          console.warn(`[ingest] Both single-pass attempts failed. Switching to multi-phase...`);
          singlePassFailed = true;
        }
      }
    }
  } catch (err) {
    // Re-throw non-parse errors (rate limits, network, etc.)
    throw err;
  }

  // ── Multi-phase fallback ───────────────────────────────────────────────────
  if (singlePassFailed) {
    usedMultiPhase = true;
    if (!result) {
      progress(10, 'Large document — switching to multi-phase ingest…');
    }
    result = await ingestMultiPhase(schema, today, index, existingFiles, originalName, text, isOverwrite, progress, summaryPath, warnings, originatorHints);
  } else {
    // v3.0.1-beta.1: single-pass also runs through the outline validator so a
    // missing/non-canonical summary page is patched the same way as multi-phase.
    // Originator hints are passed in so an omitted author entity is injected
    // before write.
    // The single-pass response shape is {title, pages:[{path, content, summary?}]}.
    const validated = validateOutline(result, summaryPath, originalName, originatorHints);
    result = validated.outline;
    for (const w of validated.warnings) {
      console.warn(`[ingest] Outline validator: ${w}`);
      warnings.push(w);
    }
  }

  // Deduplicate result.pages — multi-phase ingest can return the same path in
  // multiple batches (the LLM sometimes adds extra pages it wasn't asked for).
  // Keep the LAST occurrence so the most-complete LLM version wins; writePage's
  // mergeWikiPage will still union it with any existing on-disk content.
  {
    const seen = new Map();
    for (const page of result.pages) seen.set(page.path, page);
    result.pages = [...seen.values()];
  }

  // v3.0.1-beta.1: if the validator injected pages in single-pass mode that
  // never got content (the LLM emits {path, content}; the validator emits
  // {path, summary} as plan-only entries), fill them with a stub so the file
  // isn't empty. Multi-phase doesn't hit this path because Phase 2 generates
  // content for every validator-injected page before this point.
  for (const page of result.pages) {
    if (page && (!page.content || !page.content.trim())) {
      if (page.path === summaryPath) {
        console.warn('[ingest] Summary page had no content — generating stub.');
        warnings.push(`Summary page "${summaryPath}" had no content from the AI — wrote a stub. Re-ingest to fix.`);
        page.content = `# ${summarySlug}\n\n> ⚠ **Stub summary — AI did not produce content for this page.**\n> Re-ingest "${originalName}" to fix.\n\nSource: ${originalName}\nDate Ingested: ${today}\nTags: stub, type/summary\n`;
      } else if (page.path.startsWith('entities/') || page.path.startsWith('concepts/')) {
        console.warn(`[ingest] Validator-injected page had no content — generating stub: ${page.path}`);
        warnings.push(`Page "${page.path}" was injected by the originator-hint validator but had no AI content — wrote a stub. Re-ingest to populate.`);
        page.content = stubPageContent(page.path, page.summary, originalName);
      }
    }
  }

  // Write all wiki pages — collect canonical paths (writePage may redirect
  // dr-tali-rezun.md → tali-rezun.md, concepts/google.md → entities/google.md, etc.)
  // Each writePage now returns a change record {canonPath, status, bytesBefore,
  // bytesAfter, sectionsChanged, bulletsAdded} — collected for the result panel.
  // v3.0.1-beta.1: writeRecords[i] is aligned 1:1 with result.pages[i] (or null
  // when writePage refused the input) so mergeIntoIndex can look up the LLM's
  // per-page `summary` text by post-write canonical path.
  progress(90, `Writing ${result.pages.length} wiki pages to disk…`);
  const canonicalPaths = [];
  const changes = [];
  const writeRecords = [];
  for (const page of result.pages) {
    const record = await writePage(domain, page.path, page.content);
    writeRecords.push(record ? { originalPath: page.path, record } : null);
    if (record) {
      canonicalPaths.push(record.canonPath);
      changes.push(record);
    }
  }

  // Post-write: reconcile the summary's "Entities Mentioned" with every entity
  // page actually written this ingest. Uses canonical paths so redirected slugs
  // (dr-tali-rezun → tali-rezun) appear correctly in the summary and backlinks.
  progress(93, 'Syncing entity backlinks…');
  const summaryCanonPath = canonicalPaths.find(p => p.startsWith('summaries/'));
  if (summaryCanonPath) {
    await syncSummaryEntities(domain, summaryCanonPath, canonicalPaths);
  }

  // v3.0.1-beta.1: programmatic index merge replaces the old LLM-driven
  // Phase-3 index regeneration. Skips rows whose slugs are already in the
  // index → no duplicates on re-ingest.
  progress(96, 'Updating index…');
  // mergeIntoIndex looks up per-page summary text via writeRecords[i] →
  // pages[i].summary. Multi-phase's batched responses sometimes omit `summary`
  // even though we ask for it; fall back to the outline's planned summary.
  if (Array.isArray(result.outlinePages)) {
    const plannedByPath = new Map(result.outlinePages.map(p => [p.path, p.summary]));
    for (const page of result.pages) {
      if (page && !page.summary && plannedByPath.has(page.path)) {
        page.summary = plannedByPath.get(page.path);
      }
    }
  }
  const mergedIndex = mergeIntoIndex(index, result.pages, writeRecords);
  if (mergedIndex) {
    const indexRecord = await writePage(domain, 'index.md', mergedIndex);
    if (indexRecord) changes.push(indexRecord);
  }

  // Append to log — use canonical paths for accurate reporting
  const pageList = canonicalPaths.map(p => `  - ${p}`).join('\n');
  const warningSection = warnings.length
    ? `\nWarnings:\n${warnings.map(w => `  - ${w}`).join('\n')}`
    : '';
  const logEntry = `## [${today}] ingest | ${result.title}\nPages created or updated:\n${pageList}${warningSection}\n`;
  await appendLog(domain, logEntry);

  progress(100, 'Done!');
  return {
    title: result.title,
    pagesWritten: canonicalPaths,
    changes,    // structured per-file change records (v2.5.0+)
    warnings,   // user-visible non-fatal issues (v3.0.1-beta.1)
    truncated,  // boolean — was the source longer than TEXT_CAP?
  };
}

// Internal helpers exposed for battle-testing (v3.0.1-beta.1).
// Not part of the public API — callers should use ingestFile() instead.
export const __testing = {
  buildOutlinePrompt,
  buildPrompt,
  buildBatchPrompt,
  stubPageContent,
  TEXT_CAP: 80_000,
};
