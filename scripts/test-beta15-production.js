#!/usr/bin/env node
/**
 * v3.0.1-beta.15 — PRODUCTION end-to-end test with REAL API keys.
 *
 * Validates the five fixes against the live LLM providers the way real users
 * hit them. Unlike the offline suite (test-beta15-fixes.js, pure logic), this
 * exercises the full pipeline: real ingest, real semantic-merge file surgery,
 * real compile, on a throwaway domain that is created and deleted each run.
 *
 * Providers:
 *   • Gemini   — the default for most users. Run if a Gemini key is configured
 *                (.curator-config.json or GEMINI_API_KEY).
 *   • Anthropic — where the token-limit bug actually fired (Haiku). Run if an
 *                Anthropic key resolves. NOTE: this machine's shell exports an
 *                empty ANTHROPIC_API_KEY which shadows .env, so we load .env
 *                with { override: true } to recover the real key (the .app
 *                launcher doesn't have that stale export, so production is fine).
 *
 * Safety: the active provider is forced via .curator-config.json, which is
 * backed up and restored byte-for-byte in `finally`. Throwaway domains
 * (zztest-beta15-*) are deleted in `finally`. No user domain is touched.
 *
 * Run:  node scripts/test-beta15-production.js
 * Exit: 0 if all green; non-zero on any failure.
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });   // recover the real ANTHROPIC key (see header)

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, '.curator-config.json');

// Isolate every createDomain() into a throwaway tempdir (beats config) so this
// test never touches the real domains/ folder on a configured machine.
const DOMAINS_TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-beta15-domains-'));
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_TMP;
process.on('exit', () => { try { rmSync(DOMAINS_TMP, { recursive: true, force: true }); } catch {} });

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) { cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`)); }
function section(t) { console.log(`\n${t}`); }

// Errors that indicate a REGRESSION of the token-limit fix — if any ingest/
// compile throws with these, the fix is broken.
const FATAL_TOKEN_STRINGS = ['Streaming is strongly recommended', '> 64000', '> 8192'];

// ── helpers ───────────────────────────────────────────────────────────────────

let cfgMod, files, ingestMod, compileMod, healthMod;

async function loadModules() {
  cfgMod    = await import('../src/brain/config.js');
  files     = await import('../src/brain/files.js');
  ingestMod = await import('../src/brain/ingest.js');
  compileMod = await import('../src/brain/compile.js');
  healthMod = await import('../src/brain/health.js');
}

function forceProvider(provider) {
  const cfg = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
  cfg.activeProvider = provider;
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

async function freshDomain(slug, display) {
  try { await files.deleteDomain(slug); } catch { /* none */ }
  await files.createDomain(slug, display, 'Throwaway beta15 production test', 'generic');
}

// Count wikilinks that don't resolve to an existing page (broken-link rate).
async function brokenLinkCount(domain) {
  try {
    const report = await healthMod.scanWiki(domain);
    return (report.brokenLinks || []).length;
  } catch { return -1; }
}

// ── per-provider live suite (LLM-dependent scenarios) ──────────────────────────

