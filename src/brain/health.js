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
import { wikiPath, injectSingleBacklink, injectRelatedLink } from './files.js';

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
  // orphanLink is a pseudo-type (v2.4.4+) — never emitted by scanWiki; only
  // used to route a POST /fix that carries an AI orphan suggestion through
  // fixOrphanLink. Keeps the "only fixIssue() writes" invariant intact.
  'orphanLink',
  // semanticDupe is a pseudo-type (v2.4.5+) — never emitted by scanWiki;
  // routes AI-approved semantic-duplicate merges through fixSemanticDuplicate.
  // DESTRUCTIVE: merges + rewrites links across the domain + deletes a file.
  // Phase 3 scan is a separate opt-in flow; see scanSemanticDuplicates in
  // health-ai.js.
  'semanticDupe',
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

/**
 * Apply an AI-proposed orphan-rescue suggestion (v2.4.4+).
 *
 * The issue carries the orphan's bare slug, the target page to link FROM,
 * and a short AI-written description for the bullet's prose. Writes
 *   `- [[orphanSlug]] — description`
 * into the target's Related section via `injectRelatedLink`.
 *
 * Defense in depth:
 *   1. `targetPath` must resolve inside wikiDir (no path traversal).
 *   2. The orphan slug must actually exist on disk in entities/ or concepts/.
 *   3. Target must be an entities/ or concepts/ file — never a summary
 *      (summaries are not valid orphan-rescue targets; see docs/ai-health.md).
 */
async function fixOrphanLink(wikiDir, issue) {
  if (!issue || !issue.orphanSlug || !issue.targetSlug) return false;

  const { orphanSlug, targetSlug } = issue;
  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
  if (!SLUG_RE.test(orphanSlug) || !SLUG_RE.test(targetSlug)) return false;

  const entitiesDir = path.join(wikiDir, 'entities');
  const conceptsDir = path.join(wikiDir, 'concepts');

  // Defence 1: orphan must exist on disk (entity or concept)
  const orphanExists =
    existsSync(path.join(entitiesDir, orphanSlug + '.md')) ||
    existsSync(path.join(conceptsDir, orphanSlug + '.md'));
  if (!orphanExists) return false;

  // Defence 2: target must exist and be an entity or concept (never a summary)
  let targetPath = null;
  if (existsSync(path.join(entitiesDir, targetSlug + '.md'))) {
    targetPath = path.join(entitiesDir, targetSlug + '.md');
  } else if (existsSync(path.join(conceptsDir, targetSlug + '.md'))) {
    targetPath = path.join(conceptsDir, targetSlug + '.md');
  }
  if (!targetPath) return false;

  // Defence 3: don't link a page to itself
  if (orphanSlug === targetSlug) return false;

  return await injectRelatedLink(targetPath, orphanSlug, issue.description || '');
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
    if (type === 'orphanLink')        ok = await fixOrphanLink(wikiDir, issue);
    if (type === 'semanticDupe')      ok = await fixSemanticDuplicate(wikiDir, issue);
    return { fixed: ok ? 1 : 0, total: 1 };
  }

  // Fix all of type: re-scan and apply each. For brokenLinks, only issues
  // with a suggestedTarget count toward the total — the rest are review-only.
  // `orphanLink` and `semanticDupe` have no scan-emitted issues; fix-all is
  // a no-op. Phase 3 deliberately rejects batch merges at any scale.
  if (type === 'orphanLink')   return { fixed: 0, total: 0 };
  if (type === 'semanticDupe') return { fixed: 0, total: 0 };

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

// ── Phase 3 (v2.4.5) — Semantic near-duplicate detection ────────────────────

/**
 * Hard limit on domain size before the semantic-duplicate scan refuses.
 * At 20k pages a token-index pre-filter runs in single-digit seconds and
 * produces a manageable candidate set. Above that we ask the user to split
 * the domain — the cost of a false-positive merge across 30k pages of links
 * is too high to invite.
 */
export const SEMANTIC_DUPE_MAX_DOMAIN_PAGES = 20000;

/**
 * Default candidate-pair cap sent to the LLM. User-overridable via config
 * (Settings → AI Health cost ceiling / candidate cap).
 */
export const SEMANTIC_DUPE_DEFAULT_CAP = 500;

const STOPWORDS = new Set([
  'a','an','the','of','in','and','or','to','for','is','are','on','at',
  'by','with','from','as','it','this','that','be','was','were','has','have',
  'but','not','if','can','will','its','can','we','our','your','their',
]);

