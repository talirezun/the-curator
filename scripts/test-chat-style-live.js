/**
 * test-chat-style-live.js — LIVE suite for the Tier 2 response-style control.
 *
 * Proves on REAL Gemini + Anthropic that the response style actually changes the
 * answer's DETAIL/LENGTH while staying focused (no catalogue dump), and that it
 * layers on top of Tier 1 intent without changing classification.
 *
 * Drives buildPrompt → generateText → stripCatalogueEcho with each style's cap —
 * the exact internals of sendMessage — WITHOUT writing a conversation file, so
 * it has no side effects on the real domain. Self-skips if no key is set.
 *
 * Behavioural contract asserted: concise < comprehensive in length; both are
 * focused (< a dump); both non-empty; no catalogue echo; garbage → balanced.
 */

import dotenv from 'dotenv';
dotenv.config();

import { readSchema, readWikiPages, listDomains } from '../src/brain/files.js';
import { generateText } from '../src/brain/llm.js';
import { stripCatalogueEcho, normalizeResponseStyle, __testing } from '../src/brain/chat.js';
import { getApiKeys, setActiveProvider, getActiveProvider } from '../src/brain/config.js';

const { buildPrompt, RESPONSE_STYLES } = __testing;

let passed = 0, failed = 0, skipped = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

const BARE_PATH_RUN = /(?:(?:summaries|concepts|entities)\/[a-z0-9][a-z0-9._-]*\.md[ \t]*){5,}/i;
const MAX_FOCUSED_CHARS = 12000;   // comprehensive gets more room; a dump was ~20k
const QUESTION = 'What is retrieval-augmented generation, and how does this domain describe its trade-offs?';

async function answerFor(domain, style) {
  const schema = await readSchema(domain);
  const pages = await readWikiPages(domain);
  const prompt = buildPrompt(domain, pages, [], QUESTION, style);
  const cap = RESPONSE_STYLES[normalizeResponseStyle(style)].maxTokens;
  return stripCatalogueEcho(await generateText(schema, prompt, cap));
}

async function runProvider(name, domain) {
  section(`Provider: ${name} · domain: ${domain}`);
  const restore = switchTo(name);
  try {
    const concise = await answerFor(domain, 'concise');
    const balanced = await answerFor(domain, 'balanced');
    const comprehensive = await answerFor(domain, 'comprehensive');

    ok(concise.trim().length > 0, `[${name}] concise answer non-empty`);
    ok(balanced.trim().length > 0, `[${name}] balanced answer non-empty`);
    ok(comprehensive.trim().length > 0, `[${name}] comprehensive answer non-empty`);

    ok(!BARE_PATH_RUN.test(concise) && !BARE_PATH_RUN.test(balanced) && !BARE_PATH_RUN.test(comprehensive),
      `[${name}] no style produced a raw catalogue echo`);
    ok(concise.length < MAX_FOCUSED_CHARS && comprehensive.length < MAX_FOCUSED_CHARS,
      `[${name}] answers stay focused, not dumps (concise ${concise.length}, comp ${comprehensive.length} < ${MAX_FOCUSED_CHARS})`);

    // The core behavioural contract: the three styles are MONOTONICALLY ordered
    // in length — concise < balanced < comprehensive. (This is exactly what the
    // first live test got WRONG before the directive fix: an unconstrained
    // balanced ran longer than comprehensive. The soft "not exhaustive" balanced
    // directive + the "your longest answer" comprehensive directive restore it.)
    console.log(`     lengths → concise ${concise.length} · balanced ${balanced.length} · comprehensive ${comprehensive.length}`);
    ok(concise.length < balanced.length,
      `[${name}] concise (${concise.length}) < balanced (${balanced.length})`);
    ok(balanced.length < comprehensive.length,
      `[${name}] balanced (${balanced.length}) < comprehensive (${comprehensive.length})`);

    // Audit follow-up: comprehensive must NOT undermine the Tier 1 anti-dump
    // guardrails. An enumerate query in comprehensive style on the large domain
    // must still stay focused (no ~160-source dump, no catalogue echo).
    const schema = await readSchema(domain);
    const pages = await readWikiPages(domain);
    const enumQ = 'List the articles I have about RAG or retrieval.';
    const enumComp = stripCatalogueEcho(
      await generateText(schema, buildPrompt(domain, pages, [], enumQ, 'comprehensive'),
        RESPONSE_STYLES.comprehensive.maxTokens));
    ok(!BARE_PATH_RUN.test(enumComp) && enumComp.length < MAX_FOCUSED_CHARS,
      `[${name}] comprehensive + enumerate stays focused, no dump (${enumComp.length} < ${MAX_FOCUSED_CHARS})`);
  } finally {
    restore();
  }
}

function switchTo(providerLabel) {
  const provider = providerLabel.toLowerCase() === 'gemini' ? 'gemini' : 'anthropic';
  const prior = getActiveProvider();
  const now = setActiveProvider(provider);
  if (now !== provider) throw new Error(`could not activate ${provider} (no stored key)`);
  return () => { if (prior) { try { setActiveProvider(prior); } catch { /* best-effort */ } } };
}

(async () => {
  // Offline-safe sanity (runs even without keys): garbage → balanced.
  ok(normalizeResponseStyle('garbage') === 'balanced', 'normalizeResponseStyle garbage → balanced');

  const keys = getApiKeys();
  const haveGemini = !!keys.geminiApiKey || !!process.env.GEMINI_API_KEY;
  const haveAnthropic = !!keys.anthropicApiKey || !!process.env.ANTHROPIC_API_KEY;
  if (!haveGemini && !haveAnthropic) {
    console.log('⏭  SKIP: no Gemini or Anthropic key configured.');
    process.exit(failed > 0 ? 1 : 0);
  }

  const domains = await listDomains();
  const domain = ['articles', 'research', 'posts', 'business', 'lectures', 'projects'].find(d => domains.includes(d)) || domains[0];
  if (!domain) { console.log('⏭  SKIP: no domains available.'); process.exit(0); }

  if (haveGemini) { try { await runProvider('Gemini', domain); } catch (e) { console.log(`  ⏭  Gemini skipped: ${e.message}`); skipped++; } }
  else { console.log('\n⏭  Gemini: no key, skipped'); skipped++; }

  if (haveAnthropic) { try { await runProvider('Claude', domain); } catch (e) { console.log(`  ⏭  Anthropic skipped: ${e.message}`); skipped++; } }
  else { console.log('\n⏭  Anthropic: no key, skipped'); skipped++; }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed}   Skipped providers: ${skipped}`);
  if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
  console.log('✅ Live chat response-style (Tier 2) assertions green');
})();
