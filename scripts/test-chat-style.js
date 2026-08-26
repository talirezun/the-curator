/**
 * test-chat-style.js — OFFLINE suite for the Tier 2 response-style control.
 *
 * The response style (concise / balanced / comprehensive) is ORTHOGONAL to the
 * Tier 1 intent (decision / enumerate / synthesis): intent picks the answer
 * SHAPE, style picks the DETAIL and LENGTH. This suite verifies the contract:
 *   - normalisation (unknown / missing → balanced) so a bad client value is safe,
 *   - the style directive is appended to the prompt (all three styles carry one;
 *     the 4-arg buildPrompt default still equals the 5-arg 'balanced' string),
 *   - each style carries a sane output-token cap,
 *   - the style layers on TOP of the intent without changing classification or
 *     relaxing the anti-catalogue-dump guardrails,
 *   - the route + sendMessage signatures thread it through.
 *
 * Deterministic + free (no network).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { detectQueryIntent, __testing } from '../src/brain/chat.js';

const { buildPrompt, RESPONSE_STYLES, normalizeResponseStyle } = __testing;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got "${a}")`); }
function section(t) { console.log(`\n${t}`); }

const PAGES = [
  { path: 'concepts/rag.md', content: '# RAG\nRetrieval augmented generation.' },
  { path: 'entities/tali-rezun.md', content: '# Tali Rezun\nAuthor.' },
  { path: 'summaries/x.md', content: '# X\nA summary.' },
];

// ── 1. normalizeResponseStyle — safe on any input ───────────────────────────
section('1. normalizeResponseStyle — defaults to balanced on unknown/missing');
eq(normalizeResponseStyle('concise'), 'concise', 'concise passes through');
eq(normalizeResponseStyle('balanced'), 'balanced', 'balanced passes through');
eq(normalizeResponseStyle('comprehensive'), 'comprehensive', 'comprehensive passes through');
eq(normalizeResponseStyle('CONCISE'), 'concise', 'case-insensitive');
eq(normalizeResponseStyle('garbage'), 'balanced', 'unknown → balanced');
eq(normalizeResponseStyle(''), 'balanced', 'empty → balanced');
eq(normalizeResponseStyle(undefined), 'balanced', 'undefined → balanced');
eq(normalizeResponseStyle(null), 'balanced', 'null → balanced');
eq(normalizeResponseStyle(42), 'balanced', 'non-string → balanced');
eq(normalizeResponseStyle({}), 'balanced', 'object → balanced');
eq(normalizeResponseStyle([]), 'balanced', 'array → balanced');
eq(normalizeResponseStyle('  concise  '), 'balanced', 'whitespace-padded is not a known key → balanced');
// Inherited/prototype keys are truthy on a plain object — must NOT slip through
// (audit finding): own-property check required.
eq(normalizeResponseStyle('__proto__'), 'balanced', '"__proto__" → balanced (own-property guard)');
eq(normalizeResponseStyle('constructor'), 'balanced', '"constructor" → balanced (own-property guard)');
eq(normalizeResponseStyle('toString'), 'balanced', '"toString" → balanced');
eq(normalizeResponseStyle('hasOwnProperty'), 'balanced', '"hasOwnProperty" → balanced');
// And the resolved style always yields a usable cap/directive (no undefined).
for (const bad of ['__proto__', 'constructor', 'garbage', null, undefined, 42]) {
  const st = normalizeResponseStyle(bad);
  ok(typeof RESPONSE_STYLES[st].maxTokens === 'number' && RESPONSE_STYLES[st].maxTokens > 0,
    `normalized(${JSON.stringify(bad)}) → usable numeric cap`);
  ok(typeof RESPONSE_STYLES[st].directive === 'string',
    `normalized(${JSON.stringify(bad)}) → string directive`);
}

// ── 2. RESPONSE_STYLES — sane caps + directives ─────────────────────────────
section('2. RESPONSE_STYLES — caps + directive presence');
ok(RESPONSE_STYLES.concise.maxTokens === 4096, 'concise caps at 4096');
ok(RESPONSE_STYLES.balanced.maxTokens === 8192, 'balanced caps at 8192');
ok(RESPONSE_STYLES.comprehensive.maxTokens === 12288, 'comprehensive caps at 12288');
ok(/balanced|middle ground/i.test(RESPONSE_STYLES.balanced.directive), 'balanced directive is present (soft moderate length)');
ok(/not exhaustive/i.test(RESPONSE_STYLES.balanced.directive), 'balanced directive caps verbosity (not exhaustive)');
ok(/longest|thorough/i.test(RESPONSE_STYLES.comprehensive.directive), 'comprehensive directive aims to be the longest');
ok(/concise/i.test(RESPONSE_STYLES.concise.directive), 'concise directive is present');
ok(/comprehensive/i.test(RESPONSE_STYLES.comprehensive.directive), 'comprehensive directive is present');
// caps are within both providers' output limits (Gemini 65536, Anthropic Haiku 64000)
for (const [k, v] of Object.entries(RESPONSE_STYLES)) {
  ok(v.maxTokens >= 2048 && v.maxTokens <= 64000, `${k} cap within provider limits`);
}

// ── 3. buildPrompt — style directive appended; 4-arg defaults to balanced ───
section('3. buildPrompt — style directive layering');
{
  const q = 'how does RAG work?';
  const balanced4 = buildPrompt('a', PAGES, [], q);            // 4-arg (existing callers)
  const balanced5 = buildPrompt('a', PAGES, [], q, 'balanced');
  ok(balanced4 === balanced5, '4-arg call is identical to 5-arg balanced (default param)');
  ok(balanced5.includes('RESPONSE STYLE — BALANCED'), 'balanced prompt carries the balanced directive');

  const concise = buildPrompt('a', PAGES, [], q, 'concise');
  ok(concise.includes('RESPONSE STYLE — CONCISE'), 'concise prompt carries the concise directive');
  ok(!concise.includes('RESPONSE STYLE — BALANCED'), 'concise prompt does not carry the balanced directive');

  const comp = buildPrompt('a', PAGES, [], q, 'comprehensive');
  ok(comp.includes('RESPONSE STYLE — COMPREHENSIVE'), 'comprehensive prompt carries the comprehensive directive');

  // Garbage style → treated as balanced
  const garbage = buildPrompt('a', PAGES, [], q, 'garbage');
  ok(garbage === balanced5, 'unknown style → balanced prompt');
}

// ── 4. Style is ORTHOGONAL to intent — classification unchanged, shape kept ─
section('4. Style does not change intent classification or the intent block');
{
  // Intent classification is independent of style (detectQueryIntent takes only the message).
  eq(detectQueryIntent('recommend one of these topics'), 'decision', 'decision intent unaffected');
  eq(detectQueryIntent('list all articles about RAG'), 'enumerate', 'enumerate intent unaffected');

  // The intent's own instruction block is present regardless of style.
  const decisionConcise = buildPrompt('a', PAGES, [], 'which should I write next?', 'concise');
  ok(decisionConcise.includes('DECISION / RECOMMENDATION query'), 'decision block present under concise');
  ok(decisionConcise.includes('RESPONSE STYLE — CONCISE'), '…and the concise directive is appended');

  const enumComp = buildPrompt('a', PAGES, [], 'list all articles by Tali Rezun', 'comprehensive');
  ok(enumComp.includes('ENUMERATION query'), 'enumerate block present under comprehensive');
  // Comprehensive must NOT relax the anti-dump guardrails.
  ok(/NEVER paste the domain catalogue|Do NOT copy it into your answer/.test(enumComp),
    'comprehensive still forbids reproducing the catalogue');
  ok(/NEVER reproduce the domain\s+catalogue|NEVER reproduce the domain catalogue/i.test(enumComp)
     || /catalogue or bare file paths/i.test(enumComp),
    'comprehensive directive itself reiterates the no-catalogue rule');
}

// ── 5. Source guards — sendMessage + route thread responseStyle through ─────
section('5. Source guard — sendMessage + route wiring');
{
  const chatSrc = readFileSync(path.join(ROOT, 'src/brain/chat.js'), 'utf8');
  ok(/export async function sendMessage\(domain, conversationId, userMessage, opts = \{\}\)/.test(chatSrc),
    'sendMessage accepts an opts object');
  ok(/const responseStyle = normalizeResponseStyle\(opts\.responseStyle\)/.test(chatSrc),
    'sendMessage normalises opts.responseStyle');
  ok(/const maxTokens = RESPONSE_STYLES\[responseStyle\]\.maxTokens/.test(chatSrc),
    'sendMessage uses the style cap for generateText');
  ok(/responseStyle,/.test(chatSrc), 'sendMessage returns the resolved responseStyle');

  const routeSrc = readFileSync(path.join(ROOT, 'src/routes/chat.js'), 'utf8');
  ok(/responseStyle/.test(routeSrc), 'chat route reads responseStyle from the body');
  // Shape-pinned rather than name-pinned, so this stays a real guard as the
  // per-chat options grow: what matters to THIS suite is that responseStyle is
  // still one of them. (v3.12.x added `model`.)
  ok(/sendMessage\(domain, conversationId \|\| null, message, \{ responseStyle, provider, model \}\)/.test(routeSrc),
    'chat route passes responseStyle (+ provider, model) to sendMessage');
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat response-style (Tier 2) offline assertions green');
