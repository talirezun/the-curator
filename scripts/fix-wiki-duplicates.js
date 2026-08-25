#!/usr/bin/env node
/**
 * scripts/fix-wiki-duplicates.js
 *
 * Detects and merges duplicate/fragmented wiki pages:
 *   Part 1 — Entity near-duplicates (hyphen variants, suffix variants)
 *   Part 2 — Concept fragments (where one name is a prefix of another)
 *
 * THIS SCRIPT IS DESTRUCTIVE — it rewrites and deletes wiki files. It therefore
 * refuses to guess which domain you meant: there is no default domain, and an
 * unrecognised flag is an error rather than something silently ignored. (Before
 * this guard, `--domain=business` was silently skipped by the positional parser
 * and the script deduplicated the hardcoded `articles` domain instead — deleting
 * files in a domain the user never named while printing "Deduplicating wiki for
 * domain: articles". Reproduced live before the fix; see
 * scripts/test-wiki-script-args.js.)
 *
 * Usage:
 *   node scripts/fix-wiki-duplicates.js <domain>
 *   node scripts/fix-wiki-duplicates.js --domain=<domain>
 *   node scripts/fix-wiki-duplicates.js <domain> --dry-run
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

// ── Argument parsing ─────────────────────────────────────────────────────────

/** A domain name must be a single path segment — it is interpolated into a path. */
const DOMAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const USAGE = [
  'Usage:',
  '  node scripts/fix-wiki-duplicates.js <domain>',
  '  node scripts/fix-wiki-duplicates.js --domain=<domain>',
  '',
  'Options:',
  '  --dry-run    Report what would change without writing or deleting anything.',
  '  --help       Show this message.',
  '',
  'This script rewrites and DELETES wiki files, so it never guesses a domain:',
  'there is no default and no "all domains" mode. Name exactly one domain.',
].join('\n');

/**
 * Parses fix-wiki-duplicates argv (the tokens AFTER the script path).
 *
 * Pure — no filesystem, no environment, no process.exit. Returns
 * `{ ok: true, domain, dryRun }`, `{ ok: false, help: true }`, or
 * `{ ok: false, error }`.
 *
 * ENFORCED: exactly one domain is named, via a positional OR `--domain=`
 * (both accepted; both forms have existed in this repo's docs); an unrecognised
 * flag is an error; a `--domain=` and a positional that disagree are an error;
 * the domain is a single safe path segment.
 * NOT ENFORCED: that the domain exists — main() checks that against disk.
 *
 * Deliberately identical in behaviour to parseRepairArgs in repair-wiki.js and
 * parseStructureArgs in fix-wiki-structure.js. These three scripts are reached
 * by the same users from the same docs section; a user who learns one must not
 * be surprised by another.
 */
export function parseDedupeArgs(argv) {
  let dryRun = false;
  let flagDomain = null;
  const positionals = [];

  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--help' || arg === '-h') return { ok: false, help: true };
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg.startsWith('--domain=')) {
      const value = arg.slice('--domain='.length);
      if (!value) return { ok: false, error: '--domain= was given with no value.' };
      if (flagDomain !== null && flagDomain !== value) {
        return { ok: false, error: `Two different --domain= values given ("${flagDomain}" and "${value}").` };
      }
      flagDomain = value;
      continue;
    }
    // Anything else that looks like a flag is refused rather than ignored —
    // silently ignoring "--domain=x" is exactly how this script came to
    // deduplicate (and delete files in) the wrong domain.
    if (arg.startsWith('-')) return { ok: false, error: `Unrecognised option: ${arg}` };
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    return { ok: false, error: `Expected one domain, got ${positionals.length}: ${positionals.join(', ')}` };
  }
  const positional = positionals[0] ?? null;
  if (flagDomain !== null && positional !== null && flagDomain !== positional) {
    return { ok: false, error: `Conflicting domains: positional "${positional}" and --domain=${flagDomain}.` };
  }

  const domain = flagDomain ?? positional;
  if (domain === null) return { ok: false, error: 'No domain given. This script is destructive and has no default domain.' };
  if (!DOMAIN_RE.test(domain)) return { ok: false, error: `Invalid domain name: "${domain}"` };

  return { ok: true, domain, dryRun };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const parsed = parseDedupeArgs(process.argv.slice(2));
  if (parsed.help) { console.log(USAGE); process.exit(0); }
  if (!parsed.ok) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    process.exit(1);
  }
  const { domain, dryRun } = parsed;

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

// Run main() ONLY when this file is the entry point. Without this guard,
// importing the module (as the arg-parser test does) would execute a
// destructive deduplication as a side effect of the import.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(err => { console.error(err); process.exit(1); });
}
