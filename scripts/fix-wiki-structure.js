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
 * THIS SCRIPT IS DESTRUCTIVE — it rewrites, moves and deletes wiki files.
 *
 * Two argument bugs were fixed here, both instances of "input the user supplied
 * was silently ignored":
 *
 *   1. It read `process.argv[2]` directly, so `--domain=business` — the form
 *      documented for its sibling scripts — was taken as a LITERAL directory
 *      name. `existsSync(wikiDir)` was then false and fixDomain() returned
 *      without a word, so the run exited 0 printing "Done. Review the changes
 *      above" with nothing above it: a success report over a total no-op.
 *   2. A BARE invocation walked and mutated EVERY domain. That capability is
 *      real and was documented, so it is kept — but it now requires an explicit
 *      `--all`. An all-domains migration should be something you asked for, not
 *      what you get for forgetting an argument.
 *
 * Usage:
 *   node scripts/fix-wiki-structure.js <domain>
 *   node scripts/fix-wiki-structure.js --domain=<domain>
 *   node scripts/fix-wiki-structure.js --all             # every domain
 *   node scripts/fix-wiki-structure.js --all --dry-run
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

async function moveOrMerge(srcPath, destPath, label, dryRun) {
  const srcContent = await readFile(srcPath, 'utf8');
  if (existsSync(destPath)) {
    // Target exists — merge bullet sections
    const destContent = await readFile(destPath, 'utf8');
    const merged = mergeContent(destContent, srcContent);
    if (!dryRun) await writeFile(destPath, merged, 'utf8');
    console.log(`  MERGED  ${label}`);
  } else {
    if (!dryRun) {
      await mkdir(path.dirname(destPath), { recursive: true });
      await writeFile(destPath, srcContent, 'utf8');
    }
    console.log(`  MOVED   ${label}`);
  }
  // Remove source after successful copy/merge
  if (!dryRun) await rm(srcPath);
}

async function fixDomain(domainPath, dryRun) {
  const wikiDir = path.join(domainPath, 'wiki');
  if (!existsSync(wikiDir)) {
    // Say so. The previous silent `return` here is half of why a mistyped
    // argument could report success while doing nothing at all.
    console.warn(`\nSkipped ${path.basename(domainPath)} — no wiki/ folder at ${wikiDir}`);
    return;
  }

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
          `people/${f} -> entities/${f}`,
          dryRun
        );
      }
    }
    // Remove directory if now empty
    const remaining = await readdir(peopleDir);
    if (!remaining.length && !dryRun) { await rm(peopleDir, { recursive: true }); console.log('  Removed empty people/ directory'); }
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
          `tools/${f} -> entities/${f}`,
          dryRun
        );
      }
    }
    const remaining = await readdir(toolsDir);
    if (!remaining.length && !dryRun) { await rm(toolsDir, { recursive: true }); console.log('  Removed empty tools/ directory'); }
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
        `${e.name} -> concepts/${e.name}`,
        dryRun
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

// ── Argument parsing ──────────────────────────────────────────────────────────

/** A domain name must be a single path segment — it is interpolated into a path. */
const DOMAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const USAGE = [
  'Usage:',
  '  node scripts/fix-wiki-structure.js <domain>',
  '  node scripts/fix-wiki-structure.js --domain=<domain>',
  '  node scripts/fix-wiki-structure.js --all',
  '',
  'Options:',
  '  --all        Migrate EVERY domain. Required to act on more than one.',
  '  --dry-run    Report what would change without writing, moving or deleting.',
  '  --help       Show this message.',
  '',
  'This script rewrites, moves and DELETES wiki files, so it never guesses:',
  'name one domain, or ask for --all explicitly. A bare invocation is refused.',
].join('\n');

/**
 * Parses fix-wiki-structure argv (the tokens AFTER the script path).
 *
 * Pure — no filesystem, no environment, no process.exit. Returns
 * `{ ok: true, domain, all, dryRun }` (exactly one of `domain`/`all` is set),
 * `{ ok: false, help: true }`, or `{ ok: false, error }`.
 *
 * ENFORCED: a target is named — one domain via a positional OR `--domain=`, or
 * every domain via an explicit `--all`; `--all` and a named domain are a
 * conflict; an unrecognised flag is an error; the domain is a single safe path
 * segment.
 * NOT ENFORCED: that the domain exists — main() checks that against disk.
 *
 * Matches parseDedupeArgs / parseRepairArgs for every argument shape they share.
 * `--all` is the one addition, and it exists because this script — unlike its
 * two siblings — has a genuine, documented all-domains mode that predates the
 * fix. Keeping the capability while removing it as the DEFAULT is the whole
 * point: the broad destructive mode is now reachable only by asking for it.
 */
export function parseStructureArgs(argv) {
  let dryRun = false;
  let all = false;
  let flagDomain = null;
  const positionals = [];

  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--help' || arg === '-h') return { ok: false, help: true };
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--all') { all = true; continue; }
    if (arg.startsWith('--domain=')) {
      const value = arg.slice('--domain='.length);
      if (!value) return { ok: false, error: '--domain= was given with no value.' };
      if (flagDomain !== null && flagDomain !== value) {
        return { ok: false, error: `Two different --domain= values given ("${flagDomain}" and "${value}").` };
      }
      flagDomain = value;
      continue;
    }
    // Anything else that looks like a flag is refused rather than ignored.
    // Reading argv[2] blindly is how `--domain=business` became a literal
    // directory name here, producing a silent no-op that reported success.
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
  if (all && domain !== null) {
    return { ok: false, error: `--all migrates every domain, so it cannot be combined with "${domain}".` };
  }
  if (all) return { ok: true, domain: null, all: true, dryRun };
  if (domain === null) {
    return { ok: false, error: 'No domain given. This script is destructive: name a domain, or pass --all to migrate every domain.' };
  }
  if (!DOMAIN_RE.test(domain)) return { ok: false, error: `Invalid domain name: "${domain}"` };

  return { ok: true, domain, all: false, dryRun };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const parsed = parseStructureArgs(process.argv.slice(2));
  if (parsed.help) { console.log(USAGE); process.exit(0); }
  if (!parsed.ok) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    process.exit(1);
  }
  const { domain, all, dryRun } = parsed;

  // Load config to find domainsDir
  let domainsDir;
  try {
    const { getDomainsDir } = await import('../src/brain/config.js');
    domainsDir = getDomainsDir();
  } catch {
    domainsDir = path.join(ROOT, 'domains');
  }

  if (dryRun) console.log('DRY RUN — no files will be changed\n');

  if (all) {
    const entries = await readdir(domainsDir, { withFileTypes: true });
    const domains = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
    if (!domains.length) { console.log('No domains found.'); return; }
    console.log(`Migrating ALL ${domains.length} domain(s) in ${domainsDir}`);
    for (const d of domains) {
      await fixDomain(path.join(domainsDir, d.name), dryRun);
    }
  } else {
    const domainPath = path.join(domainsDir, domain);
    if (!existsSync(path.join(domainPath, 'wiki'))) {
      console.error(`No wiki found for domain "${domain}" (looked in ${path.join(domainPath, 'wiki')}).`);
      process.exit(1);
    }
    await fixDomain(domainPath, dryRun);
  }

  console.log('\nDone. Review the changes above, then re-open your Obsidian vault to refresh.\n');
}

// Run main() ONLY when this file is the entry point. Without this guard,
// importing the module (as the arg-parser test does) would execute a
// destructive migration as a side effect of the import.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(err => { console.error(err); process.exit(1); });
}