async function runProviderSuite(provider) {
  section(`\n══════════ PROVIDER: ${provider.toUpperCase()} ══════════`);
  forceProvider(provider);

  // Confirm the provider actually resolves with a usable key before spending.
  const active = cfgMod.getActiveProvider ? cfgMod.getActiveProvider() : provider;
  const key = cfgMod.getEffectiveKey(provider);
  ok(active === provider, `[${provider}] provider resolves to ${provider} (got ${active})`);
  if (!key) { ok(false, `[${provider}] no usable key — skipping live scenarios`); return; }

  const domain = `zztest-beta15-${provider}`;
  const tmp = mkdtempSync(path.join(os.tmpdir(), `curator-b15-${provider}-`));
  try {
    await freshDomain(domain, `ZZ beta15 ${provider}`);

    // ── S1: LARGE multi-phase ingest (Fix #2 — the headline) ──
    // ingestion-pipeline.md is ~27k chars of dense technical prose → forces the
    // multi-phase path (Phase 1 outline + batched Phase 2). On Haiku a dense
    // batch can hit the 16384 output cap; before beta.15 that KILLED the whole
    // ingest. Now it must recover and complete.
    section(`S1 [${provider}] — large multi-phase ingest recovers + completes`);
    // Use the committed docs/ingestion-pipeline.md (~35k chars of dense technical
    // prose) as the large source — it ships in the repo, so this works on CI and
    // any clean checkout. The assertions below are behaviour-based (no
    // token-limit crash, pages written, prose preserved), not content-specific.
    const bigSrc = path.join(ROOT, 'docs/ingestion-pipeline.md');
    const bigCopy = path.join(tmp, 'big-source.md');
    writeFileSync(bigCopy, readFileSync(bigSrc, 'utf8'));
    try {
      const res = await ingestMod.ingestFile(domain, bigCopy, 'big-source.md');
      ok(Array.isArray(res.pagesWritten) && res.pagesWritten.length > 3,
        `[${provider}] large ingest wrote pages (${res.pagesWritten?.length || 0})`);
      ok(res.pagesWritten.some(p => p.startsWith('summaries/')),
        `[${provider}] large ingest produced a summary page`);
      // The fix's signature: any token-limit became a RECOVERY warning, not a crash.
      const recovered = (res.warnings || []).some(w => /output limit|individually instead|more concise plan/i.test(w));
      console.log(`     ↳ warnings: ${(res.warnings || []).length}${recovered ? ' (includes a token-limit RECOVERY — exactly the fix firing)' : ''}`);
      const broken = await brokenLinkCount(domain);
      console.log(`     ↳ broken wikilinks after ingest: ${broken}`);
      ok(broken >= 0, `[${provider}] wiki is scannable after large ingest (broken=${broken})`);
    } catch (e) {
      const msg = e.message || '';
      for (const s of FATAL_TOKEN_STRINGS) ok(!msg.includes(s), `[${provider}] large ingest: no "${s}" regression`);
      ok(false, `[${provider}] large multi-phase ingest threw: ${msg.slice(0, 200)}`);
    }

    // ── S4: compile after a SINGLE user message (Fix #5) ──
    section(`S4 [${provider}] — compile a 1-user-message conversation`);
    const convId = '00000000-0000-4000-8000-0000000b1500';
    await files.writeConversation(domain, {
      id: convId,
      title: 'Why compiled knowledge beats RAG',
      createdAt: new Date().toISOString(),
      domain,
      messages: [
        { role: 'user', content: 'Explain why The Curator compiles knowledge into a wiki instead of using retrieval-augmented generation, and what the trade-offs are.' },
        { role: 'assistant', content: 'The Curator integrates each source into persistent markdown pages on ingest, so cross-references between entities and concepts are pre-built and the whole wiki can fit in one LLM context window. RAG instead fetches raw chunks at query time. The trade-off: compiling costs more up front and can lose nuance during synthesis, but retrieval is faster to set up yet re-derives structure on every query and cannot reason over the global graph.' },
      ],
    });
    try {
      const res = await compileMod.compileConversation(domain, convId);
      ok(res.ok === true, `[${provider}] 1-message compile succeeded (ok=${res.ok}${res.error ? `, error="${res.error}"` : ''}${res.reason ? `, reason="${res.reason}"` : ''})`);
      if (res.ok) ok(Array.isArray(res.pagesWritten) && res.pagesWritten.length > 0,
        `[${provider}] 1-message compile wrote pages (${res.pagesWritten?.length || 0})`);
    } catch (e) {
      ok(false, `[${provider}] 1-message compile threw: ${(e.message || '').slice(0, 200)}`);
    }
  } finally {
    try { await files.deleteDomain(domain); } catch { /* best effort */ }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ── provider-agnostic live: batch merge through real file surgery (Fix #4) ─────
// Uses a real semantic scan to find duplicates, then the batch merge. Runs under
// whatever provider is active when called.

async function runBatchMergeSuite(provider) {
  section(`\n══════════ BATCH MERGE (Fix #4) on ${provider.toUpperCase()} ══════════`);
  forceProvider(provider);
  const domain = `zztest-beta15-merge`;
  try {
    await freshDomain(domain, 'ZZ beta15 merge');
    const wiki = files.wikiPath(domain);

    // Two obvious near-duplicate concept pairs + a referencing page + a distinct
    // page (so the domain isn't trivially small for the pre-filter).
    await files.writePage(domain, 'concepts/machine-learning.md',
      '# Machine Learning\n\n## Definition\nMachine learning is a field of AI where systems learn patterns from data rather than being explicitly programmed.\n\n## Key Facts\n- Supervised, unsupervised, reinforcement learning are the main paradigms\n- Powers modern prediction systems\n');
    await files.writePage(domain, 'concepts/machine-learning-ml.md',
      '# Machine Learning (ML)\n\n## Definition\nMachine learning (ML) is the area of artificial intelligence in which systems learn patterns directly from data instead of following hand-written rules.\n\n## Key Facts\n- The three paradigms are supervised, unsupervised, and reinforcement learning\n- Underlies modern predictive applications\n');
    await files.writePage(domain, 'concepts/neural-networks.md',
      '# Neural Networks\n\n## Definition\nNeural networks are layered models of interconnected nodes that learn representations from data, loosely inspired by the brain.\n\n## Key Facts\n- Built from layers of weighted nodes\n- Trained via backpropagation\n');
    await files.writePage(domain, 'concepts/neural-nets.md',
      '# Neural Nets\n\n## Definition\nNeural nets are layered networks of interconnected units that learn data representations, loosely modelled on the brain.\n\n## Key Facts\n- Composed of weighted node layers\n- Learn through backpropagation\n');
    await files.writePage(domain, 'concepts/gradient-descent.md',
      '# Gradient Descent\n\n## Definition\nAn optimization algorithm that iteratively steps parameters in the direction that reduces a loss function.\n\n## Related\n- [[neural-nets]] use it for training\n');
    await files.writePage(domain, 'summaries/intro-to-ml.md',
      '# Intro to ML\n\n## Concepts Introduced or Referenced\n- [[machine-learning-ml]] is the core topic\n- [[neural-nets]] are a key method\n');

    const beforeBroken = await brokenLinkCount(domain);
    console.log(`     ↳ broken links before merge: ${beforeBroken}`);

    // Real semantic scan to obtain high-confidence pairs.
    section(`S3a [${provider}] — semantic scan finds the planted duplicates`);
    const pairs = [];
    try {
      const settings = cfgMod.getAiHealthSettings();
      const aiMod = await import('../src/brain/health-ai.js');
      await aiMod.scanSemanticDuplicates(domain, {
        maxPairs: settings.semanticDupeMaxPairs,
        costCeilingTokens: settings.costCeilingTokens,
      }, (ev) => { if (ev.type === 'pair') pairs.push(ev.pair); });
    } catch (e) {
      console.log(`     ↳ scan error: ${(e.message || '').slice(0, 160)}`);
    }
    const highConf = pairs.filter(p => (p.confidence || 'medium') === 'high');
    console.log(`     ↳ scan found ${pairs.length} pairs, ${highConf.length} high-confidence`);
    ok(pairs.length >= 1, `[${provider}] scan surfaced at least one duplicate pair`);

    // Use the scan's high-confidence pairs if any; otherwise construct from the
    // known planted dups so the destructive merge path is always exercised.
    let toMerge = highConf;
    if (toMerge.length === 0) {
      console.log('     ↳ no high-confidence pairs from scan — using planted pairs to exercise the merge mechanics');
      toMerge = [
        { keepSlug: 'machine-learning', keepFolder: 'concepts', removeSlug: 'machine-learning-ml', removeFolder: 'concepts' },
        { keepSlug: 'neural-networks', keepFolder: 'concepts', removeSlug: 'neural-nets', removeFolder: 'concepts' },
      ];
    }

    // Snapshot which remove-slugs we expect to disappear + which links should move.
    section(`S3b [${provider}] — batch merge deletes dups + rewrites links + no new broken links`);
    let progressCount = 0;
    const result = await healthMod.fixSemanticDuplicatesBatch(domain, toMerge, () => { progressCount++; });
    ok(result.total === toMerge.length, `batch processed all ${toMerge.length} pairs (total=${result.total})`);
    ok(progressCount === toMerge.length, `progress fired once per pair (${progressCount})`);
    ok(result.merged + result.skipped + result.errors === result.total, 'merged+skipped+errors === total');
    ok(result.errors === 0, `no errors during batch merge (errors=${result.errors})`);

    // Verify each merged remove file is gone and keep file remains.
    for (const r of result.results) {
      if (r.status !== 'merged') continue;
      const removeGone = !existsSync(path.join(wiki, 'concepts', r.removeSlug + '.md')) &&
                         !existsSync(path.join(wiki, 'entities', r.removeSlug + '.md'));
      ok(removeGone, `merged "${r.removeSlug}" file deleted`);
    }

    // No dangling links to a removed slug should remain anywhere.
    const afterBroken = await brokenLinkCount(domain);
    console.log(`     ↳ broken links after merge: ${afterBroken}`);
    ok(afterBroken <= Math.max(0, beforeBroken), `no NEW broken links introduced by merge (before=${beforeBroken}, after=${afterBroken})`);

    // The referencing summary must now point at the kept slug, not the removed one.
    const mergedRemoves = result.results.filter(r => r.status === 'merged').map(r => r.removeSlug);
    if (mergedRemoves.length) {
      const { readWikiPages } = files;
      let anyDangling = false;
      const allFiles = await files.readWikiPages(domain);
      for (const f of allFiles) {
        for (const slug of mergedRemoves) {
          const re = new RegExp(`\\[\\[(?:concepts/|entities/|summaries/)?${slug}(\\||\\])`);
          if (re.test(f.content || '')) anyDangling = true;
        }
      }
      ok(!anyDangling, 'no surviving [[link]] to any merged-away slug');
    }
  } finally {
    try { await files.deleteDomain(domain); } catch { /* best effort */ }
  }
}

// ── provider-agnostic, NO LLM: prose preservation through real writePage ───────

async function runProseSuite() {
  section('\n══════════ PROSE PRESERVATION (Fix #1, no LLM) ══════════');
  const domain = 'zztest-beta15-prose';
  try {
    await freshDomain(domain, 'ZZ beta15 prose');
    const wiki = files.wikiPath(domain);

    // First write: a rich entity page with prose sections.
    await files.writePage(domain, 'concepts/curation.md',
      '# Curation\n\n## Definition\nCuration is the deliberate selection and arrangement of knowledge with a clear point of view.\n\n## Why It Matters\nWithout a viewpoint, curation collapses into mere link-sharing. The act of curating leaves a trace of judgment.\n\n## Key Facts\n- Requires domain competence\n- Is a form of applied metacognition\n');

    // Second write: a THIN update that drops the prose (only Key Facts + Related).
    const rec = await files.writePage(domain, 'concepts/curation.md',
      '# Curation\n\n## Key Facts\n- Leaves an auditable trace\n\n## Related\n- [[metacognition]]\n');
    ok(!!rec, 'thin re-write returned a change record');

    const finalPath = path.join(wiki, 'concepts', 'curation.md');
    const finalContent = readFileSync(finalPath, 'utf8');
    ok(/## Definition/.test(finalContent), 'Definition section preserved after thin update');
    ok(/deliberate selection and arrangement/.test(finalContent), 'Definition prose body preserved');
    ok(/## Why It Matters/.test(finalContent), 'Why It Matters section preserved');
    ok(/collapses into mere link-sharing/.test(finalContent), 'Why It Matters prose body preserved');
    ok(/Requires domain competence/.test(finalContent), 'existing Key Facts bullet accumulated');
    ok(/Leaves an auditable trace/.test(finalContent), 'new Key Facts bullet present');
    ok(/\[\[metacognition\]\]/.test(finalContent), 'new Related link present');
    // No duplicated headings.
    ok((finalContent.match(/## Definition/g) || []).length === 1, 'Definition heading appears exactly once');
  } finally {
    try { await files.deleteDomain(domain); } catch { /* best effort */ }
  }
}

// ── main ───────────────────────────────────────────────────────────────────────

let configBackup = null;
(async () => {
  await loadModules();
  configBackup = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;

  const geminiKey = cfgMod.getEffectiveKey('gemini');
  const anthropicKey = cfgMod.getEffectiveKey('anthropic');
  console.log(`Providers available — gemini: ${!!geminiKey}, anthropic: ${!!anthropicKey}`);

  try {
    // No-LLM deterministic check first (cheap, fast).
    await runProseSuite();

    // Gemini: full suite (the default provider for most users).
    if (geminiKey) {
      await runProviderSuite('gemini');
      await runBatchMergeSuite('gemini');
    } else {
      console.log('\n⏭  Gemini key not found — skipping Gemini scenarios.');
    }

    // Anthropic: the token-limit-critical scenarios (large ingest + compile).
    if (anthropicKey) {
      await runProviderSuite('anthropic');
    } else {
      console.log('\n⏭  Anthropic key not found — skipping Anthropic scenarios.');
    }
  } finally {
    if (configBackup !== null) writeFileSync(CONFIG_FILE, configBackup, 'utf8');
    // Belt-and-suspenders cleanup of any throwaway domains.
    for (const d of ['zztest-beta15-gemini', 'zztest-beta15-anthropic', 'zztest-beta15-merge', 'zztest-beta15-prose']) {
      try { await files.deleteDomain(d); } catch { /* */ }
    }
    console.log('\n🧹 cleanup done — config restored, throwaway domains removed.');
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`beta.15 PRODUCTION: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  • ' + f)); process.exit(1); }
  console.log('All green ✓');
})().catch(err => {
  // Restore config even on a top-level throw.
  if (configBackup !== null) { try { writeFileSync(CONFIG_FILE, configBackup, 'utf8'); } catch {} }
  console.error('\n💥 Production test harness crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
