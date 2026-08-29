#!/usr/bin/env node
/**
 * Provider-neutral error remedies + source-type-aware ingest refusals.
 *
 * TWO DEFECTS, ONE SHAPE: a message that names the user's actual context in one
 * clause and then hardcodes a DIFFERENT context's advice in the next.
 *
 *   Defect 1 (llm.js). Both transient-failure messages interpolated the
 *   provider NAME correctly and then hardcoded GOOGLE's remedy — so an
 *   OpenRouter 429 rendered "Rate limit hit on OpenRouter … consider upgrading
 *   at ai.google.dev/pricing", and an Anthropic 503 sent the user to
 *   status.cloud.google.com. Reproduced live. It survived because v3.0.4 fixed
 *   the NAME and left the links, which removed the obvious tell.
 *
 *   Defect 2 (ingest.js). Both empty/unreadable-source refusals gave PDF/OCR
 *   advice unconditionally, so an empty .md was answered with "run ocrmypdf".
 *
 * WHY THIS SUITE IS NOT DECORATIVE. Four root causes from the 2026-08-29 audit
 * are addressed explicitly:
 *   (1) comments satisfying a positive scan → every source scan runs through
 *       `stripComments`;
 *   (2) a file-wide regex satisfied by another function → the call-site scans
 *       are scoped with `within: 'generateText'`;
 *   (3) a function executed but never called in production → §2 asserts the
 *       CALL SITES, so deleting the calls and leaving the builders reds;
 *   (4) expected read from the same constant as actual → every URL and phrase
 *       below is a HAND-WRITTEN LITERAL, compared with `checkLiteral`. None is
 *       read from PROVIDER_REMEDIES.
 *
 * NO PAID CALLS. §3 drives the REAL `generateText` retry ladder end-to-end via
 * the production injection seams (`__setAnthropicClientFactory`,
 * `__setOpenRouterAdapterFactory`) with clients that throw 429/503. Gemini's
 * SDK has no injectable client, so it is covered by the executed builders and
 * the asserted call site instead — stated rather than implied away.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, functionSource, callSiteCount, checkLiteral } from './test-helpers/source-scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
/** `checkLiteral(literal, actual, message)` → {pass, detail}. Order is fixed by the helper. */
function okLit(literal, actual, label) {
  const v = checkLiteral(literal, actual, label);
  // checkLiteral returns {pass, message}. This suite's ok() is ok(cond, label,
  // detail) — verified against the local definition above before adopting the
  // helper, which is the check its own SIGNATURE HAZARD note demands.
  ok(v.pass, label, v.pass ? undefined : v.message);
}

