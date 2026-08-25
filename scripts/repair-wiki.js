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
 *   3. Pronoun corrections on ONE named entity page — opt-in, off by default
 *      (see the fixPronouns docblock for the env vars that enable it).
 *   4. Re-runs backlink injection to cover concept pages that were missed.
 *
 * THIS SCRIPT IS DESTRUCTIVE — it rewrites and deletes wiki files. It therefore
 * refuses to guess which domain you meant: there is no default domain, and an
 * unrecognised flag is an error rather than something silently ignored. (Before
 * this guard, `--domain=business` was silently skipped by the positional parser
 * and the script repaired the hardcoded `articles` domain instead.)
 *
 * Usage:
 *   node scripts/repair-wiki.js <domain>
 *   node scripts/repair-wiki.js --domain=<domain>
 *   node scripts/repair-wiki.js <domain> --dry-run
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

// ── Part 3: Pronoun corrections on one named entity page (opt-in) ───────────

/**
 * Pronoun forms used to build the replacement list. Only the forms the anchored
 * phrases below actually consume are listed.
 */
const PRONOUN_FORMS = {
  she:  { subject: 'She',  possessive: 'Her'   },
  he:   { subject: 'He',   possessive: 'His'   },
  they: { subject: 'They', possessive: 'Their' },
};

export const PRONOUN_ENV = {
  page: 'CURATOR_REPAIR_PRONOUN_PAGE',
  from: 'CURATOR_REPAIR_PRONOUN_FROM',
  to:   'CURATOR_REPAIR_PRONOUN_TO',
};

/**
 * Reads the opt-in pronoun-repair configuration from the environment.
 *
 * Returns `{ enabled: false }` when nothing is configured (the normal case —
 * this repair is off unless a user explicitly asks for it), `{ enabled: true,
 * ... }` when fully and validly configured, or `{ enabled: true, error }` when
 * partially or invalidly configured. A half-configured request is an error
 * rather than a silent skip: silently ignoring input the user supplied is the
 * bug class this file exists to have fixed.
 *
 * ENFORCED: `from`/`to` are known pronoun sets and differ; `page` is a
 * wiki-relative `.md` path with no absolute prefix and no `..` segment.
 * NOT ENFORCED: whether the page is actually about a person, or whether every
 * pronoun on it refers to that person — see buildPronounReplacements.
 */
export function readPronounConfig(env = process.env) {
  const page = (env[PRONOUN_ENV.page] || '').trim();
  const from = (env[PRONOUN_ENV.from] || '').trim().toLowerCase();
  const to   = (env[PRONOUN_ENV.to]   || '').trim().toLowerCase();

  if (!page && !from && !to) return { enabled: false };

  const missing = [
    !page && PRONOUN_ENV.page,
    !from && PRONOUN_ENV.from,
    !to   && PRONOUN_ENV.to,
  ].filter(Boolean);
  if (missing.length) {
    return { enabled: true, error: `pronoun repair is partially configured — also set ${missing.join(' and ')}` };
  }
  if (!Object.hasOwn(PRONOUN_FORMS, from) || !Object.hasOwn(PRONOUN_FORMS, to)) {
    const known = Object.keys(PRONOUN_FORMS).join(', ');
    return { enabled: true, error: `${PRONOUN_ENV.from}/${PRONOUN_ENV.to} must each be one of: ${known}` };
  }
  if (from === to) {
    return { enabled: true, error: `${PRONOUN_ENV.from} and ${PRONOUN_ENV.to} are both "${from}" — nothing to change` };
  }
  if (path.isAbsolute(page) || page.split(/[\\/]/).includes('..')) {
    return { enabled: true, error: `${PRONOUN_ENV.page} must be a wiki-relative path with no ".." segment` };
  }
  if (!page.endsWith('.md')) {
    return { enabled: true, error: `${PRONOUN_ENV.page} must name a .md page (e.g. entities/some-person.md)` };
  }
  return { enabled: true, page, from, to };
}

/**
 * Builds the ordered replacement list for a pronoun direction.
 *
 * DELIBERATELY NARROW. It rewrites only a fixed set of ANCHORED phrases
 * ("She founded", "Her work", "Her methodology", "through her" and their
 * lowercase forms). It does NOT rewrite bare pronouns, because a page about one
 * person routinely mentions others and a global she→he sweep would corrupt
 * sentences about them. Consequence, stated rather than hidden: this misses
 * every pronoun outside those anchors.
 */
