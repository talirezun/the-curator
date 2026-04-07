import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import {
  readSchema,
  readIndex,
  rawPath,
  writePage,
  appendLog,
} from './files.js';

const client = new Anthropic();

async function extractText(filePath, mimeType) {
  if (mimeType === 'application/pdf' || filePath.endsWith('.pdf')) {
    // Dynamic import to avoid issues if pdf-parse has side effects
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const buffer = await readFile(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  }
  return readFile(filePath, 'utf8');
}

export async function ingestFile(domain, filePath, originalName) {
  // Save to raw/
  const rawDir = rawPath(domain);
  await mkdir(rawDir, { recursive: true });
  const destPath = path.join(rawDir, originalName);
  const buffer = await readFile(filePath);
  await writeFile(destPath, buffer);

  // Extract text
  const text = await extractText(destPath, '');

  // Load schema and current index
  const schema = await readSchema(domain);
  const index = await readIndex(domain);

  const today = new Date().toISOString().slice(0, 10);

  const userPrompt = `Today's date: ${today}

Current wiki index:
${index || '(empty — this is the first ingest)'}

--- SOURCE DOCUMENT: ${originalName} ---
${text.slice(0, 80000)}
--- END SOURCE DOCUMENT ---

Your task:
1. Write a summary page for this source.
2. Create or update entity pages for every person, tool, company, framework, or dataset mentioned.
3. Create or update concept pages for every key idea or technique.
4. Add cross-references between related pages using [[page-name]] syntax.
5. Produce an updated index.md that includes all existing pages plus any new ones.

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

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: schema,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content[0].text.trim();

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    // Try to extract JSON if Claude wrapped it in fences
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Claude did not return valid JSON');
    result = JSON.parse(match[0]);
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
