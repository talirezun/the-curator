import { readdir, readFile, writeFile, mkdir, unlink, rm, rename as fsRename } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDomainsDir } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function domainPath(domain) {
  return path.join(getDomainsDir(), domain);
}

export function wikiPath(domain) {
  return path.join(getDomainsDir(), domain, 'wiki');
}

export function rawPath(domain) {
  return path.join(getDomainsDir(), domain, 'raw');
}

export async function listDomains() {
  const entries = await readdir(getDomainsDir(), { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name);
}

export async function readSchema(domain) {
  const schemaFile = path.join(getDomainsDir(), domain, 'CLAUDE.md');
  return readFile(schemaFile, 'utf8');
}

export async function readWikiPages(domain) {
  const wikiDir = wikiPath(domain);
  const pages = [];
  await collectMarkdown(wikiDir, wikiDir, pages);
  return pages;
}

async function collectMarkdown(baseDir, dir, pages) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdown(baseDir, full, pages);
    } else if (entry.name.endsWith('.md')) {
      const content = await readFile(full, 'utf8');
      const relativePath = path.relative(baseDir, full);
      pages.push({ path: relativePath, content });
    }
  }
}

/**
 * Inject YAML frontmatter into every wiki page before writing.
 *
 * Strategy:
 *   - LLM is instructed NOT to produce YAML (--- blocks) — it stays inside
 *     safe markdown territory so nothing can break the JSON response.
 *   - This function extracts any inline Tags:/Type:/Source: fields the LLM
 *     did write, builds a clean YAML block, prepends it, and removes the
 *     now-redundant inline fields from the body.
 *   - If the LLM somehow included a --- block anyway, we leave it as-is.
 */
/** Normalise a single tag to a valid Obsidian tag (no spaces, no special chars). */
function slugTag(t) {
  return t.trim().toLowerCase()
    .replace(/&/g, 'and')           // "r&d" → "rand" → then dedupe dashes → "rand"... actually better: "r-and-d"
    .replace(/\s+/g, '-')           // spaces → hyphens
    .replace(/[^a-z0-9\-_/]/g, '')  // strip anything else (keep / for type/concept)
    .replace(/-{2,}/g, '-')         // collapse double-hyphens
    .replace(/^-|-$/g, '');         // trim leading/trailing hyphens
}

/**
 * Normalise LLM-returned paths to the three canonical folders.
 * Handles cases where the LLM drifts into "people/", "tools/", or drops
 * files in the wiki root instead of a subfolder.
 */
function normalizePath(relativePath) {
  if (relativePath.startsWith('people/'))  return 'entities/' + relativePath.slice(7);
  if (relativePath.startsWith('tools/'))   return 'entities/' + relativePath.slice(6);
  // Root-level .md files (no sub-folder) that aren't index/log → concepts/
  if (!relativePath.includes('/') &&
      relativePath !== 'index.md' &&
      relativePath !== 'log.md') {
    return 'concepts/' + relativePath;
  }
  return relativePath;
}

