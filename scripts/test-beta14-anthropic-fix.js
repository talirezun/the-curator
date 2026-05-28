/**
 * v3.0.1-beta.14 — Anthropic large-output fix: stress test.
 *
 * Two distinct SDK/API limits broke the Anthropic path for any call requesting
 * 65536 output tokens (single-pass ingest + conversation compile):
 *
 *   Error 1 — SDK client-side guard: messages.create() throws "Streaming is
 *             strongly recommended for operations that may take longer than 10
 *             minutes" for ANY max_tokens above ~21,333, purely as a function of
 *             the budget. Fix: use messages.stream().finalMessage().
 *
 *   Error 2 — API model cap: Claude Haiku 4.5 caps output at 64,000 tokens, so
 *             max_tokens:65536 is rejected as "max_tokens: 65536 > 64000".
 *             Fix: clamp the Anthropic budget to ANTHROPIC_MAX_OUTPUT_TOKENS.
 *
 * Gemini (the default provider) is unaffected — it allows 65,536 and has no
 * such guard — so the fix touches the Anthropic branch only.
 *
 * OFFLINE assertions always run (no network, no key).
 * LIVE assertions run only when ANTHROPIC_API_KEY is set (in .env or env). They
 * exercise the REAL failing paths against the real Haiku API:
 *   - generateText(..., 65536) in json + text mode
 *   - a full single-pass ingest (small source → 65536 budget) on a throwaway domain
 *   - a full conversation compile (65536 budget) on a throwaway domain
 *
 * The live block temporarily forces the Anthropic provider by swapping
 * .curator-config.json (backed up + restored in finally) and creates/deletes a
 * throwaway domain so the user's real domains are never touched.
 *
 * Run:  node scripts/test-beta14-anthropic-fix.js
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; }
  else { fail++; failures.push(label); console.error(`  ✗ ${label}`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

// ─────────────────────────────────────────────────────────────────────────────
// OFFLINE
// ─────────────────────────────────────────────────────────────────────────────

section('OFFLINE 1 — exported constant + clamp math');
const llm = await import('../src/brain/llm.js');
ok(llm.ANTHROPIC_MAX_OUTPUT_TOKENS === 64000,
  `ANTHROPIC_MAX_OUTPUT_TOKENS is 64000 (got ${llm.ANTHROPIC_MAX_OUTPUT_TOKENS})`);
ok(Math.min(65536, llm.ANTHROPIC_MAX_OUTPUT_TOKENS) === 64000,
  'clamp: 65536 → 64000');
ok(Math.min(16384, llm.ANTHROPIC_MAX_OUTPUT_TOKENS) === 16384,
  'clamp: 16384 stays 16384 (multi-phase outline/batch unaffected)');
ok(Math.min(4096, llm.ANTHROPIC_MAX_OUTPUT_TOKENS) === 4096,
  'clamp: 4096 stays 4096 (chat unaffected)');

section('OFFLINE 2 — SDK non-streaming guard formula (why streaming is required)');
// Reproduce node_modules/@anthropic-ai/sdk/core.js _calculateNonstreamingTimeout:
//   expectedTimeout(sec) = (60*60*maxTokens)/128000 ; throws if > 600
const guardThrows = (mt) => (60 * 60 * mt) / 128000 > 10 * 60;
ok(guardThrows(65536), 'guard fires at 65536 (pre-fix Compile/ingest failure)');
ok(guardThrows(64000), 'guard ALSO fires at clamped 64000 → clamp alone is NOT enough, streaming required');
ok(!guardThrows(16384), 'guard does not fire at 16384 (multi-phase calls were always safe)');
ok(!guardThrows(4096), 'guard does not fire at 4096 (chat was always safe)');
// threshold ≈ 21,333
ok(guardThrows(21334) && !guardThrows(21333), 'guard threshold is ~21,333 tokens');

section('OFFLINE 3 — installed SDK exposes the streaming API we rely on');
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const probeClient = new Anthropic({ apiKey: 'sk-ant-probe-not-used' });
ok(typeof probeClient.messages.stream === 'function',
  'client.messages.stream is a function');
ok(typeof probeClient.messages.create === 'function',
  'client.messages.create still exists (sanity)');

section('OFFLINE 4 — source-level guards on the Anthropic branch only');
const src = readFileSync(path.join(ROOT, 'src/brain/llm.js'), 'utf8');
ok(/export const ANTHROPIC_MAX_OUTPUT_TOKENS\s*=\s*64000/.test(src),
  'constant declared as 64000');
ok(/Math\.min\(maxTokens,\s*ANTHROPIC_MAX_OUTPUT_TOKENS\)/.test(src),
  'Anthropic branch clamps via Math.min(maxTokens, ANTHROPIC_MAX_OUTPUT_TOKENS)');
ok(/client\.messages\.stream\(/.test(src) && /\.finalMessage\(\)/.test(src),
  'Anthropic branch uses messages.stream().finalMessage()');
ok(!/client\.messages\.create\(/.test(src),
  'messages.create() no longer used anywhere in llm.js');
// Gemini branch must remain unclamped on its full 65536 budget.
ok(/maxOutputTokens:\s*maxTokens/.test(src),
  'Gemini branch still passes the raw maxTokens (not clamped)');
ok(!/maxOutputTokens:\s*Math\.min/.test(src),
  'Gemini branch is NOT clamped');

// ─────────────────────────────────────────────────────────────────────────────
// LIVE (gated on ANTHROPIC_API_KEY)
// ─────────────────────────────────────────────────────────────────────────────

const LIVE_KEY = process.env.ANTHROPIC_API_KEY;
if (!LIVE_KEY) {
  console.log('\n⏭  LIVE tests SKIPPED — set ANTHROPIC_API_KEY in .env to run them.');
  report();
}

console.log('\n🌐 LIVE tests ENABLED — using real Anthropic Haiku API.');

const CONFIG_FILE = path.join(ROOT, '.curator-config.json');
const TEST_DOMAIN = 'zztest-anthropic-beta14';
let configBackup = null;
let tmpDir = null;

// Streaming/cap errors we must NOT see anymore. If either substring appears,
// the fix regressed.
const STREAMING_ERR = 'Streaming is strongly recommended';
const CAP_ERR = '> 64000';

try {
  // Force the Anthropic provider for the duration of the live run.
  configBackup = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
  const cfg = configBackup ? JSON.parse(configBackup) : {};
  cfg.activeProvider = 'anthropic'; // getProviderInfo → anthropic; key from env
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  // Re-import config + llm fresh (config reads the file per-call, so this is
  // belt-and-suspenders) and confirm provider resolution.
  const cfgMod = await import(`../src/brain/config.js?live=${Date.now()}`);
  const provider = cfgMod.getActiveProvider();
  ok(provider === 'anthropic', `provider forced to anthropic (got ${provider})`);
  ok(!!cfgMod.getEffectiveKey('anthropic'), 'effective anthropic key resolves from env');

  // ── LIVE 1: the exact failing budget at the llm.js layer ──
  section('LIVE 1 — generateText(..., 65536) json mode (the failing budget)');
  try {
    const out = await llm.generateText(
      'You output only compact JSON. No prose.',
      'Return this exact JSON object and nothing else: {"ok": true, "n": 42}',
      65536,
      'json',
    );
    ok(typeof out === 'string' && out.length > 0, 'json-mode 65536 call returned a non-empty string');
    // Parse exactly as production does — Anthropic has no native JSON mode, so
    // it may wrap output in markdown fences; parseJSON() strips them + jsonrepair.
    const { parseJSON } = await import('../src/brain/ingest.js');
    let parsed = null; try { parsed = parseJSON(out); } catch { /* leave null */ }
    ok(parsed && parsed.ok === true, 'response parses to the requested JSON (via production parseJSON)');
  } catch (e) {
    ok(!e.message.includes(STREAMING_ERR), `no "${STREAMING_ERR}" error (got: ${e.message.slice(0, 120)})`);
    ok(!e.message.includes(CAP_ERR), `no "max_tokens > 64000" error (got: ${e.message.slice(0, 120)})`);
    ok(false, `json-mode 65536 call threw: ${e.message.slice(0, 160)}`);
  }

  section('LIVE 2 — generateText(..., 65536) text mode');
  try {
    const out = await llm.generateText(
      'You are terse.',
      'Reply with exactly the word: pong',
      65536,
      'text',
    );
    ok(typeof out === 'string' && /pong/i.test(out), 'text-mode 65536 call returned "pong"');
  } catch (e) {
    ok(false, `text-mode 65536 call threw: ${e.message.slice(0, 160)}`);
  }

  // ── LIVE 3 + 4: full ingest + compile paths on a throwaway domain ──
  const files = await import('../src/brain/files.js');
  const { ingestFile } = await import('../src/brain/ingest.js');
  const { compileConversation } = await import('../src/brain/compile.js');

  // Clean any leftover from a prior aborted run, then create fresh.
  try { await files.deleteDomain(TEST_DOMAIN); } catch { /* none */ }
  await files.createDomain(TEST_DOMAIN, 'ZZ Test Anthropic beta14', 'Throwaway test domain', 'generic');

  section('LIVE 3 — full single-pass ingest on Anthropic (65536 budget path)');
  // < 15,000 chars → single-pass path, which requests 65536. This is the exact
  // path the community user hit. Keep it small so the LLM call is cheap.
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'curator-beta14-'));
  const srcText = [
    'The Curator is a local Node.js app by Tali Rezun.',
    'It ingests sources and builds a markdown wiki of entities and concepts.',
    'Retrieval-Augmented Generation (RAG) is a technique it deliberately avoids,',
    'preferring a compiling-wiki pattern where knowledge is integrated on ingest.',
    'Obsidian renders the resulting graph. Google Gemini and Anthropic Claude are',
    'the two supported LLM providers.',
  ].join(' ');
  const srcPath = path.join(tmpDir, 'beta14-test-source.txt');
  writeFileSync(srcPath, srcText, 'utf8');
  try {
    const res = await ingestFile(TEST_DOMAIN, srcPath, 'beta14-test-source.txt');
    ok(Array.isArray(res.pagesWritten) && res.pagesWritten.length > 0,
      `ingest wrote pages (${res.pagesWritten?.length || 0})`);
    ok(res.pagesWritten.some(p => p.startsWith('summaries/')), 'ingest produced a summary page');
  } catch (e) {
    ok(!e.message.includes(STREAMING_ERR), `ingest: no streaming-guard error (got: ${e.message.slice(0, 120)})`);
    ok(!e.message.includes(CAP_ERR), `ingest: no cap error (got: ${e.message.slice(0, 120)})`);
    ok(false, `single-pass ingest threw: ${e.message.slice(0, 160)}`);
  }

  section('LIVE 4 — full conversation compile on Anthropic (65536 budget path)');
  const convId = '00000000-0000-4000-8000-00000000be14';
  await files.writeConversation(TEST_DOMAIN, {
    id: convId,
    title: 'What is RAG and why does The Curator avoid it',
    createdAt: new Date().toISOString(),
    domain: TEST_DOMAIN,
    messages: [
      { role: 'user', content: 'What is RAG?' },
      { role: 'assistant', content: 'RAG is Retrieval-Augmented Generation — fetching chunks at query time to ground an LLM answer.' },
      { role: 'user', content: 'Why does The Curator avoid it in favour of a compiling wiki?' },
      { role: 'assistant', content: 'Because it integrates knowledge into persistent wiki pages on ingest, so cross-references are pre-built and the whole wiki fits one context window.' },
    ],
  });
  try {
    const res = await compileConversation(TEST_DOMAIN, convId);
    ok(res.ok === true, `compile succeeded (ok=${res.ok}${res.error ? `, error="${res.error}"` : ''})`);
    if (res.ok) ok(Array.isArray(res.pagesWritten) && res.pagesWritten.length > 0,
      `compile wrote pages (${res.pagesWritten?.length || 0})`);
    if (!res.ok && res.error) {
      ok(!res.error.includes(STREAMING_ERR), `compile: no streaming-guard error`);
      ok(!res.error.includes(CAP_ERR), `compile: no cap error`);
    }
  } catch (e) {
    ok(false, `compile threw: ${e.message.slice(0, 160)}`);
  }
} finally {
  // Cleanup: delete throwaway domain + tmp source, restore config exactly.
  try {
    const files = await import('../src/brain/files.js');
    await files.deleteDomain(TEST_DOMAIN);
  } catch { /* best effort */ }
  if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } }
  if (configBackup !== null) writeFileSync(CONFIG_FILE, configBackup, 'utf8');
  else if (existsSync(CONFIG_FILE)) { /* leave as-is if we never backed up */ }
  console.log('\n🧹 cleanup done — config restored, throwaway domain removed.');
}

report();

function report() {
  console.log(`\n${'═'.repeat(48)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:'); failures.forEach(f => console.log(`  - ${f}`)); }
  console.log('═'.repeat(48));
  process.exit(fail > 0 ? 1 : 0);
}
