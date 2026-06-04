#!/usr/bin/env node
/**
 * v3.0.1-beta.16 — PRODUCTION end-to-end test for the bulk AI broken-link fix.
 *
 * Builds a throwaway domain with known broken links of every kind, runs the
 * REAL AI plan, applies it (destructive), and asserts each link landed
 * correctly: deterministic retargets, AI lexical-variant retargets, and
 * genuinely-missing strips (with alias display text preserved). Config is
 * force-switched + restored; the domain is created and deleted each run.
 *
 * Run: node scripts/test-beta16-production.js   (exit 0 = all green)
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

let configBackup = null;
(async () => {
  const cfgMod = await import('../src/brain/config.js');
  const files = await import('../src/brain/files.js');
  const healthAi = await import('../src/brain/health-ai.js');
  const health = await import('../src/brain/health.js');

  const geminiKey = cfgMod.getEffectiveKey('gemini');
  if (!geminiKey) { console.log('⏭  No Gemini key — skipping.'); process.exit(0); }

  configBackup = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
  const cfg = configBackup ? JSON.parse(configBackup) : {};
  cfg.activeProvider = 'gemini';
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  const domain = 'zztest-beta16-brokenlinks';
  try {
    try { await files.deleteDomain(domain); } catch {}
    await files.createDomain(domain, 'ZZ beta16 broken links', 'Throwaway', 'generic');
    const wiki = files.wikiPath(domain);

    // Real target pages.
    await files.writePage(domain, 'entities/tali-rezun.md', '# Tali Rezun\n\n## Key Facts\n- Author\n');
    await files.writePage(domain, 'concepts/artificial-intelligence.md', '# Artificial Intelligence\n\n## Definition\nAI.\n');
    await files.writePage(domain, 'concepts/model-context-protocol-mcp.md', '# Model Context Protocol (MCP)\n\n## Definition\nMCP.\n');

    // A page riddled with broken links of every category. Written DIRECTLY to
    // disk (not via writePage) because writePage normalises some of them on
    // write — e.g. it strips `.md` from `[[tali-rezun.md]]`. Real mature wikis
    // contain these because they predate that normalisation; this reproduces
    // that exact state so the deterministic + AI plan paths are both exercised.
    const hubPath = path.join(wiki, 'concepts', 'test-hub.md');
    writeFileSync(hubPath,
      '---\ntype: concept\ntags: [type/concept]\n---\n# Test Hub\n\n## Related\n' +
      '- [[tali-rezun.md]] wrote this (deterministic: strip .md → existing page)\n' +
      '- [[artificial intelligence]] is the topic (deterministic: slugify space)\n' +
      '- [[rezun-tali]] again (AI: lexical variant → tali-rezun)\n' +
      '- [[mcp]] protocol (AI: acronym contained in target)\n' +
      '- [[transportation]] is mentioned (AI: no real page → strip)\n' +
      '- [[big-data|Big Data]] analytics (AI: no real page → strip, keep alias text)\n' +
      '- [[rezun-tali|Dr. R]] bylines (variant retarget keeps alias)\n', 'utf8');

    // Sanity: scan should report these as broken before the fix.
    const before = await health.scanWiki(domain);
    const beforeCount = (before.brokenLinks || []).length;
    ok(beforeCount >= 6, `scan reports broken links before fix (${beforeCount})`);

    // ── Plan (real LLM) ──
    console.log('\nPlanning (real Gemini)…');
    const planRes = await healthAi.planBrokenLinkFixes(domain, {}, () => {});
    const byText = new Map(planRes.plan.map(p => [p.linkText, p]));

    ok(byText.get('tali-rezun.md')?.action === 'retarget' && byText.get('tali-rezun.md')?.target === 'tali-rezun', 'tali-rezun.md → retarget tali-rezun (deterministic)');
    ok(byText.get('artificial intelligence')?.action === 'retarget' && byText.get('artificial intelligence')?.target === 'artificial-intelligence', 'artificial intelligence → retarget (deterministic)');
    ok(byText.get('rezun-tali')?.action === 'retarget' && byText.get('rezun-tali')?.target === 'tali-rezun', 'rezun-tali → retarget tali-rezun (AI variant)');
    ok(byText.get('mcp')?.action === 'retarget' && byText.get('mcp')?.target === 'model-context-protocol-mcp', 'mcp → retarget model-context-protocol-mcp (AI variant)');
    ok(byText.get('transportation')?.action === 'strip', 'transportation → strip (no real page)');
    ok(byText.get('big-data')?.action === 'strip', 'big-data → strip (no real page)');

    // ── Apply (destructive) ──
    console.log('Applying…');
    let progressFired = 0;
    const applyRes = await health.applyBrokenLinkFixes(domain, planRes.plan, () => { progressFired++; });
    ok(applyRes.retargeted > 0, `apply retargeted some links (${applyRes.retargeted})`);
    ok(applyRes.stripped > 0, `apply stripped some links (${applyRes.stripped})`);
    ok(applyRes.filesChanged >= 1, `apply changed at least one file (${applyRes.filesChanged})`);

    // ── Verify the resulting file content ──
    const hub = readFileSync(path.join(wiki, 'concepts', 'test-hub.md'), 'utf8');
    ok(/\[\[tali-rezun\]\]/.test(hub), 'tali-rezun.md → [[tali-rezun]] in file');
    ok(/\[\[artificial-intelligence\]\]/.test(hub), 'artificial intelligence → [[artificial-intelligence]] in file');
    ok(!/\[\[rezun-tali\]\]/.test(hub), 'no [[rezun-tali]] remains (retargeted)');
    ok(/\[\[model-context-protocol-mcp\]\]/.test(hub), 'mcp → [[model-context-protocol-mcp]] in file');
    ok(/\[\[tali-rezun\|Dr\. R\]\]/.test(hub), 'aliased variant keeps alias: [[tali-rezun|Dr. R]]');
    ok(!/\[\[transportation\]\]/.test(hub) && /transportation is mentioned/.test(hub), 'transportation brackets removed, text kept');
    ok(!/\[\[big-data/.test(hub) && /Big Data analytics/.test(hub), 'big-data stripped, alias display text "Big Data" kept');

    // ── Re-scan: broken-link count should drop to (near) zero ──
    const after = await health.scanWiki(domain);
    const afterCount = (after.brokenLinks || []).length;
    console.log(`     ↳ broken links: ${beforeCount} → ${afterCount}`);
    ok(afterCount === 0, `all broken links resolved (after=${afterCount})`);
  } finally {
    try { await files.deleteDomain(domain); } catch {}
    if (configBackup !== null) writeFileSync(CONFIG_FILE, configBackup, 'utf8');
    console.log('\n🧹 cleanup done — config restored, throwaway domain removed.');
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`beta.16 PRODUCTION: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  • ' + f)); process.exit(1); }
  console.log('All green ✓');
})().catch(err => {
  if (configBackup !== null) { try { writeFileSync(CONFIG_FILE, configBackup, 'utf8'); } catch {} }
  console.error('\n💥 crashed:', err.message, '\n', err.stack);
  process.exit(1);
});