const llmSrc = stripComments(readFileSync(path.join(ROOT, 'src/brain/llm.js'), 'utf8'));
const ingestSrc = stripComments(readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8'));

const llm = await import('../src/brain/llm.js');
const ingest = await import('../src/brain/ingest.js');
const { isTransientLlmError } = await import('../src/brain/sharedbrain.js');
const { hasTransientMarker } = await import('./ci-flake.js');
const T = llm.__testing;
const IT = ingest.__testing;

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n§1  The remedy table is per-provider, and no vendor is a default');
// ─────────────────────────────────────────────────────────────────────────────
{
  // HAND-WRITTEN literals. Deliberately NOT read from PROVIDER_REMEDIES —
  // reading the expectation from the same constant the code reads is audit
  // root cause 4, and would make this section pass for any value at all.
  const EXPECT = [
    ['gemini',     'Gemini',      'https://status.cloud.google.com',  'https://ai.google.dev/gemini-api/docs/rate-limits'],
    ['anthropic',  'Claude',      'https://status.anthropic.com',     'https://docs.anthropic.com/en/api/rate-limits'],
    ['openrouter', 'OpenRouter',  'https://status.openrouter.ai',     'https://openrouter.ai/docs/api-reference/limits'],
  ];

  for (const [id, name, statusUrl, limitsUrl] of EXPECT) {
    const rate = T.buildRateLimitMessage(name, id, 30);
    const svc  = T.buildServiceUnavailableMessage(name, id);

    ok(rate.includes(limitsUrl), `429 on ${id} links ${limitsUrl}`, `got: ${rate}`);
    ok(svc.includes(statusUrl),  `503 on ${id} links ${statusUrl}`, `got: ${svc}`);

    // THE DEFECT ITSELF: no non-Gemini provider may mention Google anywhere.
    if (id !== 'gemini') {
      for (const googleism of ['ai.google.dev', 'status.cloud.google.com', 'google']) {
        ok(!rate.toLowerCase().includes(googleism), `429 on ${id} never mentions "${googleism}"`, `got: ${rate}`);
        ok(!svc.toLowerCase().includes(googleism),  `503 on ${id} never mentions "${googleism}"`, `got: ${svc}`);
      }
    }
    // Every message must still name the provider it is about.
    ok(rate.includes(name), `429 on ${id} names ${name}`);
    ok(svc.includes(name),  `503 on ${id} names ${name}`);
  }

  // The removed FIGURES must not come back. v3.15.0's rule: an unverifiable
  // free-tier number on an error screen is worse than none, and these were
  // Google's, printed for every provider.
  for (const [id, name] of EXPECT.map(e => [e[0], e[1]])) {
    const rate = T.buildRateLimitMessage(name, id, 30);
    for (const figure of ['15 requests', '20–50', '20-50', 'requests/day', 'requests/min']) {
      ok(!rate.includes(figure), `429 on ${id} states no invented limit figure ("${figure}")`, `got: ${rate}`);
    }
  }

  // UNKNOWN / ABSENT provider degrades to generic advice — never to a vendor.
  for (const bogus of [null, undefined, '', 'future-vendor', '__proto__', 'constructor', 'toString', 42, {}]) {
    const rate = T.buildRateLimitMessage('AI provider', bogus, 30);
    const svc  = T.buildServiceUnavailableMessage('AI provider', bogus);
    const label = JSON.stringify(bogus) ?? String(bogus);
    ok(!/https?:\/\//.test(rate), `429 with provider ${label} offers NO link rather than a wrong one`, `got: ${rate}`);
    ok(!/https?:\/\//.test(svc),  `503 with provider ${label} offers NO link rather than a wrong one`, `got: ${svc}`);
    ok(!rate.includes('[object'), `429 with provider ${label} never renders "[object …]"`, `got: ${rate}`);
    ok(!svc.includes('[object'),  `503 with provider ${label} never renders "[object …]"`, `got: ${svc}`);
    ok(rate.includes("your provider's own rate-limit documentation"), `429 with provider ${label} gives generic rate-limit advice`);
    ok(svc.includes("your provider's own status page"), `503 with provider ${label} gives generic status advice`);
  }

  // `providerRemedies` must use an OWN-property lookup. A bare index returns a
  // FUNCTION for 'constructor' — the v3.13.0 shape.
  for (const proto of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    okLit(null, T.providerRemedies(proto), `providerRemedies("${proto}") is null, not an inherited member`);
  }
  ok(typeof T.providerRemedies('gemini') === 'object' && T.providerRemedies('gemini') !== null,
    'providerRemedies("gemini") still resolves a real entry (the negatives above are not vacuous)');

  // Every KNOWN provider needs an entry, or its users get generic advice
  // silently. This is the one place reading the constant is correct: it is a
  // COVERAGE check across two lists, not an expectation about a value.
  for (const p of T.KNOWN_PROVIDERS) {
    ok(T.providerRemedies(p) !== null,
      `KNOWN_PROVIDERS entry "${p}" has remedy links (a new provider must not silently fall back to generic advice)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n§2  The builders are actually WIRED — call sites, not just source');
// ─────────────────────────────────────────────────────────────────────────────
{
  // Audit root cause 3: a builder can be perfect and have zero callers. Scoped
  // to generateText (root cause 2), over comment-stripped source (cause 1).
  const genSrc = functionSource(llmSrc, 'generateText');
  ok(genSrc !== null, 'generateText is locatable in llm.js (a null scope would pass vacuously)');

  okLit(1, callSiteCount(llmSrc, 'buildRateLimitMessage', { within: 'generateText' }),
    'buildRateLimitMessage is called exactly once inside generateText');
  okLit(1, callSiteCount(llmSrc, 'buildServiceUnavailableMessage', { within: 'generateText' }),
    'buildServiceUnavailableMessage is called exactly once inside generateText');

  // The provider ID must reach the builders. Re-deriving it from the display
  // name ('Claude' for `anthropic`) is the mistake this guards.
  ok(/providerId\s*=\s*info\.provider/.test(genSrc),
    'generateText captures the provider ID from getProviderInfo, not just the display name');
  ok(/let\s+providerId\s*=\s*null/.test(genSrc),
    'providerId starts null, so a failed provider resolution degrades to generic advice');

  // ARGUMENTS, not just call counts. §1 proves the builders render the right
  // remedy GIVEN a provider id; these prove the id is what production hands
  // them. Passing `providerName` here would render generic advice for every
  // provider — a silent regression to "no links" that a call COUNT cannot see.
  ok(/buildRateLimitMessage\(\s*providerName\s*,\s*providerId\s*,\s*delaySec\s*\)/.test(genSrc),
    'the 429 call site passes providerId (not the display name) to the builder');
  ok(/buildServiceUnavailableMessage\(\s*providerName\s*,\s*providerId\s*\)/.test(genSrc),
    'the 503 call site passes providerId (not the display name) to the builder');

  // The literal Google remedies must be gone from llm.js's runtime source.
  for (const dead of ['https://ai.google.dev/pricing', 'https://status.cloud.google.com or temporarily switch']) {
    ok(!llmSrc.includes(dead), `the hardcoded Google remedy "${dead}" is gone from llm.js code`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n§3  END-TO-END through the REAL retry ladder (no paid calls)');
// ─────────────────────────────────────────────────────────────────────────────
{
  // Drives production `generateText` with injected clients that throw the
  // provider's real error shape. Proves the wiring, the retry gate, the
  // structured tags and the rendered remedy all still line up — which the pure
  // builders alone cannot.
  //
  // SPEED, WITHOUT FAKING THE PATH. The real ladder retries 3 times before it
  // throws. The 429 delay is read from the provider's own hint by
  // parseRetryDelay, so a `"retryDelay":"0.001s"` in the injected message makes
  // production wait ~1 ms per retry instead of its 60 s default. Nothing about
  // the classification, the retry gate or the message is stubbed — only the
  // number the provider would have supplied.
  //
  // NOT ENFORCED, stated rather than implied away:
  //   - The 503 branch is NOT driven end-to-end here. Its backoff is a fixed
  //     3 s + 9 s + 27 s with no hint to shorten, and ~39 s in an offline suite
  //     is a cost every future run pays. It is covered instead by §1 (the
  //     builder executed for every provider), §2 (its call site AND its
  //     arguments asserted inside generateText) and §4 (its classifiers).
  //   - Gemini is not driven end-to-end either: its SDK client is constructed
  //     inline with no injection seam, so there is nothing to substitute
  //     without a paid call.
  const origAnthropic = process.env.ANTHROPIC_API_KEY;
  const origOpenRouter = process.env.OPENROUTER_API_KEY;

  async function drive({ setFactory, makeClient, provider, envVar, envValue }) {
    process.env[envVar] = envValue;
    setFactory(makeClient);
    try {
      await llm.generateText('sys', 'user', 64, 'text', null, { provider });
      return null;
    } catch (e) {
      return e;
    } finally {
      setFactory(null);
    }
  }

  // The key value only has to be TRUTHY: getEffectiveKey gates provider
  // resolution on presence, and the injected client never reads it. It
  // deliberately carries NO vendor prefix — a credential-SHAPED fixture is
  // one character from tripping the pre-commit secret hook (which needs 20
  // chars after `sk-ant-`/`sk-or-v1-`; the obvious placeholders were 19),
  // and v3.15.0 records both test agents declining to allow-list their own
  // fixtures because that trains the next person to allow-list.
  const FAST_429 = '429 Too Many Requests {"retryDelay":"0.001s"}';

  // ── Anthropic 429 ────────────────────────────────────────────────────────
  const a429 = await drive({
    setFactory: llm.__setAnthropicClientFactory,
    makeClient: () => ({ messages: { stream: () => { throw new Error(FAST_429); } } }),
    provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', envValue: 'placeholder-not-a-credential',
  });
  ok(a429 !== null, 'the injected Anthropic client really failed (a null here would make the rest vacuous)');
  if (a429) {
    ok(a429.message.includes('https://docs.anthropic.com/en/api/rate-limits'),
      'live 429 on Anthropic renders the ANTHROPIC rate-limit doc', `got: ${a429.message}`);
    ok(!a429.message.toLowerCase().includes('google'),
      'live 429 on Anthropic never mentions Google (the reported defect)', `got: ${a429.message}`);
    okLit('rate_limit', a429.curatorTransient, 'live 429 still carries curatorTransient="rate_limit"');
  }

  // ── OpenRouter 429 — the exact combination the tester reported ───────────
  const o429 = await drive({
    setFactory: llm.__setOpenRouterAdapterFactory,
    makeClient: () => ({ createChatCompletion: () => { throw new Error(FAST_429); } }),
    provider: 'openrouter', envVar: 'OPENROUTER_API_KEY', envValue: 'placeholder-not-a-credential',
  });
  ok(o429 !== null, 'the injected OpenRouter client really failed (a null here would make the rest vacuous)');
  if (o429) {
    ok(o429.message.includes('https://openrouter.ai/docs/api-reference/limits'),
      'live 429 on OpenRouter renders the OPENROUTER limits doc', `got: ${o429.message}`);
    // THE REPORTED DEFECT, reproduced as an assertion: this rendered
    // "consider upgrading at ai.google.dev/pricing" before the fix.
    ok(!o429.message.includes('ai.google.dev'),
      'live 429 on OpenRouter never sends the user to ai.google.dev (the reported defect)', `got: ${o429.message}`);
    ok(!o429.message.toLowerCase().includes('google'),
      'live 429 on OpenRouter never mentions Google at all', `got: ${o429.message}`);
    okLit('rate_limit', o429.curatorTransient, 'live 429 on OpenRouter still carries curatorTransient="rate_limit"');
  }

  if (origAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = origAnthropic;
  if (origOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = origOpenRouter;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n§4  Every message-matching predicate STILL FIRES on the new text');
// ─────────────────────────────────────────────────────────────────────────────
{
  // The rewritten messages are read as TEXT by five classifiers across four
  // files. Rewording "(HTTP 429)", "(HTTP 503)" or "temporarily overloaded"
  // silently breaks a recovery path with nothing else failing — e.g. the batch
  // queue would stop PAUSING on a rate limit and would instead fail 30 files
  // one by one against a provider that has said stop.
  const { classifyTransientError } = await import('../src/brain/ingest-queue.js');

  for (const [id, name] of [['gemini', 'Gemini'], ['anthropic', 'Claude'], ['openrouter', 'OpenRouter'], [null, 'AI provider']]) {
    const rate = T.buildRateLimitMessage(name, id, 30);
    const svc  = T.buildServiceUnavailableMessage(name, id);
    const label = id ?? 'unknown-provider';

    ok(T.is429({ message: rate }), `is429 fires on the ${label} 429 message`, `got: ${rate}`);
    ok(T.is503({ message: svc }),  `is503 fires on the ${label} 503 message`, `got: ${svc}`);

    ok(isTransientLlmError(rate), `sharedbrain isTransientLlmError fires on the ${label} 429 message`);
    ok(isTransientLlmError(svc),  `sharedbrain isTransientLlmError fires on the ${label} 503 message`);

    ok(hasTransientMarker(rate), `ci-flake hasTransientMarker fires on the ${label} 429 message`);
    ok(hasTransientMarker(svc),  `ci-flake hasTransientMarker fires on the ${label} 503 message`);

    // The queue's TEXT fallback, used when a wrapped error has lost the tag.
    okLit('rate_limit', classifyTransientError(new Error(`Ingest failed: ${rate}`)),
      `queue classifies a WRAPPED ${label} 429 message as rate_limit via "(HTTP 429)"`);
    okLit('service_unavailable', classifyTransientError(new Error(`Ingest failed: ${svc}`)),
      `queue classifies a WRAPPED ${label} 503 message as service_unavailable via "(HTTP 503)"`);

    // Pin the exact load-bearing literals so a reword reds HERE with a reason,
    // rather than silently downgrading a recovery path somewhere else.
    ok(rate.includes('(HTTP 429)'), `the ${label} 429 message keeps the literal "(HTTP 429)"`);
    ok(svc.includes('(HTTP 503)'),  `the ${label} 503 message keeps the literal "(HTTP 503)"`);
    ok(svc.includes('temporarily overloaded'), `the ${label} 503 message keeps the literal "temporarily overloaded"`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n§5  Ingest refusals match the source the user actually uploaded');
// ─────────────────────────────────────────────────────────────────────────────
{
  okLit('pdf', IT.sourceKind('report.pdf'), 'sourceKind classifies .pdf');
  okLit('pdf', IT.sourceKind('REPORT.PDF'), 'sourceKind is case-insensitive');
  okLit('md',  IT.sourceKind('notes.md'), 'sourceKind classifies .md');
  okLit('txt', IT.sourceKind('notes.txt'), 'sourceKind classifies .txt');
  okLit('other', IT.sourceKind('mystery'), 'sourceKind falls through to "other"');
  okLit('other', IT.sourceKind(null), 'sourceKind survives a non-string filename');

  const OCR_WORDS = ['ocrmypdf', 'OCR', 'image-only', 'scanned', 'encrypted'];

  // PDF advice KEEPS the OCR guidance — the fix must not strip it from the one
  // format where it is correct. Without this, "delete all OCR text" passes.
  for (const build of [IT.extractionFailureAdvice, IT.emptySourceAdvice]) {
    const pdf = build('pdf');
    ok(OCR_WORDS.some(w => pdf.includes(w)), 'PDF advice still offers OCR guidance (the fix is not "delete the advice")', `got: ${pdf}`);
    ok(pdf.toLowerCase().includes('pdf'), 'PDF advice still names the PDF');
  }

  // NON-PDF advice must contain NONE of it.
  for (const kind of ['md', 'txt', 'other']) {
    for (const build of [['extractionFailureAdvice', IT.extractionFailureAdvice], ['emptySourceAdvice', IT.emptySourceAdvice]]) {
      const [bname, fn] = build;
      const text = fn(kind);
      for (const w of OCR_WORDS) {
        ok(!text.includes(w), `${bname}("${kind}") never mentions "${w}"`, `got: ${text}`);
      }
      ok(text.length > 40, `${bname}("${kind}") still says something actionable`, `got: ${text}`);
    }
  }
  ok(IT.emptySourceAdvice('md').includes('Markdown'), 'empty .md advice names Markdown');
  ok(IT.emptySourceAdvice('txt').includes('text'), 'empty .txt advice names text');

  // CALL SITES inside ingestFile — root cause 3 again. Both refusals must
  // actually use the builders, and must classify from the ORIGINAL filename.
  const ingestFileSrc = functionSource(ingestSrc, 'ingestFile');
  ok(ingestFileSrc !== null, 'ingestFile is locatable in ingest.js (a null scope would pass vacuously)');
  okLit(1, callSiteCount(ingestSrc, 'extractionFailureAdvice', { within: 'ingestFile' }),
    'extractionFailureAdvice is called exactly once inside ingestFile');
  okLit(1, callSiteCount(ingestSrc, 'emptySourceAdvice', { within: 'ingestFile' }),
    'emptySourceAdvice is called exactly once inside ingestFile');
  okLit(2, callSiteCount(ingestSrc, 'sourceKind', { within: 'ingestFile' }),
    'sourceKind is called at BOTH refusal sites inside ingestFile');
  ok(/sourceKind\(originalName\)/.test(ingestFileSrc),
    'both refusals classify from originalName (what the user recognises), not the staged path');

  // The rollback the task requires to stay intact.
  ok(/unlink\(destPath\)/.test(ingestFileSrc),
    'the raw-file rollback on refusal is still present in ingestFile');
  okLit(true, ingestFileSrc.includes('The raw file has been removed so you can re-upload after fixing it.'),
    'the empty-source refusal still tells the user the raw file was rolled back');

  // Unconditional PDF advice must be gone from ingestFile's own body.
  ok(!/This usually means the PDF is image-only/.test(ingestFileSrc),
    'ingestFile no longer hardcodes "the PDF is image-only" for every source type');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
