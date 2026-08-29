import { readdir, readFile, writeFile, mkdir, unlink, rm, rename as fsRename, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDomainsDir } from './config.js';
import { writeFileAtomic } from './atomic-write.js';

// v3.0.1-beta.8: every wiki write goes through writeFileAtomic so a
// process-kill mid-write (e.g. /api/restart killing the old process while
// an ingest is mid-flight) leaves either the old file or the new file
// intact — never a truncated zero-byte file. See src/brain/atomic-write.js
// for the rationale and the same-directory-tempfile invariant.

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
  const base = getDomainsDir();
  const entries = await readdir(base, { withFileTypes: true });
  const candidates = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name);

  // A directory is only a "domain" if it has a CLAUDE.md schema. This protects
  // against ghost directories left behind after a sync deletion (git doesn't
  // track empty dirs, so `domains/<name>/wiki/` can stay on disk after the
  // remote deleted everything inside it).
  const real = [];
  for (const name of candidates) {
    const schemaPath = path.join(base, name, 'CLAUDE.md');
    try {
      const s = await stat(schemaPath);
      if (s.isFile()) real.push(name);
    } catch { /* no schema → not a real domain */ }
  }
  return real;
}

/**
 * Refuse a domain name that is not one of the real domains on disk.
 *
 * ── THIS IS AN ALLOW-LIST, AND IT IS THE ONLY CONTAINMENT CHECK ─────────────
 * `listDomains()` is the single authority on what a domain IS (a directory
 * under the domains root carrying a CLAUDE.md schema). Membership in its
 * result is therefore a stricter guarantee than any path-shape test could
 * give: `..%2fsomething`, an absolute path, a symlinked directory and a
 * ghost folder left by a sync deletion are all simply absent from the list.
 *
 * Deliberately NOT a second `resolveInside`-style check. Two hand-maintained
 * copies of a containment guard is what produced the v3.2.0 CRITICAL, so this
 * function exists so that the routes which need one can SHARE it rather than
 * each writing four lines of `listDomains().includes(...)` that can drift.
 *
 * `err.status = 404` because "no such domain" is a missing resource, matching
 * what routes/wiki.js, routes/domains.js and routes/memory.js already return.
 * The name is echoed back the way every one of those routes echoes it; it
 * reaches the client only inside a JSON string.
 */
export async function assertKnownDomain(domain) {
  const domains = await listDomains();
  if (!domains.includes(domain)) {
    const err = new Error(`Unknown domain: ${domain}`);
    err.status = 404;
    err.code = 'UNKNOWN_DOMAIN';
    throw err;
  }
}

/**
 * Returns true if the domain's CLAUDE.md declares `readonly: true` in its
 * YAML frontmatter. Used by Phase 4 MCP write tools (and the in-app Compile
 * + Health write paths) to refuse direct writes to Shared Brain mirror
 * domains (Decision 7 — docs/shared-brain-design.md).
 *
 * Returns false for:
 *   - personal domains (no readonly flag)
 *   - missing CLAUDE.md
 *   - empty / unparseable frontmatter
 *   - frontmatter where readonly is not strictly === true
 *
 * Deliberately conservative: any uncertainty defaults to "writable" so we
 * never block a legitimate write because of a parse glitch. Combined with
 * the readonly write being enforced by the MCP tools, this means a user
 * with a corrupted CLAUDE.md still has functional writes — at worst, the
 * readonly intent is temporarily lost until they fix the file.
 *
 * Tiny regex-based frontmatter parser — no YAML library dependency. We only
 * need to check a single boolean field, not parse arbitrary YAML.
 *
 * @param {string} domain  domain slug
 * @returns {Promise<boolean>}
 */
export async function isDomainReadonly(domain) {
  if (typeof domain !== 'string' || !domain) return false;
  const claudeMdPath = path.join(domainPath(domain), 'CLAUDE.md');
  let content;
  try {
    content = await readFile(claudeMdPath, 'utf8');
  } catch {
    return false; // no CLAUDE.md → not a domain we recognise → don't block
  }
  // Match opening "---\n", then capture everything up to the closing "\n---\n" or "\n---" at EOF.
  // Anchored at very start of file (no leading whitespace allowed in YAML frontmatter).
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!fmMatch) return false;
  const fmBody = fmMatch[1];
  // Look for "readonly: true" — tolerant of indentation, quotes, and case.
  // Reject any value that's not literal true (so "readonly: false", "readonly: yes",
  // "readonly: 1", etc. don't accidentally enable readonly mode).
  const readonlyMatch = fmBody.match(/^[ \t]*readonly[ \t]*:[ \t]*(.+?)[ \t]*(#.*)?$/mi);
  if (!readonlyMatch) return false;
  const value = readonlyMatch[1].trim().toLowerCase();
  // Strip optional quotes
  const unquoted = value.replace(/^["']|["']$/g, '');
  return unquoted === 'true';
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
 * Any folder the LLM invents (people/, tools/, models/, companies/, etc.)
 * is redirected to entities/ since invented categories are almost always
 * entity-like. Root-level .md files (no subfolder) go to concepts/.
 */
const CANONICAL = new Set(['entities', 'concepts', 'summaries']);

function normalizePath(relativePath) {
  // Special-case the two app-managed root files — they are NOT pages and
  // must never be redirected into entities/ or concepts/. Without this guard
  // the second branch below treats their basename as an unknown folder and
  // returns 'entities/' (no filename), which the basename-guard in writePage
  // then rejects. Latent bug pre-v2.5.2 — fixed when MCP write tools landed
  // because the in-app pipeline used writeIndex() directly and silently lost
  // the LLM's index updates without anyone noticing.
  if (relativePath === 'index.md' || relativePath === 'log.md') {
    return relativePath;
  }
  // Root-level files (no slash) → concepts/
  if (!relativePath.includes('/')) {
    return 'concepts/' + relativePath;
  }
  // If the first path segment is not one of the three canonical folders → entities/
  const folder = relativePath.split('/')[0];
  if (!CANONICAL.has(folder)) {
    return 'entities/' + relativePath.slice(folder.length + 1);
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
    if (re.test(line))                 { inSection = true;  continue; }
    if (inSection && /^##/.test(line)) { inSection = false; }
    if (inSection && line.startsWith('- ')) bullets.push(line);
  }
  return bullets;
}

/**
 * Normalise a bullet line for deduplication.
 * For Related-style bullets that contain [[link]] targets, compare by link
 * target only — so "- [[foo]] — description A" and "- [[foo]] — description B"
 * are treated as duplicates and only one is kept.
 */
function dedupKey(line) {
  const linkMatch = line.match(/\[\[([^\]]+)\]\]/);
  if (linkMatch) return linkMatch[1].toLowerCase().trim();
  return line.toLowerCase().trim();
}

/** Inject extra bullet lines into a named ## section, skipping duplicates. */
function injectBulletsIntoSection(content, sectionName, extraBullets) {
  if (!extraBullets.length) return content;
  const re = new RegExp(`^##\\s+${sectionName}\\s*$`, 'i');
  const lines = content.split('\n');

  // Collect dedup keys for bullets already present
  const seen = new Set();
  let inSection = false;
  for (const line of lines) {
    if (re.test(line))                 { inSection = true;  continue; }
    if (inSection && /^##/.test(line)) { inSection = false; }
    if (inSection && line.startsWith('- ')) seen.add(dedupKey(line));
  }
  const newBullets = extraBullets.filter(b => !seen.has(dedupKey(b)));
  if (!newBullets.length) return content;

  // If section doesn't exist at all, append it so backlinks are never silently dropped.
  // Use the 'm' (multiline) flag so ^ and $ match line boundaries in the full content.
  const sectionExistsRe = new RegExp('^##\\s+' + sectionName + '\\s*$', 'im');
  if (!sectionExistsRe.test(content)) {
    return content.trimEnd() + `\n\n## ${sectionName}\n` + newBullets.join('\n') + '\n';
  }

  // Re-scan and inject at end of section, before any trailing blank lines
  const result = [];
  inSection = false;
  let injected = false;
  let pendingBlanks = []; // hold blank lines so bullets land before them

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (re.test(line)) { inSection = true; result.push(line); continue; }

    if (inSection) {
      if (line.trim() === '') {
        pendingBlanks.push(line); // defer — inject bullets before blank lines
        continue;
      }
      if (/^##/.test(line) && !injected) {
        // Flush: bullets first, then the deferred blanks, then the new heading
        result.push(...newBullets);
        result.push(...pendingBlanks);
        injected = true;
        inSection = false;
        pendingBlanks = [];
      } else {
        // Non-blank, non-heading content — flush deferred blanks normally
        result.push(...pendingBlanks);
        pendingBlanks = [];
      }
    }

    result.push(line);
  }

  // Section was the last section — flush any deferred blanks then inject
  if (inSection && !injected) {
    result.push(...newBullets);
    result.push(...pendingBlanks);
  } else if (pendingBlanks.length) {
    result.push(...pendingBlanks);
  }

  return result.join('\n');
}

/**
 * Merge an existing wiki page with newly-generated content.
 * Strategy:
 *   - Bullet-accumulating sections (Key Facts, Related, etc.): union of bullets.
 *   - Prose sections (Summary, Definition, etc.): use incoming (LLM had full doc context).
 *   - Sections only in existing: preserved via bullet injection logic above.
 */
/**
 * Remove duplicate bullets from all accumulating sections.
 * Safety net: catches any case where the dedup logic in injectBulletsIntoSection
 * is bypassed (e.g. multi-phase ingest returning the same page in multiple batches,
 * causing writePage() to write the file twice with partially overlapping content).
 * Keyed on the same dedupKey() as the injection logic — link target for Related-
 * style bullets, full text otherwise.
 */
/**
 * Parse all `## Section` headings in a markdown document and collect the
 * bullet lines under each. Returns a Map of section-name → array of bullet
 * lines (trimmed). Used by diffBulletSections() to compute change records.
 */
function parseAllBulletSections(content) {
  const sections = new Map();
  const lines = content.split('\n');
  let currentSection = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      currentSection = heading[1].trim();
      if (!sections.has(currentSection)) sections.set(currentSection, []);
      continue;
    }
    if (currentSection && /^\s*[-*]\s/.test(line)) {
      sections.get(currentSection).push(line.trim());
    }
  }
  return sections;
}

/**
 * Compare bullet sections between existing and final content.
 * Returns the section names whose bullet count grew, and the total bullet delta.
 * Bullet-count growth is a hint, not a deep diff — sufficient for the v2.5.0
 * "what changed" panel; a re-ordering or one-for-one swap won't be flagged
 * (status='updated' + bytesBefore≠bytesAfter still accurately signals change).
 */
function diffBulletSections(existing, final) {
  const existingSections = parseAllBulletSections(existing);
  const finalSections = parseAllBulletSections(final);
  const sectionsChanged = [];
  let bulletsAdded = 0;
  const allNames = new Set([...existingSections.keys(), ...finalSections.keys()]);
  for (const name of allNames) {
    const before = existingSections.get(name) || [];
    const after = finalSections.get(name) || [];
    if (after.length > before.length) {
      sectionsChanged.push(name);
      bulletsAdded += (after.length - before.length);
    }
  }
  return { sectionsChanged, bulletsAdded };
}

function deduplicateBulletSections(content) {
  const ACCUMULATE = new Set([
    'Key Facts', 'Key Ideas', 'Key Points', 'Related',
    'Key Takeaways', 'Entities Mentioned',
    'Concepts Introduced or Referenced', 'Applications', 'Examples',
  ]);
  const lines = content.split('\n');
  const result = [];
  let inSection = false;
  let seenInSection = new Set();

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch && headingMatch[1] === '##') {
      inSection = ACCUMULATE.has(headingMatch[2].trim());
      seenInSection = new Set();
      result.push(line);
      continue;
    }
    if (inSection && line.startsWith('- ')) {
      const key = dedupKey(line);
      if (seenInSection.has(key)) continue; // drop duplicate bullet
      seenInSection.add(key);
    }
    result.push(line);
  }

  return result.join('\n');
}

