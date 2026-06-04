#!/usr/bin/env node
/**
 * v3.0.1-beta.17 — PRODUCTION end-to-end test: bulk orphan rescue, fix-all-safe,
 * and the orphan-apply security hardening. Real LLM on BOTH providers.
 *
 *  • Orphan rescue (Gemini + Anthropic Haiku): plant an orphan + a related page,
 *    run the real AI plan, apply, verify the orphan gains an incoming link.
 *  • Security (no LLM): a hand-crafted plan with a malicious orphanSlug /
 *    non-existent slug must be REJECTED — no markdown/link injection, no phantom.
 *  • fix-all-safe (no LLM): plant a folder-prefix issue on disk, one-click fix,
 *    verify it's resolved and the re-scan is clean.
 *
 * Config force-switched + restored; throwaway domains created + deleted.
 * Run: node scripts/test-beta17-production.js
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, '.curator-config.json');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) { cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`)); }
function section(t) { console.log(`\n${t}`); }

let cfgMod, files, healthAi, health;
let configBackup = null;

function forceProvider(p) {
  const cfg = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
  cfg.activeProvider = p;
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
async function fresh(domain) {
  try { await files.deleteDomain(domain); } catch {}
  await files.createDomain(domain, 'ZZ beta17', 'throwaway', 'generic');
}

async function orphanSuite(provider) {
  section(`\n══════════ ORPHAN RESCUE on ${provider.toUpperCase()} ══════════`);
  forceProvider(provider);
  if (!cfgMod.getEffectiveKey(provider)) { ok(false, `[${provider}] no key — skipped`); return; }
  const domain = `zztest-beta17-${provider}`;
  try {
    await fresh(domain);
    const wiki = files.wikiPath(domain);
    // A well-connected page + an ORPHAN clearly related to it.
    await files.writePage(domain, 'concepts/machine-learning.md', '# Machine Learning\n\n## Definition\nSystems that learn patterns from data.\n\n## Related\n- [[gradient-descent]]\n');
    await files.writePage(domain, 'concepts/gradient-descent.md', '# Gradient Descent\n\n## Definition\nOptimization that steps toward lower loss. Used to train [[machine-learning]] models.\n');
    // Orphan: nothing links to it, but it's clearly about machine learning.
    await files.writePage(domain, 'concepts/backpropagation.md', '# Backpropagation\n\n## Definition\nThe algorithm that computes gradients through a neural network so machine learning models can be trained by gradient descent.\n');

    const before = await health.scanWiki(domain);
    const orphanBefore = (before.orphans || []).some(o => o.slug === 'backpropagation');
    ok(orphanBefore, `[${provider}] backpropagation is an orphan before rescue`);

    section(`[${provider}] — plan + apply orphan rescue (real LLM)`);
    const planRes = await healthAi.planOrphanRescue(domain, {}, () => {});
    const entry = planRes.plan.find(p => p.orphanSlug === 'backpropagation');
    ok(!!entry, `[${provider}] AI found a home for backpropagation (→ ${entry ? entry.target : 'none'})`);

    const applyRes = await health.applyOrphanRescue(domain, planRes.plan, () => {});
    ok(applyRes.rescued >= 1, `[${provider}] apply rescued ≥1 orphan (${applyRes.rescued})`);

    const after = await health.scanWiki(domain);
    const stillOrphan = (after.orphans || []).some(o => o.slug === 'backpropagation');
    ok(!stillOrphan, `[${provider}] backpropagation is NO LONGER an orphan after rescue`);
    // And no broken links were introduced.
    ok((after.brokenLinks || []).length === 0, `[${provider}] no broken links introduced by rescue`);
  } finally {
    try { await files.deleteDomain(domain); } catch {}
  }
}

async function securitySuite() {
  section('\n══════════ ORPHAN-APPLY SECURITY (no LLM) ══════════');
  forceProvider('gemini');
  const domain = 'zztest-beta17-sec';
  try {
    await fresh(domain);
    const wiki = files.wikiPath(domain);
    await files.writePage(domain, 'concepts/target-page.md', '# Target Page\n\n## Definition\nA real page.\n');
    await files.writePage(domain, 'concepts/real-orphan.md', '# Real Orphan\n\n## Definition\nAn orphan.\n');

    // Malicious + invalid plan entries that must ALL be rejected.
    const maliciousPlan = [
      { orphanSlug: 'real-orphan]] — see [[target-page', target: 'target-page', description: 'x' },  // injection in slug
      { orphanSlug: '../../etc/passwd', target: 'target-page', description: 'traversal' },               // traversal
      { orphanSlug: 'does-not-exist', target: 'target-page', description: 'phantom orphan' },            // orphan not on disk
      { orphanSlug: 'real-orphan', target: 'no-such-target', description: 'bad target' },                // target not on disk
      { orphanSlug: 'real-orphan', target: 'target-page', description: 'inject [[evil]] link' },         // desc injection
    ];
    const res = await health.applyOrphanRescue(domain, maliciousPlan, () => {});
    // Only the LAST entry is valid (real-orphan → target-page); its description
    // must be sanitised (no [[evil]]).
    ok(res.rescued === 1, `exactly 1 of 5 entries applied (the only valid one) — got ${res.rescued}`);
    ok(res.skipped === 4, `4 malicious/invalid entries rejected — got ${res.skipped}`);

    const target = readFileSync(path.join(wiki, 'concepts', 'target-page.md'), 'utf8');
    ok(/\[\[real-orphan\]\]/.test(target), 'the one valid orphan link was injected');
    ok(!/\[\[evil\]\]/.test(target), 'description injection [[evil]] was stripped');
    ok(!/etc\/passwd/.test(target), 'traversal slug never written');
    ok(!/see \[\[target-page/.test(target), 'injection-shaped slug never written as a second link');
    // The injected bullet must reference ONLY real-orphan, not a fabricated link.
    const links = (target.match(/\[\[[^\]]+\]\]/g) || []);
    ok(links.every(l => l === '[[real-orphan]]'), `only [[real-orphan]] present (found: ${links.join(', ')})`);
  } finally {
    try { await files.deleteDomain(domain); } catch {}
  }
}

async function fixAllSafeSuite() {
  section('\n══════════ FIX-ALL-SAFE (no LLM) ══════════');
  forceProvider('gemini');
  const domain = 'zztest-beta17-safe';
  try {
    await fresh(domain);
    const wiki = files.wikiPath(domain);
    await files.writePage(domain, 'concepts/real-page.md', '# Real Page\n\n## Definition\nReal.\n');
    // A folder-prefix violation written DIRECTLY to disk (writePage would strip it).
    writeFileSync(path.join(wiki, 'concepts', 'hub.md'),
      '---\ntype: concept\ntags: [type/concept]\n---\n# Hub\n\n## Related\n- [[concepts/real-page]] uses a forbidden folder prefix\n', 'utf8');

    const before = await health.scanWiki(domain);
    ok((before.folderPrefixLinks || []).length >= 1, `folder-prefix issue present before fix (${(before.folderPrefixLinks || []).length})`);

    const res = await health.fixAllSafe(domain);
    ok(res.fixed >= 1, `fix-all-safe fixed ≥1 issue (${res.fixed})`);
    ok(res.byType && typeof res.byType.folderPrefixLinks === 'object', 'per-type counts returned');

    const after = await health.scanWiki(domain);
    ok((after.folderPrefixLinks || []).length === 0, 'folder-prefix issue resolved after fix-all-safe');
    const hub = readFileSync(path.join(wiki, 'concepts', 'hub.md'), 'utf8');
    ok(/\[\[real-page\]\]/.test(hub) && !/\[\[concepts\/real-page\]\]/.test(hub), 'prefix stripped → [[real-page]]');
  } finally {
    try { await files.deleteDomain(domain); } catch {}
  }
}

(async () => {
  cfgMod = await import('../src/brain/config.js');
  files = await import('../src/brain/files.js');
  healthAi = await import('../src/brain/health-ai.js');
  health = await import('../src/brain/health.js');
  configBackup = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;

  try {
    await securitySuite();
    await fixAllSafeSuite();
    if (cfgMod.getEffectiveKey('gemini')) await orphanSuite('gemini');
    else console.log('\n⏭  no Gemini key — skipping Gemini orphan suite');
    if (cfgMod.getEffectiveKey('anthropic')) await orphanSuite('anthropic');
    else console.log('\n⏭  no Anthropic key — skipping Anthropic orphan suite');
  } finally {
    if (configBackup !== null) writeFileSync(CONFIG_FILE, configBackup, 'utf8');
    for (const d of ['zztest-beta17-gemini', 'zztest-beta17-anthropic', 'zztest-beta17-sec', 'zztest-beta17-safe']) {
      try { await files.deleteDomain(d); } catch {}
    }
    console.log('\n🧹 cleanup done — config restored, throwaway domains removed.');
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`beta.17 PRODUCTION: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  • ' + f)); process.exit(1); }
  console.log('All green ✓');
})().catch(err => {
  if (configBackup !== null) { try { writeFileSync(CONFIG_FILE, configBackup, 'utf8'); } catch {} }
  console.error('\n💥 crashed:', err.message, '\n', err.stack);
  process.exit(1);
});
