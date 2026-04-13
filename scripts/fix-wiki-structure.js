#!/usr/bin/env node
/**
 * scripts/fix-wiki-structure.js
 *
 * One-time cleanup of wiki folders that the LLM created outside the three
 * canonical folders (entities/, concepts/, summaries/).
 *
 * What it does:
 *   1. Moves   people/*.md  →  entities/  (merges bullet sections if target exists)
 *   2. Moves   tools/*.md   →  entities/  (merges bullet sections if target exists)
 *   3. Moves   *.md (root)  →  concepts/  (merges bullet sections if target exists)
 *      (skips index.md and log.md)
 *   4. Deletes empty non-standard directories
 *
 * Usage:
 *   node scripts/fix-wiki-structure.js [domain]
 *   node scripts/fix-wiki-structure.js articles        # fix a specific domain
 *   node scripts/fix-wiki-structure.js                 # fix all domains
 */

import { readFile, writeFile, readdir, rm, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function mergeContent(existing, incoming) {
  const SECTIONS = ['Related','Key Facts','Key Ideas','Key Points',
    'Key Takeaways','Entities Mentioned','Concepts Introduced or Referenced',
    'Applications','Examples'];
  let merged = existing; // keep existing as base, inject incoming bullets
  for (const s of SECTIONS) {
    const incomingBullets = extractBulletsFromSection(incoming, s);
    if (incomingBullets.length) merged = injectBulletsIntoSection(merged, s, incomingBullets);
  }
  return merged;
}

async function moveOrMerge(srcPath, destPath, label) {
  const srcContent = await readFile(srcPath, 'utf8');
  if (existsSync(destPath)) {
    // Target exists — merge bullet sections
    const destContent = await readFile(destPath, 'utf8');
    const merged = mergeContent(destContent, srcContent);
    await writeFile(destPath, merged, 'utf8');
    console.log(`  MERGED  ${label}`);
  } else {
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, srcContent, 'utf8');
    console.log(`  MOVED   ${label}`);
  }
  // Remove source after successful copy/merge
  await rm(srcPath);
}

async function fixDomain(domainPath) {
  const wikiDir = path.join(domainPath, 'wiki');
  if (!existsSync(wikiDir)) return;

  const domainName = path.basename(domainPath);
  console.log(`\nDomain: ${domainName}`);

  // 1. people/*.md → entities/
  const peopleDir = path.join(wikiDir, 'people');
  if (existsSync(peopleDir)) {
    const files = (await readdir(peopleDir)).filter(f => f.endsWith('.md'));
    if (files.length) {
      console.log(`\n  people/ -> entities/  (${files.length} file(s))`);
      for (const f of files) {
        await moveOrMerge(
          path.join(peopleDir, f),
          path.join(wikiDir, 'entities', f),
          `people/${f} -> entities/${f}`
        );
      }
    }
    // Remove directory if now empty
    const remaining = await readdir(peopleDir);
    if (!remaining.length) { await rm(peopleDir, { recursive: true }); console.log('  Removed empty people/ directory'); }
  }

  // 2. tools/*.md → entities/
  const toolsDir = path.join(wikiDir, 'tools');
  if (existsSync(toolsDir)) {
    const files = (await readdir(toolsDir)).filter(f => f.endsWith('.md'));
    if (files.length) {
      console.log(`\n  tools/ -> entities/  (${files.length} file(s))`);
      for (const f of files) {
        await moveOrMerge(
          path.join(toolsDir, f),
          path.join(wikiDir, 'entities', f),
          `tools/${f} -> entities/${f}`
        );
      }
    }
    const remaining = await readdir(toolsDir);
    if (!remaining.length) { await rm(toolsDir, { recursive: true }); console.log('  Removed empty tools/ directory'); }
  }

  // 3. Root-level .md files → concepts/  (skip index.md and log.md)
  const rootEntries = await readdir(wikiDir, { withFileTypes: true });
  const rootFiles = rootEntries
    .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md' && e.name !== 'log.md');

  if (rootFiles.length) {
    console.log(`\n  root/*.md -> concepts/  (${rootFiles.length} file(s))`);
    for (const e of rootFiles) {
      await moveOrMerge(
        path.join(wikiDir, e.name),
        path.join(wikiDir, 'concepts', e.name),
        `${e.name} -> concepts/${e.name}`
      );
    }
  }

  // 4. Scan for any other unexpected subdirectories (not entities/concepts/summaries)
  const dirs = rootEntries.filter(e => e.isDirectory());
  const VALID = new Set(['entities', 'concepts', 'summaries']);
  for (const d of dirs) {
    if (!VALID.has(d.name)) {
      console.log(`\n  WARNING: Unexpected directory: ${d.name}/ — not automatically handled. Review manually.`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load config to find domainsDir
  let domainsDir;
  try {
    const { getDomainsDir } = await import('../src/brain/config.js');
    domainsDir = getDomainsDir();
  } catch {
    domainsDir = path.join(ROOT, 'domains');
  }

  const targetDomain = process.argv[2];

  if (targetDomain) {
    await fixDomain(path.join(domainsDir, targetDomain));
  } else {
    const entries = await readdir(domainsDir, { withFileTypes: true });
    const domains = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
    if (!domains.length) { console.log('No domains found.'); return; }
    for (const d of domains) {
      await fixDomain(path.join(domainsDir, d.name));
    }
  }

  console.log('\nDone. Review the changes above, then re-open your Obsidian vault to refresh.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
