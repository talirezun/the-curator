#!/usr/bin/env node
/**
 * scripts/fix-wiki-duplicates.js
 *
 * Detects and merges duplicate/fragmented wiki pages:
 *   Part 1 — Entity near-duplicates (hyphen variants, suffix variants)
 *   Part 2 — Concept fragments (where one name is a prefix of another)
 *
 * Usage:
 *   node scripts/fix-wiki-duplicates.js [domain]   # default: articles
 *   node scripts/fix-wiki-duplicates.js articles --dry-run
 */
import 'dotenv/config';
import { readFile, writeFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Merge helpers ────────────────────────────────────────────────────────────

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

function injectBulletsIntoSection(content, sectionName, extraBullets) {
  if (!extraBullets.length) return content;
  const re = new RegExp(`^##\\s+${sectionName}\\s*$`, 'i');
  const lines = content.split('\n');
  const seen = new Set();
  let inSection = false;
  for (const line of lines) {
    if (re.test(line))                     { inSection = true; continue; }
    if (inSection && /^##/.test(line))     { inSection = false; }
    if (inSection && line.startsWith('- ')) seen.add(line.toLowerCase().trim());
  }
  const newBullets = extraBullets.filter(b => !seen.has(b.toLowerCase().trim()));
  if (!newBullets.length) return content;
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
    'Applications','Examples','Definition','How It Works'];
  let merged = canonicalContent;
  for (const s of SECTIONS) {
    const bullets = extractBulletsFromSection(duplicateContent, s);
    if (bullets.length) merged = injectBulletsIntoSection(merged, s, bullets);
  }
  return merged;
}

// ── Core deduplication ───────────────────────────────────────────────────────

async function deduplicateFolder(folderPath, type, dryRun) {
  const files = (await readdir(folderPath)).filter(f => f.endsWith('.md'));
  const stems = files.map(f => f.replace('.md', ''));

  const merged = new Set(); // stems already consumed (skip as duplicates)
  let mergeCount = 0;

  for (let i = 0; i < stems.length; i++) {
    if (merged.has(stems[i])) continue;
    const canonStem = stems[i];
    const duplicates = [];

    for (let j = 0; j < stems.length; j++) {
      if (i === j || merged.has(stems[j])) continue;
      const otherStem = stems[j];

      let isDuplicate = false;

      if (type === 'entities') {
        // Rule 1: normalize dots to hyphens and compare
        const normCanon = canonStem.replace(/\./g, '-');
        const normOther = otherStem.replace(/\./g, '-');
        if (normCanon === normOther) isDuplicate = true;

        // Rule 2: strip all hyphens and compare (blocklabs vs block-labs)
        if (!isDuplicate) {
          const stripCanon = canonStem.replace(/-/g, '');
          const stripOther = otherStem.replace(/-/g, '');
          if (stripCanon === stripOther) isDuplicate = true;
        }

        // Rule 3: one is a prefix of the other (openrouter vs openrouter-llm-routing)
        if (!isDuplicate) {
          if (otherStem.startsWith(canonStem + '-') || canonStem.startsWith(otherStem + '-')) {
            isDuplicate = true;
          }
        }
      }

      if (type === 'concepts') {
        // Prefix rule: stem_a is a prefix of stem_b → merge stem_b into stem_a
        if (otherStem.startsWith(canonStem + '-')) isDuplicate = true;
      }

      if (isDuplicate) duplicates.push(otherStem);
    }

    if (duplicates.length === 0) continue;

    // Ensure we keep the shorter (more general) name as canonical
    let actualCanon = canonStem;
    for (const dup of duplicates) {
      if (dup.length < actualCanon.length) actualCanon = dup;
    }
    const toMerge = [canonStem, ...duplicates].filter(s => s !== actualCanon);

    const canonPath = path.join(folderPath, actualCanon + '.md');
    let canonContent = await readFile(canonPath, 'utf8');

    for (const dupStem of toMerge) {
      const dupPath = path.join(folderPath, dupStem + '.md');
      if (!existsSync(dupPath)) continue;
      const dupContent = await readFile(dupPath, 'utf8');
      canonContent = mergeInto(canonContent, dupContent);
      merged.add(dupStem);
      console.log(`  MERGE  ${type}/${dupStem}.md  →  ${type}/${actualCanon}.md`);
      mergeCount++;
    }

    if (!dryRun) {
      await writeFile(canonPath, canonContent, 'utf8');

      // Delete merged files
      for (const dupStem of toMerge) {
        const dupPath = path.join(folderPath, dupStem + '.md');
        if (existsSync(dupPath)) await rm(dupPath);
      }
    }
  }

  return mergeCount;
}

// ── Main ─────────────────────────────────────────────────────────────────────

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

  console.log(`\nDeduplicating wiki for domain: ${domain}\n`);

  const entitiesDir = path.join(wikiDir, 'entities');
  const conceptsDir = path.join(wikiDir, 'concepts');

  console.log('── Entities ──────────────────────────');
  const entityMerges = await deduplicateFolder(entitiesDir, 'entities', dryRun);
  if (entityMerges === 0) console.log('  No entity duplicates found.');

  console.log('\n── Concepts ──────────────────────────');
  const conceptMerges = await deduplicateFolder(conceptsDir, 'concepts', dryRun);
  if (conceptMerges === 0) console.log('  No concept duplicates found.');

  console.log(`\nDone. Merged ${entityMerges} entity duplicates, ${conceptMerges} concept fragments.`);
  console.log(`   Entity files:  ${(await readdir(entitiesDir)).filter(f => f.endsWith('.md')).length}`);
  console.log(`   Concept files: ${(await readdir(conceptsDir)).filter(f => f.endsWith('.md')).length}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
