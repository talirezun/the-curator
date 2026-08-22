import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
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
  mergeWikiPage,
} from './files.js';
import { mergeIntoIndex } from './compile.js';
// Reused, not reimplemented: the same tokeniser the Shared Brain delta/synthesis
// code uses (lowercase, punctuation-stripped, stop-worded). Keeping one
// tokeniser means "relevant to this source" means the same thing everywhere.
// ⚠ CIRCULAR IMPORT (sharedbrain-delta.js → ... → ingest.js). It
// resolves today only because `tokenize` is a HOISTED `function` declaration —
// converting it (or anything else in that cycle) to a `const` arrow would make
// it undefined at module-evaluation time on some load orders.
import { tokenize } from './sharedbrain-delta.js';
import { writeFileAtomic } from './atomic-write.js';

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

// ── Slug-inventory safety valve (v3.0.16) ───────────────────────────────────
//
// Every ingest prompt embeds the domain's existing entity/concept filenames so
// the model reuses `lumina-ai.md` instead of inventing `lumina.md`, and so it
// can ground [[wikilinks]] in slugs that actually exist. On a mature domain that
// inventory is large: on the real `articles` domain, 600 entity files render to
// ~16,100 chars and 2,651 concept files to ~112,200.
//
// ⚠ THIS IS A SAFETY VALVE, NOT A COST OPTIMISATION. READ BEFORE TUNING. ⚠
//
// It shipped as a cost measure with a 24,000-char budget and a controlled A/B on
// the real articles domain measured a REGRESSION, so the intent was changed:
//
//   Anthropic (claude-haiku-4-5), broken-wikilink rate, n=2 per arm:
//     full inventory ................ 4.3%   (2.4%, 6.1%)
//     capped at 24,000 chars ........ 9.2%   (5.4%, 13.0%)   ← 2.2x WORSE
//     uncapped, index removed ....... 4.0%   (back to baseline)
//
// Haiku leans on the full slug list to ground its links. Starving it to 562 of
// 2,651 concepts did not make it link more carefully — it made it invent slugs.
// Gemini's link quality was unharmed in every arm, so this is provider-specific,
// and the provider it harms is one we ship as a default.
//
// The cost win this release actually ships comes from dropping index.md from the
// prompt (~-39%) plus Anthropic prompt caching — the inventory was never where
// most of the money was. So: DO NOT lower this constant to save tokens. If you
// are here to reduce prompt size, remove something the model does not use;
// the slug list is load-bearing for link grounding on at least one provider.
//
// What the valve still protects against: a pathological domain (tens of
// thousands of pages in one folder) whose inventory alone would overflow the
// provider context window and hard-fail every ingest. Truncating with a visible
// warning strictly beats a failed ingest. Ranking is by token overlap with the
// source so the zero-overlap tail — pages the model was never going to name,
// because none of their words appear in the document — is what gets dropped.
//
// Residual risk when it DOES fire is the same one the A/B measured, which is
// exactly why the budget is set where nothing real reaches it. The post-answer
// safety net still applies either way: writePage's Pass A/B/C dedup, cross-folder
// dedup, and redirectSemanticDuplicates at Jaccard >= 0.85 — which deliberately
// keeps scanning the FULL on-disk list, never the capped one.

/**
 * Character budget for ONE rendered slug list (entities, concepts).
 *
 * ⚠ The arithmetic below was FIRST derived assuming index.md had been removed
 * from the outline / single-pass prompts. That removal was deferred (see the
 * note on buildOutlinePrompt), so the index — an unbounded term with no valve of
 * its own — is back in the prompt and the margin is tighter than originally
 * written. Corrected here rather than left stale.
 *
 * Tightest window we ship against is claude-haiku-4-5 at 200,000 tokens. The
 * largest output reservation on that path is the 64,000-token clamp used by
 * single-pass, which pairs with a sub-15,000-char source (~5,000 tok) and
 * ~1,000 tok of instructions.
 *
 * CHARS/TOKEN ASSUMED: 2.5 for slug lists, 3 for the index. Slug lists are the
 * pessimistic case — a hyphenated slug fragments into several tokens, so they
 * run well below the ~4 chars/token of English prose. An earlier version of this
 * comment assumed 3 for slugs and reported the symmetric case as "11% under the
 * window"; at the defensible 2.5 it is clearly OVER. Recomputed honestly:
 *
 *   REALISTIC pathological case — one dominant list at the cap (today's real
 *   ratio is 4.4:1 concepts:entities), index at today's ~121,000 chars:
 *     64,000 (inventory) + 40,300 (index) + 5,000 + 1,000 + 64,000 = 174,300  ✓
 *
 *   SYMMETRIC worst case — BOTH lists at the cap (~3,780 entities AND ~3,780
 *   concepts, a shape no real domain has):
 *     128,000 + 40,300 + 5,000 + 1,000 + 64,000 = 238,300  ✗ over the window
 *
 * So this valve BOUNDS THE LARGEST CONTROLLABLE TERM; it does not on its own
 * guarantee the request fits. It cannot: index.md grows with the domain too and
 * has no cap. If a domain ever gets large enough to overflow in practice, the
 * index is the next term to bound, not this one — lowering this budget re-enters
 * the measured-regression zone described above for a term that is no longer the
 * biggest one.
 *
 * It does NOT fire on anything real today: the largest list we have anywhere is
 * the articles domain's 2,651 concepts at ~112,200 chars — 70% of the budget,
 * with entities at 10%. It starts truncating at roughly 3,780 pages in a single
 * folder (today's ~42.3 chars/entry average), i.e. ~1.4x the largest real list.
 */
export const SLUG_INVENTORY_BUDGET_CHARS = 160_000;

/**
 * Rendered cost, in characters, of one filename in a prompt's slug inventory.
 *
 * Measured against the outline / single-pass rendering, `"  entities/x.md\n"`:
 * 2 (indent) + 9 (`entities/` or `concepts/`, both 9 chars) + name + 1 (\n).
 * The batch prompt renders the same inventory more densely (comma-separated,
 * `.md` stripped), so budgeting with the LINE cost is conservative there —
 * deliberately, because it means BOTH prompts are built from the SAME kept set:
 * a slug the outline saw stays visible to the batch that writes the page, and
 * the batch prompt's cacheable prefix stays byte-stable across batches.
 */
function slugLineCost(filename) { return filename.length + 12; }

/**
 * Cap one slug list to a character budget, keeping the entries most relevant to
 * the source document.
 *
 * SAFETY VALVE — see the block comment on SLUG_INVENTORY_BUDGET_CHARS before
 * changing anything here or calling this with a smaller budget. At the default
 * budget this is a NO-OP on every real domain we have; it exists so a
 * pathological wiki degrades with a warning instead of hard-failing on a context
 * overflow. Capping measurably HURT Anthropic link quality (2.2x the
 * broken-wikilink rate at a 24,000-char budget), so firing it is a last resort,
 * not an optimisation.
 *
 * DETERMINISTIC by construction (no clock, no randomness, total ordering with
 * the original index as the final tie-break), so it is unit-testable and two
 * ingests of the same source produce the same prompt.
 *
 * When everything fits — which is the expected case — the input array is
 * returned UNCHANGED and in its original order, so the rendered prompt is
 * byte-identical to what it would be with no cap at all.
 *
 * @param {string[]} files        filenames, e.g. ['tali-rezun.md', ...]
 * @param {Set<string>} sourceTokens  tokenize()d source document, built once
 * @returns {{files: string[], kept: number, omitted: number, total: number}}
 */
export function capSlugInventory(files, sourceTokens, budgetChars = SLUG_INVENTORY_BUDGET_CHARS) {
  const list = Array.isArray(files) ? files.filter(f => typeof f === 'string' && f) : [];
  let total = 0;
  for (const f of list) total += slugLineCost(f);
  if (total <= budgetChars) return { files: list, kept: list.length, omitted: 0, total };

  const tokens = sourceTokens instanceof Set ? sourceTokens : new Set();
  const scored = list.map((f, i) => {
    // Slugs are hyphen-joined, and tokenize() splits on whitespace only — so
    // "tali-rezun.md" must become "tali rezun" first, or it scores as one
    // unmatched token.
    const slugTokens = tokenize(f.replace(/\.md$/i, '').replace(/[-_]+/g, ' '));
    let matched = 0;
    for (const t of slugTokens) if (tokens.has(t)) matched++;
    return {
      f, i, matched,
      // Coverage, not raw overlap: a 2-word slug fully present in the source is
      // a stronger signal than one word of a 5-word slug matching by accident.
      coverage: slugTokens.length ? matched / slugTokens.length : 0,
    };
  });
  scored.sort((a, b) =>
    (b.coverage - a.coverage) ||
    (b.matched - a.matched) ||
    (slugLineCost(a.f) - slugLineCost(b.f)) ||
    (a.i - b.i));

  const keptIdx = [];
  let used = 0;
  for (const s of scored) {
    const cost = slugLineCost(s.f);
    // `continue`, not `break`: once a long entry no longer fits, shorter
    // lower-ranked ones still can. Still fully deterministic.
    if (used + cost > budgetChars) continue;
    used += cost;
    keptIdx.push(s.i);
  }
  keptIdx.sort((a, b) => a - b);   // restore on-disk order for a stable render
  const kept = keptIdx.map(i => list[i]);
  return { files: kept, kept: kept.length, omitted: list.length - kept.length, total };
}

