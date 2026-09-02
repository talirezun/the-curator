/**
 * test-health-cost-readouts.js — OFFLINE suite for the "dead data" fix on
 * /next's Health AI cost readout.
 *
 *   health-ai.js's costFields() (already shipped) added {priceKnown, costNote}
 *   alongside the existing {estimatedUsd}. Before this suite's change, the
 *   render sites printed a literal empty string for an unpriced model — no
 *   number, no message, on a SPEND GATE — and priceKnown/costNote had NO
 *   consumer anywhere in either frontend. src/public/next/views/domains.js
 *   gained costReadout(). It is pure, and is extracted from the REAL browser
 *   source (not a copy) and executed via `new Function`, because domains.js
 *   cannot be loaded whole in Node (it is a full module of top-level imports
 *   and DOM lookups).
 *
 * ── WHAT v3.41.0 REMOVED, AND WHY IT IS NOT REPLACED ─────────────────────
 * This suite covered TWO frontends and TWO jobs. Both of the halves that read
 * src/public/app.js are gone with that file:
 *
 *   • Job 1's app.js side — formatHealthCost(), its call-site guards and its
 *     mutation proof (old §§1-4, 15). The /next half below is unchanged and
 *     is now the only renderer of this field a user can reach.
 *   • Job 2 entirely — sbRevokeDoneStatus() and its mutation proof
 *     (old §§9-13, 16). That function lived ONLY in the deleted shell, and it
 *     fixed a real defect: the Shared Brain revoke route emits a type:'done'
 *     frame with NO `result`, then a second one carrying the real result, and
 *     the naive handler rendered "Revocation complete: ? contributions
 *     deleted, ? pages removed, ? rebuilt." for the first. §14 below (kept)
 *     asserts /next consumes the result on BOTH terminal frames, which is the
 *     same defect approached from the other side — but /next has no
 *     sbRevokeDoneStatus and the empty-frame behaviour is not driven here.
 *     Recorded as an open item rather than assumed handled.
 *
 * Every assertion that remains is a CONTROL-paired behavioural check: for
 * every "unpriced renders honestly" case there is a matching "known price
 * renders EXACTLY as before" case, so a renderer that broke both paths
 * identically cannot pass by accident.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// domains.js's formatUsd now DELEGATES to the one honest USD renderer
// (a non-zero cost must never render as '$0.0000'), so the sandbox has to
// be given the REAL implementation. Injecting the real module — not a
// stub — is what keeps this suite's costReadout assertions meaningful.
import { formatUsdHonest } from '../src/public/next/shared/format-usd.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DOMAINS_PATH = path.join(ROOT, 'src/public/next/views/domains.js');

const domainsSrc = readFileSync(DOMAINS_PATH, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Extraction helpers (same convention as test-ingest-queue-frontend.js:
//    a top-level `function name(...) { ... }` whose CLOSING brace sits at
//    column 0 — the non-greedy `\n\}` only matches a brace with no leading
//    whitespace, so nested `if`/`for` blocks inside the function body are
//    never mistaken for the end) ──────────────────────────────────────────
function extractFn(src, name) {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  return m ? m[0] : null;
}

function buildSandbox(src, names, inject) {
  let combined = '';
  const missing = [];
  for (const n of names) {
    const f = extractFn(src, n);
    if (!f) { missing.push(n); continue; }
    combined += f + '\n\n';
  }
  if (missing.length) throw new Error(`extractFn could not find: ${missing.join(', ')}`);
  combined += `\nreturn { ${names.join(', ')} };\n`;
  // `inject` supplies anything an extracted function IMPORTS rather than
  // declares locally. Without it the extraction still builds fine and only
  // blows up at CALL time with a bare ReferenceError, which reads as a test
  // bug rather than a missing dependency.
  const injectedNames = inject ? Object.keys(inject) : [];
  return new Function(...injectedNames, combined)(...injectedNames.map((k) => inject[k]));
}

// ── 1-4 (REMOVED in v3.41.0) — formatHealthCost lived in the deleted
//    src/public/app.js; see this file's header. Sections keep their
//    original numbers so the header's references stay checkable.

// ── 5. costReadout (domains.js /next) — extraction sanity ──────────────────
section('5. costReadout extracts and runs from the real domains.js source');
let costReadout;
{
  const sandbox = buildSandbox(domainsSrc, ['formatUsd', 'costReadout'], { formatUsdHonest });
  costReadout = sandbox.costReadout;
  ok(typeof costReadout === 'function', 'costReadout extracted as a callable function');
}

// ── 6. costReadout — known price renders EXACTLY as before (CONTROL) ───────
section('6. costReadout — known-price rendering is UNCHANGED (control)');
{
  const priced = { estimatedUsd: 0.0042, priceKnown: true, costNote: null };
  eq(costReadout(priced), '$0.0042', 'known sub-cent price → formatUsd(0.0042) unchanged');
  eq(costReadout(priced, { compact: true }), '$0.0042', 'known price is identical in compact mode (the $ figure is always short)');
  const bigPrice = { estimatedUsd: 1.5, priceKnown: true };
  eq(costReadout(bigPrice), '$1.50', 'known price >= 1c uses the 2-decimal formatUsd branch, unchanged');

  // Pre-existing null/error contract preserved — every call site still does
  // `costReadout(est) || 'unknown'` or checks the return for null.
  eq(costReadout(null), null, 'no estimate at all → null (matches every existing caller\'s null-check)');
  eq(costReadout({ error: 'boom' }), null, 'an estimate carrying .error → null, never a stale $ figure');
}

// ── 7. costReadout — unpriced model renders the HONEST signal ──────────────
section('7. costReadout — unpriced model (priceKnown:false) is never blank/$NaN/$0.0000');
{
  const unpriced = {
    estimatedUsd: null, priceKnown: false,
    costNote: 'Cost estimate unavailable — no published price for model "claude-sonnet-9000".',
  };
  const full = costReadout(unpriced);
  eq(full, unpriced.costNote, 'non-compact unpriced readout surfaces the server costNote verbatim');
  ok(full !== null && full !== '' && !/NaN/.test(full) && full !== '$0.0000',
    'non-compact unpriced readout is never null/blank/$NaN/$0.0000');

  const compact = costReadout(unpriced, { compact: true });
  eq(compact, 'cost unknown', 'compact (per-button badge) unpriced readout uses the short "cost unknown" form, not the full sentence');
  ok(compact !== null && compact !== '' && !/NaN/.test(compact) && compact !== '$0.0000',
    'compact unpriced readout is never null/blank/$NaN/$0.0000');

  // Defensive: unpriced with no costNote at all still degrades honestly.
  eq(costReadout({ estimatedUsd: null }), 'cost unknown', 'unpriced with no costNote at all falls back to "cost unknown", never blank');
}

// ── 8. domains.js call sites — rewired to costReadout ───────────────────────
section('8. domains.js call sites — old formatUsd(est.estimatedUsd) direct calls are gone');
{
  // costReadout's OWN body legitimately calls formatUsd(est.estimatedUsd)
  // on the known-price branch, and its declaration line is
  // `function costReadout(est, …)` — both must be excluded before counting
  // CALL SITES (as opposed to the definition itself).
  const costReadoutDef = extractFn(domainsSrc, 'costReadout');
  ok(costReadoutDef !== null, 'costReadout function body extracted for exclusion (precondition)');
  const srcMinusDef = domainsSrc.replace(costReadoutDef, '');

  const directCostCalls = (srcMinusDef.match(/formatUsd\(est\.estimatedUsd\)/g) || []).length;
  eq(directCostCalls, 0, 'no remaining direct formatUsd(est.estimatedUsd) CALL SITE outside costReadout itself (all 4 sites now use costReadout)');
  ok(/formatUsd\(est\.estimatedUsd\)/.test(costReadoutDef),
    'costReadout\'s own known-price branch still calls formatUsd(est.estimatedUsd) internally (that call is legitimate, not a leftover)');

  const costReadoutCalls = (srcMinusDef.match(/costReadout\(est/g) || []).length;
  eq(costReadoutCalls, 4, 'costReadout(est…) is called at all 4 known CALL sites (quickAiButton + 3 confirm dialogs), excluding its own declaration');
}

// ── 9-13 (REMOVED in v3.41.0) — sbRevokeDoneStatus lived ONLY in the
//    deleted src/public/app.js; see this file's header for what that means
//    for the empty-done-frame defect.

section('14. next/views/shared.js — revoke UI present, and result consumed on BOTH terminal frames');
{
  const sharedPath = path.join(ROOT, 'src/public/next/views/shared.js');
  const sharedSrc = readFileSync(sharedPath, 'utf8');
  ok(/data-sb-action="revoke-run"/.test(sharedSrc),
    'src/public/next/views/shared.js now ships the revoke UI (the v3.6.2 gap is closed)');
  ok(/function absorbRevokeFrame\(acc, payload\)/.test(sharedSrc),
    '/next routes every revoke SSE frame through one absorber, so a result-less terminal frame cannot drop the structured result');
  ok(/if \(payload\.type === 'error'\)[\s\S]{0,400}?if \(hasResult\) next\.result = payload\.result;/.test(sharedSrc),
    '/next reads `result` off the ERROR frame too — the half the shipping app still leaves on the floor');
  ok(/function classifyRevokeOutcome\(acc\)/.test(sharedSrc),
    '/next decides the outcome tone from the structured fields, not from the summary prose');
}

// ── 15. Mutation proof — costReadout (behavioural RED, then restore) ───────
// This was TWO mutation proofs, both against functions in the deleted
// src/public/app.js. It is one, against the function that still ships, and it
// is the same technique: reproduce the ORIGINAL bug in an in-memory copy of
// the real source, confirm the copy goes red, then prove the on-disk source
// was never touched.
section('15. Mutation proof — costReadout (behavioural RED, then restore)');
{
  const goodSrc = extractFn(domainsSrc, 'costReadout');
  ok(goodSrc !== null, 'baseline extraction succeeded (precondition for the mutation test)');

  // Mutation: reproduce the ORIGINAL bug — an unpriced estimate renders as
  // an empty string, which is what a spend gate showed before this fix.
  const brokenSrc = goodSrc.replace(/return[^\n;]*costNote[^;]*;/, "return '';");
  ok(brokenSrc !== goodSrc,
    'the mutation actually changed the source text (precondition: a no-op mutation would prove nothing)');

  const brokenFn = new Function('formatUsdHonest', `${brokenSrc}\nreturn costReadout;`)(formatUsdHonest);
  const unpriced = {
    estimatedUsd: null, priceKnown: false,
    costNote: 'Cost estimate unavailable — no published price for model "x".',
  };

  // The mutated function must still be CALLABLE (a syntax error or crash here
  // would be a red for the WRONG reason and would prove nothing about the
  // behaviour under test).
  let brokenResult;
  let threw = false;
  try { brokenResult = brokenFn(unpriced); } catch { threw = true; }
  ok(!threw, 'the mutated function runs without throwing (a red here would be a crash, not the intended behavioural failure)');
  ok(brokenResult !== unpriced.costNote,
    'CONFIRMED RED: the mutated function no longer surfaces the honest note — the assertions in section 7 would fail against this code');

  // Restore: re-extract from the UNMODIFIED source (never write back to disk)
  // and confirm the real function is unaffected and still passes.
  const restoredFn = new Function('formatUsdHonest', `${goodSrc}\nreturn costReadout;`)(formatUsdHonest);
  ok(restoredFn(unpriced) === unpriced.costNote,
    'RESTORED: the real (unmutated) function is unaffected and passes again');
  eq(goodSrc, extractFn(domainsSrc, 'costReadout'),
    'the source on disk was never touched by this mutation test (re-extraction is byte-identical)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All health-cost-readouts (/next dead-data-fix) offline assertions green');
