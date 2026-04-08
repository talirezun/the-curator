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

  // ── Attempt 1: standard prompt, full 65 536 token ceiling ─────────────────
  // 65 536 is gemini-2.5-flash-lite's actual output token maximum.
  // Previous limit was 32 768 which caused truncation on documents > ~130k chars.
  let raw;
  let result;

  raw = (await generateText(schema, buildPrompt(today, index, originalName, text, false, isOverwrite), 65536, 'json')).trim();

  try {
    result = parseJSON(raw);
  } catch (firstErr) {
    // ── Attempt 2: stricter brevity prompt ───────────────────────────────────
    console.warn(`[ingest] First parse failed (${firstErr.message.slice(0, 120)}). Retrying with strict brevity...`);

    raw = (await generateText(schema, buildPrompt(today, index, originalName, text, true, isOverwrite), 65536, 'json')).trim();

    try {
      result = parseJSON(raw);
    } catch (secondErr) {
      throw new Error(
        `Failed to parse LLM response after two attempts.\n` +
        `Attempt 1: ${firstErr.message}\n` +
        `Attempt 2: ${secondErr.message}`
      );
    }
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
