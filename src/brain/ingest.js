import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
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
 * Handles two failure modes:
 *   1. Model wrapped JSON in markdown fences  → strip and retry
 *   2. Truncated / malformed JSON             → throw with context
 */
function parseJSON(raw) {
  // Fast path
  try { return JSON.parse(raw); } catch { /* fall through */ }

  // Strip markdown fences (```json ... ```)
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
  }

  // Find the outermost { ... } block
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch { /* fall through */ }
  }

  throw new Error(
    `Could not parse JSON response. Response length: ${raw.length} chars. ` +
    `Last 200 chars: ${raw.slice(-200)}`
  );
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
- Use [[page-name]] syntax for cross-references to other wiki pages.
- Single-word tags only.

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
Each entry: one line with path and a short description.
Return ONLY the raw markdown text for index.md (no JSON, no fences).`;
}

// ── Single-pass prompt (small documents) ─────────────────────────────────────

function buildPrompt(today, index, originalName, text, strict, isOverwrite = false) {
  const conciseness = strict
    ? 'CRITICAL: Maximum 3 bullet points per page. No prose. Single-word tags only. The shorter the better.'
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

async function ingestMultiPhase(schema, today, index, originalName, text, isOverwrite) {
  // Phase 1: outline
  console.log('[ingest] Large document — using multi-phase ingest. Phase 1: outline...');
  const outlineRaw = (await generateText(
    schema,
    buildOutlinePrompt(today, index, originalName, text, isOverwrite),
    16384,   // increased from 4096 — large docs can have 30+ pages in the outline
    'json'
  )).trim();

  const outline = parseJSON(outlineRaw);
  const allPages = outline.pages; // [{path, summary}]
  console.log(`[ingest] Phase 1 complete — ${allPages.length} pages planned.`);

  // Phase 2: batched content
  const writtenPages = []; // [{path, content}]

  for (let i = 0; i < allPages.length; i += BATCH_SIZE) {
    const batch = allPages.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allPages.length / BATCH_SIZE);
    console.log(`[ingest] Phase 2 — batch ${batchNum}/${totalBatches} (${batch.length} pages)...`);

    const batchRaw = (await generateText(
      schema,
      buildBatchPrompt(today, originalName, text, batch),
      32768,   // increased from 16384 — each batch can contain rich content
      'json'
    )).trim();

    const batchResult = parseJSON(batchRaw);
    writtenPages.push(...batchResult.pages);
  }

  // Phase 3: index
  console.log('[ingest] Phase 3: updating index...');
  const newIndex = (await generateText(
    schema,
    buildIndexPrompt(index, allPages),
    4096,
    'text'
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

export async function ingestFile(domain, filePath, originalName, isOverwrite = false) {
  // Save to raw/
  const rawDir = rawPath(domain);
  await mkdir(rawDir, { recursive: true });
  const destPath = path.join(rawDir, originalName);
  const buffer = await readFile(filePath);
  await writeFile(destPath, buffer);

  // Extract text — cap at 80 000 chars to stay within input limits
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
    const raw = (await generateText(
      schema,
      buildPrompt(today, index, originalName, text, false, isOverwrite),
      65536,
      'json'
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

        const raw2 = (await generateText(
          schema,
          buildPrompt(today, index, originalName, text, true, isOverwrite),
          65536,
          'json'
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
    result = await ingestMultiPhase(schema, today, index, originalName, text, isOverwrite);
  }

  // Write all wiki pages
  for (const page of result.pages) {
    await writePage(domain, page.path, page.content);
  }

  // Write updated index
  await writePage(domain, 'index.md', result.index);

  // Append to log
  const pageList = result.pages.map(p => `  - ${p.path}`).join('\n');
  const logEntry = `## [${today}] ingest | ${result.title}\nPages created or updated:\n${pageList}\n`;
  await appendLog(domain, logEntry);

  return {
    title: result.title,
    pagesWritten: result.pages.map(p => p.path),
  };
}