/**
 * Remove blank lines that appear inside bullet-list sections.
 * The LLM sometimes emits two groups of bullets separated by a blank line;
 * this causes the merge logic to place injected bullets after the gap.
 * Running this after every write keeps sections clean unconditionally.
 */
function stripBlanksInBulletSections(content) {
  const ACCUMULATE = new Set([
    'Key Facts', 'Key Ideas', 'Key Points', 'Related',
    'Key Takeaways', 'Entities Mentioned',
    'Concepts Introduced or Referenced', 'Applications', 'Examples',
  ]);
  const lines = content.split('\n');
  const result = [];
  let inSection = false;
  let pendingBlanks = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch && headingMatch[1] === '##') {
      if (inSection && pendingBlanks.length) {
        // Flush trailing blanks before next heading (keep one for spacing)
        result.push('');
        pendingBlanks = [];
      }
      inSection = ACCUMULATE.has(headingMatch[2].trim());
      result.push(line);
      continue;
    }

    if (inSection) {
      if (line.trim() === '') {
        pendingBlanks.push(line);
        continue;
      }
      if (line.startsWith('- ')) {
        // Drop blanks that appeared between bullets — they're LLM artifacts
        pendingBlanks = [];
      } else {
        result.push(...pendingBlanks);
        pendingBlanks = [];
      }
    }

    result.push(line);
  }

  result.push(...pendingBlanks);
  return result.join('\n');
}

/**
 * After a summary page is written, inject [[summaries/slug]] backlinks into
 * every entity page listed under "Entities Mentioned" in that summary.
 *
 * This creates bidirectional graph connections in Obsidian automatically —
 * every entity knows which summaries reference it, not just the other way around.
 * Safe to call on re-ingest: dedupKey() prevents duplicate backlinks.
 */
/**
 * After writing all pages for an ingest, reconcile the summary's
 * "Entities Mentioned" section with every entity page that was actually
 * written during the ingest.
 *
 * WHY THIS EXISTS:
 * The LLM consistently produces a truncated "Entities Mentioned" list —
 * it might list 5–7 entities while the ingest actually writes 20–30 entity
 * pages. This means most entity pages never receive a [[summaries/...]]
 * backlink unless we repair this. This function closes that gap automatically
 * after every ingest, for any domain and any text type.
 *
 * WHAT IT DOES:
 * 1. Derives entity slugs from the written entity file paths
 * 2. Reads the summary file
 * 3. Injects any missing entity slugs as [[slug]] bullets under
 *    "Entities Mentioned" (using existing dedup logic — safe to call twice)
 * 4. Writes the updated summary back to disk
 * 5. Re-runs injectSummaryBacklinks() so every entity page gets the
 *    [[summaries/slug]] backlink it was missing
 *
 * @param {string} domain          - domain slug (e.g. "articles")
 * @param {string} summaryPath     - relative path (e.g. "summaries/foo.md")
 * @param {string[]} writtenPaths  - all paths returned by writePage() for this ingest
 */