/** Extract bullet lines (starting with "- ") from a named ## section of a wiki page. */
function extractBulletsFromSection(content, sectionName) {
  const lines = content.split('\n');
  const bullets = [];
  let inSection = false;
  const re = new RegExp(`^##\\s+${sectionName}\\s*$`, 'i');
  for (const line of lines) {
    if (re.test(line))            { inSection = true;  continue; }
    if (inSection && /^##/.test(line)) { inSection = false; }
    if (inSection && line.startsWith('- ')) bullets.push(line);
  }
  return bullets;
}

/** Inject extra bullet lines into a named ## section, skipping duplicates. */
function injectBulletsIntoSection(content, sectionName, extraBullets) {
  if (!extraBullets.length) return content;
  const re = new RegExp(`^##\\s+${sectionName}\\s*$`, 'i');
  const lines = content.split('\n');

  // Collect bullets already present so we don't duplicate
  const seen = new Set();
  let inSection = false;
  for (const line of lines) {
    if (re.test(line))                 { inSection = true;  continue; }
    if (inSection && /^##/.test(line)) { inSection = false; }
    if (inSection && line.startsWith('- ')) seen.add(line.toLowerCase().trim());
  }
  const newBullets = extraBullets.filter(b => !seen.has(b.toLowerCase().trim()));
  if (!newBullets.length) return content;

  // Re-scan and inject at end of section
  const result = [];
  inSection = false;
  let injected = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (re.test(line)) { inSection = true; result.push(line); continue; }
    if (inSection && /^##/.test(line) && !injected) {
      result.push(...newBullets);
      injected = true;
      inSection = false;
    }
    result.push(line);
  }
  if (inSection && !injected) result.push(...newBullets); // section was last
  return result.join('\n');
}

/**
 * Merge an existing wiki page with newly-generated content.
 * Strategy:
 *   - Bullet-accumulating sections (Key Facts, Related, etc.): union of bullets.
 *   - Prose sections (Summary, Definition, etc.): use incoming (LLM had full doc context).
 *   - Sections only in existing: preserved via bullet injection logic above.
 */
function mergeWikiPage(existingContent, incomingContent) {
  const ACCUMULATE = [
    'Related',
    'Key Facts', 'Key Ideas', 'Key Points',
    'Key Takeaways',
    'Entities Mentioned',
    'Concepts Introduced or Referenced',
    'Applications', 'Examples',
  ];
  let merged = incomingContent;
  for (const section of ACCUMULATE) {
    const existing = extractBulletsFromSection(existingContent, section);
    if (existing.length) merged = injectBulletsIntoSection(merged, section, existing);
  }
  return merged;
}

function injectFrontmatter(content, relativePath, today) {
  const normed = normalizePath(relativePath);
  const type = normed.startsWith('summaries/') ? 'summary'
             : normed.startsWith('concepts/')  ? 'concept'
             : normed.startsWith('entities/')  ? 'entity'
             : null;

  if (!type) return content;  // index.md, log.md — skip

  // If YAML already present (e.g. user ingesting a pre-formatted .md file),
  // sanitize the tags line in place and return — don't rebuild the whole block.
  if (content.trimStart().startsWith('---')) {
    return content.replace(/^(tags:\s*\[)(.+?)(\])/m, (_, open, inner, close) => {
      const fixed = inner.split(',').map(slugTag).filter(Boolean).join(', ');
      return open + fixed + close;
    });
  }

  // Extract inline Tags: field → YAML tags array
  const tagsMatch = content.match(/^Tags:\s*(.+)$/m);
  const existing = tagsMatch
    ? tagsMatch[1].split(',').map(slugTag).filter(Boolean)
    : [];

  // Extract inline Source: and Date Ingested: for summary pages
  const sourceMatch = content.match(/^Source:\s*(.+)$/m);
  const dateMatch   = content.match(/^Date Ingested:\s*(.+)$/m);

  // Merge extracted tags with the mandatory type tag, deduplicate
  const tags = [...new Set([...existing, `type/${type}`])];

  // Build YAML block
  const yamlLines = ['---', `type: ${type}`];
  if (type === 'summary' && sourceMatch) {
    // Sanitise value: strip surrounding quotes the LLM may have added
    const src = sourceMatch[1].trim().replace(/^["']|["']$/g, '');
    yamlLines.push(`source: ${src}`);
  }
  if (type === 'summary' && dateMatch) yamlLines.push(`date: ${dateMatch[1].trim()}`);
  yamlLines.push(`tags: [${tags.join(', ')}]`, `created: ${today}`, '---', '');

  // Strip the now-redundant inline fields from the body
  let body = content
    .replace(/^Tags:\s*.+\n?/m, '')
    .replace(/^Type:\s*.+\n?/m, '')
    .replace(/^Source:\s*.+\n?/m, '')
    .replace(/^Date Ingested:\s*.+\n?/m, '')
    .trimStart();                        // remove any leading blank lines left behind

  return yamlLines.join('\n') + body;
}

export async function writePage(domain, relativePath, content) {
  const today = new Date().toISOString().slice(0, 10);
  // Redirect mis-filed paths to canonical folders
  const canonPath = normalizePath(relativePath);
  const processed = injectFrontmatter(content, canonPath, today);
  const fullPath = path.join(wikiPath(domain), canonPath);
  const dir = path.dirname(fullPath);
  await mkdir(dir, { recursive: true });

  // Merge with existing content instead of overwriting — this makes the
  // wiki grow: bullet-list sections (Key Facts, Related, etc.) accumulate
  // knowledge across multiple ingests of different source documents.
  let final = processed;
  const skipMerge = canonPath === 'index.md' || canonPath === 'log.md';
  if (!skipMerge && existsSync(fullPath)) {
    try {
      const existing = await readFile(fullPath, 'utf8');
      final = mergeWikiPage(existing, processed);
    } catch {
      // If merge fails, fall back to plain write — better than crashing
    }
  }

  await writeFile(fullPath, final, 'utf8');
}

export async function appendLog(domain, entry) {
  const logFile = path.join(wikiPath(domain), 'log.md');
  const existing = await readFile(logFile, 'utf8');
  await writeFile(logFile, existing + entry + '\n', 'utf8');
}

export async function readIndex(domain) {
  const indexFile = path.join(wikiPath(domain), 'index.md');
  if (!existsSync(indexFile)) return '';
  return readFile(indexFile, 'utf8');
}

export async function writeIndex(domain, content) {
  const indexFile = path.join(wikiPath(domain), 'index.md');
  await writeFile(indexFile, content, 'utf8');
}

// ── Conversations ─────────────────────────────────────────────────────────────

export function conversationsPath(domain) {
  return path.join(getDomainsDir(), domain, 'conversations');
}

export async function listConversations(domain) {
  const dir = conversationsPath(domain);
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  const convs = [];
  for (const f of entries.filter(f => f.endsWith('.json'))) {
    try {
      const raw = await readFile(path.join(dir, f), 'utf8');
      const conv = JSON.parse(raw);
      convs.push({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        messageCount: conv.messages.length,
      });
    } catch { /* skip malformed files */ }
  }
  return convs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function readConversation(domain, id) {
  const file = path.join(conversationsPath(domain), `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeConversation(domain, conversation) {
  const dir = conversationsPath(domain);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${conversation.id}.json`),
    JSON.stringify(conversation, null, 2),
    'utf8'
  );
}

export async function deleteConversation(domain, id) {
  const file = path.join(conversationsPath(domain), `${id}.json`);
  if (existsSync(file)) await unlink(file);
}

// ── Domain Management ─────────────────────────────────────────────────────────

function generateClaudemd(slug, displayName, description, template) {
  const today = new Date().toISOString().slice(0, 10);

  const templateConfig = {
    tech: {
      scope: description || 'Artificial intelligence, machine learning, software engineering, developer tools, programming languages, research papers, open-source projects, and the people and companies behind them.',
      entityTypes: 'person | tool | company | dataset',
      entitiesDesc: 'One page per notable person, tool, framework, company, or dataset (e.g., `entities/andrej-karpathy.md`, `entities/langchain.md`).',
      entityKeyField: 'Key Facts',
      conceptMiddle: `## How It Works
Explanation with examples.

## Applications
- Use case 1
- Use case 2`,
      ingestEntity: 'Create or update entity pages for every person, tool, company, or dataset mentioned.',
      ingestConcept: 'Create or update concept pages for every key idea or technique.',
    },
    business: {
      scope: description || 'Startups, venture capital, investing, markets, macroeconomics, business strategy, company analysis, financial instruments, and the people and organizations shaping the business world.',
      entityTypes: 'person | company | fund | institution',
      entitiesDesc: 'One page per notable person, company, fund, or institution (e.g., `entities/sam-altman.md`, `entities/sequoia.md`).',
      entityKeyField: 'Key Facts',
      conceptMiddle: `## Why It Matters
Business significance and applications.

## Examples
- Example 1
- Example 2`,
      ingestEntity: 'Create or update entity pages for every person, company, fund, or institution mentioned.',
      ingestConcept: 'Create or update concept pages for every key business idea or financial concept.',
    },
    personal: {
      scope: description || 'Self-improvement, mental models, habits, learning techniques, decision-making, books, psychology, philosophy, productivity systems, and the thinkers behind them.',
      entityTypes: 'person | book | framework',
      entitiesDesc: 'One page per notable person, book, or framework (e.g., `entities/james-clear.md`, `entities/atomic-habits.md`).',
      entityKeyField: 'Key Ideas',
      conceptMiddle: `## Why It Matters
How this applies to personal growth.

## How to Apply It
Practical steps or examples.`,
      ingestEntity: 'Create or update entity pages for every person, book, or notable framework mentioned.',
      ingestConcept: 'Create or update concept pages for every key idea, mental model, or principle.',
    },
    generic: {
      scope: description || 'A focused knowledge domain for collecting, connecting, and querying information on this topic.',
      entityTypes: 'person | item | organization',
      entitiesDesc: 'One page per notable person, item, tool, or organization related to this domain.',
      entityKeyField: 'Key Points',
      conceptMiddle: `## Overview
Detailed explanation with context.

## Examples
- Example 1
- Example 2`,
      ingestEntity: 'Create or update entity pages for every person, item, or organization mentioned.',
      ingestConcept: 'Create or update concept pages for every key idea, framework, or technique.',
    },
  };

  const cfg = templateConfig[template] || templateConfig.generic;

  return `# Domain: ${displayName}

This is a dedicated knowledge curator for ${displayName.toLowerCase()} topics.

## Scope
${cfg.scope}

## Wiki Conventions

### Page Types
- **entities/** — ${cfg.entitiesDesc}
- **concepts/** — One page per idea, technique, or framework concept.
- **summaries/** — One page per ingested source (e.g., \`summaries/article-title.md\`).

### Page Format

Every wiki page (entity, concept, summary) MUST begin with a YAML frontmatter block.
The \`tags\` array MUST include the type tag (\`type/entity\`, \`type/concept\`, or \`type/summary\`).

**Entity page:**
\`\`\`
---
type: entity
tags: [tag1, tag2, type/entity]
created: YYYY-MM-DD
---
# [Entity Name]

## Summary
One-paragraph description.

## ${cfg.entityKeyField}
- Bullet facts

## Related
- [[concept-name]] — why related
- [[other-entity]] — why related
\`\`\`

**Concept page:**
\`\`\`
---
type: concept
tags: [tag1, tag2, type/concept]
created: YYYY-MM-DD
---
# [Concept Name]

## Definition
Clear, concise definition.

${cfg.conceptMiddle}

## Related
- [[entity-or-concept]] — why related
\`\`\`

**Summary page:**
\`\`\`
---
type: summary
source: [filename or description]
date: YYYY-MM-DD
tags: [tag1, tag2, type/summary]
created: YYYY-MM-DD
---
# [Source Title]

## Key Takeaways
- Bullet list of main points

## Concepts Introduced or Referenced
- [[concept-name]]

## Entities Mentioned
- [[entity-name]]

## Notes
Any additional commentary.
\`\`\`

## Cross-Referencing Rules
- Always use \`[[page-name]]\` syntax for internal links — NEVER include folder prefixes (e.g., write \`[[rag]]\` not \`[[concepts/rag]]\`).
- When you create or update a summary, update the corresponding entity and concept pages to reference it.
- Every entity or concept mentioned in a source gets either a new page or an update to an existing page.

## index.md Format
\`\`\`
# Wiki Index — ${displayName}
Last updated: [YYYY-MM-DD]

| Page | Type | Summary |
|------|------|---------|
| [[page-name]] | concept/entity/summary | One-line description |
\`\`\`

## log.md Format
Append one entry per ingest:
\`\`\`
## [YYYY-MM-DD] ingest | [Source Title]
Pages created or updated: list them
\`\`\`

## Instructions for the AI
When ingesting a source:
1. Write a summary page under \`summaries/\`.
2. ${cfg.ingestEntity}
3. ${cfg.ingestConcept}
4. Add cross-references between all related pages.
5. Return the full list of pages to create/update as JSON.

When answering a query:
- Cite specific pages using \`[source: path/to/page.md]\`.
- Synthesize across multiple pages rather than quoting verbatim.
`;
}

async function generateUniqueSlug(displayName, excludeSlug = null) {
  let base = displayName
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, '-and-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Truncate at 32 chars on a word boundary
  if (base.length > 32) {
    base = base.slice(0, 32).replace(/-[^-]*$/, '') || base.slice(0, 32).replace(/[^a-z0-9]/g, '');
  }

  if (!base) throw new Error('Could not generate a valid folder name from that display name');

  // Collision detection
  const candidate = async (slug) => {
    if (slug === excludeSlug) return slug; // renaming to same — caller handles this
    if (!existsSync(domainPath(slug))) return slug;
    return null;
  };

  const first = await candidate(base);
  if (first !== null) return first;

  for (let i = 2; i <= 9; i++) {
    const s = `${base.slice(0, 30)}-${i}`;
    const r = await candidate(s);
    if (r !== null) return r;
  }

  throw new Error('A domain with a very similar name already exists. Choose a more distinct name.');
}

export async function createDomain(slug, displayName, description, template) {
  // Security guard
  if (!slug || slug.includes('..') || slug.includes('/') || slug.includes('\\') || slug.startsWith('.')) {
    throw new Error('Invalid domain name');
  }

  if (existsSync(domainPath(slug))) {
    throw new Error('Domain already exists');
  }

  const base = domainPath(slug);
  try {
    await mkdir(path.join(base, 'raw'), { recursive: true });
    await mkdir(path.join(base, 'wiki', 'entities'), { recursive: true });
    await mkdir(path.join(base, 'wiki', 'concepts'), { recursive: true });
    await mkdir(path.join(base, 'wiki', 'summaries'), { recursive: true });
    await mkdir(path.join(base, 'conversations'), { recursive: true });

    const today = new Date().toISOString().slice(0, 10);

    await writeFile(
      path.join(base, 'wiki', 'index.md'),
      `# Wiki Index — ${displayName}\nLast updated: ${today}\n\n| Page | Type | Summary |\n|------|------|---------|`,
      'utf8'
    );
    await writeFile(
      path.join(base, 'wiki', 'log.md'),
      `# Ingest Log — ${displayName}\n`,
      'utf8'
    );
    await writeFile(
      path.join(base, 'CLAUDE.md'),
      generateClaudemd(slug, displayName, description, template),
      'utf8'
    );
  } catch (err) {
    // Clean up partial directory
    try { await rm(base, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

export async function deleteDomain(slug) {
  if (!slug || slug.includes('..') || slug.includes('/') || slug.includes('\\') || slug.startsWith('.')) {
    throw new Error('Invalid domain name');
  }
  if (!existsSync(domainPath(slug))) {
    throw new Error('Domain not found');
  }
  await rm(domainPath(slug), { recursive: true, force: true });
}

export async function renameDomain(oldSlug, newSlug, newDisplayName) {
  for (const s of [oldSlug, newSlug]) {
    if (!s || s.includes('..') || s.includes('/') || s.includes('\\') || s.startsWith('.')) {
      throw new Error('Invalid domain name');
    }
  }
  if (!existsSync(domainPath(oldSlug))) throw new Error('Domain not found');
  if (oldSlug !== newSlug && existsSync(domainPath(newSlug))) throw new Error('A domain with that name already exists');

  if (oldSlug !== newSlug) {
    await fsRename(domainPath(oldSlug), domainPath(newSlug));
  }

  // Update conversation domain fields
  const convDir = path.join(domainPath(newSlug), 'conversations');
  try {
    const files = await readdir(convDir);
    await Promise.all(
      files.filter(f => f.endsWith('.json')).map(async f => {
        const fullPath = path.join(convDir, f);
        try {
          const conv = JSON.parse(await readFile(fullPath, 'utf8'));
          conv.domain = newSlug;
          await writeFile(fullPath, JSON.stringify(conv, null, 2), 'utf8');
        } catch {}
      })
    );
  } catch {}

  // Update display name in CLAUDE.md
  const claudePath = path.join(domainPath(newSlug), 'CLAUDE.md');
  try {
    const content = await readFile(claudePath, 'utf8');
    const updated = content.replace(/^# Domain: .+$/m, `# Domain: ${newDisplayName}`);
    await writeFile(claudePath, updated, 'utf8');
  } catch {}

  // Update wiki/index.md header
  const indexPath = path.join(domainPath(newSlug), 'wiki', 'index.md');
  try {
    const content = await readFile(indexPath, 'utf8');
    const updated = content.replace(/^# Wiki Index — .+$/m, `# Wiki Index — ${newDisplayName}`);
    await writeFile(indexPath, updated, 'utf8');
  } catch {}

  // Update wiki/log.md header
  const logPath = path.join(domainPath(newSlug), 'wiki', 'log.md');
  try {
    const content = await readFile(logPath, 'utf8');
    const updated = content.replace(/^# Ingest Log — .+$/m, `# Ingest Log — ${newDisplayName}`);
    await writeFile(logPath, updated, 'utf8');
  } catch {}
}

export async function getDomainStats(slug) {
  const base = domainPath(slug);

  const [displayName, pageCount, conversationCount, lastIngestDate] = await Promise.all([
    // Display name from CLAUDE.md first line
    readFile(path.join(base, 'CLAUDE.md'), 'utf8')
      .then(content => {
        const firstLine = content.split('\n')[0];
        return firstLine.replace(/^# Domain:\s*/, '').trim() || slug;
      })
      .catch(() => slug),

    // Page count: recursive .md files in wiki/ excluding index.md and log.md
    (async () => {
      let count = 0;
      async function countMd(dir) {
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await countMd(full);
            else if (e.name.endsWith('.md') && e.name !== 'index.md' && e.name !== 'log.md') count++;
          }
        } catch {}
      }
      await countMd(path.join(base, 'wiki'));
      return count;
    })(),

    // Conversation count
    readdir(path.join(base, 'conversations'))
      .then(files => files.filter(f => f.endsWith('.json')).length)
      .catch(() => 0),

    // Last ingest date from log.md
    readFile(path.join(base, 'wiki', 'log.md'), 'utf8')
      .then(content => {
        const match = content.match(/^## \[(\d{4}-\d{2}-\d{2})\]/m);
        return match ? match[1] : null;
      })
      .catch(() => null),
  ]);

  return { slug, displayName, pageCount, conversationCount, lastIngestDate };
}

export { generateUniqueSlug };
