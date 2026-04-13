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
function parseJSON(raw) {
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

function buildOutlinePrompt(today, index, existingFiles, originalName, text, isOverwrite) {
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

CRITICAL — Valid folder prefixes for page paths:
  • summaries/  — one summary page per source document
  • entities/   — every person, tool, company, framework, dataset, project
  • concepts/   — every idea, technique, principle, methodology
NEVER use any other folder (e.g. "people/", "tools/", "frameworks/" are INVALID).
Every path MUST start with one of the three prefixes above.

Return ONLY valid JSON in this exact shape (no markdown fences, no commentary):
{
  "title": "human-readable title of this source",
  "pages": [
    { "path": "summaries/example-source.md", "summary": "one-line description" },
    { "path": "concepts/some-concept.md",    "summary": "one-line description" },
    { "path": "entities/some-entity.md",     "summary": "one-line description" }
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

EXISTING WIKI FILES — when writing content for these pages, use [[page-name]] links that match existing filenames exactly.
Existing entities: ${existingFiles.entities.map(f => f.replace('.md', '')).join(', ')}
Existing concepts: ${existingFiles.concepts.map(f => f.replace('.md', '')).join(', ')}

CRITICAL — Valid folder prefixes for page paths:
  • summaries/  — one summary page per source document
  • entities/   — every person, tool, company, framework, dataset, project
  • concepts/   — every idea, technique, principle, methodology
NEVER use any other folder (e.g. "people/", "tools/", "frameworks/" are INVALID).
Every path MUST start with one of the three prefixes above.

Return ONLY valid JSON in this exact shape (no markdown fences, no commentary):
{
  "pages": [
    { "path": "summaries/example-source.md", "content": "..." },
    { "path": "concepts/some-concept.md",    "content": "..." }
  ]
}`;
}

// ── Phase 3: index update ─────────────────────────────────────────────────────

function buildIndexPrompt(existingIndex, newPages) {
  const pageList = newPages
    .map(p => `  ${p.path}: ${p.summary || p.path}`)
    .join('\n');

  return `Current index.md:
${existingIndex || '(empty)'}

New or updated pages to incorporate:
${pageList}

Write a complete, updated index.md that lists ALL pages (existing + new).
Rules:
- Use [[page-name]] format for all links — NEVER include folder prefix (write [[rag]] not [[concepts/rag]]).
- No duplicate rows — if a page already appears in the current index, update it rather than adding a second entry.
- index.md has NO YAML frontmatter.
Return ONLY the raw markdown text for index.md (no JSON, no fences).`;
}

// ── Single-pass prompt (small documents) ─────────────────────────────────────

function buildPrompt(today, index, existingFiles, originalName, text, strict, isOverwrite = false) {
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
1. Write a summary page for this source.
2. Create or update entity pages for every person, tool, company, framework, or dataset mentioned.
3. Create or update concept pages for every key idea or technique.
4. Add cross-references between related pages using [[page-name]] syntax.
5. Produce an updated index.md that includes all existing pages plus any new ones.

${conciseness}

Page body rules:
- Do NOT include YAML frontmatter (--- blocks) — it is added automatically after generation.
- Entity pages: include a "Type: <entity-type>" line and a "Tags: tag1, tag2" line in the body.
- Concept and summary pages: include a "Tags: tag1, tag2" line in the body.
- Links: always write [[page-name]] — NEVER use folder prefix (write [[rag]] not [[concepts/rag]]).
- In the index.md table, use [[page-name]] (no folder prefix, no duplicates).

CRITICAL — Valid folder prefixes for page paths:
  • summaries/  — one summary page per source document
  • entities/   — every person, tool, company, framework, dataset, project
  • concepts/   — every idea, technique, principle, methodology
NEVER use any other folder (e.g. "people/", "tools/", "frameworks/" are INVALID).
Every path MUST start with one of the three prefixes above.

Return ONLY valid JSON in this exact shape (no markdown fences, no commentary):
{
  "title": "human-readable title of this source",
  "pages": [
    { "path": "summaries/example-source.md", "content": "..." },
    { "path": "concepts/some-concept.md", "content": "..." },
    { "path": "entities/some-entity.md", "content": "..." }
  ],
  "index": "full content of the updated index.md"
}`;
}

// ── Multi-phase ingest (large documents) ─────────────────────────────────────

// Smaller batches produce shorter JSON responses, dramatically reducing parse
// failures from accumulated unescaped quotes in dense documents.
const BATCH_SIZE = 4;

async function ingestMultiPhase(schema, today, index, existingFiles, originalName, text, isOverwrite, progress) {
  // Phase 1: outline
  console.log('[ingest] Large document — using multi-phase ingest. Phase 1: outline...');
  progress(12, 'Phase 1: planning wiki structure…');
  const outlineRaw = (await generateText(
    schema,
    buildOutlinePrompt(today, index, existingFiles, originalName, text, isOverwrite),
    16384,
    'json',
    (msg) => progress(12, msg, 'wait')
  )).trim();

  const outline = parseJSON(outlineRaw);
  const allPages = outline.pages; // [{path, summary}]
  const totalBatches = Math.ceil(allPages.length / BATCH_SIZE);
  console.log(`[ingest] Phase 1 complete — ${allPages.length} pages planned.`);

  // Phase 2: batched content  (20% → 78%)
  const writtenPages = []; // [{path, content}]

  for (let i = 0; i < allPages.length; i += BATCH_SIZE) {
    const batch = allPages.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batchPct = Math.round(20 + (batchNum / totalBatches) * 58);
    console.log(`[ingest] Phase 2 — batch ${batchNum}/${totalBatches} (${batch.length} pages)...`);
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
          console.log(`[ingest]   ✓ ${singlePage.path}`);
        } catch (singleErr) {
          // Absolute last resort — create a stub page so the ingest completes.
          console.warn(`[ingest]   ✗ ${singlePage.path} — stub created.`);
          batchResult.pages.push({
            path: singlePage.path,
            content: `# ${singlePage.path.replace(/^.*\//, '').replace('.md', '')}\n\n${singlePage.summary}\n`,
          });
        }
      }
    }

    writtenPages.push(...batchResult.pages);
  }

  // Phase 3: index
  console.log('[ingest] Phase 3: updating index...');
  progress(82, 'Phase 3: updating wiki index…');
  const newIndex = (await generateText(
    schema,
    buildIndexPrompt(index, allPages),
    4096,
    'text',
    (msg) => progress(82, msg, 'wait')
  )).trim();

  return {
    title: outline.title,
    pages: writtenPages,
    index: newIndex,
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

  // Save to raw/
  progress(4, 'Saving source file…');
  const rawDir = rawPath(domain);
  await mkdir(rawDir, { recursive: true });
  const destPath = path.join(rawDir, originalName);
  const buffer = await readFile(filePath);
  await writeFile(destPath, buffer);

  // Extract text — cap at 80 000 chars to stay within input limits
  progress(8, 'Extracting text from document…');
  const fullText = await extractText(destPath);
  const text = fullText.slice(0, 80000);

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
    console.log(`[ingest] Input text ${text.length} chars — skipping single-pass, going straight to multi-phase.`);
    singlePassFailed = true;
  }

  if (!singlePassFailed) try {
    progress(15, 'AI is analyzing the document…');
    const raw = (await generateText(
      schema,
      buildPrompt(today, index, existingFiles, originalName, text, false, isOverwrite),
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
          buildPrompt(today, index, existingFiles, originalName, text, true, isOverwrite),
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
    result = await ingestMultiPhase(schema, today, index, existingFiles, originalName, text, isOverwrite, progress);
  }

  // Write all wiki pages
  progress(90, `Writing ${result.pages.length} wiki pages to disk…`);
  for (const page of result.pages) {
    await writePage(domain, page.path, page.content);
  }

  // Post-write: reconcile the summary's "Entities Mentioned" with every entity
  // page actually written this ingest. The LLM reliably under-lists entities in
  // the summary (writes 5–7 while creating 20–30 entity pages), which breaks
  // bidirectional graph connections. syncSummaryEntities() fills the gap
  // automatically and re-fires injectSummaryBacklinks() with the full list.
  progress(93, 'Syncing entity backlinks…');
  const summaryPath = result.pages.find(p => p.path.startsWith('summaries/'))?.path;
  const writtenPaths = result.pages.map(p => p.path);
  if (summaryPath) {
    await syncSummaryEntities(domain, summaryPath, writtenPaths);
  }

  // Write updated index
  progress(96, 'Updating index…');
  await writePage(domain, 'index.md', result.index);

  // Append to log
  const pageList = result.pages.map(p => `  - ${p.path}`).join('\n');
  const logEntry = `## [${today}] ingest | ${result.title}\nPages created or updated:\n${pageList}\n`;
  await appendLog(domain, logEntry);

  progress(100, 'Done!');
  return {
    title: result.title,
    pagesWritten: result.pages.map(p => p.path),
  };
}
