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
// IMPORTED, never re-typed: the OpenRouter catalogue's admission floor is the
// real ceiling every chat cap must clear (see section 2a). openrouter-eligibility.js
// is a deliberately PURE, import-free module, so pulling it in keeps this suite
// offline and free.
import { APP_OUTPUT_FLOOR_TOKENS } from '../src/brain/openrouter-eligibility.js';

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

// ── 2. RESPONSE_STYLES — caps, ceiling, ordering, directives ────────────────
//
// WHAT THESE CAPS MEAN CHANGED IN v3.23 AND THE ASSERTIONS FOLLOW IT.
// `maxTokens` bounds the model's hidden REASONING and its ANSWER together, so on
// a reasoning model it was never a length control — it was a truncation risk.
// Measured on `z-ai/glm-5.3-flash`: at max_tokens 2048 the provider returned
// `finish_reason: "length"` with completion_tokens exactly 2048, of which 1873
// (91%) were reasoning. At the OLD caps, balanced and comprehensive were running
// at 90% and 85% of budget on an ordinary question — one harder question from
// being cut off. Length is governed by the DIRECTIVE, which is unchanged; these
// numbers are a SAFETY ceiling and a SPEND ceiling.
section('2. RESPONSE_STYLES — caps + ceiling + ordering + directives');
ok(RESPONSE_STYLES.concise.maxTokens === 12288, 'concise caps at 12288');
ok(RESPONSE_STYLES.balanced.maxTokens === 16384, 'balanced caps at 16384');
ok(RESPONSE_STYLES.comprehensive.maxTokens === 20480, 'comprehensive caps at 20480');
ok(/balanced|middle ground/i.test(RESPONSE_STYLES.balanced.directive), 'balanced directive is present (soft moderate length)');
ok(/not exhaustive/i.test(RESPONSE_STYLES.balanced.directive), 'balanced directive caps verbosity (not exhaustive)');
ok(/longest|thorough/i.test(RESPONSE_STYLES.comprehensive.directive), 'comprehensive directive aims to be the longest');
ok(/concise/i.test(RESPONSE_STYLES.concise.directive), 'concise directive is present');
ok(/comprehensive/i.test(RESPONSE_STYLES.comprehensive.directive), 'comprehensive directive is present');

// ── 2a. THE CEILING IS DERIVED, NOT TYPED ──────────────────────────────────
// The binding constraint is NOT Gemini (clamps server-side at 65536) and NOT
// Anthropic (clamped client-side by anthropicMaxOutputTokens, 64000 for
// haiku-4-5). It is OPENROUTER, where `provider: {allow_fallbacks:false,
// require_parameters:true}` means an unsatisfiable max_tokens can be REFUSED
// rather than clamped — measured: moonshotai/kimi-k2-0905 accepts 65536 and
// returns HTTP 400 at 100352, which is that model's own published ceiling. And a
// routing-constraint refusal is classified DETERMINISTIC (v3.15.1), so it does
// not walk the fallback chain: the user gets an error, not an answer.
//
// So the floor to clear is the catalogue's ADMISSION floor — the smallest output
// ceiling a synced chat model is allowed to publish. It is IMPORTED from the
// module that owns it rather than re-typed here, because a hardcoded 24576 would
// silently stop tracking the real rule the day that constant moves. (The old
// assertion's `<= 64000` was ~2.6x too loose and could not have caught this.)
for (const [k, v] of Object.entries(RESPONSE_STYLES)) {
  ok(v.maxTokens < APP_OUTPUT_FLOOR_TOKENS,
    `${k} cap (${v.maxTokens}) is below the OpenRouter admission floor ${APP_OUTPUT_FLOOR_TOKENS}`);
}

// ── 2b. EVERY CAP MUST ABSORB A REAL DELIBERATION ──────────────────────────
// The largest reasoning burn measured live on a real chat prompt was 8874 tokens
// (comprehensive, glm-5.3-flash). A cap at or below that is a cap where a
// reasoning model can consume the ENTIRE budget before writing a word — which is
// precisely the defect this release fixed, and it is what the pre-v3.23 concise
// cap of 4096 was. Reinstating any of the old values reds this.
const MEASURED_MAX_REASONING_TOKENS = 8874;
for (const [k, v] of Object.entries(RESPONSE_STYLES)) {
  ok(v.maxTokens > MEASURED_MAX_REASONING_TOKENS,
    `${k} cap (${v.maxTokens}) exceeds the largest measured reasoning burn (${MEASURED_MAX_REASONING_TOKENS})`);
}

// ── 2c. THE ORDERING INVARIANT — NOW A SPEND ORDERING ──────────────────────
// KEPT, and deliberately not deleted, but read it correctly: it is no longer a
// claim about how long each answer will be (the DIRECTIVES make that claim, and
// the live suite is what checks it — measured on a non-reasoning model at the new
// caps: 1366 / 1390 / 3095 completion tokens, correctly ordered while none came
// within 6x of its ceiling). It is a WORST-CASE SPEND ordering: a user who picks
// Concise is guaranteed a strictly lower ceiling on what one turn can cost than a
// user who picks Comprehensive. Flattening the three to one shared constant would
// still satisfy "no style truncates" and would silently destroy that guarantee.
ok(RESPONSE_STYLES.concise.maxTokens < RESPONSE_STYLES.balanced.maxTokens,
  'spend ceiling: concise < balanced');
ok(RESPONSE_STYLES.balanced.maxTokens < RESPONSE_STYLES.comprehensive.maxTokens,
  'spend ceiling: balanced < comprehensive');

// ── 2d. THE `reasoning` PARAMETER IS A TRAP AND THE FILE MUST SAY SO ───────
// All three variants were measured. `reasoning.max_tokens` and `reasoning.effort`
// DISABLE reasoning (zero reasoning tokens) rather than capping it, which would
// silently delete the live thinking-region the chat view renders.
// `reasoning.exclude: true` is worse: it still burns the full budget and still
// truncates, it merely HIDES the stream. This is pinned as a source guard because
// it is the obvious-looking fix a future maintainer will otherwise reach for, and
// the comment is the only thing that stops them.
{
  const chatSrcTrap = readFileSync(path.join(ROOT, 'src/brain/chat.js'), 'utf8');
  ok(/reasoning\.exclude/.test(chatSrcTrap),
    'chat.js records the reasoning.exclude trap by name');
  ok(/reasoning\.effort/.test(chatSrcTrap) && /reasoning\.max_tokens/.test(chatSrcTrap),
    'chat.js records that reasoning.effort / reasoning.max_tokens DISABLE rather than cap');
  ok(/hidden deliberation|reasoning[\s\S]{0,80}answer together|DELIBERATION AND ITS ANSWER TOGETHER/i.test(chatSrcTrap),
    'chat.js states that max_tokens bounds reasoning AND answer together');
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
  // WIDENED (chat-cancellation): this pinned a CLOSED object literal, so it had
  // to be hand-edited every time an option was added (v3.12.x did exactly that
  // for `model`) — which contradicts the comment directly above it. The intent
  // is unchanged and is what is now enforced: responseStyle, provider AND model
  // must all still be forwarded in THIS call's options object. Dropping any one
  // still reds it; the object may now grow (it carries `signal` since chat
  // gained cancellation) without a suite edit.
  ok(/sendMessage\(domain, conversationId \|\| null, message, \{[^}]*\bresponseStyle\b[^}]*\bprovider\b[^}]*\bmodel\b[^}]*\}/.test(routeSrc),
    'chat route passes responseStyle (+ provider, model) to sendMessage');
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat response-style (Tier 2) offline assertions green');
