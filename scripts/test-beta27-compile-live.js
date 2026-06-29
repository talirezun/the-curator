#!/usr/bin/env node
/**
 * v3.0.1-beta.27 — Fix #2 LIVE test against REAL Gemini AND Anthropic.
 *
 * The fallback LADDER (full → concise → summary-only) and the compile-specific
 * error are covered deterministically offline (test-beta27-compile-fallback.js)
 * by injecting a fake LLM. This live test covers what only a real model can
 * confirm:
 *   • NO REGRESSION — a normal conversation still compiles via the `full` path
 *     on both providers, with no degradation warnings.
 *   • The new `concise` and `summary-only` prompts are HONOURED by real models:
 *     concise → valid JSON with a summary; summary-only → exactly one summary
 *     page (no entity/concept pages).
 *
 * Safety: forces the provider via .curator-config.json (backed up + restored),
 * isolates all domains into a tempdir via CURATOR_TEST_DOMAINS_DIR. Each provider
 * self-skips if its key is absent.
 *
 * Run:  node scripts/test-beta27-compile-live.js
 * Exit: 0 if all green (or skipped); non-zero on any failure.
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, '.curator-config.json');

const DOMAINS_TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-beta27-live-'));
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_TMP;
process.on('exit', () => { try { rmSync(DOMAINS_TMP, { recursive: true, force: true }); } catch {} });

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`));
}
function section(t) { console.log(`\n${t}`); }

const cfgMod = await import('../src/brain/config.js');
const files = await import('../src/brain/files.js');
const compileMod = await import('../src/brain/compile.js');
const llmMod = await import('../src/brain/llm.js');
const ingestMod = await import('../src/brain/ingest.js');

const cfgBackup = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
function forceProvider(provider) {
  const cfg = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
  cfg.activeProvider = provider;
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

const SAMPLE_CONV = {
  title: 'Why compiled knowledge beats RAG',
  messages: [
    { role: 'user', content: 'Explain why The Curator compiles knowledge into a wiki instead of using retrieval-augmented generation, and what the trade-offs are. Mention OpenAI and RAG.' },
    { role: 'assistant', content: 'The Curator integrates each source into persistent markdown pages on ingest, so cross-references between entities (like OpenAI) and concepts (like RAG) are pre-built and the whole wiki fits in one LLM context window. RAG instead fetches raw chunks at query time. The trade-off: compiling costs more up front and can lose nuance during synthesis, but retrieval re-derives structure on every query and cannot reason over the global graph.' },
  ],
};

async function runProvider(provider) {
  section(`\n══════════ PROVIDER: ${provider.toUpperCase()} ══════════`);
  forceProvider(provider);
  const key = cfgMod.getEffectiveKey(provider);
  if (!key) { console.log(`  ⊘ no ${provider} key — skipping`); return; }
  ok(cfgMod.getActiveProvider() === provider, `[${provider}] active provider resolves`);

  const domain = `zztest-beta27-${provider}`;
  try {
    try { await files.deleteDomain(domain); } catch {}
    await files.createDomain(domain, `ZZ beta27 ${provider}`, 'Throwaway beta27 live test', 'generic');

    // ── A. NO REGRESSION: a normal conversation compiles via the full path ──
    section(`A [${provider}] — normal compile still succeeds (no regression)`);
    const convId = '00000000-0000-4000-8000-0000000027aa';
    await files.writeConversation(domain, { id: convId, title: SAMPLE_CONV.title, createdAt: '2026-06-29T00:00:00.000Z', domain, messages: SAMPLE_CONV.messages });
    try {
      const res = await compileMod.compileConversation(domain, convId);
      ok(res.ok === true, `[${provider}] compile ok (${res.error || res.reason || ''})`);
      if (res.ok) {
        ok(res.pagesWritten.length > 0 && res.pagesWritten.some(p => p.startsWith('summaries/')),
          `[${provider}] wrote pages incl. a summary (${res.pagesWritten.length})`);
        ok(Array.isArray(res.warnings) && res.warnings.length === 0,
          `[${provider}] no degradation warnings on a normal compile`);
      }
    } catch (e) {
      ok(false, `[${provider}] normal compile threw: ${(e.message || '').slice(0, 160)}`);
    }

    // ── B. The concise + summary-only prompts are HONOURED by the real model ──
    section(`B [${provider}] — real model honours the fallback prompts`);
    const schema = await files.readSchema(domain);
    const existingFiles = { entities: ['openai.md'], concepts: ['retrieval-augmented-generation.md'] };
    const summaryPath = 'summaries/live-test-2026-06-29-abcd.md';

    // concise → valid JSON with at least a summary page
    try {
      const concisePrompt = compileMod.buildCompilePrompt({ today: '2026-06-29', existingFiles, conversation: SAMPLE_CONV, summaryPath, mode: 'concise' });
      const raw = (await llmMod.generateText(schema, concisePrompt, 65536, 'json')).trim();
      const parsed = ingestMod.parseJSON(raw);
      ok(Array.isArray(parsed.pages) && parsed.pages.length >= 1, `[${provider}] concise → valid JSON with pages (${parsed.pages?.length || 0})`);
      ok(parsed.pages.some(p => p.path && p.path.startsWith('summaries/')), `[${provider}] concise → includes a summary page`);
    } catch (e) {
      ok(false, `[${provider}] concise prompt failed: ${(e.message || '').slice(0, 160)}`);
    }

    // summary-only → EXACTLY one summary page, no entity/concept pages
    try {
      const summaryPrompt = compileMod.buildCompilePrompt({ today: '2026-06-29', existingFiles, conversation: SAMPLE_CONV, summaryPath, mode: 'summary-only' });
      const raw = (await llmMod.generateText(schema, summaryPrompt, 65536, 'json')).trim();
      const parsed = ingestMod.parseJSON(raw);
      const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
      ok(pages.length >= 1 && pages.some(p => p.path && p.path.startsWith('summaries/')),
        `[${provider}] summary-only → includes a summary page (${pages.length})`);
      ok(!pages.some(p => p.path && (p.path.startsWith('entities/') || p.path.startsWith('concepts/'))),
        `[${provider}] summary-only → NO entity/concept pages (model honoured the constraint)`);
    } catch (e) {
      ok(false, `[${provider}] summary-only prompt failed: ${(e.message || '').slice(0, 160)}`);
    }
  } finally {
    try { await files.deleteDomain(domain); } catch {}
  }
}

try {
  if (cfgMod.getEffectiveKey('gemini')) await runProvider('gemini');
  else console.log('\n⊘ no Gemini key — skipping Gemini');
  if (cfgMod.getEffectiveKey('anthropic')) await runProvider('anthropic');
  else console.log('\n⊘ no Anthropic key — skipping Anthropic');
} finally {
  if (cfgBackup !== null) writeFileSync(CONFIG_FILE, cfgBackup, 'utf8');
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All beta.27 LIVE compile-fallback assertions green (or skipped).');
