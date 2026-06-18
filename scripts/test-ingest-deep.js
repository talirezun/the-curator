#!/usr/bin/env node
/**
 * In-depth ingest pipeline stress test (v3.0.1-beta.8+).
 *
 * Runs the FULL production ingest pipeline (live Gemini Flash calls)
 * across a battery of synthetic + real-world inputs designed to exercise
 * every code path and every safety net in src/brain/ingest.js +
 * src/brain/files.js + src/brain/llm.js. The output of each ingest is
 * then run through a strict quality-metric checker — broken-link scan,
 * backlink bidirectionality, zero-byte file detection, frontmatter
 * validation, etc. — so we catch issues the user would otherwise see
 * weeks later when their wiki health scan turns up problems.
 *
 * Test scenarios:
 *
 *   SYN-1  tiny baseline (≤2k chars)         — single-pass path
 *   SYN-2  trunk-cluster trigger             — verifies trunk detector
 *   SYN-3  JSON-stressor content             — verifies parseJSON resilience
 *   SYN-4  multi-phase (>15k chars)          — verifies multi-phase path
 *   SYN-5  honorific author with diacritic   — verifies originator hint
 *   SYN-6  empty file                        — verifies empty-extraction guard
 *   SYN-7  near-empty (<200 chars)           — verifies MIN_TEXT_LEN guard
 *   SYN-8  re-ingest SYN-1 (idempotency)     — verifies merge correctness
 *   REAL-1 The_Energy_and_Water_Footprint    — full real-world re-ingest
 *
 * Quality metrics applied to every successful ingest:
 *
 *   Q1.  Atomic-write contract     — no zero-byte files, no orphan .tmp-*
 *   Q2.  Frontmatter present       — every page has YAML frontmatter block
 *   Q3.  Type tag present          — entity/concept/summary type tag set
 *   Q4.  Summary structure         — Entities Mentioned section populated
 *   Q5.  Wikilink resolution       — every [[link]] resolves to a file
 *   Q6.  Backlink bidirectionality — every entity in Entities Mentioned
 *                                    has the summary in its Related section
 *   Q7.  Index integrity           — every wiki page has an index row
 *   Q8.  Log entry present         — log.md has the ingest entry
 *   Q9.  Health-clean              — scanWiki reports 0 structural issues
 *   Q10. No stub markers (unless deliberate)
 *
 * Isolation:
 *   - Uses a dedicated domain `in-depth-ingest-test` (NOT in the user's
 *     real config — config file is moved aside for the duration)
 *   - Tempdir DOMAINS_PATH, fully cleaned up at end
 *
 * Requirements:
 *   GEMINI_API_KEY env var set (or .curator-config.json with geminiApiKey)
 *
 * Run:
 *   node scripts/test-ingest-deep.js
 *
 * Exit code 0 on green; non-zero on any failure.
 *
 * Run with --quick to skip the real-world REAL-1 test (saves ~30s of
 * live LLM time when iterating on the synthetic suite).
 */