export function buildPronounReplacements(from, to) {
  const f = PRONOUN_FORMS[from];
  const t = PRONOUN_FORMS[to];
  if (!f || !t) return [];
  const pairs = [
    [`${f.subject} founded`,      `${t.subject} founded`],
    [`${f.possessive} work`,      `${t.possessive} work`],
    [`${f.possessive} methodology`, `${t.possessive} methodology`],
    [`through ${f.possessive.toLowerCase()}`, `through ${t.possessive.toLowerCase()}`],
  ];
  const out = [];
  for (const [a, b] of pairs) {
    out.push([new RegExp(`\\b${a}\\b`, 'g'), b]);
    const aLower = a.charAt(0).toLowerCase() + a.slice(1);
    const bLower = b.charAt(0).toLowerCase() + b.slice(1);
    if (aLower !== a) out.push([new RegExp(`\\b${aLower}\\b`, 'g'), bLower]);
  }
  return out;
}

/** Applies a replacement list to a string. Exported for testing. */
export function applyPronounReplacements(content, replacements) {
  let out = content;
  for (const [re, to] of replacements) out = out.replace(re, to);
  return out;
}

async function fixPronouns(wikiDir, dryRun, cfg) {
  if (!cfg.enabled) {
    console.log(`  Skipped — not configured (set ${PRONOUN_ENV.page}, ${PRONOUN_ENV.from}, ${PRONOUN_ENV.to} to enable).`);
    return 0;
  }
  if (cfg.error) {
    console.warn(`  Skipped — ${cfg.error}`);
    return 0;
  }

  const file = path.join(wikiDir, cfg.page);
  if (!existsSync(file)) {
    console.warn(`  Skipped — no such page: ${cfg.page}`);
    return 0;
  }

  const original = await readFile(file, 'utf8');
  const content = applyPronounReplacements(original, buildPronounReplacements(cfg.from, cfg.to));

  if (content !== original) {
    console.log(`  FIX    ${cfg.page}: corrected ${cfg.from} → ${cfg.to} pronouns`);
    if (!dryRun) await writeFile(file, content, 'utf8');
    return 1;
  }
  return 0;
}

// ── Argument parsing ────────────────────────────────────────────────────────

/** A domain name must be a single path segment — it is interpolated into a path. */
const DOMAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const USAGE = [
  'Usage:',
  '  node scripts/repair-wiki.js <domain>',
  '  node scripts/repair-wiki.js --domain=<domain>',
  '',
  'Options:',
  '  --dry-run    Report what would change without writing or deleting anything.',
  '  --help       Show this message.',
  '',
  'This script rewrites and DELETES wiki files, so it never guesses a domain:',
  'there is no default and no "all domains" mode. Name exactly one domain.',
].join('\n');

/**
 * Parses repair-wiki argv (the tokens AFTER the script path).
 *
 * Pure — no filesystem, no environment, no process.exit. Returns
 * `{ ok: true, domain, dryRun }`, `{ ok: false, help: true }`, or
 * `{ ok: false, error }`.
 *
 * ENFORCED: exactly one domain is named, via a positional OR `--domain=`
 * (both accepted; both documented forms have existed in this repo); an
 * unrecognised flag is an error; a `--domain=` and a positional that disagree
 * are an error; the domain is a single safe path segment.
 * NOT ENFORCED: that the domain exists — main() checks that against disk.
 */
export function parseRepairArgs(argv) {
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
    // silently ignoring "--domain=x" is exactly how this script came to repair
    // the wrong domain.
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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const parsed = parseRepairArgs(process.argv.slice(2));
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
    console.error(`No wiki found for domain "${domain}" (looked in ${wikiDir}).`);
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

  // Part 3: Fix pronouns (opt-in; see readPronounConfig)
  console.log('\n── Part 3: Pronoun fixes ─────────────────────');
  const pronounCfg = readPronounConfig();
  const pronounFixes = await fixPronouns(wikiDir, dryRun, pronounCfg);
  if (pronounFixes === 0 && pronounCfg.enabled && !pronounCfg.error) {
    console.log('  No pronoun issues found.');
  }

  // Part 4: Re-run backlink injection to cover concepts
  console.log('\n── Part 4: Re-inject summary backlinks ───────');
  if (!dryRun) {
    try {
      // execFileSync, not execSync: no shell, so `domain` cannot be interpreted
      // as shell syntax. (DOMAIN_RE already refuses such names; this is the
      // second, independent layer.)
      const { execFileSync } = await import('child_process');
      execFileSync(process.execPath, [
        path.join(ROOT, 'scripts', 'inject-summary-backlinks.js'),
        `--domain=${domain}`,
      ], {
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

// Run main() ONLY when this file is the entry point. Without this guard,
// importing the module (as the arg-parser test does) would execute a
// destructive repair as a side effect of the import.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(err => { console.error(err); process.exit(1); });
}
