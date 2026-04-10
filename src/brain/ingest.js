import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { jsonrepair } from 'jsonrepair';
import { generateText } from './llm.js';
import {
  readSchema,
  readIndex,
  rawPath,
  writePage,
  appendLog,
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
    throw new Error(
      `Could not parse JSON response. Response length: ${raw.length} chars. ` +
      `Last 200 chars: ${raw.slice(-200)}`
    );
  }
}

// ── Phase 1: outline ──────────────────────────────────────────────────────────

function buildOutlinePrompt(today, index, originalName, text, isOverwrite) {
  const overwriteNote = isOverwrite
    ? 'NOTE: This document has been ingested before. Update existing pages rather than duplicating content.'
    : '';

  return `Today's date: ${today}
${overwriteNote ? '\n' + overwriteNote : ''}
Current wiki index:
${index || '(empty — this is the first ingest)'}

--- SOURCE DOCUMENT: ${originalName} ---
${text}
--- END SOURCE DOCUMENT ---

Your task: Plan which wiki pages to create or update for this source.
Produce ONLY a JSON outline — do NOT write any page content yet.

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

function buildBatchPrompt(today, originalName, text, pageBatch) {
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
- YAML frontmatter: start every page with a --- block containing type, tags (array), and created (today's date).
  - entities/ pages:  type: entity,  tags must include type/entity
  - concepts/ pages:  type: concept, tags must include type/concept
  - summaries/ pages: type: summary, tags must include type/summary, also add source and date fields
- Do NOT use inline "Type:" or "Tags:" fields in the body — put them in the YAML only.
- Links: always use [[page-name]] — NEVER include folder prefix (write [[rag]] not [[concepts/rag]]).

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

function buildPrompt(today, index, originalName, text, strict, isOverwrite = false) {
  const conciseness = strict
    ? 'CRITICAL: Maximum 3 bullet points per page. No prose. The shorter the better.'
    : 'Keep each page concise — 3 to 8 bullet points or sentences max. No long prose.';

  const overwriteNote = isOverwrite
    ? 'NOTE: This document has been ingested before. Update any existing wiki pages with new or changed information rather than duplicating content. Merge carefully.'
    : '';

  return `Today's date: ${today}
${overwriteNote ? '\n' + overwriteNote : ''}
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

YAML frontmatter rules (apply to every entity, concept, and summary page):
- Start every page with a --- block. Example for a concept:
  ---
  type: concept
  tags: [machine-learning, nlp, type/concept]
  created: ${today}
  ---
- entities/ → type: entity,  tags include type/entity
- concepts/ → type: concept, tags include type/concept
- summaries/ → type: summary, tags include type/summary; also add source and date fields
- Do NOT use inline "Type:" or "Tags:" lines in the body — YAML only.
- index.md has NO frontmatter.

Link rules:
- Always write [[page-name]] — NEVER use folder prefix (write [[rag]] not [[concepts/rag]]).
- In index.md table, use [[page-name]] (no folder prefix, no duplicates).

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

const BATCH_SIZE = 10;

async function ingestMultiPhase(schema, today, index, originalName, text, isOverwrite, progress) {
  // Phase 1: outline
  console.log('[ingest] Large document — using multi-phase ingest. Phase 1: outline...');
  progress(12, 'Phase 1: planning wiki structure…');
  const outlineRaw = (await generateText(
    schema,
    buildOutlinePrompt(today, index, originalName, text, isOverwrite),
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
      buildBatchPrompt(today, originalName, text, batch),
      32768,
      'json',
      (msg) => progress(batchPct, msg, 'wait')
    )).trim();

    const batchResult = parseJSON(batchRaw);
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

// If the single-pass response is longer than this, assume multi-phase is needed.
// 200 000 chars ≈ 50k tokens — safely below the 65 536 ceiling.
const SINGLE_PASS_CHAR_LIMIT = 200_000;

// Skip single-pass entirely for large input documents.
// At 40 000+ chars of source text the response routinely approaches the output
// token ceiling and gets truncated mid-JSON — wasting two API calls before the
// fallback triggers. Going straight to multi-phase is faster and more reliable.
const MULTI_PHASE_INPUT_THRESHOLD = 40_000;

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
      buildPrompt(today, index, originalName, text, false, isOverwrite),
      65536,
      'json',
      (msg) => progress(15, msg, 'wait')
    )).trim();

    if (raw.length > SINGLE_PASS_CHAR_LIMIT) {
      console.warn(
        `[ingest] Single-pass response too large (${raw.length} chars). ` +
        `Switching to multi-phase ingest...`
      );
      singlePassFailed = true;
    } else {
      try {
        result = parseJSON(raw);
      } catch (firstErr) {
        // Retry with stricter brevity
        console.warn(`[ingest] First parse failed (${firstErr.message.slice(0, 120)}). Retrying with strict brevity...`);
        progress(15, 'Retrying with brevity constraints…');

        const raw2 = (await generateText(
          schema,
          buildPrompt(today, index, originalName, text, true, isOverwrite),
          65536,
          'json',
          (msg) => progress(15, msg, 'wait')
        )).trim();

        if (raw2.length > SINGLE_PASS_CHAR_LIMIT) {
          console.warn(`[ingest] Strict retry also too large (${raw2.length} chars). Switching to multi-phase...`);
          singlePassFailed = true;
        } else {
          try {
            result = parseJSON(raw2);
          } catch (secondErr) {
            console.warn(`[ingest] Both single-pass attempts failed. Switching to multi-phase...`);
            singlePassFailed = true;
          }
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
    result = await ingestMultiPhase(schema, today, index, originalName, text, isOverwrite, progress);
  }

  // Write all wiki pages
  progress(90, `Writing ${result.pages.length} wiki pages to disk…`);
  for (const page of result.pages) {
    await writePage(domain, page.path, page.content);
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