import {
  mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync,
  existsSync, readdirSync, statSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const INPUTS_DIR = path.join(__dirname, 'test-ingest-deep-inputs');

const QUICK = process.argv.includes('--quick');

// ── Setup: isolated tempdir + config sidelined ────────────────────────────
// CURATOR_TEST_DOMAINS_DIR beats config; plain DOMAINS_PATH loses to a
// configured domainsPath and would write into the real domains/ folder.
const tempRoot = mkdtempSync(path.join(tmpdir(), 'curator-deep-ingest-'));
process.env.CURATOR_TEST_DOMAINS_DIR = tempRoot;

const realConfig = path.join(PROJECT_ROOT, '.curator-config.json');
const sidelinedConfig = realConfig + '.deep-test-bak';
let configStashed = false;
let savedGeminiKey = process.env.GEMINI_API_KEY;
if (existsSync(realConfig)) {
  // Read the key from the config BEFORE moving it aside, so that the test
  // can run even if the user only configured the key in the UI.
  try {
    const cfg = JSON.parse(readFileSync(realConfig, 'utf8'));
    if (cfg.geminiApiKey && !savedGeminiKey) {
      process.env.GEMINI_API_KEY = cfg.geminiApiKey;
      savedGeminiKey = cfg.geminiApiKey;
    }
  } catch { /* ignore — fall back to env */ }
  copyFileSync(realConfig, sidelinedConfig);
  rmSync(realConfig);
  configStashed = true;
}

let exitCode = 0;
const issuesFound = [];

function logIssue(level, scenario, msg, detail) {
  issuesFound.push({ level, scenario, msg, detail });
}

async function cleanup() {
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (configStashed) {
    try { copyFileSync(sidelinedConfig, realConfig); rmSync(sidelinedConfig); } catch {}
  }
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

// ── Test plumbing ─────────────────────────────────────────────────────────
let totalAssertions = 0, passedAssertions = 0;
const scenarioResults = [];

function startScenario(name, description) {
  const sc = { name, description, passed: 0, failed: 0, warnings: [], issues: [] };
  scenarioResults.push(sc);
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${name} — ${description}`);
  console.log('═'.repeat(72));
  return sc;
}

function ok(sc, label) {
  totalAssertions++; passedAssertions++; sc.passed++;
  console.log(`  ✓ ${label}`);
}
function fail(sc, label, detail) {
  totalAssertions++; sc.failed++;
  exitCode = 1;
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`    └─ ${detail}`);
  sc.issues.push({ label, detail });
  logIssue('FAIL', sc.name, label, detail);
}
function warn(sc, label, detail) {
  console.log(`  ⚠ ${label}`);
  if (detail) console.log(`    └─ ${detail}`);
  sc.warnings.push({ label, detail });
  logIssue('WARN', sc.name, label, detail);
}
function assertTrue(sc, cond, label, detail) { if (cond) return ok(sc, label); return fail(sc, label, detail); }
function assertEq(sc, actual, expected, label) {
  if (actual === expected) return ok(sc, label);
  return fail(sc, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Quality metric checks (shared) ────────────────────────────────────────

function walkMdFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMdFiles(full, base));
    else if (entry.name.endsWith('.md')) {
      out.push({ rel: path.relative(base, full), abs: full, name: entry.name });
    }
  }
  return out;
}

function extractWikilinks(content) {
  // [[target]] or [[target|alias]] — skip code blocks first
  const stripped = content
    .replace(/```[\s\S]*?```/g, '')   // fenced code blocks
    .replace(/`[^`]*`/g, '');           // inline code
  const links = [];
  const re = /\[\[([^\]|#\n]+?)(\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    links.push(m[1].trim());
  }
  return links;
}

function pageExists(wikiDir, slug) {
  // Slug may be "concepts/foo", "entities/bar", "summaries/baz", or bare "foo"
  if (slug.includes('/')) {
    return existsSync(path.join(wikiDir, slug + '.md'));
  }
  // Bare slug — could be in entities/ or concepts/
  return existsSync(path.join(wikiDir, 'entities', slug + '.md')) ||
         existsSync(path.join(wikiDir, 'concepts', slug + '.md'));
}

function extractFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_-]+)\s*:\s*(.+?)\s*$/);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '');
  }
  return fm;
}

