#!/usr/bin/env node
/**
 * scripts/bulk-reingest.js
 *
 * Re-ingests all source files from a domain's raw/ folder.
 * With merge logic active (Fix 2), each re-ingest ACCUMULATES knowledge
 * into existing entity/concept pages rather than overwriting them.
 *
 * After running this, entity pages like entities/tali-rezun.md will reference
 * ALL articles where that entity appears, not just the last one ingested.
 *
 * Usage:
 *   node scripts/bulk-reingest.js <domain>
 *   node scripts/bulk-reingest.js articles
 *
 * Options:
 *   --dry-run   List files that would be ingested, without ingesting
 *   --delay=N   Delay N ms between files (default: 3000) to avoid rate limits
 */

import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const args = process.argv.slice(2);
  const domain = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const delayArg = args.find(a => a.startsWith('--delay='));
  const delay = delayArg ? parseInt(delayArg.split('=')[1], 10) : 3000;

  if (!domain) {
    console.error('Usage: node scripts/bulk-reingest.js <domain> [--dry-run] [--delay=3000]');
    process.exit(1);
  }

  // Load modules
  const { getDomainsDir } = await import('../src/brain/config.js');
  const { ingestFile } = await import('../src/brain/ingest.js');
  const { rawPath } = await import('../src/brain/files.js');

  const rawDir = rawPath(domain);
  let files;
  try {
    files = await readdir(rawDir);
  } catch {
    console.error(`No raw/ directory found for domain "${domain}". Path: ${rawDir}`);
    process.exit(1);
  }

  const sourceFiles = files.filter(f =>
    f.endsWith('.pdf') || f.endsWith('.md') || f.endsWith('.txt')
  );

  if (!sourceFiles.length) {
    console.log(`No source files found in ${rawDir}`);
    return;
  }

  console.log(`\nBulk re-ingest -- domain: ${domain}`);
  console.log(`   ${sourceFiles.length} file(s) found in raw/`);
  if (dryRun) { console.log('   DRY RUN -- no files will be ingested\n'); }
  else        { console.log(`   Delay between files: ${delay}ms\n`); }

  for (let i = 0; i < sourceFiles.length; i++) {
    const fileName = sourceFiles[i];
    const filePath = path.join(rawDir, fileName);
    console.log(`[${i + 1}/${sourceFiles.length}] ${fileName}`);

    if (dryRun) continue;

    try {
      const result = await ingestFile(
        domain,
        filePath,
        fileName,
        true,  // isOverwrite — merge with existing pages
        ({ type, pct, message }) => {
          if (type !== 'wait') process.stdout.write(`\r  ${pct}% -- ${message}        `);
        }
      );
      process.stdout.write('\n');
      console.log(`  OK ${result.pagesWritten.length} pages written\n`);
    } catch (err) {
      process.stdout.write('\n');
      console.error(`  ERROR: ${err.message}\n`);
    }

    // Rate-limit pause between files
    if (i < sourceFiles.length - 1) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.log('\nBulk re-ingest complete.');
  console.log('   Entity pages now accumulate knowledge from all source documents.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
