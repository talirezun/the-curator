#!/usr/bin/env node
/**
 * scripts/repair-wiki.js
 *
 * One-time repair script for existing wiki data. Fixes:
 *
 *   1. Cross-folder duplicates — merges concepts/google.md into entities/google.md
 *      when both exist, keeping the richer file as canonical.
 *   2. Broken wikilinks — fixes [[international-energy-agency]] → [[iea]],
 *      [[energy-and-water-footprint-of-generative-ai]] → [[summaries/the-...]], etc.
 *   3. Pronoun inconsistencies in tali-rezun.md (she/her → he/his)
 *   4. Re-runs backlink injection to cover concept pages that were missed.
 *
 * Usage:
 *   node scripts/repair-wiki.js [domain]          # default: articles
 *   node scripts/repair-wiki.js articles --dry-run
 */
import 'dotenv/config';
import { readFile, writeFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Merge helpers (same as fix-wiki-duplicates.js) ──────────────────────────

function extractBulletsFromSection(content, sectionName) {
  const lines = content.split('\n');
  const bullets = [];
  let inSection = false;
  const re = new RegExp(`^##\\s+${sectionName}\\s*$`, 'i');
  for (const line of lines) {
    if (re.test(line))                     { inSection = true; continue; }
    if (inSection && /^##/.test(line))     { inSection = false; }
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
    if (re.test(line))                     { inSection = true; continue; }
    if (inSection && /^##/.test(line))     { inSection = false; }
    if (inSection && line.startsWith('- ')) seen.add(dedupKey(line));
  }
  const newBullets = extraBullets.filter(b => !seen.has(dedupKey(b)));
  if (!newBullets.length) return content;

  // If section doesn't exist, append it
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

function mergeInto(canonicalContent, duplicateContent) {
  const SECTIONS = ['Related','Key Facts','Key Ideas','Key Points',
    'Key Takeaways','Entities Mentioned','Concepts Introduced or Referenced',
    'Applications','Examples'];
  let merged = canonicalContent;
  for (const s of SECTIONS) {
    const bullets = extractBulletsFromSection(duplicateContent, s);
    if (bullets.length) merged = injectBulletsIntoSection(merged, s, bullets);
  }
  return merged;
}

// ── Part 1: Cross-folder dedup ──────────────────────────────────────────────

async function fixCrossFolderDuplicates(wikiDir, dryRun) {
  const entitiesDir = path.join(wikiDir, 'entities');
  const conceptsDir = path.join(wikiDir, 'concepts');

  const entityFiles = (await readdir(entitiesDir)).filter(f => f.endsWith('.md'));
  const conceptFiles = (await readdir(conceptsDir)).filter(f => f.endsWith('.md'));

  // Build hyphen-normalised lookup for entity files
  const entityNormMap = new Map();
  for (const f of entityFiles) entityNormMap.set(f.replace(/-/g, '').toLowerCase(), f);

  let mergeCount = 0;
  const merged = []; // concept files that were merged into entities

  for (const cf of conceptFiles) {
    const norm = cf.replace(/-/g, '').toLowerCase();
    const entityMatch = entityNormMap.get(norm);
    if (!entityMatch) continue;

    // Both exist — merge concept into entity (entity folder is canonical for duplicates)
    const entityPath = path.join(entitiesDir, entityMatch);
    const conceptPath = path.join(conceptsDir, cf);

    const entityContent = await readFile(entityPath, 'utf8');
    const conceptContent = await readFile(conceptPath, 'utf8');

    // Keep whichever is longer as the base, merge bullets from the other
    let result;
    if (entityContent.length >= conceptContent.length) {
      result = mergeInto(entityContent, conceptContent);
    } else {
      result = mergeInto(conceptContent, entityContent);
      // Fix frontmatter type from concept → entity since it's going to entities/
      result = result.replace(/^type: concept$/m, 'type: entity');
      result = result.replace(/type\/concept/g, 'type/entity');
    }

    console.log(`  MERGE  concepts/${cf}  →  entities/${entityMatch}`);
    mergeCount++;
    merged.push(cf.replace('.md', ''));

    if (!dryRun) {
      await writeFile(entityPath, result, 'utf8');
      await rm(conceptPath);
    }
  }

  return { mergeCount, merged };
}

// ── Part 2: Fix broken wikilinks across all files ───────────────────────────

async function fixBrokenLinks(wikiDir, mergedConcepts, dryRun) {
  const entitiesDir = path.join(wikiDir, 'entities');
  const conceptsDir = path.join(wikiDir, 'concepts');
  const summariesDir = path.join(wikiDir, 'summaries');

  // Build slug lookups
  let entityFiles = [], conceptFiles = [], summaryFiles = [];
  try { entityFiles = (await readdir(entitiesDir)).filter(f => f.endsWith('.md')); } catch {}
  try { conceptFiles = (await readdir(conceptsDir)).filter(f => f.endsWith('.md')); } catch {}
  try { summaryFiles = (await readdir(summariesDir)).filter(f => f.endsWith('.md')); } catch {}

  const ARTICLE_PREFIX_RE = /^(the|a|an)-/;
  const allSlugsMap = new Map(); // normKey → { folder, slug }

  for (const f of entityFiles) {
    const s = f.slice(0, -3);
    const key = s.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
    if (!allSlugsMap.has(key)) allSlugsMap.set(key, { folder: null, slug: s });
  }
  for (const f of conceptFiles) {
    const s = f.slice(0, -3);
    const key = s.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
    if (!allSlugsMap.has(key)) allSlugsMap.set(key, { folder: null, slug: s });
  }
  for (const f of summaryFiles) {
    const s = f.slice(0, -3);
    const key = s.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
    if (!allSlugsMap.has(key)) allSlugsMap.set(key, { folder: 'summaries', slug: s });
  }

  const allBareSlugs = new Set([
    ...entityFiles.map(f => f.slice(0, -3)),
    ...conceptFiles.map(f => f.slice(0, -3)),
  ]);

  // Also add merged concept slugs that now live in entities/ → redirect any
  // bare [[slug]] to the entity version (they're the same slug, so this is a no-op
  // for links but ensures concepts that were merged don't leave orphan links)

  let fixCount = 0;

  // Walk all .md files in the wiki
  async function walkAndFix(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkAndFix(full);
      } else if (entry.name.endsWith('.md') && entry.name !== 'index.md') {
        let content = await readFile(full, 'utf8');
        let changed = false;

        const fixed = content.replace(/\[\[([^\]|#\n]+?)(\|[^\]]+)?\]\]/g, (match, slug, alias) => {
          // Don't touch already-prefixed summary links
          if (slug.includes('/')) return match;
          // Already a known slug — nothing to do
          if (allBareSlugs.has(slug)) return match;

          // Prefix-tolerant match
          const normKey = slug.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
          const hit = allSlugsMap.get(normKey);
          if (hit) {
            const target = hit.folder ? `${hit.folder}/${hit.slug}` : hit.slug;
            changed = true;
            return `[[${target}${alias || ''}]]`;
          }
          return match;
        });

        if (changed) {
          const relPath = path.relative(wikiDir, full);
          const changes = [];
          // Find what changed
          const oldLinks = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
          const newLinks = [...fixed.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
          for (let i = 0; i < oldLinks.length; i++) {
            if (oldLinks[i] !== newLinks[i]) changes.push(`${oldLinks[i]} → ${newLinks[i]}`);
          }
          console.log(`  FIX    ${relPath}: ${changes.join(', ')}`);
          fixCount++;
          if (!dryRun) await writeFile(full, fixed, 'utf8');
        }
      }
    }
  }

  await walkAndFix(wikiDir);
  return fixCount;
}

// ── Part 3: Fix pronoun inconsistencies in tali-rezun.md ────────────────────

async function fixPronouns(wikiDir, dryRun) {
  const file = path.join(wikiDir, 'entities', 'tali-rezun.md');
  if (!existsSync(file)) return 0;

  let content = await readFile(file, 'utf8');
  const original = content;

  // Fix she/her → he/his in bullet points (Tali Režun is male)
  content = content.replace(/\bShe founded\b/g, 'He founded');
  content = content.replace(/\bshe founded\b/g, 'he founded');
  content = content.replace(/\bHer work\b/g, 'His work');
  content = content.replace(/\bher work\b/g, 'his work');
  content = content.replace(/\bHer methodology\b/g, 'His methodology');
  content = content.replace(/\bher methodology\b/g, 'his methodology');
  content = content.replace(/\bthrough her\b/g, 'through his');
  content = content.replace(/\bthrough his "From Lab to Life" series\./g, 'through his "From Lab to Life" series.');

  // Fix "Shares insights on AI developments through her" pattern
  content = content.replace(/through her "From Lab to Life"/g, 'through his "From Lab to Life"');

  if (content !== original) {
    console.log('  FIX    entities/tali-rezun.md: corrected she/her → he/his pronouns');
    if (!dryRun) await writeFile(file, content, 'utf8');
    return 1;
  }
  return 0;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const domain = args.find(a => !a.startsWith('--')) || 'articles';
  const dryRun = args.includes('--dry-run');

  let domainsDir;
  try {
    const { getDomainsDir } = await import('../src/brain/config.js');
    domainsDir = getDomainsDir();
  } catch {
    domainsDir = path.join(ROOT, 'domains');
  }

  const wikiDir = path.join(domainsDir, domain, 'wiki');
  if (!existsSync(wikiDir)) {
    console.error(`No wiki found for domain: ${domain}`);
    process.exit(1);
  }

  if (dryRun) console.log('DRY RUN — no files will be changed\n');
  console.log(`\nRepairing wiki for domain: ${domain}\n`);

  // Part 1: Cross-folder dedup
  console.log('── Part 1: Cross-folder duplicates ──────────');
  const { mergeCount, merged } = await fixCrossFolderDuplicates(wikiDir, dryRun);
  if (mergeCount === 0) console.log('  No cross-folder duplicates found.');
  else console.log(`  Merged ${mergeCount} concept files into entities.`);

  // Part 2: Fix broken wikilinks
  console.log('\n── Part 2: Broken wikilinks ──────────────────');
  const linkFixes = await fixBrokenLinks(wikiDir, merged, dryRun);
  if (linkFixes === 0) console.log('  No broken links found.');
  else console.log(`  Fixed links in ${linkFixes} files.`);

  // Part 3: Fix pronouns
  console.log('\n── Part 3: Pronoun fixes ─────────────────────');
  const pronounFixes = await fixPronouns(wikiDir, dryRun);
  if (pronounFixes === 0) console.log('  No pronoun issues found.');

  // Part 4: Re-run backlink injection to cover concepts
  console.log('\n── Part 4: Re-inject summary backlinks ───────');
  if (!dryRun) {
    try {
      const { execSync } = await import('child_process');
      execSync(`node ${path.join(ROOT, 'scripts', 'inject-summary-backlinks.js')} --domain=${domain}`, {
        stdio: 'inherit',
        cwd: ROOT,
      });
    } catch (err) {
      console.warn('  Backlink injection failed:', err.message);
    }
  } else {
    console.log('  (skipped in dry-run mode)');
  }

  console.log(`\nDone. Summary: ${mergeCount} cross-folder merges, ${linkFixes} link fixes, ${pronounFixes} pronoun fixes.`);

  // Show final file counts
  const entityCount = (await readdir(path.join(wikiDir, 'entities'))).filter(f => f.endsWith('.md')).length;
  const conceptCount = (await readdir(path.join(wikiDir, 'concepts'))).filter(f => f.endsWith('.md')).length;
  const summaryCount = (await readdir(path.join(wikiDir, 'summaries'))).filter(f => f.endsWith('.md')).length;
  console.log(`   Entity files:  ${entityCount}`);
  console.log(`   Concept files: ${conceptCount}`);
  console.log(`   Summary files: ${summaryCount}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