function tokenizeSlug(slug) {
  // Split on hyphen/underscore, drop tokens < 3 chars, drop stopwords, lowercase
  return slug
    .toLowerCase()
    .split(/[-_]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Jaro-Winkler similarity (0-1). Used by the pre-filter to rank candidates.
 * Inlined rather than adding a dep — the algorithm is small and stable.
 */
function jaroWinkler(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatch = new Array(la).fill(false);
  const bMatch = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(lb, i + matchDist + 1);
    for (let j = start; j < end; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const m = matches;
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  // Winkler prefix bonus (up to 4 chars)
  let p = 0;
  const maxP = Math.min(4, la, lb);
  while (p < maxP && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

function candidatePairScore(slugA, slugB, sharedTokens) {
  // Multi-signal score (0-1).
  //   token overlap   — proportional to shared tokens
  //   JW similarity   — character-level
  //   length ratio    — penalises wildly different lengths
  const tokensA = tokenizeSlug(slugA);
  const tokensB = tokenizeSlug(slugB);
  const maxTokens = Math.max(tokensA.length, tokensB.length);
  const tokenOverlap = maxTokens > 0 ? sharedTokens / maxTokens : 0;
  const jw = jaroWinkler(slugA, slugB);
  const lenRatio = Math.min(slugA.length, slugB.length) / Math.max(slugA.length, slugB.length);
  return 0.5 * tokenOverlap + 0.35 * jw + 0.15 * lenRatio;
}

/**
 * Pre-filter: find slug pairs that *might* be semantic duplicates, using
 * token overlap + Jaro-Winkler. Scales to ~20k pages via an inverted
 * token-index (O(N·k) not O(N²)).
 *
 * Returns pairs ranked by score (highest first), capped at `maxPairs`.
 * Only pairs within entities/ or within concepts/, OR entity↔concept
 * cross-folder pairs, are considered. Summaries are excluded.
 *
 * Exact-match cross-folder duplicates (entities/X + concepts/X) are omitted
 * because they are already caught by scanWiki's crossFolderDupes branch.
 *
 * @param {string} domain
 * @param {number} maxPairs — cap on output pairs (default 500)
 * @returns {Promise<{pageCount, pairs, truncated}>}
 */
export async function findSemanticCandidatePairs(domain, maxPairs = SEMANTIC_DUPE_DEFAULT_CAP) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);

  const entityFiles  = await listMd(path.join(wikiDir, 'entities'));
  const conceptFiles = await listMd(path.join(wikiDir, 'concepts'));

  const pageCount = entityFiles.length + conceptFiles.length;
  if (pageCount > SEMANTIC_DUPE_MAX_DOMAIN_PAGES) {
    const err = new Error(
      `Semantic-duplicate scan is capped at ${SEMANTIC_DUPE_MAX_DOMAIN_PAGES} pages; ` +
      `this domain has ${pageCount}. Consider splitting the domain.`
    );
    err.code = 'DOMAIN_TOO_LARGE';
    throw err;
  }

  // Build slug list with folder metadata
  const allSlugs = [
    ...entityFiles.map(f => ({ slug: f.slice(0, -3), folder: 'entities' })),
    ...conceptFiles.map(f => ({ slug: f.slice(0, -3), folder: 'concepts' })),
  ];

  // Inverted token index: token → list of indices in allSlugs
  const tokenIndex = new Map();
  const slugTokens = new Array(allSlugs.length);
  for (let i = 0; i < allSlugs.length; i++) {
    const toks = tokenizeSlug(allSlugs[i].slug);
    slugTokens[i] = toks;
    for (const t of toks) {
      if (!tokenIndex.has(t)) tokenIndex.set(t, []);
      tokenIndex.get(t).push(i);
    }
  }

  // Generate candidate pairs through shared tokens (bounded per-slug).
  // Only keep pairs whose score > 0.5 — below that, false-positive rate is
  // too high to burn LLM tokens on.
  const MIN_SCORE = 0.5;
  const pairMap = new Map(); // key "i|j" (i<j) → {a, b, score, shared}
  for (let i = 0; i < allSlugs.length; i++) {
    const toks = slugTokens[i];
    if (toks.length === 0) continue;
    const candIndices = new Set();
    for (const t of toks) {
      for (const j of tokenIndex.get(t)) {
        if (j > i) candIndices.add(j);
      }
    }
    for (const j of candIndices) {
      const shared = slugTokens[i].filter(t => slugTokens[j].includes(t)).length;
      if (shared === 0) continue;
      // Skip exact-match cross-folder (already caught by scanWiki)
      if (allSlugs[i].slug === allSlugs[j].slug) continue;
      const score = candidatePairScore(allSlugs[i].slug, allSlugs[j].slug, shared);
      if (score < MIN_SCORE) continue;
      pairMap.set(`${i}|${j}`, { i, j, score });
    }
  }

  // Also add prefix-subsequence candidates (e.g. "rag" vs "retrieval-augmented-generation"
  // share no tokens but one is an acronym of the other — handled via JW only
  // where JW ≥ 0.8 as a secondary pass.
  for (let i = 0; i < allSlugs.length; i++) {
    for (let j = i + 1; j < allSlugs.length; j++) {
      if (pairMap.has(`${i}|${j}`)) continue;
      if (allSlugs[i].slug === allSlugs[j].slug) continue;
      const jw = jaroWinkler(allSlugs[i].slug, allSlugs[j].slug);
      if (jw >= 0.85) {
        pairMap.set(`${i}|${j}`, { i, j, score: 0.5 * jw + 0.5 }); // bias up
      }
    }
    // Note: outer loop capped by O(N²) only for the high-JW pass; for 20k
    // pages this is 200M ops — marginal. If it proves slow on real-world
    // data, we'll add locality-sensitive hashing. Currently acceptable.
  }

  const ranked = [...pairMap.values()].sort((a, b) => b.score - a.score);
  const truncated = ranked.length > maxPairs;
  const slice = ranked.slice(0, maxPairs);

  const pairs = slice.map(p => ({
    slugA:   allSlugs[p.i].slug,
    folderA: allSlugs[p.i].folder,
    slugB:   allSlugs[p.j].slug,
    folderB: allSlugs[p.j].folder,
    score:   Number(p.score.toFixed(3)),
  }));

  return { pageCount, pairs, truncated, totalCandidates: ranked.length };
}

/**
 * Count how many .md files in the domain contain `[[removeSlug]]` or
 * `[[folder/removeSlug]]` — used for the merge preview-diff ("14 links will
 * be rewritten"). Does not modify anything.
 */
export async function countLinksToSlug(domain, slug) {
  const wikiDir = wikiPath(domain);
  const allFiles = await walkMdFiles(wikiDir);
  const escSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\[\\[(entities/|concepts/|summaries/)?${escSlug}(\\|[^\\]]+)?\\]\\]`, 'g');
  let files = 0;
  let links = 0;
  for (const full of allFiles) {
    const rel = path.relative(wikiDir, full);
    if (rel === 'index.md' || rel === 'log.md') continue;
    const content = await readFile(full, 'utf8');
    const matches = content.match(re);
    if (matches) { files++; links += matches.length; }
  }
  return { files, links };
}

/**
 * Build a human-readable diff preview for a semantic-duplicate merge.
 * Shows:
 *   - which file will be deleted
 *   - how many other files will have their links rewritten
 *   - a list of those files (capped at 50 for UI sanity)
 *   - the merged Related/Key-Facts sections that will land in the kept page
 *
 * Runs no writes. Returns a structured object the UI renders.
 */
export async function previewSemanticDuplicateMerge(domain, issue) {
  const { keepSlug, keepFolder, removeSlug, removeFolder } = issue || {};
  if (!keepSlug || !keepFolder || !removeSlug || !removeFolder) {
    throw new Error('Invalid semanticDupe issue: keep/remove slug+folder are required');
  }
  const wikiDir = wikiPath(domain);
  const keepPath = path.join(wikiDir, keepFolder, keepSlug + '.md');
  const removePath = path.join(wikiDir, removeFolder, removeSlug + '.md');
  if (!existsSync(keepPath) || !existsSync(removePath)) {
    throw new Error('Both pages must exist to preview a merge');
  }

  const keepContent = await readFile(keepPath, 'utf8');
  const removeContent = await readFile(removePath, 'utf8');

  // Mirror the real merge's direction logic: larger body wins as the base
  const merged = keepContent.length >= removeContent.length
    ? mergeBulletSections(keepContent, removeContent)
    : mergeBulletSections(removeContent, keepContent);

  // Count affected files for the "N links will be rewritten" message
  const affectedFiles = [];
  const allFiles = await walkMdFiles(wikiDir);
  const escSlug = removeSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\[\\[(entities/|concepts/|summaries/)?${escSlug}(\\|[^\\]]+)?\\]\\]`, 'g');
  for (const full of allFiles) {
    const rel = path.relative(wikiDir, full);
    if (rel === 'index.md' || rel === 'log.md') continue;
    const content = await readFile(full, 'utf8');
    const matches = content.match(re);
    if (matches && matches.length > 0) {
      affectedFiles.push({ path: rel, linkCount: matches.length });
    }
  }

  return {
    keepPath: path.relative(wikiDir, keepPath),
    removePath: path.relative(wikiDir, removePath),
    mergedPreview: merged.slice(0, 4000), // cap for UI
    mergedLength: merged.length,
    affectedFiles: affectedFiles.slice(0, 50),
    affectedCount: affectedFiles.length,
    totalLinksRewritten: affectedFiles.reduce((s, f) => s + f.linkCount, 0),
  };
}

/**
 * Apply a semantic-duplicate merge. DESTRUCTIVE.
 *
 * Steps (ordered so a mid-operation crash leaves the wiki recoverable):
 *   1. Validate both slugs exist, distinct, not summaries, slug-regex safe.
 *   2. Read both files + merge bullet sections (larger body wins as base).
 *   3. Rewrite `[[removeSlug]]` / `[[removeFolder/removeSlug]]` →
 *      `[[keepSlug]]` across every .md file in the domain (summaries included —
 *      a summary linking to the old slug must point to the new canonical).
 *   4. Write the merged content to the kept file.
 *   5. Delete the removed file.
 *
 * Returns true on success, false on any validation failure (silent no-op —
 * matches the pattern used by fixOrphanLink).
 */
async function fixSemanticDuplicate(wikiDir, issue) {
  if (!issue) return false;
  const { keepSlug, keepFolder, removeSlug, removeFolder } = issue;
  const SLUG_RE = /^[a-z0-9][a-z0-9.-]*$/i;
  if (!SLUG_RE.test(keepSlug) || !SLUG_RE.test(removeSlug)) return false;
  if (keepSlug === removeSlug && keepFolder === removeFolder) return false;
  if (keepFolder === 'summaries' || removeFolder === 'summaries') return false;
  if (!['entities', 'concepts'].includes(keepFolder)) return false;
  if (!['entities', 'concepts'].includes(removeFolder)) return false;

  const keepPath = path.join(wikiDir, keepFolder, keepSlug + '.md');
  const removePath = path.join(wikiDir, removeFolder, removeSlug + '.md');
  if (!existsSync(keepPath) || !existsSync(removePath)) return false;

  // Step 2: merge bodies
  const keepContent = await readFile(keepPath, 'utf8');
  const removeContent = await readFile(removePath, 'utf8');
  let merged = keepContent.length >= removeContent.length
    ? mergeBulletSections(keepContent, removeContent)
    : mergeBulletSections(removeContent, keepContent);

  // Normalise frontmatter type to match the kept folder
  const wantType = keepFolder === 'entities' ? 'entity' : 'concept';
  const otherType = keepFolder === 'entities' ? 'concept' : 'entity';
  merged = merged.replace(new RegExp(`^type:\\s*${otherType}$`, 'm'), `type: ${wantType}`);
  merged = merged.replace(new RegExp(`type/${otherType}`, 'g'), `type/${wantType}`);

  // Step 3: rewrite links across the entire domain.
  // We match `[[X]]`, `[[entities/X]]`, `[[concepts/X]]`, `[[summaries/X]]`,
  // plus any alias suffix `|alias`.
  const escRemove = removeSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkRe = new RegExp(
    `\\[\\[(?:entities/|concepts/|summaries/)?${escRemove}(\\|[^\\]]+)?\\]\\]`,
    'g'
  );

  const allFiles = await walkMdFiles(wikiDir);
  for (const full of allFiles) {
    // Skip the file we're about to delete
    if (path.resolve(full) === path.resolve(removePath)) continue;
    const rel = path.relative(wikiDir, full);
    if (rel === 'index.md' || rel === 'log.md') continue;
    let content;
    // If this is the keep file, use our already-merged content
    if (path.resolve(full) === path.resolve(keepPath)) {
      content = merged;
    } else {
      content = await readFile(full, 'utf8');
    }
    const rewritten = content.replace(linkRe, (_m, alias) => `[[${keepSlug}${alias || ''}]]`);
    if (rewritten !== content) {
      await writeFile(full, rewritten, 'utf8');
      if (path.resolve(full) === path.resolve(keepPath)) merged = rewritten;
    } else if (path.resolve(full) === path.resolve(keepPath)) {
      // Keep file had no inbound-to-self links but we still need to persist merge
      await writeFile(full, merged, 'utf8');
    }
  }

  // Step 4: ensure the merged content was written even if the keep file
  // didn't appear in the loop's mutation set (no links to remove to itself).
  const keepFinal = await readFile(keepPath, 'utf8');
  if (keepFinal !== merged) await writeFile(keepPath, merged, 'utf8');

  // Step 5: delete the removed file
  await rm(removePath);
  return true;
}
