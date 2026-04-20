/**
 * src/brain/health.js
 *
 * Wiki Health — structural validation + repair.
 *
 * scanWiki(domain)  → pure scanner. Reads the wiki and returns a report of
 *                     structural issues: broken links, orphans, folder-prefix
 *                     violations, cross-folder duplicates, hyphen variants,
 *                     missing summary→entity backlinks.
 *
 * fixIssue(domain, type, issue?)  → applies a single repair, or all repairs
 *                                   of one type when issue is omitted.
 *
 * This module is the single source of truth used by both the /api/health
 * route and (in the future) the CLI repair scripts.
 */
import { readFile, writeFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { wikiPath, injectSingleBacklink } from './files.js';

const ARTICLE_PREFIX_RE = /^(the|a|an)-/;

// ── Shared helpers (mirror those in files.js / repair-wiki.js) ──────────────

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

function dedupKey(line) {
  const linkMatch = line.match(/\[\[([^\]]+)\]\]/);
  if (linkMatch) return linkMatch[1].toLowerCase().trim();
  return line.toLowerCase().trim();
}

function injectBulletsIntoSection(content, sectionName, extraBullets) {
  if (!extraBullets.length) return content;
  const re = new RegExp(`^##\\s+${sectionName}\\s*$`, 'i');
  const lines = content.split('\n');
  const seen = new Set();
  let inSection = false;
  for (const line of lines) {
    if (re.test(line))                 { inSection = true;  continue; }
    if (inSection && /^##/.test(line)) { inSection = false; }
    if (inSection && line.startsWith('- ')) seen.add(dedupKey(line));
  }
  const newBullets = extraBullets.filter(b => !seen.has(dedupKey(b)));
  if (!newBullets.length) return content;

  const sectionExistsRe = new RegExp('^##\\s+' + sectionName + '\\s*$', 'im');
  if (!sectionExistsRe.test(content)) {
    return content.trimEnd() + `\n\n## ${sectionName}\n` + newBullets.join('\n') + '\n';
  }

  const result = [];
  inSection = false;
  let injected = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (re.test(line)) { inSection = true; result.push(line); continue; }
    if (inSection && /^##/.test(line) && !injected) {
      result.push(...newBullets); injected = true; inSection = false;
    }
    result.push(line);
  }
  if (inSection && !injected) result.push(...newBullets);
  return result.join('\n');
}

function mergeBulletSections(canonicalContent, duplicateContent) {
  const SECTIONS = ['Related','Key Facts','Key Ideas','Key Points',
    'Key Takeaways','Entities Mentioned','Concepts Introduced or Referenced',
    'Applications','Examples','Definition','How It Works'];
  let merged = canonicalContent;
  for (const s of SECTIONS) {
    const bullets = extractBulletsFromSection(duplicateContent, s);
    if (bullets.length) merged = injectBulletsIntoSection(merged, s, bullets);
  }
  return merged;
}

async function listMd(dir) {
  try {
    return (await readdir(dir)).filter(f => f.endsWith('.md'));
  } catch { return []; }
}

function normKey(slug) {
  return slug.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
}

async function walkMdFiles(rootDir) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.md')) out.push(full);
    }
  }
  if (existsSync(rootDir)) await walk(rootDir);
  return out;
}

// ── Scanner ─────────────────────────────────────────────────────────────────

/**
 * Scan a domain's wiki and return a structured issue report.
 * Pure — no writes.
 */