export async function syncSummaryEntities(domain, summaryPath, writtenPaths) {
  const wikiDir = wikiPath(domain);
  const summaryFile = path.join(wikiDir, summaryPath);

  let summaryContent;
  try {
    summaryContent = await readFile(summaryFile, 'utf8');
  } catch {
    console.warn(`[syncSummaryEntities] Could not read summary: ${summaryPath}`);
    return;
  }

  // Build [[slug]] bullets from every entity AND concept path written this ingest.
  // Include concepts because the LLM sometimes misclassifies entities as concepts —
  // those pages still need to appear in "Entities Mentioned" and receive backlinks.
  const entityBullets = writtenPaths
    .filter(p => p.startsWith('entities/') || p.startsWith('concepts/'))
    .map(p => `- [[${path.basename(p, '.md')}]]`);

  if (!entityBullets.length) return;

  // Ensure the summary has an "Entities Mentioned" section to inject into.
  // If it's missing entirely (fully truncated summary), add it before Notes or at end.
  if (!/^## Entities Mentioned\s*$/m.test(summaryContent)) {
    console.warn(`[syncSummaryEntities] Summary has no "Entities Mentioned" section — adding it.`);
    // Insert before ## Notes if present, otherwise append
    if (/^## Notes\s*$/m.test(summaryContent)) {
      summaryContent = summaryContent.replace(/^## Notes\s*$/m, '## Entities Mentioned\n\n## Notes');
    } else {
      summaryContent = summaryContent.trimEnd() + '\n\n## Entities Mentioned\n';
    }
  }

  // Inject missing entity bullets (dedup logic inside injectBulletsIntoSection)
  const updated = injectBulletsIntoSection(summaryContent, 'Entities Mentioned', entityBullets);
  const stripped = stripBlanksInBulletSections(updated);
  const cleaned = deduplicateBulletSections(stripped);

  await writeFileAtomic(summaryFile, cleaned, 'utf8');

  // Now re-run backlink injection with the complete Entities Mentioned list
  const summarySlug = path.basename(summaryPath, '.md');
  await injectSummaryBacklinks(summarySlug, cleaned, wikiDir);

  const injected = entityBullets.length;
  // IMPORTANT: every diagnostic in this module MUST use console.error (stderr).
  // src/brain/files.js is imported directly by the MCP server (mcp/server.js)
  // which uses stdout exclusively for JSON-RPC. Any console.log here would
  // poison the JSON-RPC stream and break Claude Desktop with "Unexpected
  // token" parse errors. See v2.5.2 release notes.
  console.error(`[syncSummaryEntities] Synced ${injected} entity slugs into ${summaryPath} and propagated backlinks.`);
}

export async function injectSummaryBacklinks(summarySlug, summaryContent, wikiDir) {
  // Extract the summary title from the # heading for use in the backlink description
  const titleMatch = summaryContent.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : summarySlug;

  const entityBullets = extractBulletsFromSection(summaryContent, 'Entities Mentioned');
  if (!entityBullets.length) {
    // Summary is missing its Entities Mentioned section — the LLM produced a
    // truncated page. Log a warning so the issue is visible in the server console.
    console.warn(
      `[injectSummaryBacklinks] WARNING: summaries/${summarySlug}.md has no ` +
      `"Entities Mentioned" section — no entity backlinks were injected. ` +
      `Consider re-ingesting the source or adding the section manually.`
    );
    return;
  }

  for (const bullet of entityBullets) {
    const linkMatch = bullet.match(/\[\[([^\]]+)\]\]/);
    if (!linkMatch) continue;
    let entityName = linkMatch[1].trim();

    // Strip folder prefix if the LLM included it (e.g. "entities/tali-rezun" → "tali-rezun")
    if (entityName.includes('/')) entityName = entityName.split('/').pop();

    // Pass A: strip title prefix (dr-, mr-, prof-, etc.)
    const stripped = entityName.replace(TITLE_PREFIX_RE, '');
    if (stripped !== entityName) {
      const canonFile = path.join(wikiDir, 'entities', `${stripped}.md`);
      if (existsSync(canonFile)) entityName = stripped;
    }

    // Pass B: resolve to the target file. Order:
    //   1. Exact match in entities/
    //   2. Exact match in concepts/    (matches the scan's resolution order)
    //   3. Hyphen-normalised match in entities/
    //   4. Hyphen-normalised match in concepts/
    //
    // The exact-match passes MUST come before hyphen-normalised fallbacks.
    // Without this, when both `concepts/email.md` and `concepts/e-mail.md` exist,
    // an `[[email]]` bullet would fuzzy-match `e-mail.md` (first alphabetical
    // hyphen-variant) and the backlink would silently land in the wrong file.
    let entityFile = null;
    const exactEntity  = path.join(wikiDir, 'entities', `${entityName}.md`);
    const exactConcept = path.join(wikiDir, 'concepts', `${entityName}.md`);
    if      (existsSync(exactEntity))  entityFile = exactEntity;
    else if (existsSync(exactConcept)) entityFile = exactConcept;
    else {
      const norm = entityName.replace(/-/g, '').toLowerCase();
      try {
        const existing = await readdir(path.join(wikiDir, 'entities'));
        const match = existing.find(f =>
          f.endsWith('.md') && f.replace(/-/g, '').toLowerCase() === norm + '.md'
        );
        if (match) entityFile = path.join(wikiDir, 'entities', match);
      } catch { /* dir may not exist */ }
      if (!entityFile) {
        try {
          const conceptFiles = await readdir(path.join(wikiDir, 'concepts'));
          const match = conceptFiles.find(f =>
            f.endsWith('.md') && f.replace(/-/g, '').toLowerCase() === norm + '.md'
          );
          if (match) entityFile = path.join(wikiDir, 'concepts', match);
        } catch { /* dir may not exist */ }
      }
      if (!entityFile) continue;
    }

    try {
      let entityContent = await readFile(entityFile, 'utf8');
      const backlink = `- [[summaries/${summarySlug}]] — ${title}`;
      entityContent = injectBulletsIntoSection(entityContent, 'Related', [backlink]);
      entityContent = stripBlanksInBulletSections(entityContent);
      await writeFileAtomic(entityFile, entityContent, 'utf8');
    } catch (err) {
      console.warn(`[injectSummaryBacklinks] Failed to update ${entityName}: ${err.message}`);
    }
  }
}

/**
 * Inject a single backlink into a specific entity/concept page's Related section.
 *
 * Unlike `injectSummaryBacklinks`, this function does NOT re-resolve slug names;
 * it trusts the caller's resolved `entityFilePath`. This matters for the Wiki
 * Health "Fix" action, where the scan has already resolved which file is missing
 * a backlink — re-resolving from the summary could hit hyphen-variant files
 * (e.g. writing to `concepts/e-mail.md` when the scan pointed at `concepts/email.md`).
 *
 * Returns true if the file was modified, false if the backlink already existed.
 */
export async function injectSingleBacklink(entityFilePath, summarySlug, summaryTitle) {
  if (!existsSync(entityFilePath)) return false;
  const backlink = `- [[summaries/${summarySlug}]] — ${summaryTitle}`;
  let content = await readFile(entityFilePath, 'utf8');
  const before = content;
  content = injectBulletsIntoSection(content, 'Related', [backlink]);
  content = stripBlanksInBulletSections(content);
  if (content === before) return false;
  await writeFileAtomic(entityFilePath, content, 'utf8');
  return true;
}

/**
 * Inject a generic wikilink bullet into a target file's "Related" section.
 *
 * Used by v2.4.4+ AI orphan rescue: adds `- [[linkSlug]] — description` to
 * the target's Related section, dedup-safe against existing bullets via the
 * existing `injectBulletsIntoSection` machinery.
 *
 * Unlike `injectSingleBacklink`, this helper does NOT enforce the
 * "summaries/" folder prefix — callers pass whatever slug syntax they need
 * (bare `rag`, folder-qualified `summaries/foo`, etc.). The link-target
 * dedup key comparison already handles both cases.
 *
 * @param {string} targetFilePath — absolute path to the target .md file
 * @param {string} linkSlug       — the slug inside `[[ ]]` (bare or folder-qualified)
 * @param {string} description    — prose after the em-dash
 * @returns {Promise<boolean>}    — true if the file changed
 */
export async function injectRelatedLink(targetFilePath, linkSlug, description) {
  if (!existsSync(targetFilePath)) return false;
  const cleanDesc = String(description || '').replace(/\s+/g, ' ').trim();
  const bullet = cleanDesc
    ? `- [[${linkSlug}]] — ${cleanDesc}`
    : `- [[${linkSlug}]]`;
  let content = await readFile(targetFilePath, 'utf8');
  const before = content;
  content = injectBulletsIntoSection(content, 'Related', [bullet]);
  content = stripBlanksInBulletSections(content);
  if (content === before) return false;
  await writeFileAtomic(targetFilePath, content, 'utf8');
  return true;
}

/**
 * Parse a markdown body into a Map of `## Heading` → full block text
 * (the heading line plus every line until the next `#`/`##` heading or EOF).
 * Frontmatter and the top-level `# Title` are ignored — we only key on
 * level-2 section headings, which is the convention for the wiki body.
 * Used by mergeWikiPage to detect prose sections the incoming page dropped.
 */
function extractSectionMap(content) {
  const lines = content.split('\n');
  const map = new Map();
  let currentName = null;
  let buffer = [];
  // Keys are lowercased so a heading that differs only in case between the
  // existing and incoming page (the LLM is not case-stable across ingests —
  // "## Definition" vs "## definition") is treated as the SAME section. Without
  // this, the prose-preservation pass would append the existing section as a
  // duplicate, and an ACCUMULATE section could be both bullet-injected AND
  // appended (double content). The bullet helpers already match case-insensitively
  // via the 'i' regex flag — this keeps the section logic consistent (audit fix).
  const flush = () => {
    if (currentName !== null) map.set(currentName.toLowerCase(), buffer.join('\n').replace(/\s+$/, ''));
  };
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const h1 = /^#\s+/.test(line);
    if (h2) {
      flush();
      currentName = h2[1].trim();
      buffer = [line];
    } else if (h1) {
      // A level-1 heading ends the current level-2 section without starting one.
      flush();
      currentName = null;
      buffer = [];
    } else if (currentName !== null) {
      buffer.push(line);
    }
  }
  flush();
  return map;
}