function checkQualityMetrics(sc, wikiDir, ingestResult) {
  const pages = walkMdFiles(wikiDir);
  console.log(`\n  Quality checks (${pages.length} wiki files):`);

  // Q1. Atomic write contract — no zero-byte files, no orphan .tmp-* anywhere
  {
    let zeroByte = 0, tmpFiles = 0;
    function scan(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(full); continue; }
        if (entry.name.startsWith('.tmp-')) tmpFiles++;
        if (entry.name.endsWith('.md')) {
          const st = statSync(full);
          if (st.size === 0) {
            zeroByte++;
            warn(sc, `zero-byte file: ${path.relative(wikiDir, full)}`);
          }
        }
      }
    }
    scan(wikiDir);
    assertEq(sc, zeroByte, 0, 'Q1a: no zero-byte .md files (atomic write contract)');
    assertEq(sc, tmpFiles, 0, 'Q1b: no orphan .tmp-* files');
  }

  // Q2. Frontmatter present on every entity/concept/summary page
  {
    let missing = 0;
    for (const p of pages) {
      if (p.name === 'index.md' || p.name === 'log.md' || p.name === 'CLAUDE.md') continue;
      const content = readFileSync(p.abs, 'utf8');
      const fm = extractFrontmatter(content);
      if (!fm) {
        missing++;
        warn(sc, `Q2: ${p.rel} missing frontmatter`);
      }
    }
    assertEq(sc, missing, 0, 'Q2: every wiki page has YAML frontmatter');
  }

  // Q3. Type tag in frontmatter matches folder
  {
    let mismatched = 0;
    for (const p of pages) {
      if (p.name === 'index.md' || p.name === 'log.md') continue;
      const content = readFileSync(p.abs, 'utf8');
      const folder = p.rel.split(path.sep)[0];
      const expectedType = folder === 'entities' ? 'type/entity'
                         : folder === 'concepts' ? 'type/concept'
                         : folder === 'summaries' ? 'type/summary' : null;
      if (!expectedType) continue;
      if (!content.includes(expectedType)) {
        mismatched++;
        warn(sc, `Q3: ${p.rel} missing ${expectedType} tag`);
      }
    }
    assertEq(sc, mismatched, 0, 'Q3: every page has the correct type/* tag for its folder');
  }

  // Q4. Summary structure — Entities Mentioned populated
  {
    const summaries = pages.filter(p => p.rel.startsWith('summaries' + path.sep));
    for (const s of summaries) {
      const content = readFileSync(s.abs, 'utf8');
      const hasSection = /^##\s+Entities Mentioned/m.test(content);
      assertTrue(sc, hasSection,
        `Q4: summary ${s.name} has "Entities Mentioned" section`);
      if (hasSection) {
        // Count entities listed
        const section = content.split(/^##\s+Entities Mentioned\s*$/m)[1] || '';
        const nextSection = section.search(/^##\s+/m);
        const block = nextSection >= 0 ? section.slice(0, nextSection) : section;
        const bullets = block.match(/^- /gm) || [];
        if (bullets.length === 0) {
          warn(sc, `Q4: summary ${s.name} has Entities Mentioned section but no bullets`);
        }
      }
    }
  }

  // Q5. Wikilink resolution — every [[link]] resolves to a file
  {
    let totalLinks = 0, brokenLinks = 0;
    const brokenSamples = [];
    for (const p of pages) {
      if (p.name === 'index.md' || p.name === 'log.md') continue;  // index/log have raw paths, not [[]]
      const content = readFileSync(p.abs, 'utf8');
      const links = extractWikilinks(content);
      for (const link of links) {
        totalLinks++;
        if (!pageExists(wikiDir, link)) {
          brokenLinks++;
          if (brokenSamples.length < 8) brokenSamples.push(`${p.rel} → [[${link}]]`);
        }
      }
    }
    if (brokenLinks === 0) {
      ok(sc, `Q5: every wikilink resolves (${totalLinks} links checked)`);
    } else {
      // Broken links are a quality issue but not a test failure — they're a
      // known LLM-compliance failure; the goal is to MEASURE how many slip
      // through and track over time. Warn, don't fail (unless many).
      const pct = ((brokenLinks / totalLinks) * 100).toFixed(1);
      const msg = `${brokenLinks} of ${totalLinks} wikilinks broken (${pct}%)`;
      if (brokenLinks / totalLinks > 0.10) {
        fail(sc, `Q5: too many broken wikilinks`, `${msg}. Samples: ${brokenSamples.slice(0, 5).join('; ')}`);
      } else if (brokenLinks > 0) {
        warn(sc, `Q5: ${msg}`, `Samples: ${brokenSamples.slice(0, 5).join('; ')}`);
      }
    }
  }

  // Q6. Backlink bidirectionality — every entity in summary's Entities
  //     Mentioned section has a backlink to the summary
  {
    const summaries = pages.filter(p => p.rel.startsWith('summaries' + path.sep));
    for (const s of summaries) {
      const sContent = readFileSync(s.abs, 'utf8');
      const sectMatch = sContent.match(/^##\s+Entities Mentioned\s*\n([\s\S]*?)(?=^##\s+|\Z)/m);
      if (!sectMatch) continue;
      const entitySlugs = [];
      for (const line of sectMatch[1].split('\n')) {
        const linkMatch = line.match(/-\s*\[\[([^\]|#\n]+?)(\|[^\]]+)?\]\]/);
        if (linkMatch) entitySlugs.push(linkMatch[1].trim());
      }
      const summarySlug = s.name.replace(/\.md$/, '');
      const summaryFolderSlug = `summaries/${summarySlug}`;
      let missingBacklinks = 0;
      const missingSamples = [];
      for (const eSlug of entitySlugs) {
        // Find the entity/concept file
        const ePath = ['entities', 'concepts']
          .map(f => path.join(wikiDir, f, eSlug + '.md'))
          .find(p => existsSync(p));
        if (!ePath) {
          missingBacklinks++;
          if (missingSamples.length < 5) missingSamples.push(`${eSlug} → file not found`);
          continue;
        }
        const eContent = readFileSync(ePath, 'utf8');
        // The backlink is [[summaries/<slug>]] (with prefix) — that's the
        // convention enforced by injectSummaryBacklinks
        if (!eContent.includes(`[[${summaryFolderSlug}]]`)) {
          missingBacklinks++;
          if (missingSamples.length < 5) missingSamples.push(`${eSlug}`);
        }
      }
      if (missingBacklinks === 0 && entitySlugs.length > 0) {
        ok(sc, `Q6: ${entitySlugs.length} entities in summary all have backlinks`);
      } else if (missingBacklinks > 0) {
        warn(sc, `Q6: ${missingBacklinks} of ${entitySlugs.length} entities missing backlink to ${summarySlug}`,
          missingSamples.join('; '));
      }
    }
  }

  // Q7. Index has rows for written pages
  {
    const indexPath = path.join(wikiDir, 'index.md');
    if (existsSync(indexPath)) {
      const indexContent = readFileSync(indexPath, 'utf8');
      let missingFromIndex = 0;
      const missingSamples = [];
      for (const p of pages) {
        if (p.name === 'index.md' || p.name === 'log.md') continue;
        if (p.rel.startsWith('summaries' + path.sep)) continue;  // summaries listed elsewhere
        const slug = p.name.replace(/\.md$/, '');
        if (!indexContent.includes(`[[${slug}]]`) && !indexContent.includes(slug)) {
          missingFromIndex++;
          if (missingSamples.length < 5) missingSamples.push(p.rel);
        }
      }
      if (missingFromIndex === 0) {
        ok(sc, 'Q7: index has rows for all entity/concept pages');
      } else {
        warn(sc, `Q7: ${missingFromIndex} pages missing from index`, missingSamples.join('; '));
      }
    }
  }

  // Q8. Log entry present
  {
    const logPath = path.join(wikiDir, 'log.md');
    if (existsSync(logPath)) {
      const logContent = readFileSync(logPath, 'utf8');
      assertTrue(sc, logContent.includes('ingest'), 'Q8: log.md has an ingest entry');
    } else {
      warn(sc, 'Q8: log.md does not exist');
    }
  }

  // Q10. Stub-page detection (warn, not fail — stubs are sometimes deliberate)
  {
    let stubs = 0;
    for (const p of pages) {
      const content = readFileSync(p.abs, 'utf8');
      if (content.includes('Stub page — AI failed to write')) {
        stubs++;
        warn(sc, `Q10: stub page found: ${p.rel}`);
      }
    }
    if (stubs === 0) ok(sc, 'Q10: no stub-page markers');
  }
}

// ── Async run logic ──────────────────────────────────────────────────────

async function runIngest(domain, sourcePath, originalName, sc) {
  // Load late so DOMAINS_PATH is in effect
  const { ingestFile } = await import('../src/brain/ingest.js');
  const stagedPath = path.join(tempRoot, originalName);
  copyFileSync(sourcePath, stagedPath);

  let lastPct = 0;
  const startTime = Date.now();
  const result = await ingestFile(
    domain,
    stagedPath,
    originalName,
    false,
    (ev) => {
      if (ev.pct && ev.pct !== lastPct) {
        process.stdout.write(`\r    [${String(ev.pct).padStart(3)}%] ${(ev.message || '').slice(0, 50).padEnd(50)}`);
        lastPct = ev.pct;
      }
    }
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Ingest completed in ${elapsed}s — ${result.pagesWritten.length} pages.`);

  if (result.warnings && result.warnings.length > 0) {
    console.log('\n  Validator warnings:');
    for (const w of result.warnings) {
      console.log(`    • ${w.slice(0, 120)}${w.length > 120 ? '…' : ''}`);
    }
  }
  return result;
}

async function runHealthScan(domain, sc) {
  const { scanWiki } = await import('../src/brain/health.js');
  try {
    const report = await scanWiki(domain);
    const counts = {
      brokenLinks: report.brokenLinks?.length || 0,
      orphans: report.orphans?.length || 0,
      folderPrefixLinks: report.folderPrefixLinks?.length || 0,
      crossFolderDupes: report.crossFolderDupes?.length || 0,
      hyphenVariants: report.hyphenVariants?.length || 0,
      missingBacklinks: report.missingBacklinks?.length || 0,
    };
    console.log('\n  Health scan:');
    for (const [k, v] of Object.entries(counts)) {
      console.log(`    ${k.padEnd(20)} ${v}`);
    }
    assertEq(sc, counts.folderPrefixLinks, 0, 'Q9a: 0 folder-prefix link violations');
    assertEq(sc, counts.crossFolderDupes, 0, 'Q9b: 0 cross-folder duplicate files');
    assertEq(sc, counts.hyphenVariants, 0, 'Q9c: 0 hyphen-variant duplicate files');
    if (counts.brokenLinks > 0) {
      warn(sc, `Q9d: Health flagged ${counts.brokenLinks} broken links`,
        report.brokenLinks.slice(0, 3).map(b => `${b.file} → [[${b.link}]]`).join('; '));
    } else {
      ok(sc, 'Q9d: 0 broken links');
    }
    if (counts.orphans > 0) {
      warn(sc, `Q9e: ${counts.orphans} orphan pages`,
        report.orphans.slice(0, 5).map(o => o.file || o).join(', '));
    } else {
      ok(sc, 'Q9e: 0 orphan pages');
    }
    if (counts.missingBacklinks > 0) {
      warn(sc, `Q9f: ${counts.missingBacklinks} missing backlinks (auto-fixable)`);
    } else {
      ok(sc, 'Q9f: 0 missing backlinks');
    }
    return report;
  } catch (err) {
    warn(sc, 'Q9: health scan threw', err.message);
    return null;
  }
}

async function createTestDomain(domainName) {
  const { createDomain } = await import('../src/brain/files.js');
  await createDomain(domainName, 'Deep Ingest Test', 'In-depth stress test of the ingest pipeline', 'tech');
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  In-depth ingest pipeline stress test');
  console.log(`  DOMAINS_PATH = ${tempRoot}`);
  console.log(`  Mode: ${QUICK ? 'QUICK (synthetic only)' : 'FULL (synthetic + real-world)'}`);
  console.log('═══════════════════════════════════════════════════════════════════════');

  if (!process.env.GEMINI_API_KEY) {
    console.error('\nERROR: GEMINI_API_KEY not set and no key found in .curator-config.json.');
    console.error('Cannot run live LLM tests. Configure a key and try again.');
    await cleanup();
    process.exit(2);
  }

  // ── SYN-1: tiny baseline ───────────────────────────────────────────────
  {
    const sc = startScenario('SYN-1', 'tiny baseline (~1.5k chars) — single-pass path');
    await createTestDomain('syn1');
    const result = await runIngest('syn1', path.join(INPUTS_DIR, '01-tiny-baseline.md'), '01-tiny-baseline.md', sc);
    assertTrue(sc, result.pagesWritten.length >= 3, 'baseline produced ≥ 3 pages',
      `got ${result.pagesWritten.length}`);
    const wikiDir = path.join(tempRoot, 'syn1', 'wiki');
    checkQualityMetrics(sc, wikiDir, result);
    await runHealthScan('syn1', sc);
  }

  // ── SYN-2: trunk-cluster trigger ───────────────────────────────────────
  {
    const sc = startScenario('SYN-2', 'trunk-cluster trigger — verifies trunk-page detector fires');
    await createTestDomain('syn2');
    const result = await runIngest('syn2', path.join(INPUTS_DIR, '02-trunk-cluster.md'), '02-trunk-cluster.md', sc);

    // The article develops "memory" as 5 sibling concepts. The trunk
    // detector should inject `concepts/memory.md` if not present. (We
    // expect either the detector to fire OR the LLM to do the right
    // thing — either way, concepts/memory.md should exist.)
    const memoryParentExists = result.pagesWritten.includes('concepts/memory.md');
    assertTrue(sc, memoryParentExists,
      'SYN-2: concepts/memory.md exists (either via LLM compliance or trunk detector)',
      `pagesWritten: ${result.pagesWritten.filter(p => p.includes('memory')).join(', ')}`);

    // Whether the warning fired tells us which path we took
    const trunkWarning = (result.warnings || []).find(w => w.includes('without a parent'));
    if (trunkWarning) {
      ok(sc, 'SYN-2: trunk detector warning emitted (LLM omitted, detector injected)');
    } else if (memoryParentExists) {
      ok(sc, 'SYN-2: LLM produced the parent without needing the detector');
    }

    const wikiDir = path.join(tempRoot, 'syn2', 'wiki');
    checkQualityMetrics(sc, wikiDir, result);
    await runHealthScan('syn2', sc);
  }

  // ── SYN-3: JSON stressor ─────────────────────────────────────────────
  {
    const sc = startScenario('SYN-3', 'JSON-stressor content — verifies parseJSON resilience under contentions');
    await createTestDomain('syn3');
    let result;
    try {
      result = await runIngest('syn3', path.join(INPUTS_DIR, '03-json-stressor.md'), '03-json-stressor.md', sc);
    } catch (err) {
      fail(sc, 'SYN-3: ingest threw despite JSON-stressor content', err.message);
      return;
    }
    assertTrue(sc, result.pagesWritten.length >= 3, 'SYN-3: produced ≥ 3 pages',
      `got ${result.pagesWritten.length}`);
    const wikiDir = path.join(tempRoot, 'syn3', 'wiki');
    checkQualityMetrics(sc, wikiDir, result);
    await runHealthScan('syn3', sc);
  }

  // ── SYN-4: multi-phase trigger ────────────────────────────────────────
  {
    const sc = startScenario('SYN-4', 'multi-phase (>15k chars) — verifies outline + batched content path');
    await createTestDomain('syn4');
    const result = await runIngest('syn4', path.join(INPUTS_DIR, '04-multi-phase.md'), '04-multi-phase.md', sc);
    assertTrue(sc, result.pagesWritten.length >= 5,
      'SYN-4: large doc produced ≥ 5 pages', `got ${result.pagesWritten.length}`);
    const wikiDir = path.join(tempRoot, 'syn4', 'wiki');
    checkQualityMetrics(sc, wikiDir, result);
    await runHealthScan('syn4', sc);
  }

  // ── SYN-5: honorific author with diacritic ───────────────────────────
  {
    const sc = startScenario('SYN-5', 'honorific author + diacritic — verifies originator hint + slug normalisation');
    await createTestDomain('syn5');
    const result = await runIngest('syn5', path.join(INPUTS_DIR, '05-honorific-author.md'), '05-honorific-author.md', sc);

    const wikiDir = path.join(tempRoot, 'syn5', 'wiki');
    const entitiesDir = path.join(wikiDir, 'entities');
    const entityFiles = existsSync(entitiesDir) ? readdirSync(entitiesDir).filter(f => f.endsWith('.md')) : [];

    // Should land on exactly ONE author file — canonical tali-rezun.md
    const taliVariants = entityFiles.filter(f => f.toLowerCase().includes('tali') || f.toLowerCase().includes('rezun'));
    assertEq(sc, taliVariants.length, 1, 'SYN-5: exactly one Tali Rezun file (no honorific variants)');
    if (taliVariants.length === 1) {
      assertEq(sc, taliVariants[0], 'tali-rezun.md',
        'SYN-5: canonical slug is "tali-rezun.md" (no honorific, no diacritic)');
    } else if (taliVariants.length > 1) {
      warn(sc, 'SYN-5: multiple variants found', taliVariants.join(', '));
    }

    checkQualityMetrics(sc, wikiDir, result);
    await runHealthScan('syn5', sc);
  }

  // ── SYN-6: empty file ────────────────────────────────────────────────
  {
    const sc = startScenario('SYN-6', 'empty file — verifies empty-extraction guard refuses gracefully');
    await createTestDomain('syn6');
    let caught = null;
    try {
      await runIngest('syn6', path.join(INPUTS_DIR, '06-empty.txt'), '06-empty.txt', sc);
      fail(sc, 'SYN-6: ingest should have refused empty file but did not throw');
    } catch (err) {
      caught = err;
    }
    if (caught) {
      assertTrue(sc, /too little|extract|OCR|encrypted|empty|character/i.test(caught.message),
        'SYN-6: empty-extraction guard threw a recognisable refusal message',
        caught.message.slice(0, 200));

      // Raw file should be rolled back so retry isn't 409-blocked
      const rawDir = path.join(tempRoot, 'syn6', 'raw');
      const rawFile = path.join(rawDir, '06-empty.txt');
      assertEq(sc, existsSync(rawFile), false,
        'SYN-6: raw file rolled back on extraction failure');
    }
  }

  // ── SYN-7: near-empty (<200 chars) ──────────────────────────────────
  {
    const sc = startScenario('SYN-7', 'near-empty (<200 chars) — verifies MIN_TEXT_LEN guard');
    await createTestDomain('syn7');
    let caught = null;
    try {
      await runIngest('syn7', path.join(INPUTS_DIR, '07-near-empty.txt'), '07-near-empty.txt', sc);
      fail(sc, 'SYN-7: ingest should have refused near-empty file');
    } catch (err) {
      caught = err;
    }
    if (caught) {
      assertTrue(sc, /too little|character|empty|OCR/i.test(caught.message),
        'SYN-7: near-empty guard threw a recognisable refusal message',
        caught.message.slice(0, 200));
    }
  }

  // ── SYN-8: re-ingest SYN-1 (idempotency) ────────────────────────────
  {
    const sc = startScenario('SYN-8', 're-ingest SYN-1 — verifies merge-not-duplicate behaviour');
    // Use the SYN-1 wiki that already exists; re-ingest the same file
    const result = await runIngest('syn1', path.join(INPUTS_DIR, '01-tiny-baseline.md'), '01-tiny-baseline.md', sc);
    assertTrue(sc, result.pagesWritten.length >= 1, 'SYN-8: re-ingest produced page records');

    // Count summary files — there must be exactly one
    const summariesDir = path.join(tempRoot, 'syn1', 'wiki', 'summaries');
    const summaryFiles = existsSync(summariesDir) ? readdirSync(summariesDir).filter(f => f.endsWith('.md')) : [];
    assertEq(sc, summaryFiles.length, 1, 'SYN-8: still exactly one summary file after re-ingest');

    // Check that no entity slug has a duplicate (-2 suffix, honorific variant)
    const entitiesDir = path.join(tempRoot, 'syn1', 'wiki', 'entities');
    const entityFiles = existsSync(entitiesDir) ? readdirSync(entitiesDir).filter(f => f.endsWith('.md')) : [];
    const normSlugs = entityFiles.map(f => f.replace(/-/g, '').toLowerCase());
    const uniqSlugs = new Set(normSlugs);
    assertEq(sc, normSlugs.length, uniqSlugs.size,
      'SYN-8: no hyphen-variant or near-duplicate entity files',
      `${entityFiles.join(', ')}`);

    // Index has no duplicate rows
    const indexContent = readFileSync(path.join(tempRoot, 'syn1', 'wiki', 'index.md'), 'utf8');
    const allRows = indexContent.match(/\|\s*\[\[[^\]]+\]\]/g) || [];
    const uniqRows = new Set(allRows);
    assertEq(sc, allRows.length, uniqRows.size,
      'SYN-8: index has no duplicate rows after re-ingest');

    await runHealthScan('syn1', sc);
  }

  // ── SYN-9: hub-shaped source (v3.0.1-beta.11) ───────────────────────
  // Verifies the post-batch linkification pass: a source that lists 8
  // sibling sub-techniques under one umbrella should produce a hub
  // concept page with [[wikilinks]] to all 8 children.
  {
    const sc = startScenario('SYN-9', 'hub-shaped source — verifies post-batch linkification');
    await createTestDomain('syn9');
    const result = await runIngest('syn9', path.join(INPUTS_DIR, '08-hub-shape.md'), '08-hub-shape.md', sc);
    const wikiDir = path.join(tempRoot, 'syn9', 'wiki');
    checkQualityMetrics(sc, wikiDir, result);

    // The hub itself should be a concept page. Find it (filename match)
    // and confirm the body has wikilinks to ≥4 of the 8 children.
    const conceptsDir = path.join(wikiDir, 'concepts');
    const conceptFiles = existsSync(conceptsDir) ? readdirSync(conceptsDir).filter(f => f.endsWith('.md')) : [];
    const hubCandidate = conceptFiles.find(f => f.includes('visual') || f.includes('note-taking'));
    if (hubCandidate) {
      const hubContent = readFileSync(path.join(conceptsDir, hubCandidate), 'utf8');
      const linkCount = (hubContent.match(/\[\[[^\]|#\n]+/g) || []).length;
      assertTrue(sc, linkCount >= 4,
        `SYN-9: hub page "${hubCandidate}" has ≥4 wikilinks to siblings (got ${linkCount})`);
    } else {
      warn(sc, 'SYN-9: no clear hub page found (LLM may have structured differently than expected)');
    }

    // The linkification report should have surfaced as a warning when it fired
    const linkifyWarning = (result.warnings || []).find(w => w.includes('Hub linkification'));
    if (linkifyWarning) {
      ok(sc, 'SYN-9: linkification warning emitted — hub pass actively added links');
    }

    await runHealthScan('syn9', sc);
  }

  // ── SYN-10: Jaccard semantic-dupe (related-articles scenario) ───────
  // Ingest two articles about the same concept with singular vs plural
  // surface forms. With beta.11 Jaccard guard, only one entity/concept
  // file should remain — the plural form redirects onto the existing
  // singular form.
  {
    const sc = startScenario('SYN-10', 'Jaccard semantic-dupe — two articles, singular vs plural');
    await createTestDomain('syn10');
    // Pass 1: singular form
    const result1 = await runIngest('syn10', path.join(INPUTS_DIR, '09a-roundup-singular.md'), '09a-roundup-singular.md', sc);
    assertTrue(sc, result1.pagesWritten.length >= 2,
      'SYN-10a: first article produced ≥2 pages');

    // Pass 2: plural form
    const result2 = await runIngest('syn10', path.join(INPUTS_DIR, '09b-roundup-plural.md'), '09b-roundup-plural.md', sc);
    assertTrue(sc, result2.pagesWritten.length >= 1,
      'SYN-10b: second article produced ≥1 page');

    // Now verify: only ONE concept page about expert-roundup should exist
    const conceptsDir = path.join(tempRoot, 'syn10', 'wiki', 'concepts');
    const conceptFiles = existsSync(conceptsDir) ? readdirSync(conceptsDir).filter(f => f.endsWith('.md')) : [];
    const roundupFiles = conceptFiles.filter(f =>
      f.toLowerCase().includes('roundup') || f.toLowerCase().includes('round-up'));

    // We accept 1 (perfect dedup) or 2 (the guard fired with a warning but
    // didn't auto-redirect because Jaccard fell in the warn band). Both are
    // acceptable behaviour. We REJECT 3+ which would indicate runaway drift.
    assertTrue(sc, roundupFiles.length <= 2,
      `SYN-10c: at most 2 roundup-related concept files (got ${roundupFiles.length}): ${roundupFiles.join(', ')}`);

    // Look for the guard's warning in either ingest's warnings list
    const semDupeWarning = [...(result1.warnings || []), ...(result2.warnings || [])]
      .find(w => w.includes('Jaccard') || w.includes('near-duplicate'));
    if (roundupFiles.length === 1 && semDupeWarning) {
      ok(sc, 'SYN-10d: Jaccard guard actively redirected the plural variant');
    } else if (roundupFiles.length === 1) {
      ok(sc, 'SYN-10d: only one concept file — LLM may have used the same slug both times');
    } else if (roundupFiles.length === 2 && semDupeWarning) {
      ok(sc, 'SYN-10d: Jaccard guard fired warning even if did not auto-redirect (warn band)');
    } else {
      warn(sc, `SYN-10d: 2 roundup files exist without a Jaccard warning — review`);
    }

    const wikiDir = path.join(tempRoot, 'syn10', 'wiki');
    checkQualityMetrics(sc, wikiDir, result2);
    await runHealthScan('syn10', sc);
  }

  // ── REAL-1: real-world re-ingest ────────────────────────────────────
  if (!QUICK) {
    const sc = startScenario('REAL-1', 'real-world re-ingest of The_Energy_and_Water_Footprint_of_Generative_AI');
    const realArticle = path.join(PROJECT_ROOT, 'domains/articles/raw/The_Energy_and_Water_Footprint_of_Generative_AI.pdf');
    if (!existsSync(realArticle)) {
      warn(sc, 'REAL-1: source article not found, skipping');
    } else {
      await createTestDomain('real1');
      const result = await runIngest('real1', realArticle, 'The_Energy_and_Water_Footprint_of_Generative_AI.pdf', sc);
      assertTrue(sc, result.pagesWritten.length >= 8,
        'REAL-1: real article produced ≥ 8 pages', `got ${result.pagesWritten.length}`);
      const wikiDir = path.join(tempRoot, 'real1', 'wiki');
      checkQualityMetrics(sc, wikiDir, result);
      await runHealthScan('real1', sc);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  Summary');
  console.log('═'.repeat(72));
  console.log(`\n  Scenarios: ${scenarioResults.length}`);
  for (const sc of scenarioResults) {
    const status = sc.failed === 0 ? '✓' : '✗';
    const warns = sc.warnings.length > 0 ? ` (${sc.warnings.length} warnings)` : '';
    console.log(`  ${status} ${sc.name}: ${sc.passed} passed, ${sc.failed} failed${warns}`);
  }
  console.log(`\n  Total assertions: ${passedAssertions} passed of ${totalAssertions}`);
  console.log(`  Failures: ${totalAssertions - passedAssertions}`);

  if (issuesFound.length > 0) {
    console.log('\n  Issues collected (for analysis):');
    for (const i of issuesFound.slice(0, 30)) {
      console.log(`    [${i.level}] ${i.scenario}: ${i.msg}${i.detail ? ` — ${i.detail.slice(0, 80)}` : ''}`);
    }
    if (issuesFound.length > 30) {
      console.log(`    ... +${issuesFound.length - 30} more`);
    }
  }

  await cleanup();
  process.exit(exitCode);
}

main().catch(async err => {
  console.error('\nFATAL:', err.message);
  console.error(err.stack);
  await cleanup();
  process.exit(2);
});