/**
 * Apply the slug-inventory safety valve to BOTH lists for prompt embedding.
 *
 * Expected outcome on every real domain today: no truncation, no warnings, and
 * the same arrays back. It only does anything on a domain large enough that the
 * inventory alone would threaten the provider context window — see the block
 * comment on SLUG_INVENTORY_BUDGET_CHARS for why the budget sits where it does
 * and why lowering it is a measured regression, not a saving.
 *
 * If it ever does fire, that must not be silent: every omission is reported
 * through the same `warnings[]` array the ingest result already carries and the
 * UI already renders, because a dropped slug is a slug the model may then
 * re-invent as a duplicate page.
 *
 * The returned object is for PROMPTS ONLY. The full, uncapped list must keep
 * flowing to redirectSemanticDuplicates — capping the dedup guard's input would
 * weaken the very safety net that covers a truncation.
 */
export function capExistingFilesForPrompt(existingFiles, sourceText, budgetChars = SLUG_INVENTORY_BUDGET_CHARS) {
  const sourceTokens = new Set(tokenize(typeof sourceText === 'string' ? sourceText : ''));
  const warnings = [];
  const files = { entities: [], concepts: [] };
  for (const kind of ['entities', 'concepts']) {
    const r = capSlugInventory(existingFiles?.[kind], sourceTokens, budgetChars);
    files[kind] = r.files;
    if (r.omitted > 0) {
      const noun = kind === 'entities' ? 'entity' : 'concept';
      warnings.push(
        `This domain has grown large enough that the AI request had to be trimmed: ${r.omitted} of ` +
        `${r.kept + r.omitted} ${noun} pages were left out, keeping the ${r.kept} most relevant to this ` +
        `source. Without trimming, the request would exceed what the AI can read at once. Watch for ` +
        `near-duplicate pages after this ingest and merge them from the Health tab.`
      );
    }
  }
  return { files, warnings };
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

/**
 * Phase 1 outline prompt.
 *
 * NOTE ON index.md (v3.0.16): dropping the full index from this prompt was
 * implemented, measured, and then DEFERRED. It saved ~16% of the canonical
 * request on its own, but it is the only part of the prompt-slimming work that
 * changes WHAT THE MODEL SEES rather than merely the order it sees it in, and a
 * paired live A/B (n=3 per arm on Gemini) could not resolve its effect on
 * broken-wikilink rate or page count in either direction — the arms overlapped.
 * The caching + reorder work is worth roughly twice as much (~30%) and changes
 * only ordering, so that shipped and this did not. If you pick this back up,
 * the blocker is measurement power, not implementation: you need enough paired
 * runs to separate an effect from the run-to-run variance.
 */
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

/**
 * Phase 2 batch prompt, split into a STABLE PREFIX and a VOLATILE SUFFIX.
 *
 * Within one ingest, every Phase 2 call shares `today`, `originalName`, the
 * source text, the existing-files inventory and the outline page list. The ONLY
 * thing that differs between batch 1..N is `pageBatch`. Pre-v3.0.16 the batch
 * page list sat near the TOP (immediately after the source), so the shared
 * prefix ended after the source and everything downstream re-processed on every
 * call. Moving the page list to the END makes the entire instruction +
 * inventory + source block one reusable prefix:
 *
 *   • Anthropic — the caller can place a `cache_control` breakpoint at
 *     prefix.length (see generateText's opts.cachePrefixChars). Cache reads are
 *     ~0.1x base input; writes are 1.25x, so break-even is 2 calls — which is
 *     why the caller only enables it when the ingest will actually make >= 2
 *     calls against the same prefix.
 *   • Gemini — 2.5-family models do implicit prefix caching automatically, with
 *     no API change; a longer stable prefix is simply worth more.
 *
 * The reorder is deliberately MINIMAL: the source document stays where it has
 * always been (early), and only the page list moves. That yields the identical
 * cacheable prefix while keeping the shipped prompt's behaviour as close to
 * unchanged as possible, and it lands on the canonical long-context shape —
 * document, then instructions, then the specific ask, then the output format.
 *
 * @returns {{prefix: string, suffix: string}}  prefix + suffix === the prompt
 */
function buildBatchPromptParts(today, originalName, text, pageBatch, existingFiles = { entities: [], concepts: [] }, allOutlinePages = []) {
  const pageList = pageBatch
    .map(p => `  { "path": "${p.path}", "summary": "${p.summary}" }`)
    .join(',\n');

  // v3.0.1-beta.11: build the "pages being created in THIS ingest" block
  // so a batch writing a hub page can wikilink to items being created in
  // other batches. Pre-beta.11 the LLM only saw the current batch's slugs
  // plus the pre-ingest existing-files snapshot — it had no way to know
  // what slugs sibling batches would produce, so hub pages defaulted to
  // plain-text item names instead of [[wikilinks]] (Root Cause 1 + 4
  // from the community bug report).
  //
  // Format split by folder so the LLM uses the right link syntax:
  //   entities/concepts → [[slug]]
  //   summaries → [[summaries/slug]]
  const inThisIngest = { entities: [], concepts: [], summaries: [] };
  for (const p of allOutlinePages) {
    if (!p || typeof p.path !== 'string') continue;
    const slug = p.path.replace(/\.md$/, '');
    if (slug.startsWith('entities/'))  inThisIngest.entities.push(slug.slice('entities/'.length));
    else if (slug.startsWith('concepts/'))  inThisIngest.concepts.push(slug.slice('concepts/'.length));
    else if (slug.startsWith('summaries/')) inThisIngest.summaries.push(slug);
  }

  // ── STABLE across every batch of this ingest ──────────────────────────────
  const prefix = `Today's date: ${today}

--- SOURCE DOCUMENT: ${originalName} ---
${text}
--- END SOURCE DOCUMENT ---

Guidelines:
- Each page: 3–8 concise bullet points or sentences. No long prose.
- Do NOT include YAML frontmatter (--- blocks) — it is added automatically after generation.
- Entity pages: include a line "Type: <type>" and a line "Tags: tag1, tag2" in the body.
- Concept and summary pages: include a line "Tags: tag1, tag2" in the body.
- Links: always use [[page-name]] — NEVER include folder prefix (write [[rag]] not [[concepts/rag]]).
- LINK ACCURACY: Use the EXACT slug from existing filenames when linking. If the entity file is iea.md, write [[iea]], NOT [[international-energy-agency]]. If the summary is the-energy-and-water-footprint-of-generative-ai.md, link as [[summaries/the-energy-and-water-footprint-of-generative-ai]], not a shortened form.
- HUB-PAGE RULE: if your page enumerates many sibling concepts (e.g. a "library", "taxonomy", or "comparison" page), you MUST wikilink to each item using the exact slugs listed below. Plain-text item names without brackets leave the hub disconnected from the items in the graph.

EXISTING WIKI FILES — when writing content for these pages, use [[page-name]] links that match existing filenames exactly.
Existing entities: ${existingFiles.entities.map(f => f.replace('.md', '')).join(', ')}
Existing concepts: ${existingFiles.concepts.map(f => f.replace('.md', '')).join(', ')}

PAGES BEING CREATED IN THIS SAME INGEST — even if a slug below is not in the batch you're writing right now, OTHER batches will write it, so you MUST link to it by the exact slug listed (no guesses).
Entities being created:  ${inThisIngest.entities.join(', ') || '(none)'}
Concepts being created:  ${inThisIngest.concepts.join(', ') || '(none)'}
Summaries being created: ${inThisIngest.summaries.join(', ') || '(none)'}

CRITICAL — Valid folder prefixes for page paths:
  • summaries/  — one summary page per source document
  • entities/   — every person, tool, company, framework, dataset, project, country, organization
  • concepts/   — every idea, technique, principle, methodology
NEVER use any other folder (e.g. "people/", "tools/", "frameworks/" are INVALID).
Every path MUST start with one of the three prefixes above.

CROSS-FOLDER RULE: If a file already exists in entities/, do NOT create a concepts/ file with the same or similar name, and vice versa. Companies (Google, Microsoft), organizations (IEA), and countries (Chile, Japan) are ALWAYS entities, never concepts.

Each "page.summary" is a 1-line description that will be added to the wiki
index. Keep each under 160 characters. Where a page listed BELOW already comes
with a summary, you may reuse that summary text verbatim.`;

  // ── VARIES per batch — must stay AFTER the cache breakpoint ───────────────
  const suffix = `

Write the full markdown content for EXACTLY these wiki pages (no others):
[
${pageList}
]

Return ONLY valid JSON in this exact shape (no markdown fences, no commentary):
{
  "pages": [
    { "path": "summaries/example-source.md", "content": "...", "summary": "1-line description for the index" },
    { "path": "concepts/some-concept.md",    "content": "...", "summary": "1-line description" }
  ]
}`;

  return { prefix, suffix };
}

/** The assembled Phase 2 batch prompt. Kept for callers/tests that want the string. */
function buildBatchPrompt(today, originalName, text, pageBatch, existingFiles = { entities: [], concepts: [] }, allOutlinePages = []) {
  const { prefix, suffix } = buildBatchPromptParts(today, originalName, text, pageBatch, existingFiles, allOutlinePages);
  return prefix + suffix;
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

  // v3.0.1-beta.8: drop entries that aren't well-formed page records BEFORE
  // any structural check fires. Defends against the LLM occasionally returning
  // a malformed entry (null, missing path, non-string path) inside an otherwise
  // valid outline — without this guard the structural checks below could
  // throw on a `.startsWith` against undefined.
  for (let i = pages.length - 1; i >= 0; i--) {
    const p = pages[i];
    if (!p || typeof p.path !== 'string' || !p.path) {
      warnings.push('Outline contained a malformed page entry without a path — dropped.');
      pages.splice(i, 1);
    }
  }

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

  // v3.0.1-beta.8: TRUNK-PAGE DETECTOR — the granularity-inversion fix.
  //
  // The LLM (especially Anthropic Haiku, which lacks JSON-mode rails) tends
  // to create many specific sub-concept pages (`taste-as-moat.md`,
  // `taste-as-judgment.md`, `taste-development-formula.md`) while skipping
  // the obvious parent — just `taste.md`. The downstream consequence: pages
  // link to `[[taste]]` and the link is broken because no trunk page exists.
  //
  // Detection: scan the outline for clusters of ≥3 concept pages sharing a
  // common first segment (`<prefix>-...`). If the trunk page for that prefix
  // is missing AND wasn't already injected, add it. Phase 2 (or single-pass)
  // will generate content for it using the same source text.
  //
  // Why concept-only: the consolidation rule applies to concept-clusters
  // (umbrella idea + sub-ideas). Entity clusters (e.g. `openai-gpt-4`,
  // `openai-gpt-5`) are sometimes legitimate sub-pages but more often
  // mis-classifications writePage's cross-folder dedup will catch later.
  // Restricting to concepts/ keeps the detector conservative.
  {
    const CLUSTER_THRESHOLD = 3;
    const conceptByPrefix = new Map();
    for (const p of pages) {
      if (typeof p.path !== 'string' || !p.path.startsWith('concepts/')) continue;
      const slug = p.path.replace(/^concepts\//, '').replace(/\.md$/, '');
      const m = slug.match(/^([a-z0-9]+(?:[a-z0-9])*)-/);  // first segment before a hyphen
      if (!m) continue;
      const prefix = m[1];
      if (prefix.length < 2) continue;  // skip single-char prefixes ("a-foo", "i-foo")
      if (!conceptByPrefix.has(prefix)) conceptByPrefix.set(prefix, []);
      conceptByPrefix.get(prefix).push(p);
    }

    // Build the set of concept slugs already in the outline (for fast lookup)
    const conceptSlugsInOutline = new Set();
    for (const p of pages) {
      if (typeof p.path === 'string' && p.path.startsWith('concepts/')) {
        conceptSlugsInOutline.add(p.path.replace(/^concepts\//, '').replace(/\.md$/, ''));
      }
    }

    for (const [prefix, cluster] of conceptByPrefix) {
      if (cluster.length < CLUSTER_THRESHOLD) continue;
      // Trunk page is just `concepts/<prefix>.md` — does it already exist
      // in the outline? If yes, the LLM did the right thing; skip.
      if (conceptSlugsInOutline.has(prefix)) continue;

      const trunkPath = `concepts/${prefix}.md`;
      const subPaths = cluster.map(p => p.path).slice(0, 5);
      const subList = subPaths.length === cluster.length
        ? subPaths.join(', ')
        : subPaths.join(', ') + `, … (+${cluster.length - subPaths.length} more)`;

      warnings.push(
        `Outline had ${cluster.length} "${prefix}-*" pages without a parent "${trunkPath}" — ` +
        `injected the trunk page (granularity-inversion fix). Sub-pages: ${subList}.`
      );

      // Insert the trunk page AFTER the summary so Phase 2 writes it before
      // any of its children — that way the children can link back to it.
      const trunkEntry = {
        path: trunkPath,
        summary: `Umbrella concept that the ${prefix}-* pages elaborate on.`,
      };
      const summaryIdx = pages.findIndex(p =>
        p && typeof p.path === 'string' && p.path.startsWith('summaries/')
      );
      const insertAt = summaryIdx >= 0 ? summaryIdx + 1 : 0;
      pages.splice(insertAt, 0, trunkEntry);
      conceptSlugsInOutline.add(prefix);
    }
  }

  // v3.0.1-beta.8: STRUCTURAL CHECKS — cheap, deterministic, mostly advisory.
  //
  // These don't reject the outline (the user is mid-ingest; we never throw
  // here), but they do surface warnings the user can see in the result panel.
  // The goal is to catch outlines that are obviously off-spec before they hit
  // disk so the user knows whether to re-ingest.
  {
    // Duplicate paths in the outline — multi-phase batches each generate
    // independent content, so two identical paths in the outline would write
    // the same file twice (the second overwriting/merging into the first).
    // writePage's merge handles this safely but it's wasted work.
    const seenPaths = new Map();
    for (const p of pages) {
      if (typeof p?.path !== 'string') continue;
      seenPaths.set(p.path, (seenPaths.get(p.path) || 0) + 1);
    }
    const dups = [...seenPaths.entries()].filter(([, n]) => n > 1);
    if (dups.length > 0) {
      warnings.push(
        `Outline had duplicate paths: ${dups.map(([p, n]) => `${p} (×${n})`).join(', ')} — ` +
        `each will be written once via mergeWikiPage.`
      );
    }

    // Coverage: entity + concept folder presence. If the outline has only a
    // summary and no entities, that's a strong signal something went wrong
    // (no author entity, no extracted concepts).
    const hasEntity = pages.some(p => typeof p?.path === 'string' && p.path.startsWith('entities/'));
    const hasConcept = pages.some(p => typeof p?.path === 'string' && p.path.startsWith('concepts/'));
    if (!hasEntity) {
      warnings.push('Outline contained no entities/ pages. Check the source — every document should have at least one originator entity (author/speaker/company).');
    }
    if (!hasConcept) {
      warnings.push('Outline contained no concepts/ pages. Check the source — most substantive sources develop at least one concept worth its own page.');
    }

    // Minimum page count — a real ingest should produce at least the summary
    // plus a handful of entities/concepts. Outlines under 3 pages are a
    // strong signal that the LLM gave up early or hit a budget.
    if (pages.length < 3) {
      warnings.push(`Outline planned only ${pages.length} pages — very short. The source may have been short, or the AI may have given up early. Inspect the result.`);
    }
  }

  return { outline: { ...outline, pages }, warnings };
}

// ── Semantic-near-duplicate guard (v3.0.1-beta.11) ───────────────────────────
//
// Catches the slug-drift pattern that the structural Pass A/B/C in writePage
// cannot:
//   expert-roundup-format  vs  experts-roundup-format    (singular/plural)
//   tools-directory        vs  tools-directory-format    (suffix variant)
//   pattern-library        vs  pattern-library-format    (suffix variant)
//
// Surfaced by a community-member field report on the Curation domain after
// multiple related articles were ingested — each used slightly different
// surface phrasing for the same concept, so each ingest minted a new slug.
// The hyphen-normalised Pass B can't see these as equivalent because the
// underlying letters genuinely differ. The v2.4.5 Health-side semantic-dupe
// scan exists but is post-hoc cleanup — by the time it runs the wiki is
// already populated with the drift.
//
// Approach: tokenize each candidate slug + each existing slug into a token
// set, lightly normalize singular→singular (trim trailing 's' if the
// remainder is ≥3 chars), then compute Jaccard similarity:
//   ≥ 0.85 → auto-redirect (the new slug becomes the existing one)
//   0.5 – 0.85 → warn so the user knows there's a candidate cluster
//   < 0.5 → independent concepts, no action
//
// Auto-redirect is intentionally aggressive at 0.85 — a Jaccard of 0.85 on
// short slugs (3-5 tokens) means at most one token differs, and that
// difference is almost always a synonym, plural, or suffix variant. The
// 0.5–0.85 band is the false-positive risk zone, so we warn but don't act.
//
// Currently scoped to CONCEPT pages only. Entities are usually proper nouns
// (people, companies, countries) where slight slug differences may genuinely
// be different entities (e.g. "open-ai" vs "open-source-ai"). Concepts are
// the surface where slug drift compounds quickly across ingests.

const SEMANTIC_DUPE_AUTO_REDIRECT = 0.85;
const SEMANTIC_DUPE_WARN_THRESHOLD = 0.5;

function singularStem(token) {
  // Lightweight singular/plural stem: drop trailing 's' if the remainder is
  // at least 3 chars long. Catches "collections" → "collection",
  // "roundups" → "roundup" without harming words that legitimately end in s
  // ("is", "as", "css"). Doesn't try to be a real stemmer.
  if (typeof token !== 'string' || token.length < 4) return token;
  if (!token.endsWith('s')) return token;
  return token.slice(0, -1);
}

function slugToStemmedTokens(slug) {
  // Split on hyphens (slug convention) then stem each token. Drop empties
  // and common slug-noise tokens.
  if (typeof slug !== 'string') return new Set();
  return new Set(
    slug.split('-')
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length > 1)
      .map(singularStem)
  );
}

function jaccardOnSets(a, b) {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  return intersect / (a.size + b.size - intersect);
}

/**
 * Detect and redirect semantic near-duplicate CONCEPT slugs in the outline.
 *
 * Mutates `outline.pages` in place when a redirect fires. Returns
 * `{ warnings, redirects }` so the caller can surface them like the rest of
 * validateOutline's signal.
 *
 * Exported for unit testing.
 */
export function redirectSemanticDuplicates(outline, existingFiles) {
  const warnings = [];
  const redirects = [];
  if (!outline || !Array.isArray(outline.pages)) return { warnings, redirects };

  // Build the inventory of existing concept slugs (on-disk before this
  // ingest). Use the same stemming so comparisons are symmetric.
  const existingSlugs = (existingFiles?.concepts || [])
    .map(f => f.replace(/\.md$/, ''))
    .filter(Boolean);
  const existingTokenSets = existingSlugs.map(s => ({ slug: s, tokens: slugToStemmedTokens(s) }));

  // Track redirects so we can also rewrite within-outline duplicates.
  const newPaths = [];
  const seenSlugsInOutline = [];

  for (const p of outline.pages) {
    if (!p || typeof p.path !== 'string') continue;
    if (!p.path.startsWith('concepts/')) {
      newPaths.push(p);
      continue;
    }
    const slug = p.path.replace(/^concepts\//, '').replace(/\.md$/, '');
    const tokens = slugToStemmedTokens(slug);

    // Compare against EXISTING on-disk slugs first.
    let bestExisting = null;
    let bestExistingScore = 0;
    for (const { slug: exSlug, tokens: exTokens } of existingTokenSets) {
      if (exSlug === slug) {
        bestExisting = exSlug;
        bestExistingScore = 1.0;
        break;
      }
      const score = jaccardOnSets(tokens, exTokens);
      if (score > bestExistingScore) {
        bestExisting = exSlug;
        bestExistingScore = score;
      }
    }

    if (bestExistingScore >= SEMANTIC_DUPE_AUTO_REDIRECT && bestExisting && bestExisting !== slug) {
      // Auto-redirect onto the existing slug.
      const newPath = `concepts/${bestExisting}.md`;
      warnings.push(
        `Outline proposed "concepts/${slug}.md" — semantic near-duplicate ` +
        `(Jaccard ${bestExistingScore.toFixed(2)}) of existing "concepts/${bestExisting}.md". ` +
        `Redirected; bullets will merge into the existing page.`
      );
      redirects.push({ from: slug, to: bestExisting, score: bestExistingScore, scope: 'existing' });
      p.path = newPath;
      newPaths.push(p);
      seenSlugsInOutline.push({ slug: bestExisting, tokens: slugToStemmedTokens(bestExisting), entry: p });
      continue;
    }
    if (bestExistingScore >= SEMANTIC_DUPE_WARN_THRESHOLD && bestExisting && bestExisting !== slug) {
      warnings.push(
        `Outline proposed "concepts/${slug}.md" — possible semantic near-duplicate ` +
        `(Jaccard ${bestExistingScore.toFixed(2)}) of existing "concepts/${bestExisting}.md". ` +
        `Keeping both; review via Wiki Health → Scan for semantic duplicates if they're truly the same concept.`
      );
    }

    // Compare against OTHER slugs already kept in THIS outline pass — catches
    // the case where one ingest plans both `expert-roundup-format` and
    // `experts-roundup-format` for the same source.
    let bestWithin = null;
    let bestWithinScore = 0;
    for (const seen of seenSlugsInOutline) {
      if (seen.slug === slug) continue;
      const score = jaccardOnSets(tokens, seen.tokens);
      if (score > bestWithinScore) {
        bestWithin = seen;
        bestWithinScore = score;
      }
    }
    if (bestWithinScore >= SEMANTIC_DUPE_AUTO_REDIRECT && bestWithin) {
      warnings.push(
        `Outline planned two near-duplicate concept slugs: "${slug}" and ` +
        `"${bestWithin.slug}" (Jaccard ${bestWithinScore.toFixed(2)}). ` +
        `Dropping "${slug}" — its content will merge into "${bestWithin.slug}".`
      );
      redirects.push({ from: slug, to: bestWithin.slug, score: bestWithinScore, scope: 'within' });
      // Don't push this entry; we treat it as a duplicate of the earlier one.
      continue;
    }

    newPaths.push(p);
    seenSlugsInOutline.push({ slug, tokens, entry: p });
  }

  outline.pages = newPaths;
  return { warnings, redirects };
}

/**
 * The `.md`-normalised form of a page path.
 *
 * The model returns a planned page WITHOUT its extension often enough that any
 * identity comparison on the raw string is wrong: writePage appends the
 * extension (v3.0.16), so "concepts/x" and "concepts/x.md" are the SAME FILE.
 * Comparing raw strings mis-reports a planned page as unplanned, mis-classifies
 * a canonical summary returned without ".md" as an invented one, and lets both
 * spellings survive a de-duplication pass so one file gets written twice.
 */
function withMdExtension(p) {
  if (typeof p !== 'string' || !p) return p;
  return /\.md$/i.test(p) ? p.slice(0, -3) + '.md' : p + '.md';
}

/**
 * Enforce the outline's structural guarantees on what Phase 2 actually RETURNED.
 *
 * THE HOLE THIS CLOSES (found in live testing, pre-existing since multi-phase
 * shipped): Phase 2 pushed `batchResult.pages` straight into the result, trusting
 * whatever `path` the model put in its batch JSON. `validateOutline` runs on the
 * OUTLINE, so its guarantees — exactly one summary, at the canonical path — were
 * enforced on the plan and then trivially bypassed by the content phase. A real
 * run produced BOTH `summaries/ingestion-pipeline.md` (canonical) and
 * `summaries/the-ingestion-pipeline-technical-deep-dive.md` (invented), with no
 * warning anywhere, because the outline had been clean.
 *
 * Why a stray summary is worse than a stray file: the deterministic summary slug
 * exists so re-ingesting the same source MERGES into the same summary instead of
 * duplicating it. One stray summary permanently breaks idempotency for that
 * source — every later re-ingest merges into the canonical page while the stray
 * lingers with divergent content.
 *
 * Handling, by case:
 *   • summaries/<other> → REDIRECTED to the canonical summaryPath, never written
 *     as a second file. If an entry already occupies that path, the two are
 *     merged rather than one overwriting the other (see below) — content is
 *     never dropped, and the caller ends up with exactly ONE entry per path, so
 *     nothing double-writes.
 *   • a non-summary path that is not in the outline at all → ALLOWED, with a
 *     warning. Rationale: writePage already normalises folders, dedups against
 *     existing slugs and enforces canonical prefixes, so a renamed or
 *     spontaneously-added entity/concept is usually still useful content the
 *     user paid for — refusing it would be the silent-drop failure mode this
 *     very fix exists to remove. The warning makes it visible, and Wiki Health
 *     surfaces it if it turns out to be junk.
 *   • a path that IS in the outline but belongs to a different batch → allowed
 *     silently. That is benign cross-batch chatter (the page is planned, and the
 *     owning batch writes it); the caller's existing keep-last-occurrence dedup
 *     already collapses it, and warning on it would bury the real signals.
 *
 * MERGE DIRECTION for a summary collision: `mergeWikiPage(existing, incoming)`
 * treats `incoming` as the base and injects `existing`'s ACCUMULATE bullets plus
 * any prose section `incoming` dropped entirely. So the AUTHORITATIVE entry (the
 * one the model actually returned at the canonical path) is passed as `incoming`
 * and wins every conflict, while the redirected entry's unique bullets and
 * sections survive as `existing`. If no authoritative entry exists, the first
 * redirected entry becomes the base.
 *
 * Pure and deterministic — no I/O, no clock. Exported for offline testing.
 *
 * @returns {{pages: Array, warnings: string[]}}
 */
export function reconcileGeneratedPages(pages, { summaryPath, plannedPaths = [] } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  // Without a canonical summary path there is nothing to reconcile TO. Returning
  // the pages untouched is the only safe answer: the redirect below would
  // otherwise rewrite every summary entry's path to `undefined`/null, writePage
  // would refuse it, and the content would be destroyed. `ingestFile` always
  // supplies one, so this is defensive — but the function is exported and pure,
  // and a pure function must not destroy data on a degenerate input.
  if (typeof summaryPath !== 'string' || !summaryPath) {
    return { pages: list, warnings: [] };
  }
  const warnings = [];
  const planned = new Set((plannedPaths || []).filter(Boolean).map(withMdExtension));
  const canonicalSummary = withMdExtension(summaryPath);
  const out = [];
  let summaryIdx = -1;              // index in `out` of the canonical summary
  let summaryIsAuthoritative = false;
  const redirected = [];
  const unplanned = [];

  for (const page of list) {
    if (!page || typeof page.path !== 'string' || !page.path) {
      warnings.push('The AI returned a page with no path — it could not be written.');
      continue;
    }

    if (page.path.startsWith('summaries/')) {
      const authoritative = withMdExtension(page.path) === canonicalSummary;
      if (!authoritative) {
        redirected.push(page.path);
      }
      // Always pin to the exact canonical string — including the extension-less
      // spelling of the canonical path itself — so there can only ever be ONE
      // entry for this file and nothing double-writes.
      page.path = summaryPath;
      if (summaryIdx === -1) {
        summaryIdx = out.length;
        summaryIsAuthoritative = authoritative;
        out.push(page);
        continue;
      }
      // Collision: fold the two into ONE entry so the caller never double-writes.
      const held = out[summaryIdx];
      const base = (authoritative && !summaryIsAuthoritative) ? page : held;
      const other = base === page ? held : page;
      let merged = base.content;
      try {
        if (other.content && base.content) merged = mergeWikiPage(other.content, base.content);
        else merged = base.content || other.content;
      } catch { /* merge failure → keep the base content rather than crash */ }
      out[summaryIdx] = {
        ...base,
        path: summaryPath,
        content: merged,
        summary: base.summary || other.summary,
      };
      if (authoritative) summaryIsAuthoritative = true;
      continue;
    }

    if (!planned.has(withMdExtension(page.path))) unplanned.push(page.path);
    out.push(page);
  }

  if (redirected.length) {
    warnings.push(
      `The AI invented ${redirected.length} extra summary page${redirected.length > 1 ? 's' : ''} ` +
      `(${redirected.join(', ')}) — merged into the canonical summary "${summaryPath}" instead of ` +
      `creating duplicates, so re-ingesting this source still updates the same page.`
    );
  }
  if (unplanned.length) {
    const shown = unplanned.slice(0, 5).join(', ');
    warnings.push(
      `The AI wrote ${unplanned.length} page${unplanned.length > 1 ? 's' : ''} that ` +
      `${unplanned.length > 1 ? 'were' : 'was'} not in its own plan ` +
      `(${shown}${unplanned.length > 5 ? ', …' : ''}). They were kept — check them in the Wiki tab and ` +
      `merge or delete any that duplicate an existing page.`
    );
  }
  return { pages: out, warnings };
}

// ── Single-pass prompt (small documents) ─────────────────────────────────────

/**
 * Single-pass prompt (documents under MULTI_PHASE_INPUT_THRESHOLD).
 *
 * See the note on buildOutlinePrompt: removing index.md from this prompt was
 * implemented and then deferred for the same reason. Byte-identical to v3.0.15.
 */
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

// Output-token budgets for the multi-phase calls (v3.0.1-beta.15).
// All three stay well under Claude Haiku's 64000 cap AND under the ~21333
// streaming-guard threshold concerns for the smaller ones. The page-by-page
// fallback budget was raised from 4096 → 8192 so a dense single page is far
// less likely to truncate into a stub. The outline budget was raised from
// 16384 → 24576 so a document that plans many pages doesn't blow the cap while
// merely listing paths + one-line summaries.
const MULTI_PHASE_OUTLINE_TOKENS     = 24576;
const MULTI_PHASE_BATCH_TOKENS       = 16384;
const MULTI_PHASE_SINGLE_PAGE_TOKENS = 8192;

/**
 * True when an LLM error is an output-token-limit (the model truncated its
 * response). These are RECOVERABLE by re-running the work at a smaller scope
 * (page-by-page / a more concise outline). Every OTHER generateText error —
 * rate limit (429), service overload (503), auth, network — is fatal here:
 * llm.js has already exhausted its own retry/backoff before throwing, so
 * re-issuing the same call page-by-page would just fail again and silently
 * degrade real content into stub pages. Those must propagate so the user sees
 * the genuine error instead of a wiki full of stubs. (v3.0.1-beta.15 audit fix.)
 */
export function isOutputTokenLimit(err) {
  return /output token limit/i.test((err && err.message) || '');
}

/**
 * Accumulate real token usage across every LLM call an ingest makes.
 *
 * `generateText` returns a bare string (18 call sites depend on that), so spend
 * arrives out-of-band through `opts.onUsage` — fired once per COMPLETED provider
 * call, retries and fallback-chain rungs included. That means the totals here
 * are what was actually BILLED, not just what the successful call cost.
 *
 * The callback never throws (llm.js also guards it) and never affects the
 * ingest's outcome.
 */
export function makeUsageAccumulator() {
  // Field semantics are the provider-neutral convention documented on
  // normalizeGeminiUsage in llm.js: inputTokens EXCLUDES cached tokens on BOTH
  // providers, so `inputTokens + cachedReadTokens + cacheWriteTokens` is the
  // total prompt size and a cost calculation never branches on provider.
  const totals = {
    calls: 0, inputTokens: 0, outputTokens: 0,
    cachedReadTokens: 0, cacheWriteTokens: 0,
    provider: null, model: null,
  };
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    totals,
    onUsage(u) {
      const r = u && typeof u === 'object' ? u : {};
      totals.calls++;
      totals.inputTokens      += num(r.inputTokens);
      totals.outputTokens     += num(r.outputTokens);
      totals.cachedReadTokens += num(r.cachedReadTokens);
      totals.cacheWriteTokens += num(r.cacheWriteTokens);
      if (r.provider) totals.provider = r.provider;
      if (r.model)    totals.model = r.model;
    },
  };
}

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

/**
 * @param {object} existingFiles  FULL on-disk entity/concept filename lists —
 *   used by redirectSemanticDuplicates, which must never see a capped list.
 * @param {object} promptFiles    the same lists after capExistingFilesForPrompt,
 *   i.e. what is safe to embed in a prompt. On a small domain these are the
 *   same arrays and the rendered prompts are byte-identical to pre-v3.0.16.
 * @param {function|null} onUsage token-usage callback threaded to every call.
 */
async function ingestMultiPhase(schema, today, index, existingFiles, originalName, text, isOverwrite, progress, summaryPath, warnings, originatorHints = [], promptFiles = existingFiles, onUsage = null) {
  // Phase 1: outline
  // Diagnostics use console.error so this module is safe to import from the
  // MCP child process (which reserves stdout for JSON-RPC) — see v2.5.2.
  console.error('[ingest] Large document — using multi-phase ingest. Phase 1: outline...');
  progress(12, 'Phase 1: planning wiki structure…');

  // v3.0.1-beta.7 + beta.15: retry once with a stricter, more concise prompt if
  // the first outline attempt FAILS for ANY reason. beta.7 only caught malformed
  // JSON (a parse error); but a max_tokens error throws from generateText BEFORE
  // parseJSON runs, so it used to escape uncaught and kill the ingest. Now the
  // generateText call is inside the try, so both failure modes recover the same
  // way. The retry adds a "plan FEWER, broader pages" instruction so a document
  // that planned too many pages produces a smaller outline that fits the budget.
  // The outline call and its parse are handled separately so a FATAL
  // generateText error (rate limit / overload / auth / network) propagates with
  // its real message instead of being re-cast as the misleading "malformed JSON
  // twice" error after a futile retry (v3.0.1-beta.15 audit fix). Only an
  // output-token-limit or a JSON parse failure triggers the stricter retry.
  let outline = null;
  let outlineRaw = null;
  let firstFailedOnTokenLimit = false;
  try {
    outlineRaw = (await generateText(
      schema,
      buildOutlinePrompt(today, index, promptFiles, originalName, text, isOverwrite, summaryPath),
      MULTI_PHASE_OUTLINE_TOKENS,
      'json',
      (msg) => progress(12, msg, 'wait'),
      { onUsage }
    )).trim();
  } catch (genErr) {
    if (!isOutputTokenLimit(genErr)) throw genErr;   // fatal — surface it
    firstFailedOnTokenLimit = true;
  }
  if (outlineRaw !== null) {
    try { outline = parseJSON(outlineRaw); }
    catch { /* malformed JSON → stricter retry below */ }
  }

  if (!outline) {
    console.warn(`[ingest] Phase 1 outline failed (${firstFailedOnTokenLimit ? 'output token limit' : 'parse'}). Retrying with stricter prompt...`);
    warnings.push(firstFailedOnTokenLimit
      ? 'Phase 1 outline was too large for the AI output limit; auto-retried asking for a more concise plan.'
      : 'Phase 1 outline returned malformed JSON; auto-retried with stricter prompt.');
    progress(13, 'Phase 1: retrying…', 'wait');

    const strictPrompt = buildOutlinePrompt(today, index, promptFiles, originalName, text, isOverwrite, summaryPath)
      + '\n\nIMPORTANT — STRICT JSON REQUIREMENTS:\n'
      + '1. Return ONLY the JSON object. No markdown fences, no "```json" wrapper, no commentary before or after.\n'
      + '2. Inside "summary" string values: do NOT use double quotes. Use single quotes if you need quotation marks. Avoid backslashes and special characters.\n'
      + '3. Keep each "summary" under 120 characters to reduce the chance of malformed strings.\n'
      + '4. Plan FEWER, broader pages — prefer one parent concept over many tiny sibling pages — so the outline stays concise.\n'
      + '5. The response must parse with native JSON.parse on the first try.';

    let outlineRaw2 = null;
    try {
      outlineRaw2 = (await generateText(
        schema, strictPrompt, MULTI_PHASE_OUTLINE_TOKENS, 'json',
        (msg) => progress(13, msg, 'wait'),
        { onUsage }
      )).trim();
    } catch (genErr2) {
      if (!isOutputTokenLimit(genErr2)) throw genErr2;   // fatal — surface it
      // token-limit on the retry too → fall through to the actionable error
    }
    if (outlineRaw2 !== null) {
      try { outline = parseJSON(outlineRaw2); console.error('[ingest] Phase 1 stricter retry succeeded.'); }
      catch { /* still malformed → actionable error below */ }
    }

    if (!outline) {
      // Both attempts failed (parse and/or token-limit) — throw a clean,
      // actionable error the UI can show.
      throw new Error(
        `⚠ The AI could not produce a usable plan for this source after two attempts — ` +
        `usually a transient AI-provider issue, or a source so dense the outline overflowed ` +
        `the model's output limit (not a problem with The Curator or your file). ` +
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

  // v3.0.1-beta.11: pre-write semantic-dupe guard. Catches slugs like
  // "experts-roundup-format" landing in the same outline (or being created
  // against an existing "expert-roundup-format" on disk) and redirects them
  // onto the existing slug so bullets merge instead of accumulating
  // near-duplicate sibling pages.
  const semDupe = redirectSemanticDuplicates(outline, existingFiles);
  for (const w of semDupe.warnings) {
    console.warn(`[ingest] Semantic-dupe guard: ${w}`);
    warnings.push(w);
  }

  const allPages = outline.pages; // [{path, summary}]
  const totalBatches = Math.ceil(allPages.length / BATCH_SIZE);

  // v3.0.16 — prompt caching, enabled ONLY where it can pay for itself.
  //
  // An Anthropic cache WRITE costs 1.25x the base input rate; a READ costs
  // ~0.1x. So a breakpoint on a prefix used exactly once makes the call 25%
  // MORE expensive, and break-even is two calls (1.25 + 0.1 = 1.35 vs 2.0).
  // Every Phase 2 batch of this ingest shares the identical prefix, so >= 2
  // batches means >= 2 uses. Single-pass ingest is ONE call and never gets a
  // breakpoint (it does not go through this path at all). llm.js additionally
  // refuses to mark a prefix shorter than ANTHROPIC_CACHE_MIN_PREFIX_CHARS,
  // because Anthropic silently declines to cache below the model's minimum
  // (4096 tokens on claude-haiku-4-5, the Curator's Anthropic default).
  // Gemini ignores the hint entirely — 2.5-family models cache prefixes
  // implicitly, so the reordering above is the whole benefit there.
  const cacheAcrossBatches = totalBatches >= 2;
  console.error(`[ingest] Phase 1 complete — ${allPages.length} pages planned.`);

  // Phase 2: batched content  (20% → 78%)
  const writtenPages = []; // [{path, content, summary?}]

  for (let i = 0; i < allPages.length; i += BATCH_SIZE) {
    const batch = allPages.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batchPct = Math.round(20 + (batchNum / totalBatches) * 58);
    console.error(`[ingest] Phase 2 — batch ${batchNum}/${totalBatches} (${batch.length} pages)...`);
    progress(batchPct, `Phase 2: writing content, batch ${batchNum} of ${totalBatches}…`);

    // The batch LLM call and its JSON parse are handled separately so the two
    // recoverable failures (output-token-limit, malformed JSON) fall back to
    // page-by-page, while a FATAL generateText error (rate limit / overload /
    // auth / network) propagates instead of silently degrading to stub pages
    // (v3.0.1-beta.15 + audit fix). Before beta.15 the generateText call sat
    // outside the try, so a max_tokens error killed the whole ingest; now it
    // recovers, but only for token-limit/parse — not for genuine outages.
    let batchResult = null;
    let batchRaw = null;
    // prefix is byte-identical across every batch; only `suffix` carries the
    // per-batch page list — that split is what makes the prefix cacheable.
    const batchParts = buildBatchPromptParts(today, originalName, text, batch, promptFiles, allPages);
    try {
      batchRaw = (await generateText(
        schema,
        batchParts.prefix + batchParts.suffix,
        MULTI_PHASE_BATCH_TOKENS,
        'json',
        (msg) => progress(batchPct, msg, 'wait'),
        { onUsage, cachePrefixChars: cacheAcrossBatches ? batchParts.prefix.length : 0 }
      )).trim();
    } catch (genErr) {
      if (!isOutputTokenLimit(genErr)) throw genErr;   // fatal — surface it
      console.warn(`[ingest] Batch ${batchNum} hit the output token limit — retrying page-by-page...`);
      warnings.push(`Batch ${batchNum} of ${totalBatches} was too large for the AI's output limit — wrote those pages individually instead.`);
    }
    if (batchRaw !== null) {
      try {
        batchResult = parseJSON(batchRaw);
      } catch (parseErr) {
        console.warn(`[ingest] Batch ${batchNum} parse failed (${batchRaw.length} chars) — retrying page-by-page...`);
      }
    }

    if (!batchResult) {
      // Fall back to one page at a time. A single-page response is small enough
      // to (a) stay under any model's output cap and (b) be essentially
      // impossible to fail parsing.
      batchResult = { pages: [] };
      // The single-page prompts reuse the SAME prefix as the batch call above
      // (only the page list differs), so the cache set up by the batch attempt
      // is read back here. Worth a breakpoint whenever >= 2 calls will share
      // it: either this batch writes >= 2 pages, or other batches follow.
      const cacheSinglePages = cacheAcrossBatches || batch.length >= 2;
      for (const singlePage of batch) {
        let singleRaw = null;
        const singleParts = buildBatchPromptParts(today, originalName, text, [singlePage], promptFiles, allPages);
        try {
          singleRaw = (await generateText(
            schema,
            singleParts.prefix + singleParts.suffix,
            MULTI_PHASE_SINGLE_PAGE_TOKENS,
            'json',
            (msg) => progress(batchPct, msg, 'wait'),
            { onUsage, cachePrefixChars: cacheSinglePages ? singleParts.prefix.length : 0 }
          )).trim();
        } catch (singleGenErr) {
          if (!isOutputTokenLimit(singleGenErr)) throw singleGenErr;  // fatal — surface it
          // token-limit on a single page → fall through to a stub below
        }
        let singlePages = null;
        if (singleRaw !== null) {
          try { singlePages = parseJSON(singleRaw).pages; }
          catch { /* parse failure → stub below */ }
        }
        if (singlePages) {
          batchResult.pages.push(...singlePages);
          console.error(`[ingest]   ✓ ${singlePage.path}`);
        } else {
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

  // v3.0.16: enforce the outline's structural guarantees on what Phase 2 actually
  // returned. Covers BOTH the batch path and the page-by-page fallback, since
  // both feed writtenPages.
  const reconciled = reconcileGeneratedPages(writtenPages, {
    summaryPath,
    plannedPaths: allPages.map(p => p && p.path).filter(Boolean),
  });
  for (const w of reconciled.warnings) {
    console.warn(`[ingest] Phase 2 path check: ${w}`);
    warnings.push(w);
  }

  // No Phase 3 — index is merged programmatically by the caller.
  return {
    title: outline.title,
    pages: reconciled.pages,
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
  // v3.0.1-beta.8: atomic raw save so a kill mid-write doesn't leave a
  // half-saved PDF in raw/ that the duplicate-check (routes/ingest.js)
  // then blocks future retries on.
  await writeFileAtomic(destPath, buffer);

  // v3.0.1-beta.8: extract text inside a try/catch so a corrupt / encrypted /
  // image-only PDF doesn't (a) crash the pipeline with an unhandled
  // pdf-parse error and (b) leave the raw file lingering — which would then
  // 409-block the user when they try to re-upload the file after fixing it.
  //
  // ALSO guards against silent garbage ingest: if pdf-parse returns 0 or
  // near-0 characters (image-only PDF, encrypted PDF that "extracts" empty
  // text), the LLM would otherwise see an empty document and hallucinate
  // wiki pages from the filename alone. Refuse early with an actionable
  // message instead.
  progress(8, 'Extracting text from document…');
  const MIN_TEXT_LEN = 200;          // empirical: useful sources are far longer
  let fullText;
  try {
    fullText = await extractText(destPath);
  } catch (err) {
    // Best-effort cleanup of the raw file so the user can retry without
    // hitting the duplicate-check 409.
    try { await unlink(destPath); } catch { /* ignore */ }
    throw new Error(
      `Could not extract text from "${originalName}". ` +
      `This is usually caused by an encrypted PDF, a scanned / image-only PDF ` +
      `that needs OCR first, or a malformed file. Try: opening the PDF and ` +
      `re-saving without encryption; running OCR (e.g. macOS Preview → Tools → ` +
      `Adjust Text → OCR, or ocrmypdf); or converting to .md / .txt first. ` +
      `(Underlying error: ${err.message.slice(0, 200)})`
    );
  }
  if (!fullText || fullText.trim().length < MIN_TEXT_LEN) {
    try { await unlink(destPath); } catch { /* ignore */ }
    const got = fullText ? fullText.trim().length : 0;
    throw new Error(
      `"${originalName}" yielded only ${got} characters of text — too little to ` +
      `produce meaningful wiki pages. This usually means the PDF is image-only ` +
      `(scanned, no embedded text layer) and needs OCR before ingest. ` +
      `Try: macOS Preview → Tools → Adjust Text → OCR, or run ocrmypdf, or paste ` +
      `the article text into a .md file and ingest that instead. The raw file ` +
      `has been removed so you can re-upload after fixing it.`
    );
  }
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

  // v3.0.16: the inventory embedded in PROMPTS is capped and ranked by
  // relevance to this source (see capExistingFilesForPrompt). `existingFiles`
  // itself stays FULL — redirectSemanticDuplicates below must keep scanning
  // every on-disk slug, since it is the safety net that covers anything the cap
  // drops. On a domain small enough to fit the budget, promptFiles holds the
  // same arrays and every rendered prompt is byte-identical to pre-v3.0.16.
  const capped = capExistingFilesForPrompt(existingFiles, text);
  const promptFiles = capped.files;
  for (const w of capped.warnings) {
    console.warn(`[ingest] ${w}`);
    warnings.push(w);
  }

  // v3.0.16: real token spend, gathered out-of-band from every LLM call this
  // ingest makes (including retries and model-fallback rungs).
  const usage = makeUsageAccumulator();

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
      buildPrompt(today, index, promptFiles, originalName, text, false, isOverwrite, summaryPath),
      65536,
      'json',
      (msg) => progress(15, msg, 'wait'),
      // No cache breakpoint here: single-pass is ONE call, and an Anthropic
      // cache write costs 1.25x the base input rate — marking a prefix that is
      // used exactly once would make this call MORE expensive, not less.
      { onUsage: usage.onUsage }
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
          buildPrompt(today, index, promptFiles, originalName, text, true, isOverwrite, summaryPath),
          65536,
          'json',
          (msg) => progress(15, msg, 'wait'),
          { onUsage: usage.onUsage }
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
    // v3.0.1-beta.15: an output-token-limit error on the single-pass call is
    // recoverable — multi-phase splits the work into small batches that each
    // stay well under the cap. Fall through to it instead of failing the whole
    // ingest. All other errors (rate limits, network, auth) are genuinely fatal
    // and re-thrown unchanged.
    if (/output token limit/i.test(err.message || '')) {
      console.warn('[ingest] Single-pass hit the output token limit — switching to multi-phase.');
      warnings.push('The document was too large for a single AI pass — switched to the chunked (multi-phase) importer automatically.');
      singlePassFailed = true;
    } else {
      throw err;
    }
  }

  // ── Multi-phase fallback ───────────────────────────────────────────────────
  if (singlePassFailed) {
    usedMultiPhase = true;
    if (!result) {
      progress(10, 'Large document — switching to multi-phase ingest…');
    }
    result = await ingestMultiPhase(schema, today, index, existingFiles, originalName, text, isOverwrite, progress, summaryPath, warnings, originatorHints, promptFiles, usage.onUsage);
  } else {
    // v3.0.1-beta.1: single-pass also runs through the outline validator so a
    // missing/non-canonical summary page is patched the same way as multi-phase.
    // Originator hints are passed in so an omitted author entity is injected
    // before write.
    // The single-pass response shape is {title, pages:[{path, content, summary?}]}.
    //
    // v3.0.16: run the Phase-2-style path reconciliation FIRST. Single-pass hits
    // the same class of defect (the model returning a second, invented summary),
    // and validateOutline's remedy there is to DROP the extra — which discards
    // content the user paid for, because unlike an outline entry a single-pass
    // entry carries the page body. Reconciling first merges the stray into the
    // canonical summary, after which validateOutline sees exactly one canonical
    // summary and is a no-op for that check. plannedPaths is the response's own
    // path set, since in single-pass the pages ARE the plan — so the
    // "not in the plan" warning can never fire spuriously here.
    {
      const rec = reconcileGeneratedPages(result.pages, {
        summaryPath,
        plannedPaths: (result.pages || []).map(p => p && p.path).filter(Boolean),
      });
      result.pages = rec.pages;
      for (const w of rec.warnings) {
        console.warn(`[ingest] Single-pass path check: ${w}`);
        warnings.push(w);
      }
    }

    const validated = validateOutline(result, summaryPath, originalName, originatorHints);
    result = validated.outline;
    for (const w of validated.warnings) {
      console.warn(`[ingest] Outline validator: ${w}`);
      warnings.push(w);
    }

    // v3.0.1-beta.11: same semantic-dupe guard as multi-phase. Catches a
    // single-pass result where the LLM proposes a slug that's a plural/
    // suffix variant of an existing concept on disk.
    const semDupe = redirectSemanticDuplicates(result, existingFiles);
    for (const w of semDupe.warnings) {
      console.warn(`[ingest] Semantic-dupe guard: ${w}`);
      warnings.push(w);
    }
  }

  // Deduplicate result.pages — multi-phase ingest can return the same path in
  // multiple batches (the LLM sometimes adds extra pages it wasn't asked for).
  // Keep the LAST occurrence so the most-complete LLM version wins; writePage's
  // mergeWikiPage will still union it with any existing on-disk content.
  {
    // v3.0.16: key on the .md-normalised path. writePage now appends a missing
    // extension, so "concepts/x" and "concepts/x.md" are the same file — keying
    // on the raw string let both survive and write the same file twice (create,
    // then merge), producing two change records and two warnings for one page.
    const seen = new Map();
    for (const page of result.pages) seen.set(withMdExtension(page.path), page);
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
    // v3.0.16: writePage refusals and path auto-corrections now surface to the
    // user instead of dying in a console line — a discarded page means content
    // the user paid for silently vanished.
    const record = await writePage(domain, page.path, page.content, {
      onWarn: (w) => warnings.push(w),
    });
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

  // v3.0.1-beta.11: post-batch hub-page linkification.
  //
  // After all pages are on disk, scan each concept page just written for
  // "hub" shape — many sibling list items + few existing wikilinks. For each
  // such hub, find plain-text occurrences of OTHER pages' titles/slugs from
  // this same ingest and wrap them in [[brackets]]. Fixes the systematic
  // Haiku failure mode where hub pages list 25 sibling items as plain text
  // because the LLM didn't know their slugs at write time. With this pass
  // running after every batch completes, the slugs are now all on disk and
  // can be linked deterministically.
  //
  // Non-fatal: if anything goes wrong, the warning is logged and the ingest
  // continues — the audit pass below will still report any phantom links.
  try {
    const linkifyReport = await linkifyHubPages(domain, canonicalPaths);
    if (linkifyReport.linksAdded > 0) {
      warnings.push(
        `Hub linkification: added ${linkifyReport.linksAdded} wikilinks across ` +
        `${linkifyReport.hubsModified} hub-shaped concept page(s) to connect them to ` +
        `siblings created in this same ingest.`
      );
    }
  } catch (linkifyErr) {
    console.warn(`[ingest] Hub linkification failed (non-fatal): ${linkifyErr.message}`);
  }

  // v3.0.1-beta.9: post-write broken-link audit. Surfaces the count of
  // wikilinks that don't resolve to a file on disk, as a warning that flows
  // into the ingest result panel + log entry. This is the actionable signal
  // the user gets WITHOUT needing to run a separate Health scan after every
  // ingest. Surfaced by the deep-test harness which showed ~14-20% broken
  // wikilinks on real Gemini Flash output (mostly LLM mentioning entities
  // in Phase 2 batches that weren't on the page plan in Phase 1).
  //
  // Doesn't FAIL the ingest — it's informational. The broken links remain
  // in the pages; the user can run Health scan → Ask AI to triage them.
  try {
    const brokenAudit = await auditBrokenWikilinks(domain, canonicalPaths);
    if (brokenAudit.brokenCount > 0) {
      const pct = ((brokenAudit.brokenCount / brokenAudit.totalCount) * 100).toFixed(1);
      const samples = brokenAudit.samples.slice(0, 3).map(s => `${s.target}`).join(', ');
      const msg = `${brokenAudit.brokenCount} of ${brokenAudit.totalCount} wikilinks (${pct}%) don't resolve to an existing page. Examples: ${samples}${brokenAudit.samples.length > 3 ? '…' : ''}. Run Wiki Health → Ask AI to fix or strip them, or re-ingest with broader entity coverage.`;
      warnings.push(msg);
    }
  } catch (auditErr) {
    // Non-fatal — broken-link audit is informational only.
    console.warn(`[ingest] Broken-link audit failed (non-fatal): ${auditErr.message}`);
  }

  // Append to log — use canonical paths for accurate reporting
  const pageList = canonicalPaths.map(p => `  - ${p}`).join('\n');
  const warningSection = warnings.length
    ? `\nWarnings:\n${warnings.map(w => `  - ${w}`).join('\n')}`
    : '';
  const logEntry = `## [${today}] ingest | ${result.title}\nPages created or updated:\n${pageList}${warningSection}\n`;
  await appendLog(domain, logEntry);

  // v3.0.16: real token spend for this ingest. stderr, never stdout — this
  // module is imported by the MCP child process (v2.5.2).
  {
    const t = usage.totals;
    console.error(
      `[ingest] Token usage — ${t.calls} call(s) via ${t.provider || 'unknown'}/${t.model || 'unknown'}: ` +
      `${t.inputTokens} in, ${t.outputTokens} out, ` +
      `${t.cachedReadTokens} cached-read, ${t.cacheWriteTokens} cache-write.`
    );
  }

  progress(100, 'Done!');
  return {
    title: result.title,
    pagesWritten: canonicalPaths,
    changes,    // structured per-file change records (v2.5.0+)
    warnings,   // user-visible non-fatal issues (v3.0.1-beta.1)
    truncated,  // boolean — was the source longer than TEXT_CAP?
    // Additive (v3.0.16): measured spend across every LLM call this ingest
    // made. The SSE route picks fields explicitly, so this is invisible to
    // existing clients; it exists for measurement + future cost metering.
    //
    // {calls, inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens,
    //  provider, model}. inputTokens EXCLUDES cached tokens on BOTH providers
    // (normalised — see normalizeGeminiUsage in llm.js), so total prompt size is
    // inputTokens + cachedReadTokens + cacheWriteTokens and a cost calculation
    // never has to branch on which provider ran.
    tokenUsage: usage.totals,
  };
}

/**
 * Audit broken wikilinks across the wiki after an ingest. Returns the count
 * + first few samples so the caller can surface them as a warning. Reads
 * every page in the wiki once; cheap on small/medium domains.
 *
 * v3.0.1-beta.9 — surfaces a quality signal the user previously had to run
 * Wiki Health to discover. Implementation lives in the ingest module because
 * the timing matters: we want the audit to reflect THIS ingest's writes
 * (which is why we run it AFTER all writePage calls + after the index merge,
 * but BEFORE the log entry — so the count goes into the log entry too).
 *
 * Doesn't dedupe — if `[[bitcoin-mining]]` appears in 5 pages, it counts as 5.
 * That's deliberate: high count = high impact = more reason to investigate.
 */
/**
 * Post-batch hub-page linkification (v3.0.1-beta.11).
 *
 * Some concept pages are inherently HUBS — their job is to enumerate other
 * concepts in the domain (a "curation format library" listing 25 formats,
 * a "memory taxonomy" listing 5 memory types, etc.). The LLM writes these
 * with the item names as plain text (often bold or numbered) instead of
 * `[[wikilinks]]` because, at the moment of writing the hub, it doesn't
 * know the exact slugs that sibling batches will produce. The result is
 * a hub that looks rich in prose but has zero outgoing graph edges to the
 * items it's supposed to organize.
 *
 * This pass runs AFTER every batch has written, when every sibling slug
 * is now on disk. For each "hub-shaped" concept page just written, we
 * scan its body for plain-text mentions of other pages' titles/slugs from
 * this same ingest and wrap them in `[[brackets]]`.
 *
 * Conservative matching (avoid false positives):
 *   - Only operates on CONCEPT pages with ≥5 list items AND ≤2 existing
 *     wikilinks ("hub" pattern — enumerates many things, links to few)
 *   - Matches the page's first heading (Title Case) — these are the
 *     anchors the LLM uses to refer to sibling pages
 *   - Skips code blocks, inline code, and content already inside `[[]]`
 *   - Skips self-references (a hub page doesn't link to itself)
 *   - Uses `[[slug|Display Title]]` so the user-visible text stays the
 *     same as the LLM wrote — purely additive change
 */
async function linkifyHubPages(domain, canonicalPaths) {
  const wikiDir = wikiPath(domain);

  // Step 1: build the slug → display title map by reading each page's first
  // heading. The display title is the natural-language form the LLM most
  // likely used when mentioning the page in another page's body.
  const slugToTitle = new Map();
  for (const relPath of canonicalPaths) {
    if (!relPath.startsWith('concepts/') && !relPath.startsWith('entities/')) continue;
    const slug = relPath.split('/').pop().replace(/\.md$/, '');
    try {
      const content = await readFile(path.join(wikiDir, relPath), 'utf8');
      const titleMatch = content.match(/^#{1,3}\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : slug.replace(/-/g, ' ');
      slugToTitle.set(slug, title);
    } catch {
      slugToTitle.set(slug, slug.replace(/-/g, ' '));
    }
  }

  let hubsModified = 0;
  let linksAdded = 0;

  for (const relPath of canonicalPaths) {
    if (!relPath.startsWith('concepts/')) continue;  // hub pattern lives on concepts/

    const fullPath = path.join(wikiDir, relPath);
    let content;
    try { content = await readFile(fullPath, 'utf8'); } catch { continue; }

    // Step 2: detect "hub-shaped" pages.
    const listItemCount = (content.match(/^\s*(?:\d+\.|[-*])\s+/gm) || []).length;
    const existingLinkCount = (content.match(/\[\[/g) || []).length;
    if (listItemCount < 5) continue;          // not enough enumeration
    if (existingLinkCount > 2) continue;      // already well-linked

    const selfSlug = relPath.split('/').pop().replace(/\.md$/, '');

    // Critical: we MUST re-split the content between every candidate so a
    // freshly-wrapped `[[slug|Title]]` becomes a protected segment in the
    // NEXT iteration. Otherwise a second candidate's case-insensitive
    // regex matches the lowercase slug INSIDE the wrap we just produced,
    // producing nested malformed brackets (`[[[[microsoft]]` etc.).
    // Discovered during the v3.0.1-beta.11 deep test on the live REAL-1
    // ingest where 30 broken `[[[[X]]` patterns appeared on a single page.
    let modified = content;
    let pageLinks = 0;

    for (const [slug, title] of slugToTitle.entries()) {
      if (slug === selfSlug) continue;
      if (!title || title.length < 4) continue;  // skip 1-3 char titles (too noisy)

      // Build the set of display candidates we'll search for. Both the
      // human-readable title and the slug-with-spaces form catch different
      // LLM phrasings.
      const candidates = new Set();
      candidates.add(title);
      candidates.add(slug.replace(/-/g, ' '));

      for (const candidate of candidates) {
        if (!candidate || candidate.length < 4) continue;
        const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Whole-word, case-insensitive. Require a word boundary on each side
        // so "Tools" doesn't match inside "ToolsDirectory" and "RAG" doesn't
        // match inside "DRAGON".
        const re = new RegExp(`\\b${escaped}\\b`, 'gi');

        // Re-split on every candidate iteration. Performance is fine
        // because hubs are small (few KB) and the candidate count is
        // bounded by the number of slugs in this ingest.
        const segments = modified.split(/(```[\s\S]*?```|`[^`]*`|\[\[[^\]]*\]\])/g);
        let candidateLinks = 0;
        for (let i = 0; i < segments.length; i++) {
          if (i % 2 === 1) continue;
          const before = segments[i];
          if (!re.test(before)) continue;
          re.lastIndex = 0;
          segments[i] = before.replace(re, (match) => {
            candidateLinks++;
            return `[[${slug}|${match}]]`;
          });
        }
        if (candidateLinks > 0) {
          modified = segments.join('');
          pageLinks += candidateLinks;
        }
      }
    }

    if (pageLinks > 0) {
      // Write back via writePage so all the safeguards (atomic write,
      // bullet dedup, variant-link normalisation Pass A/B/C) still apply.
      await writePage(domain, relPath, modified);
      hubsModified++;
      linksAdded += pageLinks;
    }
  }

  return { hubsModified, linksAdded };
}

async function auditBrokenWikilinks(domain, recentlyWrittenPaths) {
  const wikiDir = wikiPath(domain);
  // Build the slug inventory once
  const entitiesDir = path.join(wikiDir, 'entities');
  const conceptsDir = path.join(wikiDir, 'concepts');
  const summariesDir = path.join(wikiDir, 'summaries');
  const [entityFiles, conceptFiles, summaryFiles] = await Promise.all([
    readdir(entitiesDir).then(f => f.filter(x => x.endsWith('.md'))).catch(() => []),
    readdir(conceptsDir).then(f => f.filter(x => x.endsWith('.md'))).catch(() => []),
    readdir(summariesDir).then(f => f.filter(x => x.endsWith('.md'))).catch(() => []),
  ]);
  const entitySlugs = new Set(entityFiles.map(f => f.slice(0, -3)));
  const conceptSlugs = new Set(conceptFiles.map(f => f.slice(0, -3)));
  const summarySlugs = new Set(summaryFiles.map(f => f.slice(0, -3)));

  // Scan ONLY the pages we just wrote (recentlyWrittenPaths) — keeps the
  // audit narrow to the current ingest's output, not the whole domain.
  let totalCount = 0;
  let brokenCount = 0;
  const samples = [];
  for (const relPath of recentlyWrittenPaths) {
    const full = path.join(wikiDir, relPath);
    let content;
    try { content = await readFile(full, 'utf8'); }
    catch { continue; }
    // Strip code blocks so [[X]] inside ``` isn't counted
    const stripped = content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '');
    const linkRe = /\[\[([^\]|#\n]+?)(\|[^\]]+)?\]\]/g;
    let m;
    while ((m = linkRe.exec(stripped)) !== null) {
      totalCount++;
      const target = m[1].trim();
      let resolved;
      if (target.includes('/')) {
        const [folder, slug] = target.split('/', 2);
        if (folder === 'summaries') resolved = summarySlugs.has(slug);
        else if (folder === 'entities') resolved = entitySlugs.has(slug);
        else if (folder === 'concepts') resolved = conceptSlugs.has(slug);
        else resolved = false;
      } else {
        resolved = entitySlugs.has(target) || conceptSlugs.has(target);
      }
      if (!resolved) {
        brokenCount++;
        if (samples.length < 10) samples.push({ source: relPath, target });
      }
    }
  }
  return { totalCount, brokenCount, samples };
}

// Internal helpers exposed for battle-testing (v3.0.1-beta.1).
// Not part of the public API — callers should use ingestFile() instead.
export const __testing = {
  buildOutlinePrompt,
  buildPrompt,
  buildBatchPrompt,
  buildBatchPromptParts,
  slugLineCost,
  stubPageContent,
  isOutputTokenLimit,
  TEXT_CAP: 80_000,
};