export function mergeWikiPage(existingContent, incomingContent) {
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

  // Prose-section preservation (v3.0.1-beta.15).
  //
  // The incoming page is the base, so any PROSE section (Definition, Summary,
  // Why It Matters, Overview, etc.) the incoming page omits would be lost —
  // exactly what happened when a minimal Compile/Curate edit shipped a thin
  // version of an existing rich page. We only preserve sections the incoming
  // page DROPPED ENTIRELY; if the incoming page includes the heading (even a
  // rewrite), the incoming version still wins — that keeps ingest's
  // "full-document-context rewrite" behaviour intact. Bullet-accumulating
  // sections are handled above (and re-created by injectBulletsIntoSection when
  // missing), so they are skipped here.
  // Lowercased accumulate names so the case-insensitive section keys match.
  const accumulateSet = new Set(ACCUMULATE.map(s => s.toLowerCase()));
  const existingSections = extractSectionMap(existingContent);
  const incomingSections = extractSectionMap(merged);
  const preserved = [];
  for (const [name, block] of existingSections) {
    if (accumulateSet.has(name)) continue;       // bullets handled separately
    if (incomingSections.has(name)) continue;    // incoming has it — incoming wins
    if (!block || !block.trim()) continue;       // nothing worth preserving
    preserved.push(block);
  }
  if (preserved.length) {
    merged = merged.replace(/\s+$/, '') + '\n\n' + preserved.join('\n\n') + '\n';
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

  // If YAML already present (e.g. user ingesting a pre-formatted .md file, or
  // the LLM mirroring the source's frontmatter), sanitize the tags line in
  // place AND ensure the required type/<type> tag is present. Pre-v3.0.1-
  // beta.9 this fast path only sanitised existing tags — if the existing
  // frontmatter had no `tags:` line or its tags didn't include `type/<type>`,
  // the resulting wiki page lacked the type tag entirely, breaking the
  // Obsidian graph-color contract (entities blue, concepts green, summaries
  // purple). Surfaced by the deep-test harness on a real ingest where the
  // source MD had its own frontmatter but no type/summary in tags.
  const typeTag = `type/${type}`;
  if (content.trimStart().startsWith('---')) {
    // Match the existing frontmatter block — we'll either patch the tags
    // line in place or inject a new one before the closing `---`.
    const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
    if (!fmMatch) {
      // Defensive: looks like FM but doesn't parse — fall through to rebuild
    } else {
      const [, opening, body, closing] = fmMatch;
      const tagsLineRe = /^(tags:\s*\[)(.*?)(\])/m;
      const tagsMatch = body.match(tagsLineRe);
      let patchedBody;
      if (tagsMatch) {
        // Tags line exists — sanitize + ensure typeTag present
        const inner = tagsMatch[2];
        const fixed = [...new Set(inner.split(',').map(slugTag).filter(Boolean))];
        if (!fixed.includes(typeTag)) fixed.push(typeTag);
        patchedBody = body.replace(tagsLineRe, (_, open, _inner, close) => open + fixed.join(', ') + close);
      } else {
        // No tags line — inject one with at least the type tag
        patchedBody = body + (body.endsWith('\n') ? '' : '\n') + `tags: [${typeTag}]`;
      }
      return opening + patchedBody + closing + content.slice(fmMatch[0].length);
    }
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

// Title prefixes the LLM adds that shouldn't create separate entity files
// Honorific / title prefixes the LLM sometimes attaches to entity slugs.
// Allows an OPTIONAL period after the honorific because the LLM occasionally
// preserves the dot from "Dr." when slugifying — producing "dr.-tali-rezun"
// instead of "dr-tali-rezun". Without the optional `\.?`, Pass A failed to
// strip the prefix and the canonical-slug dedup didn't fire, leaving two
// entity files on disk for the same person (v3.0.1-beta.2 fix).
const TITLE_PREFIX_RE = /^(dr|mr|ms|mrs|prof|professor|the)\.?-/;

/**
 * True when a page path can never be a legitimate wiki page: a NUL byte, a
 * Windows separator, an absolute path, or any `..` segment. Applied to both the
 * raw LLM-supplied path and the normalised one (v3.0.16).
 */
function isUnsafePagePath(p) {
  if (typeof p !== 'string') return true;
  return p.includes('\0') || p.includes('\\') || path.isAbsolute(p) || p.split('/').includes('..');
}

export async function writePage(domain, relativePath, content, opts = {}) {
  // opts.onWarn (v3.0.16): optional callback(message) so a REFUSED or
  // auto-corrected page becomes visible to the user instead of dying in a
  // console line nobody reads. Contract mirrors the v3.0.4 adapter onWarn
  // rule — a throwing callback must never break the write. Diagnostics go to
  // stderr because this module is imported by the MCP child process (v2.5.2).
  const warn = (msg) => {
    console.warn(`[writePage] ${msg}`);
    if (typeof opts.onWarn === 'function') {
      try { opts.onWarn(msg); } catch { /* observability must not break a write */ }
    }
  };

  // Defensive: callers rely on writePage returning null for unusable input.
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    warn('Refused a page with a missing or non-string path — nothing was written.');
    return null;
  }

  // opts.replace (v3.0.3+): skip the union merge with the existing file —
  // the incoming content IS the page (replace semantics). Used by Shared
  // Brain mirror pulls so facts deleted from the collective (conflict
  // resolution, GDPR revocation) actually disappear locally instead of
  // being resurrected by the ACCUMULATE-section merge. Every other stage
  // (path normalisation, dedup passes, frontmatter, link normalisation,
  // backlinks) runs unchanged, so this stays the single write path.
  const today = new Date().toISOString().slice(0, 10);

  // 1. Redirect mis-filed paths to canonical folders
  let canonPath = normalizePath(relativePath);

  // 1a. Containment guard. This MUST run before ANY basename rewriting.
  //     Pre-v3.0.16 the blanket "basename must end in .md" rule was doing
  //     double duty as an accidental traversal defence — "../../etc/passwd"
  //     has no .md basename, so it was refused. Appending .md without an
  //     explicit check would have converted that accident into a real escape
  //     (`entities/../../etc/passwd.md` resolves outside the wiki folder).
  //
  //     Checked on BOTH the raw input and the normalised path: normalizePath
  //     rewrites an absolute path into `entities/<rest>` (contained, but a
  //     silent relocation of something that is unambiguously malformed), so an
  //     `isAbsolute` test on canonPath alone would never fire.
  if (isUnsafePagePath(relativePath) || isUnsafePagePath(canonPath)) {
    warn(`Refused an unsafe page path "${relativePath}" — it is not a valid wiki page path. Nothing was written.`);
    return null;
  }

  // 1b. A path that names a folder but no file (e.g. "entities/") is
  //     unusable — writing it would either crash with EISDIR or, once the
  //     extension is appended below, create a bogus "entities.md" at the root.
  if (canonPath.endsWith('/')) {
    warn(`Refused page path "${relativePath}" — it names a folder, not a page. Its content was not written; re-ingest to recover it.`);
    return null;
  }

  // 1c. Normalise underscores → hyphens in the filename portion.
  //     The LLM sometimes mirrors the original PDF filename (e.g. two_worlds_of_code.pdf
  //     → two_worlds_of_code.md). Wiki convention is lowercase-hyphenated slugs.
  {
    const dir = path.dirname(canonPath);
    const base = path.basename(canonPath).replace(/_/g, '-');
    canonPath = dir === '.' ? base : `${dir}/${base}`;
  }

  // 2. Missing (or wrong-cased) .md extension → APPEND it and write the page.
  //     v3.0.16: the model occasionally returns "concepts/concurrency-control"
  //     with no extension. That page was planned, its content was generated
  //     and paid for, and writePage then discarded it with a console line and
  //     nothing in warnings[] — the user had no way to know. This is the same
  //     class of normalisation normalizePath already performs for underscores
  //     and non-canonical folders, so it belongs here rather than in a caller.
  {
    const dir = path.dirname(canonPath);
    let base = path.basename(canonPath);
    if (!/\.md$/i.test(base)) {
      base += '.md';
      warn(`Page path "${relativePath}" was missing the .md extension — wrote it as "${dir === '.' ? base : `${dir}/${base}`}".`);
    } else if (!base.endsWith('.md')) {
      base = base.slice(0, -3) + '.md';       // ".MD" → ".md"
    }
    canonPath = dir === '.' ? base : `${dir}/${base}`;
  }

  // 2a. FLATTEN nested paths to the wiki's one-folder-deep invariant.
  //
  //     The whole app assumes exactly `<canonical-folder>/<slug>.md`. EVERY
  //     consumer is non-recursive: ingest's existing-files scan and all three
  //     of health.js's scans use a flat `readdir` filtered on `.md`. So a page
  //     written at `entities/companies/openai.md` is real on disk and gets an
  //     index row, but is invisible to the existing-files inventory (the model
  //     re-invents it on the next ingest), invisible to the Health scanner, and
  //     every inbound [[openai]] link is reported BROKEN even though the file
  //     exists — while Obsidian, which resolves by basename, shows it as fine.
  //     The app and the vault end up disagreeing about reality.
  //
  //     FLATTEN rather than refuse, for three reasons: (1) it preserves content
  //     the user paid for, which is the whole point of the v3.0.16 writePage
  //     work — refusing would reintroduce the silent-discard failure mode at a
  //     different address; (2) `<folder>/<basename>` is exactly where the page
  //     belongs, so it becomes visible to every consumer; (3) it is the same
  //     move normalizePath already makes for invented folders (`people/` →
  //     `entities/`), so this is one rule applied consistently rather than a new
  //     policy. A collision with an existing page merges via mergeWikiPage,
  //     which is the desired outcome, not a duplicate.
  //
  //     Partly pre-existing — `entities/companies/openai.md` was already
  //     accepted — but 2 above widened it to the extension-less form, so it is
  //     fixed here rather than left for the next reader to trip over.
  {
    const segments = canonPath.split('/');
    if (segments.length > 2) {
      const flattened = `${segments[0]}/${segments[segments.length - 1]}`;
      warn(`Page path "${relativePath}" was nested more than one folder deep — wrote it as "${flattened}". The wiki is flat: pages live directly in entities/, concepts/ or summaries/.`);
      canonPath = flattened;
    }
  }

  // 2b. Final guard: a leading dot means a hidden file, not a page — covers a
  //     bare ".md" and the "..md" that a path of "." would otherwise produce.
  const basename = path.basename(canonPath);
  if (!basename || basename.startsWith('.')) {
    warn(`Refused page path "${relativePath}" — it has no usable filename. Its content was not written; re-ingest to recover it.`);
    return null;
  }

  // 3. For entity paths, apply two deduplication passes so the LLM never
  //    creates a variant file when a canonical one already exists.
  //
  //    Pass A — title prefix stripping: "dr-tali-rezun.md" → "tali-rezun.md"
  //    Pass B — hyphen-normalised slug match: "talirezun.md" → "tali-rezun.md"
  //             Strips all hyphens from both the incoming slug and every existing
  //             entity filename; if they match, redirect to the existing file.
  //             This handles any author/entity whose name the LLM hyphenates
  //             differently on different ingests — not just tali-rezun.
  if (canonPath.startsWith('entities/')) {
    const entitiesDir = path.join(wikiPath(domain), 'entities');
    let filename = canonPath.slice('entities/'.length);

    // Pass A: strip title prefix
    const stripped = filename.replace(TITLE_PREFIX_RE, '');
    if (stripped !== filename) {
      const canonFile = path.join(entitiesDir, stripped);
      if (existsSync(canonFile)) { filename = stripped; canonPath = 'entities/' + stripped; }
    }

    // Pass B: hyphen-normalised match against all existing entity files
    const incomingNorm = filename.replace(/-/g, '').toLowerCase();
    try {
      const existing = await readdir(entitiesDir);
      const match = existing.find(f =>
        f.endsWith('.md') && f.replace(/-/g, '').toLowerCase() === incomingNorm
      );
      if (match && match !== filename) {
        canonPath = 'entities/' + match;
      }
    } catch { /* entities dir may not exist yet on first ingest */ }
  }

  // 3b. Cross-folder dedup — prevent concepts/google.md when entities/google.md
  //     already exists (or vice versa). The LLM sometimes misclassifies entities
  //     as concepts; first-write wins so the existing file's folder is canonical.
  if (canonPath.startsWith('entities/') || canonPath.startsWith('concepts/')) {
    const folder = canonPath.split('/')[0];
    const filename = path.basename(canonPath);
    const siblingFolder = folder === 'entities' ? 'concepts' : 'entities';
    const siblingDir = path.join(wikiPath(domain), siblingFolder);
    const norm = filename.replace(/-/g, '').toLowerCase();
    try {
      const siblingFiles = await readdir(siblingDir);
      const match = siblingFiles.find(f =>
        f.endsWith('.md') && f.replace(/-/g, '').toLowerCase() === norm
      );
      if (match) {
        console.error(`[writePage] Cross-folder dedup: ${canonPath} → ${siblingFolder}/${match}`);
        canonPath = `${siblingFolder}/${match}`;
      }
    } catch { /* sibling dir may not exist yet */ }
  }

  const processed = injectFrontmatter(content, canonPath, today);
  const fullPath = path.join(wikiPath(domain), canonPath);
  const dir = path.dirname(fullPath);
  await mkdir(dir, { recursive: true });

  // Capture pre-write state once — used both by the merge step below and by
  // the change-record computation after the write.
  const existedBefore = existsSync(fullPath);
  let existingContent = '';
  if (existedBefore) {
    try { existingContent = await readFile(fullPath, 'utf8'); }
    catch { /* unreadable; treat as if it didn't exist */ }
  }

  // 4. Merge with existing content instead of overwriting — bullet-list
  //    sections (Key Facts, Related, etc.) accumulate across ingests.
  let final = processed;
  const skipMerge = canonPath === 'index.md' || canonPath === 'log.md';
  if (!skipMerge && existedBefore && !opts.replace) {
    try {
      final = mergeWikiPage(existingContent, processed);
    } catch {
      // If merge fails, fall back to plain write — better than crashing
    }
  }

  // 5. Strip blank lines that appear inside bullet sections — the LLM sometimes
  //    emits two groups of bullets separated by a blank line. Remove those gaps
  //    so sections stay clean on both first-write and merge paths.
  if (!skipMerge) final = stripBlanksInBulletSections(final);

  // 5a. Remove duplicate bullets from all accumulating sections. Safety net for
  //     cases where the same page is written more than once in a multi-phase
  //     ingest (the LLM returns a page in multiple batches), causing mergeWikiPage
  //     to produce duplicate bullets before the regular dedup can catch them.
  if (!skipMerge) final = deduplicateBulletSections(final);

  // 5b. Strip folder prefixes from [[wiki-links]] — the LLM sometimes writes
  //     [[concepts/rag]], [[entities/tali-rezun]], or [[summaries/foo]] instead
  //     of [[rag]], [[tali-rezun]], [[summaries/foo]].
  //     Exception: [[summaries/...]] links are intentionally kept as-is because
  //     they live in a separate folder and need the prefix for Obsidian routing.
  if (!skipMerge) {
    final = final.replace(/\[\[(entities|concepts)\/([^\]]+)\]\]/g, '[[$2]]');
  }

  // 5b2. Strip trailing `.md` from wikilinks — the LLM sometimes writes
  //      `[[summaries/foo.md]]` or `[[llama-3.1.md]]` instead of
  //      `[[summaries/foo]]` / `[[llama-3.1]]`. Wikilink syntax never includes
  //      the file extension; Obsidian (and our own page-exists check) treats
  //      the literal `.md` as part of the target slug, making the link broken.
  //      v3.0.1-beta.8+ deep-test surfaced this as ~15-20% of broken-link
  //      reports on real LLM output. The prompt asks the model to omit the
  //      extension, but compliance is imperfect — strip programmatically.
  //
  //      Preserves `|alias` text: `[[foo.md|FooLabel]]` → `[[foo|FooLabel]]`.
  if (!skipMerge) {
    final = final.replace(/\[\[([^\]|#\n]+?)\.md(\|[^\]]+)?\]\]/g, '[[$1$2]]');
  }

  // 5c. Normalize [[variant-slug]] links to canonical wiki slugs.
  //     Pass A: title-prefix strip (dr-, mr-, prof-, etc.)
  //     Pass B: hyphen-normalised match against entities and concepts
  //     Pass C: prefix-tolerant match across ALL wiki files (entities, concepts, summaries)
  //             Strips common article prefixes (the-, a-, an-) for comparison,
  //             catching [[energy-and-water-footprint-of-generative-ai]] →
  //             [[summaries/the-energy-and-water-footprint-of-generative-ai]].
  if (!skipMerge) {
    const wiki = wikiPath(domain);

    // Load slugs from all three canonical folders
    let entityFiles = [], conceptFiles = [], summaryFiles = [];
    try { entityFiles = (await readdir(path.join(wiki, 'entities'))).filter(f => f.endsWith('.md')); } catch {}
    try { conceptFiles = (await readdir(path.join(wiki, 'concepts'))).filter(f => f.endsWith('.md')); } catch {}
    try { summaryFiles = (await readdir(path.join(wiki, 'summaries'))).filter(f => f.endsWith('.md')); } catch {}

    const entitySlugs = new Set(entityFiles.map(f => f.slice(0, -3)));
    const conceptSlugs = new Set(conceptFiles.map(f => f.slice(0, -3)));

    // Build a prefix-tolerant lookup Map for Pass C: key → { folder, slug }
    // Keys are hyphen-stripped AND article-prefix-stripped for maximum match coverage
    const ARTICLE_PREFIX_RE = /^(the|a|an)-/;
    const allSlugsMap = new Map();
    for (const f of entityFiles) {
      const s = f.slice(0, -3);
      const key = s.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
      if (!allSlugsMap.has(key)) allSlugsMap.set(key, { folder: null, slug: s }); // bare link
    }
    for (const f of conceptFiles) {
      const s = f.slice(0, -3);
      const key = s.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
      if (!allSlugsMap.has(key)) allSlugsMap.set(key, { folder: null, slug: s }); // bare link
    }
    for (const f of summaryFiles) {
      const s = f.slice(0, -3);
      const key = s.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
      if (!allSlugsMap.has(key)) allSlugsMap.set(key, { folder: 'summaries', slug: s }); // prefixed link
    }

    final = final.replace(/\[\[([^\]|#\n]+?)(\|[^\]]+)?\]\]/g, (match, slug, alias) => {
      // Never touch summaries/ prefixed links or any link containing a sub-path
      if (slug.includes('/')) return match;
      // Already a known canonical entity or concept slug — nothing to do
      if (entitySlugs.has(slug) || conceptSlugs.has(slug)) return match;

      // Pass A: strip title prefix (dr-, mr-, prof-, etc.)
      const stripped = slug.replace(TITLE_PREFIX_RE, '');
      if (stripped !== slug && (entitySlugs.has(stripped) || conceptSlugs.has(stripped))) {
        return `[[${stripped}${alias || ''}]]`;
      }

      // Pass B: hyphen-normalised match against entities and concepts
      const norm = slug.replace(/-/g, '').toLowerCase();
      for (const s of entitySlugs) {
        if (s.replace(/-/g, '').toLowerCase() === norm) return `[[${s}${alias || ''}]]`;
      }
      for (const s of conceptSlugs) {
        if (s.replace(/-/g, '').toLowerCase() === norm) return `[[${s}${alias || ''}]]`;
      }

      // Pass C: prefix-tolerant match across all wiki files (incl. summaries)
      const normKey = slug.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
      const hit = allSlugsMap.get(normKey);
      if (hit) {
        const target = hit.folder ? `${hit.folder}/${hit.slug}` : hit.slug;
        return `[[${target}${alias || ''}]]`;
      }

      return match;
    });
  }

  await writeFileAtomic(fullPath, final, 'utf8');

  // 6. For summary pages, inject [[summaries/slug]] backlinks into every
  //    entity listed under "Entities Mentioned" — builds the full bidirectional
  //    graph automatically so Obsidian shows all connections.
  if (canonPath.startsWith('summaries/')) {
    const summarySlug = path.basename(canonPath, '.md');
    await injectSummaryBacklinks(summarySlug, final, wikiPath(domain));
  }

  // Compute change record — what callers (ingest, compile, MCP) report to users.
  // canonPath is the actual path written to disk (may differ from input after
  // redirects by Pass A, Pass B, step 3b, or normalizePath()).
  const bytesBefore = Buffer.byteLength(existingContent, 'utf8');
  const bytesAfter = Buffer.byteLength(final, 'utf8');
  let status;
  if (!existedBefore) status = 'created';
  else if (existingContent === final) status = 'unchanged';
  else status = 'updated';

  const { sectionsChanged, bulletsAdded } = (existedBefore && !skipMerge && status === 'updated')
    ? diffBulletSections(existingContent, final)
    : { sectionsChanged: [], bulletsAdded: 0 };

  return {
    canonPath,
    status,
    bytesBefore,
    bytesAfter,
    sectionsChanged,
    bulletsAdded,
  };
}

export async function appendLog(domain, entry) {
  const logFile = path.join(wikiPath(domain), 'log.md');
  const existing = await readFile(logFile, 'utf8');
  await writeFileAtomic(logFile, existing + entry + '\n', 'utf8');
}

export async function readIndex(domain) {
  const indexFile = path.join(wikiPath(domain), 'index.md');
  if (!existsSync(indexFile)) return '';
  return readFile(indexFile, 'utf8');
}

export async function writeIndex(domain, content) {
  const indexFile = path.join(wikiPath(domain), 'index.md');
  await writeFileAtomic(indexFile, content, 'utf8');
}

// ── Conversations ─────────────────────────────────────────────────────────────

export function conversationsPath(domain) {
  return path.join(getDomainsDir(), domain, 'conversations');
}

// Longest search string this will act on. A query is a substring test run
// once per conversation body, so an unbounded one is a cheap way for a
// scripted client to make the server do real work per request; 200 is far
// past any real search and keeps the cap a fact rather than a guess. Over
// the cap the query is TRUNCATED, never refused: a truncated query still
// returns a superset of what the full one would (a prefix matches at least
// as much), so the failure direction is "too many rows", never a silent
// empty result that reads as "you have no such conversation".
export const CONVERSATION_SEARCH_MAX_CHARS = 200;

/**
 * Does this conversation match a search query, and WHERE?
 *
 * Returns null for no match, otherwise 'title' or 'message'. Title is
 * checked first because it is the cheap case and the one the UI already
 * shows — a conversation whose title matches never needs its bodies read.
 *
 * WHY THE BODIES ARE SCANNED AT ALL. A conversation's title is its first
 * user message truncated at 57 characters (src/brain/chat.js), so before
 * this, everything said after the opening line of a thread was unreachable
 * by search — the longer and more useful the conversation, the smaller the
 * fraction of it that could be found. Bodies are scanned HERE, on the
 * server, rather than shipped to the client, because listConversations
 * already parses every conversation file in its loop: the messages are
 * in memory at this exact moment and scanning them costs no extra I/O,
 * whereas sending them would multiply the sidebar payload by the whole
 * transcript of every thread in the domain.
 *
 * Case-insensitive: `needle` arrives already lowercased (normalised once by
 * the caller rather than per-conversation), and each haystack is lowercased
 * here. Exported for the offline suite.
 */
export function matchConversation(conv, needle) {
  if (!needle) return null;
  if (typeof conv?.title === 'string' && conv.title.toLowerCase().includes(needle)) return 'title';
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  for (const m of messages) {
    if (typeof m?.content === 'string' && m.content.toLowerCase().includes(needle)) return 'message';
  }
  return null;
}

/**
 * List a domain's conversations, newest first.
 *
 * `opts.q` filters them. An absent, non-string, or whitespace-only query is
 * NO FILTER — the full list, byte-identical to the pre-search behaviour —
 * so every existing caller (and the route with no `q` parameter) is on
 * exactly the path it was on before.
 *
 * A filtered row carries `matchField` ('title' | 'message') so the sidebar
 * can say WHY a conversation matched when the reason is not visible in the
 * title it renders. Unfiltered rows carry no such field: there is no match
 * to explain, and adding `matchField: null` to every row would put a value
 * on the wire that means nothing.
 */
export async function listConversations(domain, opts = {}) {
  const dir = conversationsPath(domain);
  // ── A READ PATH CREATES NOTHING ───────────────────────────────────────────
  // This used to be `await mkdir(dir, {recursive: true})`. Cross-origin GETs
  // are exempt from the CSRF guard BY DESIGN (a GET is not the browser-driven
  // mutation vector), so `GET /api/chat/<anything>` was a directory-creation
  // primitive any web page in the user's browser could reach — recursive, so
  // it made every missing parent too. The route now refuses a domain that is
  // not on the allow-list, which closes the reachable half; this closes the
  // shape itself, so no future caller can reintroduce it.
  //
  // ENOENT reads as "no conversations", which is what an empty directory
  // already returned — so the ANSWER is unchanged for every legitimate caller,
  // only the side effect is gone. Any other error (EACCES, ENOTDIR) still
  // throws: "we could not look" must never be served as "there is nothing".
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const rawQuery = typeof opts.q === 'string' ? opts.q : '';
  const needle = rawQuery.slice(0, CONVERSATION_SEARCH_MAX_CHARS).trim().toLowerCase();
  const convs = [];
  for (const f of entries.filter(f => f.endsWith('.json'))) {
    try {
      const raw = await readFile(path.join(dir, f), 'utf8');
      const conv = JSON.parse(raw);
      // messageCount is read BEFORE any filtering decision so the number the
      // sidebar shows is the conversation's real length, never a count of
      // matching messages — those are two different facts and the row label
      // ("12 messages") claims the first one.
      const row = {
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        messageCount: conv.messages.length,
      };
      if (needle) {
        const matchField = matchConversation(conv, needle);
        if (!matchField) continue;
        row.matchField = matchField;
      }
      convs.push(row);
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
  await writeFileAtomic(
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

    await writeFileAtomic(
      path.join(base, 'wiki', 'index.md'),
      `# Wiki Index — ${displayName}\nLast updated: ${today}\n\n| Page | Type | Summary |\n|------|------|---------|`,
      'utf8'
    );
    await writeFileAtomic(
      path.join(base, 'wiki', 'log.md'),
      `# Ingest Log — ${displayName}\n`,
      'utf8'
    );
    await writeFileAtomic(
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
          await writeFileAtomic(fullPath, JSON.stringify(conv, null, 2), 'utf8');
        } catch {}
      })
    );
  } catch {}

  // Update display name in CLAUDE.md
  const claudePath = path.join(domainPath(newSlug), 'CLAUDE.md');
  try {
    const content = await readFile(claudePath, 'utf8');
    const updated = content.replace(/^# Domain: .+$/m, `# Domain: ${newDisplayName}`);
    await writeFileAtomic(claudePath, updated, 'utf8');
  } catch {}

  // Update wiki/index.md header
  const indexPath = path.join(domainPath(newSlug), 'wiki', 'index.md');
  try {
    const content = await readFile(indexPath, 'utf8');
    const updated = content.replace(/^# Wiki Index — .+$/m, `# Wiki Index — ${newDisplayName}`);
    await writeFileAtomic(indexPath, updated, 'utf8');
  } catch {}

  // Update wiki/log.md header
  const logPath = path.join(domainPath(newSlug), 'wiki', 'log.md');
  try {
    const content = await readFile(logPath, 'utf8');
    const updated = content.replace(/^# Ingest Log — .+$/m, `# Ingest Log — ${newDisplayName}`);
    await writeFileAtomic(logPath, updated, 'utf8');
  } catch {}
}

const CANONICAL_PAGE_FOLDERS = ['entities', 'concepts', 'summaries'];

/**
 * Count the pages under a domain's wiki/, broken down by canonical folder.
 *
 * Returns `{entities, concepts, summaries, other}` where a PAGE is a real
 * file at `<entities|concepts|summaries>/<name>.md` — exactly one level
 * deep, which is the only shape writePage can produce (it FLATTENS nested
 * paths, v3.0.16) and the only shape health.js can resolve a link to (its
 * slug sets come from a shallow readdir). `other` is every remaining .md
 * file anywhere under wiki/: a stray note at the wiki root, a nested file,
 * a symlink. index.md and log.md are excluded by name at any depth — they
 * are app-managed, not pages.
 *
 * Why one walk instead of "recursive total + three shallow readdirs"
 * (v3.2.0 audit finding M6): the two were computed by different code with
 * different rules, so the Domains card could contradict itself in a single
 * sentence — "A compounding wiki of 7 pages — 2 entities, 1 concept, 1
 * summary". `pageCount` recursed over the whole tree; the per-type counts
 * were three shallow readdirs with no isFile() check. Anything the two
 * disagreed about (a nested file, a directory literally named `x.md`, or —
 * the common one — the `Untitled.md` Obsidian drops at the vault root,
 * which the setup docs tell users to point AT the wiki dir) showed up as an
 * unexplained gap. Deriving all four numbers from ONE traversal with ONE
 * rule makes disagreement impossible by construction, and `other` keeps the
 * remainder visible instead of hiding it:
 *
 *     entities + concepts + summaries + other === pageCount
 *                                            === every `.md` file on disk
 *                                                under wiki/, except
 *                                                index.md and log.md.
 *
 * `.md` is matched case-sensitively here, exactly as health.js's `listMd` /
 * `walkMdFiles` and chat's `collectMarkdown` match it, so a `.MD` file is not
 * a page for the counter either. Aligning that was audit finding L1's tail:
 * a case-insensitive extension test paired with a case-sensitive
 * index.md/log.md exclusion made `INDEX.MD` count as a user page.
 *
 * `other` is the remainder, not a discard pile — see the invariant comment in
 * getDomainStats for why pageCount keeps counting it (audit finding L1: the
 * delete confirmation is built on that total, and a total that omits `other`
 * under-reports what the delete removes).
 *
 * Deliberately does NOT read file contents — readdir + dirent types only,
 * so this stays as cheap as the rest of getDomainStats (unlike scanWiki,
 * which is a full content scan and must never be called from this hot,
 * polled path). It is now cheaper than the code it replaces: one traversal
 * instead of a traversal plus three readdirs.
 *
 * Two deliberate divergences from health.js's `listMd`, both erring toward
 * "a page is a real file":
 *
 *   • `listMd` filters readdir NAMES, so it would count a *directory* named
 *     `foo.md` as a page. This uses dirent types and does not. (The
 *     extension test itself is identical — see above.)
 *
 *   • A SYMLINKED `.md` is counted here, but always as `other`, never as a
 *     typed page — even when it points back INSIDE the wiki, which health.js
 *     does accept as a real entity. So a domain with an in-wiki alias reports
 *     it under `other` while the Health tab treats it as a page. That is a
 *     known, narrow disagreement, called out because an earlier version of
 *     this comment justified only the ESCAPING case and left a reader to
 *     assume the in-wiki case matched. The stated invariant is unaffected
 *     (`entities + concepts + summaries + other === pageCount` holds
 *     exactly), and the direction is the safe one for the delete
 *     confirmation: the link is a real directory entry that `rm -r` removes,
 *     so counting it keeps the total honest.
 */
async function countWikiPages(wikiDir) {
  const counts = { entities: 0, concepts: 0, summaries: 0, other: 0 };
  async function walk(dir, relPrefix) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(path.join(dir, e.name), rel); continue; }
      // Case-SENSITIVE, deliberately, and symmetric with the exclusion below.
      // An earlier draft matched /\.md$/i while still excluding index.md/log.md
      // with ===, which counted `INDEX.MD` as a user page and reported a
      // `.MD` file as an entity that health.js (listMd, walkMdFiles) and chat
      // (collectMarkdown) both ignore — every one of them uses
      // endsWith('.md'). A page is what the rest of the app calls a page.
      if (!e.name.endsWith('.md')) continue;
      if (e.name === 'index.md' || e.name === 'log.md') continue;
      const parts = rel.split('/');
      if (e.isFile() && parts.length === 2 && CANONICAL_PAGE_FOLDERS.includes(parts[0])) {
        counts[parts[0]] += 1;
      } else {
        counts.other += 1;
      }
    }
  }
  await walk(wikiDir, '');
  return counts;
}

const MAX_DISPLAY_NAME_LENGTH = 120;

// Derive a domain's display name from its CLAUDE.md, tolerant of every shape
// a CLAUDE.md actually takes in this codebase — not just the one
// generateClaudemd() writes.
//
// Pre-v3.1.4 this was `content.split('\n')[0].replace(/^# Domain:\s*/, '')
// .trim() || slug` — a bare first-line heuristic that assumed every CLAUDE.md
// opens with "# Domain: X". That's true for domains created through the app
// (generateClaudemd(), below), but ensureSharedDomainExists() in
// sharedbrain.js (Decision 7) writes a Shared Brain mirror's CLAUDE.md
// starting with a YAML frontmatter block (`---\nreadonly: true\n...\n---`)
// so the MCP write tools can detect and refuse direct writes to it. For a
// mirror, "the first line" is the literal string "---", the regex doesn't
// match it, and '---'.trim() is TRUTHY — so the `|| slug` fallback never
// fires. Every Shared Brain mirror displayed as "---" in the Domains tab.
// A hand-written CLAUDE.md (users create domains by hand too) can look like
// neither shape at all.
//
// Fix: look past any leading frontmatter block for the first real heading,
// strip whichever conventional prefix this codebase actually writes
// ("Domain:" from generateClaudemd, "Shared Brain Mirror:" from
// ensureSharedDomainExists), and fall back to the slug whenever nothing
// sensible is found — rather than trusting "the first line, whatever it is".
export function extractDomainDisplayName(content, slug) {
  if (typeof content !== 'string' || content.trim() === '') return slug;

  const lines = content.split(/\r\n|\r|\n/);
  let i = 0;

  // Skip a leading YAML frontmatter block if present. Bounded to an actual
  // closing "---" line further down the file — an unterminated one (or a
  // lone "---" used as a hand-written horizontal rule with no matching
  // close) has nothing reliable to read past it, so fall back to the slug
  // rather than guess.
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    let closeIdx = -1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === '---') { closeIdx = j; break; }
    }
    if (closeIdx === -1) return slug;
    i = closeIdx + 1;
  }

  // First non-blank line after any frontmatter is, by convention, a "# ..."
  // heading. If it isn't — a hand-written CLAUDE.md with plain prose, or
  // nothing at all after the frontmatter — there's nothing sensible to show.
  while (i < lines.length && lines[i].trim() === '') i++;
  const heading = i < lines.length ? lines[i].trim() : '';

  const m = heading.match(/^#\s+(.*)$/);
  if (!m) return slug;

  let name = m[1].trim();

  // Closing ATX hashes: `# Domain: Articles ###` is the same heading as
  // `# Domain: Articles` in every markdown renderer, but the raw text was
  // being shown verbatim in the Domains tab (v3.2.0 audit finding L3).
  name = name.replace(/\s+#+\s*$/, '');

  // Emphasis around the conventional prefix. `# **Domain:** Articles` is a
  // shape people genuinely write (and one an LLM-written CLAUDE.md
  // produces), and it used to render as the literal string
  // "**Domain:** Articles" because the prefix regexes required the bare
  // word. The backreference keeps the opening and closing markers matched,
  // so `**Domain:**`, `*Domain*:` and plain `Domain:` all strip while a
  // name that merely CONTAINS an asterisk or underscore is left alone.
  name = name.replace(
    /^([*_]{1,3})?\s*(?:Domain|Shared Brain Mirror)\s*(?:\1)?\s*:\s*(?:\1)?\s*/i,
    ''
  );
  // Whatever emphasis run is left dangling at the end after the opener was
  // consumed (`# **Domain: Articles**` → "Articles**").
  name = name.replace(/[*_]{1,3}$/, '');
  name = name.trim();

  // Length bound. Nothing upstream constrains a heading's length, and this
  // string lands in a fixed-width card and a delete-confirmation dialog; a
  // 5,000-character "name" is a layout bug at best. 120 characters is far
  // past any real domain name.
  if (name.length > MAX_DISPLAY_NAME_LENGTH) {
    name = name.slice(0, MAX_DISPLAY_NAME_LENGTH - 1).trimEnd() + '…';
  }

  return name || slug;
}

export async function getDomainStats(slug) {
  // Defense in depth (v3.2.0 audit finding L1). Every HTTP caller now gates
  // on listDomains() first, but this function takes a raw slug and joins it
  // straight onto the domains dir, so a caller that forgets — as
  // GET /api/domains/:domain/stats did, where Express hands ".." through
  // from a %2e%2e URL — could read a CLAUDE.md outside the domains folder.
  // Same guard shape deleteDomain/renameDomain have used for releases.
  if (!slug || typeof slug !== 'string' || slug.includes('..') || slug.includes('/')
      || slug.includes('\\') || slug.startsWith('.')) {
    throw new Error('Invalid domain name');
  }

  const base = domainPath(slug);

  const [displayName, pageCounts, conversationCount, lastIngestDate] = await Promise.all([
    // Display name from CLAUDE.md — see extractDomainDisplayName() above.
    readFile(path.join(base, 'CLAUDE.md'), 'utf8')
      .then(content => extractDomainDisplayName(content, slug))
      .catch(() => slug),

    // All four page numbers from ONE traversal — see countWikiPages() above
    // for why pageCount is no longer computed separately from the per-type
    // breakdown (they could disagree, and the Domains card showed both).
    countWikiPages(path.join(base, 'wiki')),

    // Conversation count
    readdir(path.join(base, 'conversations'))
      .then(files => files.filter(f => f.endsWith('.json')).length)
      .catch(() => 0),

    // Last ingest date from log.md — pick the MOST RECENT entry.
    //
    // Pre-v3.0.1-beta.10 this used `content.match(/.../m)` without the `g`
    // flag, which returns only the FIRST match in the file. But appendLog
    // APPENDS new entries to the end of log.md, so "first match" was actually
    // the OLDEST entry — every "Last ingest" date displayed in the Domains
    // tab showed the date of the FIRST-EVER ingest of that domain rather
    // than the most recent one. Confirmed empirically on a real domain log
    // with 25 entries spanning April–May 2026: the UI rendered the April
    // date even after a fresh May ingest.
    //
    // Fix: collect all `## [YYYY-MM-DD]` headings via matchAll, then return
    // the lexicographic max. ISO-8601 dates sort correctly as strings, so
    // this is both robust to manually-edited logs (a user reordering
    // entries doesn't lie about "most recent") and free of false positives
    // (only headings of the documented log-entry format match).
    readFile(path.join(base, 'wiki', 'log.md'), 'utf8')
      .then(content => {
        const matches = [...content.matchAll(/^## \[(\d{4}-\d{2}-\d{2})\]/gm)];
        if (matches.length === 0) return null;
        let max = matches[0][1];
        for (const m of matches) if (m[1] > max) max = m[1];
        return max;
      })
      .catch(() => null),
  ]);

  // INVARIANT (v3.2.0): pageCount === entities + concepts + summaries + other,
  // always, on every wiki — because all five numbers come from the same
  // traversal. pageCount is EVERY `.md` file under wiki/ at any depth except
  // the two app-managed ones (index.md, log.md) — byte-for-byte the set the
  // pre-v3.2.0 recursive count produced, and the set the rest of the app
  // treats as pages. (Deleting the domain also removes non-`.md` files and
  // raw sources; the dialog counts PAGES, which is what it says.)
  //
  // It was briefly narrowed to entities + concepts + summaries, and that was
  // wrong (v3.2.0 audit finding L1). `pageCount` is a published field with
  // consumers that were not — and deliberately are not — being edited in this
  // release, and the highest-stakes of them is the delete confirmation in
  // src/public/app.js: on a wiki with a stray `Untitled.md`, a nested page and
  // a symlinked page it promised to delete 4 pages and then deleted 7.
  // Under-reporting how much a destructive confirm will destroy is a worse
  // failure than the inconsistency the narrowing set out to fix.
  //
  // The thing the narrowing was actually fixing — the Domains card saying
  // "7 pages — 2 entities, 1 concept, 1 summary" with an unexplained gap — is
  // fixed by the BREAKDOWN carrying `other`, not by shrinking the total. With
  // `other` present the four numbers reconcile exactly, so a renderer that
  // shows the breakdown alongside the total can no longer produce a gap; one
  // that shows only three of the four is now the bug, and a visible one.
  //
  // Callers wanting "real, resolvable, one-level-deep pages" have that: it is
  // pageCounts.entities + .concepts + .summaries, named and separate.
  const pageCount = pageCounts.entities + pageCounts.concepts
    + pageCounts.summaries + pageCounts.other;

  return {
    slug,
    displayName,
    pageCount,
    conversationCount,
    lastIngestDate,
    // Additive (v3.1.x): per-type breakdown for the redesigned Domains view.
    // `other` is additive in v3.2.0 — see the invariant above.
    pageCounts,
  };
}

export { generateUniqueSlug };
