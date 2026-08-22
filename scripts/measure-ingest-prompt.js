#!/usr/bin/env node
/**
 * measure-ingest-prompt.js — MANUAL measurement harness for the v3.0.16 ingest
 * prompt-size work. NOT part of `npm test` / `npm run test:live`.
 *
 * It answers two questions on REAL data:
 *   1. How big is each ingest prompt now, versus before the change?
 *   2. What does an ingest actually cost in tokens? (opt-in, spends money)
 *
 * READ-ONLY by default. The default mode never writes to the wiki, never calls
 * an LLM, and never costs anything: it reads the domain's entity/concept
 * filenames + index.md, extracts the source text, and rebuilds every prompt both
 * the v3.0.15 way and the current way. NOTE: as shipped in v3.0.16 these are
 * BYTE-IDENTICAL for the outline and single-pass prompts — the index-removal
 * experiment was deferred (see this file's note below). The remaining delta is
 * the batch prompt's prefix/suffix split, which enables caching without
 * changing prompt size.
 *
 * USAGE
 *   # Free, read-only. Prints before/after prompt sizes per phase.
 *   node scripts/measure-ingest-prompt.js --domain=articles --source=path/to/file.pdf
 *
 *   # Same, but using a file already in the domain's raw/ folder by name:
 *   node scripts/measure-ingest-prompt.js --domain=articles --raw="Some Article.pdf"
 *
 *   # List what is available if you are not sure:
 *   node scripts/measure-ingest-prompt.js --domain=articles --list
 *
 *   # ALSO run a real ingest against the configured provider and report the
 *   # true token spend via opts.onUsage. THIS COSTS MONEY AND WRITES PAGES.
 *   # Use a throwaway domain.
 *   node scripts/measure-ingest-prompt.js --domain=zztest --source=file.md --live
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getDomainsDir } from '../src/brain/config.js';
import { readIndex, wikiPath, rawPath } from '../src/brain/files.js';
import {
  capExistingFilesForPrompt,
  computeSummarySlugFromSource,
  __testing as ingestTesting,
} from '../src/brain/ingest.js';

const { buildOutlinePrompt, buildPrompt, buildBatchPromptParts } = ingestTesting;

// ── args ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  })
);
const domain = args.domain;
if (!domain) {
  console.error('Usage: node scripts/measure-ingest-prompt.js --domain=<name> --source=<file> [--raw=<name>] [--list] [--live]');
  process.exit(1);
}

const TEXT_CAP = ingestTesting.TEXT_CAP;
const BATCH_SIZE = 4;                       // mirrors ingest.js
const kb = n => `${(n / 1024).toFixed(1)} KB`;
const pct = (a, b) => (b === 0 ? 'n/a' : `${(((b - a) / b) * 100).toFixed(1)}% smaller`);
// Rough, for orientation only. Real counts come from --live's onUsage.
const approxTokens = chars => Math.round(chars / 4);

async function extractText(filePath) {
  if (filePath.toLowerCase().endsWith('.pdf')) {
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    return (await pdfParse(await readFile(filePath))).text;
  }
  return readFile(filePath, 'utf8');
}

async function main() {
  const domainsDir = getDomainsDir();
  const wikiDir = wikiPath(domain);
  const rawDir = rawPath(domain);

  const existingFiles = {
    entities: await readdir(path.join(wikiDir, 'entities')).then(f => f.filter(x => x.endsWith('.md'))).catch(() => []),
    concepts: await readdir(path.join(wikiDir, 'concepts')).then(f => f.filter(x => x.endsWith('.md'))).catch(() => []),
  };
  const index = await readIndex(domain).catch(() => '');

  if (args.list) {
    const raws = await readdir(rawDir).catch(() => []);
    console.log(`domains dir : ${domainsDir}`);
    console.log(`domain      : ${domain}`);
    console.log(`entities    : ${existingFiles.entities.length}`);
    console.log(`concepts    : ${existingFiles.concepts.length}`);
    console.log(`index.md    : ${index.length} bytes`);
    console.log(`raw/ files  :\n${raws.map(r => `  ${r}`).join('\n') || '  (none)'}`);
    return;
  }

  const sourcePath = args.source
    ? path.resolve(String(args.source))
    : args.raw ? path.join(rawDir, String(args.raw)) : null;
  if (!sourcePath) {
    console.error('Give me a source: --source=<path> or --raw=<filename in the domain raw/ folder>, or --list.');
    process.exit(1);
  }
  await stat(sourcePath);   // fail loudly if it does not exist

  const originalName = path.basename(sourcePath);
  const fullText = await extractText(sourcePath);
  const text = fullText.slice(0, TEXT_CAP);
  const today = new Date().toISOString().slice(0, 10);
  const summaryPath = `summaries/${computeSummarySlugFromSource(originalName)}.md`;

  const capped = capExistingFilesForPrompt(existingFiles, text);
  const promptFiles = capped.files;

  console.log('─'.repeat(72));
  console.log(`Domain        : ${domain}   (${domainsDir})`);
  console.log(`Source        : ${originalName}  — ${kb(fullText.length)} extracted${fullText.length > TEXT_CAP ? `, capped to ${kb(text.length)}` : ''}`);
  console.log(`index.md      : ${kb(index.length)}`);
  console.log(`entity files  : ${existingFiles.entities.length}  → ${promptFiles.entities.length} in prompt`);
  console.log(`concept files : ${existingFiles.concepts.length}  → ${promptFiles.concepts.length} in prompt`);
  for (const w of capped.warnings) console.log(`  ⚠ ${w}`);
  console.log('─'.repeat(72));

  // ── Phase 1 / single-pass ────────────────────────────────────────────────
  // v3.0.16 ships the caching + reorder work; the index-removal experiment was
  // DEFERRED, so these two prompts are byte-identical to v3.0.15. They are
  // reported as an absolute size (and broken into terms) rather than a
  // before/after, because for them there is no delta.
  const outline = buildOutlinePrompt(today, index, promptFiles, originalName, text, false, summaryPath);
  const single  = buildPrompt(today, index, promptFiles, originalName, text, false, false, summaryPath);
  const invChars = promptFiles.entities.reduce((n, f) => n + f.length + 12, 0)
                 + promptFiles.concepts.reduce((n, f) => n + f.length + 12, 0);

  console.log('\nPHASE 1 — outline prompt   (unchanged from v3.0.15: index removal deferred)');
  console.log(`  size   : ${outline.length} chars / ${kb(outline.length)}  (~${approxTokens(outline.length)} tok)`);
  console.log(`  terms  : index ${index.length} + inventory ${invChars} + source ${text.length} + instructions ~${outline.length - index.length - invChars - text.length}`);
  console.log('\nSINGLE-PASS prompt (documents under 15k chars)   (unchanged from v3.0.15)');
  console.log(`  size   : ${single.length} chars / ${kb(single.length)}  (~${approxTokens(single.length)} tok)`);
  console.log('  note   : ONE call — no cache breakpoint is set (an Anthropic cache write costs 1.25x).');

  // ── Phase 2 batches ──────────────────────────────────────────────────────
  // The batch prompt NEVER contained index.md, so its size is unchanged too —
  // its entire win is the prefix/suffix split plus Anthropic prompt caching.
  const simulated = Array.from({ length: 20 }, (_, i) => ({
    path: i === 0 ? summaryPath : `concepts/simulated-page-${i}.md`,
    summary: 'simulated one-line description for measurement',
  }));
  const totalBatches = Math.ceil(simulated.length / BATCH_SIZE);
  const parts = buildBatchPromptParts(today, originalName, text, simulated.slice(0, BATCH_SIZE), promptFiles, simulated);
  const whole = parts.prefix.length + parts.suffix.length;

  console.log(`\nPHASE 2 — batch prompt (simulated ${simulated.length}-page outline → ${totalBatches} batches)`);
  console.log(`  size   : ${whole} chars / ${kb(whole)} per call  (~${approxTokens(whole)} tok) — unchanged in SIZE`);
  console.log(`  split  : cacheable prefix ${parts.prefix.length} chars (~${approxTokens(parts.prefix.length)} tok) + volatile suffix ${parts.suffix.length} chars`);
  console.log(`  index  : ${parts.prefix.includes('Current wiki index:') ? 'PRESENT (unexpected!)' : 'absent — never was in this prompt'}`);
  {
    const p = approxTokens(parts.prefix.length), sfx = approxTokens(parts.suffix.length);
    for (const n of [totalBatches, 7]) {
      const uncached = (p + sfx) * n;
      const cached = (p * 1.25 + sfx) + (p * 0.1 + sfx) * (n - 1);
      console.log(`  Anthropic caching, ${n} batches: ~${uncached} → ~${Math.round(cached)} equivalent input tok  (−${(((uncached - cached) / uncached) * 100).toFixed(0)}%)`);
    }
    console.log(`  (write 1.25x once, read ~0.1x thereafter; prefix must be >= 4096 tok on claude-haiku-4-5 — it is)`);
  }
  console.log('─'.repeat(72));

  if (!args.live) {
    console.log('\nRead-only mode. Nothing was written and no LLM was called.');
    console.log('Add --live to run a REAL ingest and report true token usage (costs money, writes pages).');
    return;
  }

  // ── LIVE: real ingest, real token usage ──────────────────────────────────
  console.log('\n⚠ LIVE MODE — running a real ingest. This calls the configured provider and WRITES wiki pages.');
  const { ingestFile } = await import('../src/brain/ingest.js');
  const t0 = Date.now();
  const result = await ingestFile(domain, sourcePath, originalName, false, ev => {
    if (ev.type === 'progress') process.stderr.write(`  … ${ev.pct}% ${ev.message}\n`);
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const u = result.tokenUsage || {};
  console.log('\nREAL TOKEN USAGE');
  console.log(`  provider/model : ${u.provider}/${u.model}`);
  console.log(`  LLM calls      : ${u.calls}   (${secs}s wall clock)`);
  console.log(`  input tokens   : ${u.inputTokens}`);
  console.log(`  output tokens  : ${u.outputTokens}`);
  console.log(`  cached reads   : ${u.cachedReadTokens}`);
  console.log(`  cache writes   : ${u.cacheWriteTokens}`);
  console.log(`  pages written  : ${result.pagesWritten.length}`);
  if (result.warnings.length) {
    console.log('  warnings:');
    for (const w of result.warnings) console.log(`    - ${w}`);
  }
}

main().catch(err => { console.error(`\n✗ ${err.stack || err.message}`); process.exit(1); });
