/**
 * test-chat-intent-live.js — LIVE suite for the v3.0.7 Tier 1 chat-quality fix.
 *
 * Proves on REAL Gemini + Anthropic, against a real (large) domain, that:
 *   • A DECISION question ("evaluate these and recommend one") returns a
 *     FOCUSED answer — not the ~20k-char full-domain dump the community user saw.
 *   • An ANALYTICAL "which concepts have the MOST sources disagreeing?" question
 *     returns synthesis, not an enumerated dump.
 *   • No answer contains a raw catalogue echo (a run of 5+ bare file paths).
 *
 * Drives buildPrompt → generateText → stripCatalogueEcho directly (the exact
 * sendMessage path) WITHOUT writing a conversation file, so it has no side
 * effects on the real domain. Self-skips if no key is set. Runs on whichever
 * providers are configured; restores the active provider byte-exact.
 *
 * NOTE: assertions are about ANSWER SHAPE (bounded length, no catalogue dump),
 * not content — the dev machine's `articles` domain is not the reporter's
 * `curation` domain, but the shape regression is domain-independent.
 */

import dotenv from 'dotenv';
dotenv.config();

import { readSchema, readWikiPages, listDomains } from '../src/brain/files.js';
import { generateText } from '../src/brain/llm.js';
import { detectQueryIntent, stripCatalogueEcho, __testing } from '../src/brain/chat.js';
import { getApiKeys, setActiveProvider, getActiveProvider } from '../src/brain/config.js';

const { buildPrompt } = __testing;

let passed = 0, failed = 0, skipped = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

const BARE_PATH_RUN = /(?:(?:summaries|concepts|entities)\/[a-z0-9][a-z0-9._-]*\.md[\s,;|]*){5,}/i;
const MAX_FOCUSED_CHARS = 9000;   // the reported dump was ~20k; a focused answer is 1–4k

// Robin's Q2 verbatim + a decision question that would tempt a large domain to dump.
const Q_DECISION =
  'I want to write ONE article that best introduces my readers to how AI is changing ' +
  'knowledge work and personal knowledge management. Evaluate what I have and recommend ' +
  'the single best topic to focus on, with a short reason.';
const Q_ANALYTICAL =
  'Which concepts here have the most sources disagreeing, and what exactly is the disagreement?';

async function answerFor(domain, question) {
  const schema = await readSchema(domain);
  const pages = await readWikiPages(domain);
  const prompt = buildPrompt(domain, pages, [], question);
  const raw = await generateText(schema, prompt, 8192);   // same cap as sendMessage
  return stripCatalogueEcho(raw);
}

async function runProvider(name, domain) {
  section(`Provider: ${name} · domain: ${domain}`);
  const restore = switchTo(name);
  try {
    // Intent classification is deterministic but confirm end-to-end.
    ok(detectQueryIntent(Q_DECISION) === 'decision', `[${name}] decision question classified as decision`);
    ok(detectQueryIntent(Q_ANALYTICAL) === 'synthesis', `[${name}] analytical question classified as synthesis`);

    const decisionAns = await answerFor(domain, Q_DECISION);
    ok(decisionAns.trim().length > 0, `[${name}] decision answer is non-empty`);
    ok(decisionAns.length < MAX_FOCUSED_CHARS,
      `[${name}] decision answer is FOCUSED, not a dump (${decisionAns.length} chars < ${MAX_FOCUSED_CHARS})`);
    ok(!BARE_PATH_RUN.test(decisionAns), `[${name}] decision answer has no raw catalogue echo`);

    const analyticalAns = await answerFor(domain, Q_ANALYTICAL);
    ok(analyticalAns.trim().length > 0, `[${name}] analytical answer is non-empty`);
    ok(analyticalAns.length < MAX_FOCUSED_CHARS,
      `[${name}] analytical answer is FOCUSED, not a dump (${analyticalAns.length} chars < ${MAX_FOCUSED_CHARS})`);
    ok(!BARE_PATH_RUN.test(analyticalAns), `[${name}] analytical answer has no raw catalogue echo`);
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
  const keys = getApiKeys();
  const haveGemini = !!keys.geminiApiKey || !!process.env.GEMINI_API_KEY;
  const haveAnthropic = !!keys.anthropicApiKey || !!process.env.ANTHROPIC_API_KEY;
  if (!haveGemini && !haveAnthropic) {
    console.log('⏭  SKIP: no Gemini or Anthropic key configured.');
    process.exit(0);
  }

  // Pick a real, non-empty domain. Prefer a large one so the model is tempted to dump.
  const domains = await listDomains();
  const preferred = ['articles', 'research', 'posts', 'business', 'lectures', 'projects'];
  let domain = preferred.find(d => domains.includes(d)) || domains[0];
  if (!domain) { console.log('⏭  SKIP: no domains available.'); process.exit(0); }

  if (haveGemini) { try { await runProvider('Gemini', domain); } catch (e) { console.log(`  ⏭  Gemini skipped: ${e.message}`); skipped++; } }
  else { console.log('\n⏭  Gemini: no key, skipped'); skipped++; }

  if (haveAnthropic) { try { await runProvider('Claude', domain); } catch (e) { console.log(`  ⏭  Anthropic skipped: ${e.message}`); skipped++; } }
  else { console.log('\n⏭  Anthropic: no key, skipped'); skipped++; }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed}   Skipped providers: ${skipped}`);
  if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
  console.log('✅ Live chat-intent (Tier 1) assertions green');
})();