export async function scanWiki(domain) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) {
    throw new Error(`No wiki found for domain: ${domain}`);
  }

  const entitiesDir  = path.join(wikiDir, 'entities');
  const conceptsDir  = path.join(wikiDir, 'concepts');
  const summariesDir = path.join(wikiDir, 'summaries');

  const entityFiles  = await listMd(entitiesDir);
  const conceptFiles = await listMd(conceptsDir);
  const summaryFiles = await listMd(summariesDir);

  // Slug sets (bare filename without .md)
  const entitySlugs  = new Set(entityFiles.map(f => f.slice(0, -3)));
  const conceptSlugs = new Set(conceptFiles.map(f => f.slice(0, -3)));
  const summarySlugs = new Set(summaryFiles.map(f => f.slice(0, -3)));

  // Prefix-tolerant lookup for broken-link suggestions
  const allSlugsMap = new Map(); // normKey → { folder: null|'summaries', slug }
  for (const f of entityFiles)  allSlugsMap.set(normKey(f.slice(0,-3)), { folder: null, slug: f.slice(0,-3) });
  for (const f of conceptFiles) {
    const k = normKey(f.slice(0,-3));
    if (!allSlugsMap.has(k))    allSlugsMap.set(k, { folder: null, slug: f.slice(0,-3) });
  }
  for (const f of summaryFiles) {
    const k = normKey(f.slice(0,-3));
    if (!allSlugsMap.has(k))    allSlugsMap.set(k, { folder: 'summaries', slug: f.slice(0,-3) });
  }

  // Incoming-link map: target slug → Set of source file paths (relative to wikiDir)
  const incomingLinks = new Map();

  const brokenLinks = [];
  const folderPrefixLinks = [];

  const allFiles = await walkMdFiles(wikiDir);

  for (const full of allFiles) {
    const relPath = path.relative(wikiDir, full);
    if (relPath === 'index.md' || relPath === 'log.md') continue;

    const content = await readFile(full, 'utf8');
    const links = [...content.matchAll(/\[\[([^\]|#\n]+?)(\|[^\]]+)?\]\]/g)];

    for (const m of links) {
      const raw = m[1].trim();

      // Folder-prefix violations (entities/ or concepts/ — summaries/ is intentional)
      if (raw.startsWith('entities/') || raw.startsWith('concepts/')) {
        folderPrefixLinks.push({ sourceFile: relPath, linkText: raw });
      }

      // Resolve the link's target slug (for incoming-link tracking + broken detection)
      let targetSlug;
      let exists = false;

      if (raw.includes('/')) {
        // e.g. "summaries/foo" or "entities/bar"
        const [folder, slug] = raw.split('/');
        targetSlug = slug;
        if (folder === 'summaries' && summarySlugs.has(slug)) exists = true;
        else if (folder === 'entities' && entitySlugs.has(slug)) exists = true;
        else if (folder === 'concepts' && conceptSlugs.has(slug)) exists = true;
      } else {
        targetSlug = raw;
        if (entitySlugs.has(raw) || conceptSlugs.has(raw)) exists = true;
      }

      if (exists) {
        if (!incomingLinks.has(targetSlug)) incomingLinks.set(targetSlug, new Set());
        incomingLinks.get(targetSlug).add(relPath);
      } else {
        // Try suggestion via prefix-tolerant match
        const hit = allSlugsMap.get(normKey(raw.replace(/^[^/]+\//, '')));
        let suggestedTarget = null;
        if (hit) {
          suggestedTarget = hit.folder ? `${hit.folder}/${hit.slug}` : hit.slug;
          if (suggestedTarget === raw) suggestedTarget = null;
        }
        brokenLinks.push({ sourceFile: relPath, linkText: raw, suggestedTarget });
      }
    }
  }

  // Orphans: entity/concept pages with zero incoming links
  const orphans = [];
  for (const f of entityFiles) {
    const slug = f.slice(0, -3);
    if (!incomingLinks.has(slug)) orphans.push({ path: `entities/${f}`, type: 'entity', slug });
  }
  for (const f of conceptFiles) {
    const slug = f.slice(0, -3);
    if (!incomingLinks.has(slug)) orphans.push({ path: `concepts/${f}`, type: 'concept', slug });
  }

  // Cross-folder duplicates (concepts/X + entities/X where X matches hyphen-normalised)
  const entityNormMap = new Map();
  for (const f of entityFiles) entityNormMap.set(f.replace(/-/g, '').toLowerCase(), f);
  const crossFolderDupes = [];
  for (const cf of conceptFiles) {
    const norm = cf.replace(/-/g, '').toLowerCase();
    const match = entityNormMap.get(norm);
    if (match) {
      crossFolderDupes.push({ keep: `entities/${match}`, remove: `concepts/${cf}` });
    }
  }

  // Hyphen variants within entities/ (talirezun + tali-rezun)
  const hyphenVariants = [];
  const seenGroups = new Set();
  for (let i = 0; i < entityFiles.length; i++) {
    const stemA = entityFiles[i].slice(0, -3);
    if (seenGroups.has(stemA)) continue;
    const group = [stemA];
    const normA = stemA.replace(/-/g, '').toLowerCase();
    for (let j = i + 1; j < entityFiles.length; j++) {
      const stemB = entityFiles[j].slice(0, -3);
      if (seenGroups.has(stemB)) continue;
      const normB = stemB.replace(/-/g, '').toLowerCase();
      if (normA === normB) { group.push(stemB); seenGroups.add(stemB); }
    }
    if (group.length > 1) {
      // Prefer the form with the most hyphens — wiki convention favors
      // readable hyphenated slugs (e.g. "tali-rezun" over "talirezun").
      const canonical = group.slice().sort((a, b) => {
        const hy = (s) => (s.match(/-/g) || []).length;
        const diff = hy(b) - hy(a);
        return diff !== 0 ? diff : a.length - b.length;
      })[0];
      hyphenVariants.push({ files: group, suggestedSlug: canonical });
      seenGroups.add(stemA);
    }
  }

  // Missing backlinks: summary mentions entity X (in Entities Mentioned),
  // but X's Related section has no [[summaries/summarySlug]]
  const missingBacklinks = [];
  for (const sf of summaryFiles) {
    const summarySlug = sf.slice(0, -3);
    const summaryContent = await readFile(path.join(summariesDir, sf), 'utf8');
    const entityBullets = extractBulletsFromSection(summaryContent, 'Entities Mentioned');
    for (const bullet of entityBullets) {
      const m = bullet.match(/\[\[([^\]]+)\]\]/);
      if (!m) continue;
      let name = m[1].trim();
      if (name.includes('/')) name = name.split('/').pop();

      // Resolve to a file (try entities/ first, then concepts/, hyphen-normalised)
      let targetRel = null;
      if (entitySlugs.has(name))      targetRel = `entities/${name}.md`;
      else if (conceptSlugs.has(name)) targetRel = `concepts/${name}.md`;
      else {
        const norm = name.replace(/-/g, '').toLowerCase();
        for (const f of entityFiles) {
          if (f.replace(/-/g, '').toLowerCase() === norm + '.md') { targetRel = `entities/${f}`; break; }
        }
        if (!targetRel) {
          for (const f of conceptFiles) {
            if (f.replace(/-/g, '').toLowerCase() === norm + '.md') { targetRel = `concepts/${f}`; break; }
          }
        }
      }
      if (!targetRel) continue; // broken link — handled separately

      const targetContent = await readFile(path.join(wikiDir, targetRel), 'utf8');
      const related = extractBulletsFromSection(targetContent, 'Related');
      const hasBacklink = related.some(b => {
        const lm = b.match(/\[\[([^\]]+)\]\]/);
        return lm && lm[1].trim() === `summaries/${summarySlug}`;
      });
      if (!hasBacklink) {
        missingBacklinks.push({ summary: `summaries/${sf}`, entity: targetRel, summarySlug });
      }
    }
  }

  return {
    domain,
    scannedAt: new Date().toISOString(),
    counts: {
      entities: entityFiles.length,
      concepts: conceptFiles.length,
      summaries: summaryFiles.length,
    },
    brokenLinks,
    orphans,
    folderPrefixLinks,
    crossFolderDupes,
    hyphenVariants,
    missingBacklinks,
  };
}

// ── Fix handlers ────────────────────────────────────────────────────────────

/**
 * Auto-fixable issue types. Orphans are always review-only. brokenLinks are
 * auto-fixable per-issue only when a `suggestedTarget` is present; issues
 * without a suggestion fall through as review-only in the UI.
 */
export const AUTO_FIXABLE = new Set([
  'brokenLinks',
  'folderPrefixLinks',
  'crossFolderDupes',
  'hyphenVariants',
  'missingBacklinks',
]);

async function fixBrokenLink(wikiDir, issue) {
  if (!issue.suggestedTarget) return false;
  const full = path.join(wikiDir, issue.sourceFile);
  if (!existsSync(full)) return false;
  const before = await readFile(full, 'utf8');
  const esc = issue.linkText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Allow whitespace inside [[ ... ]] — the scanner trims linkText but the source
  // file may have `[[ Cline]]` or `[[Cline ]]` with stray spaces from LLM output.
  const re = new RegExp(`\\[\\[\\s*${esc}\\s*(\\|[^\\]]+)?\\]\\]`, 'g');
  const after = before.replace(re, (_m, alias) => `[[${issue.suggestedTarget}${alias || ''}]]`);
  if (after === before) return false;
  await writeFile(full, after, 'utf8');
  return true;
}

async function fixFolderPrefixLink(wikiDir, issue) {
  const full = path.join(wikiDir, issue.sourceFile);
  let content = await readFile(full, 'utf8');
  const before = content;
  content = content.replace(/\[\[(entities|concepts)\/([^\]|#\n]+?)(\|[^\]]+)?\]\]/g,
    (_m, _folder, slug, alias) => `[[${slug}${alias || ''}]]`);
  if (content !== before) await writeFile(full, content, 'utf8');
  return content !== before;
}

async function fixCrossFolderDupe(wikiDir, issue) {
  const keepPath = path.join(wikiDir, issue.keep);
  const removePath = path.join(wikiDir, issue.remove);
  if (!existsSync(keepPath) || !existsSync(removePath)) return false;

  const keepContent   = await readFile(keepPath, 'utf8');
  const removeContent = await readFile(removePath, 'utf8');

  let merged;
  if (keepContent.length >= removeContent.length) {
    merged = mergeBulletSections(keepContent, removeContent);
  } else {
    merged = mergeBulletSections(removeContent, keepContent);
    // Normalise frontmatter type to match the kept folder (entities/)
    merged = merged.replace(/^type: concept$/m, 'type: entity');
    merged = merged.replace(/type\/concept/g, 'type/entity');
  }

  await writeFile(keepPath, merged, 'utf8');
  await rm(removePath);
  return true;
}

async function fixHyphenVariant(wikiDir, issue) {
  const entitiesDir = path.join(wikiDir, 'entities');
  const canonical = issue.suggestedSlug;
  const canonPath = path.join(entitiesDir, canonical + '.md');
  if (!existsSync(canonPath)) return false;

  let canonContent = await readFile(canonPath, 'utf8');
  for (const slug of issue.files) {
    if (slug === canonical) continue;
    const dupPath = path.join(entitiesDir, slug + '.md');
    if (!existsSync(dupPath)) continue;
    const dupContent = await readFile(dupPath, 'utf8');
    canonContent = mergeBulletSections(canonContent, dupContent);
    await rm(dupPath);
  }
  await writeFile(canonPath, canonContent, 'utf8');
  return true;
}

async function fixMissingBacklink(wikiDir, issue) {
  // Use the entity path the scan already resolved, instead of re-running the
  // bulk injectSummaryBacklinks machinery. The bulk function re-resolves every
  // bullet in the summary's "Entities Mentioned" section and can land the
  // backlink in a hyphen-variant file (e.g. e-mail.md when the scan pointed
  // at email.md), leaving the flagged file unchanged and the issue unfixed.
  const entityPath = path.join(wikiDir, issue.entity);
  const summaryPath = path.join(wikiDir, issue.summary);
  if (!existsSync(entityPath) || !existsSync(summaryPath)) return false;

  const summaryContent = await readFile(summaryPath, 'utf8');
  const titleMatch = summaryContent.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : issue.summarySlug;

  await injectSingleBacklink(entityPath, issue.summarySlug, title);
  return true;
}

/**
 * Apply one fix for a specific issue object, OR all fixes of a given type
 * when `issue` is not provided.
 *
 * @param {string} domain
 * @param {string} type       — one of AUTO_FIXABLE
 * @param {object|null} issue — if null, fix all issues of this type
 * @returns {{ fixed: number, total: number }}
 */
export async function fixIssue(domain, type, issue = null) {
  if (!AUTO_FIXABLE.has(type)) {
    throw new Error(`Issue type "${type}" is review-only and cannot be auto-fixed.`);
  }
  const wikiDir = wikiPath(domain);

  // Fix one specific issue
  if (issue) {
    let ok = false;
    if (type === 'brokenLinks')       ok = await fixBrokenLink(wikiDir, issue);
    if (type === 'folderPrefixLinks') ok = await fixFolderPrefixLink(wikiDir, issue);
    if (type === 'crossFolderDupes')  ok = await fixCrossFolderDupe(wikiDir, issue);
    if (type === 'hyphenVariants')    ok = await fixHyphenVariant(wikiDir, issue);
    if (type === 'missingBacklinks')  ok = await fixMissingBacklink(wikiDir, issue);
    return { fixed: ok ? 1 : 0, total: 1 };
  }

  // Fix all of type: re-scan and apply each. For brokenLinks, only issues
  // with a suggestedTarget count toward the total — the rest are review-only.
  const report = await scanWiki(domain);
  let issues = report[type] || [];
  if (type === 'brokenLinks') issues = issues.filter(i => i.suggestedTarget);
  let fixed = 0;
  for (const it of issues) {
    let ok = false;
    try {
      if (type === 'brokenLinks')       ok = await fixBrokenLink(wikiDir, it);
      if (type === 'folderPrefixLinks') ok = await fixFolderPrefixLink(wikiDir, it);
      if (type === 'crossFolderDupes')  ok = await fixCrossFolderDupe(wikiDir, it);
      if (type === 'hyphenVariants')    ok = await fixHyphenVariant(wikiDir, it);
      if (type === 'missingBacklinks')  ok = await fixMissingBacklink(wikiDir, it);
    } catch (err) {
      console.warn(`[fixIssue] ${type} failed:`, err.message);
    }
    if (ok) fixed++;
  }
  return { fixed, total: issues.length };
}
