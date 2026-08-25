/**
 * test-health-cost-readouts.js — OFFLINE suite for two "dead data" fixes:
 *
 *   Job 1 — Health AI cost estimates. health-ai.js's costFields() (already
 *   shipped) added {priceKnown, costNote} alongside the existing
 *   {estimatedUsd}. Before this suite's change, two render sites in app.js
 *   (renderBrokenLinkPreview, renderOrphanPreview) printed a literal empty
 *   string for an unpriced model — no number, no message, on a spend gate —
 *   and priceKnown/costNote had NO consumer anywhere in either frontend.
 *   src/public/app.js gained formatHealthCost(); src/public/next/views/
 *   domains.js gained costReadout(). Both are pure and are extracted from
 *   the REAL browser source (not a copy) and executed via `new Function`,
 *   following the pattern in test-chat-markdown.js / test-ingest-queue-
 *   frontend.js — app.js/domains.js cannot be loaded whole in Node (they're
 *   full modules full of top-level `document.getElementById`/`import`).
 *
 *   Job 2 — Shared Brain revoke. The route forwards revokeContributor's own
 *   onProgress('done', doneMsg) as a type:'done' SSE frame with NO `result`,
 *   then emits a SECOND type:'done' frame carrying the real `result` once
 *   the HTTP handler's await returns. app.js used to read
 *   result.contributions_deleted unconditionally, rendering "Revocation
 *   complete: ? contributions deleted, ? pages removed, ? rebuilt." for
 *   that empty intermediate frame. The new sbRevokeDoneStatus(payload) pure
 *   function (sibling to the existing sbComposeDoneMessage) prefers the
 *   server's own result.summary, falls back to the hand-built string only
 *   when counted fields exist, and returns null (render nothing) for an
 *   empty frame — extracted and executed the same way as Job 1.
 *
 * Every assertion in section 1-4/6 is a CONTROL-paired behavioural check:
 * for every "unpriced renders honestly" case there is a matching "known
 * price renders EXACTLY as before" case, so a renderer that broke both
 * paths identically cannot pass by accident.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_PATH = path.join(ROOT, 'src/public/app.js');
const DOMAINS_PATH = path.join(ROOT, 'src/public/next/views/domains.js');

const appSrc = readFileSync(APP_PATH, 'utf8');
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

function buildSandbox(src, names) {
  let combined = '';
  const missing = [];
  for (const n of names) {
    const f = extractFn(src, n);
    if (!f) { missing.push(n); continue; }
    combined += f + '\n\n';
  }
  if (missing.length) throw new Error(`extractFn could not find: ${missing.join(', ')}`);
  combined += `\nreturn { ${names.join(', ')} };\n`;
  return new Function(combined)();
}

// ── 1. formatHealthCost (app.js) — extraction sanity ────────────────────────
section('1. formatHealthCost extracts and runs from the real app.js source');
let formatHealthCost;
{
  const sandbox = buildSandbox(appSrc, ['formatHealthCost']);
  formatHealthCost = sandbox.formatHealthCost;
  ok(typeof formatHealthCost === 'function', 'formatHealthCost extracted as a callable function');
}

// ── 2. formatHealthCost — known price renders EXACTLY as before (CONTROL) ──
section('2. formatHealthCost — known-price rendering is UNCHANGED (control)');
{
  const priced = { estimatedUsd: 0.0042, priceKnown: true, costNote: null, provider: 'gemini', model: 'gemini-2.5-flash-lite' };
  eq(formatHealthCost(priced), '$0.0042',
    'known price, no withProviderModel → bare $X.XXXX (matches every pre-existing "usd" call site)');
  eq(formatHealthCost(priced, { withProviderModel: true }), '$0.0042 on gemini/gemini-2.5-flash-lite',
    'known price, withProviderModel:true → "$X.XXXX on provider/model" (matches every pre-existing "costStr" call site)');

  // A real $0 price (e.g. a genuinely free local/dry-run estimate) is a
  // KNOWN price, not the unpriced case — `0 !== null` must keep it on the
  // priced branch rather than falling through to the costNote message.
  const free = { estimatedUsd: 0, priceKnown: true, costNote: null, provider: 'gemini', model: 'x' };
  eq(formatHealthCost(free), '$0.0000', 'a genuine $0 estimate still renders as a number, not the unpriced message');
}

// ── 3. formatHealthCost — unpriced model renders the HONEST signal ──────────
section('3. formatHealthCost — unpriced model (priceKnown:false) is never blank/$NaN/$0.0000');
{
  const unpriced = {
    estimatedUsd: null, priceKnown: false,
    costNote: 'Cost estimate unavailable — no published price for model "claude-sonnet-9000".',
    provider: 'anthropic', model: 'claude-sonnet-9000',
  };
  const rendered = formatHealthCost(unpriced);
  eq(rendered, unpriced.costNote, 'unpriced model renders the SERVER-SUPPLIED costNote verbatim (one source of truth)');
  ok(rendered !== '', 'unpriced model never renders a blank string (job 1\'s worst-outcome case)');
  ok(!/NaN/.test(rendered), 'unpriced model never renders $NaN');
  ok(rendered !== '$0.0000', 'unpriced model never renders $0.0000 (would falsely claim the operation is free)');

  // withProviderModel must not fight the costNote path — the note already
  // names the model, so it must render unchanged regardless of the flag.
  eq(formatHealthCost(unpriced, { withProviderModel: true }), unpriced.costNote,
    'withProviderModel:true does not alter the costNote branch');

  // Defensive fallback: a payload predating costNote (estimatedUsd:null with
  // no costNote field at all) must still be honest, never blank.
  const legacyShape = { estimatedUsd: null };
  const fallback = formatHealthCost(legacyShape);
  ok(fallback !== '' && typeof fallback === 'string' && fallback.length > 10,
    'a payload with no costNote at all still renders a real sentence, not a blank string');
  eq(formatHealthCost(null), fallback, 'a completely missing cost object renders the same honest fallback');
  eq(formatHealthCost(undefined), fallback, 'undefined cost renders the same honest fallback');
}

// ── 4. app.js — every previously-blank/duplicated call site was rewired ────
section('4. app.js call sites — old broken patterns are GONE, formatHealthCost is wired in');
{
  // The exact broken line from renderBrokenLinkPreview/renderOrphanPreview:
  // `cost.estimatedUsd != null ? ... : ''` — rendered nothing on a spend gate.
  ok(!/cost && cost\.estimatedUsd != null \? `\$\$\{cost\.estimatedUsd\.toFixed\(4\)\}` : ''/.test(appSrc),
    'the blank-string cost fallback (renderBrokenLinkPreview / renderOrphanPreview) is gone');
  // The bare 'cost unknown' ternaries that ignored costNote entirely.
  const bareCostUnknownTernaries = (appSrc.match(/\? `\$\$\{est\.estimatedUsd\.toFixed\(4\)\}[^`]*` : 'cost unknown'/g) || []).length;
  eq(bareCostUnknownTernaries, 0, 'no remaining hand-rolled "$X.XXXX : cost unknown" ternary (all route through formatHealthCost)');

  // 1 definition + 6 known call sites (2 semantic-dupes, 2 broken-links,
  // 2 orphan-rescue — one estimate-dialog costStr + one plan-preview usd
  // per feature).
  const totalMatches = (appSrc.match(/formatHealthCost\(/g) || []).length;
  eq(totalMatches, 7, `formatHealthCost appears exactly 7 times total (1 definition + 6 call sites; found ${totalMatches})`);

  // The two innerHTML sites (renderBrokenLinkPreview, renderOrphanPreview)
  // must escape the value before interpolating — formatHealthCost can now
  // surface a costNote sentence that echoes a model id.
  ok(/Planning cost: \$\{escapeHtml\(usd\)\}\./.test(appSrc),
    'the two "Planning cost: …" innerHTML sites escapeHtml() the formatted cost before interpolating');
  const planningCostSites = (appSrc.match(/Planning cost: \$\{escapeHtml\(usd\)\}\./g) || []).length;
  eq(planningCostSites, 2, 'exactly the two known sites (broken-link + orphan preview) carry the escaped Planning-cost line');

  // The semantic-scan "done" readout assigns straight to .textContent (not
  // innerHTML) — confirm it stayed that way, so no escaping regression there.
  ok(/const usd = formatHealthCost\(event\.cost\);\s*\n\s*ui\.text\.textContent = /.test(appSrc),
    'the semantic-scan done readout still assigns via .textContent (no HTML injection surface)');
}

// ── 5. costReadout (domains.js /next) — extraction sanity ──────────────────
section('5. costReadout extracts and runs from the real domains.js source');
let costReadout;
{
  const sandbox = buildSandbox(domainsSrc, ['formatUsd', 'costReadout']);
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

// ── 9. sbRevokeDoneStatus (app.js) — extraction + behaviour ─────────────────
section('9. sbRevokeDoneStatus extracts and runs from the real app.js source');
let sbRevokeDoneStatus;
{
  const sandbox = buildSandbox(appSrc, ['sbRevokeDoneStatus']);
  sbRevokeDoneStatus = sandbox.sbRevokeDoneStatus;
  ok(typeof sbRevokeDoneStatus === 'function', 'sbRevokeDoneStatus extracted as a callable function');
}

section('10. sbRevokeDoneStatus — the intermediate empty done frame is silenced');
{
  // This is the EXACT shape revokeContributor's onProgress('done', doneMsg)
  // produces once forwarded by the route: type:'done', a human `message`,
  // and NO `result` key at all.
  const intermediateFrame = { type: 'done', message: 'Revocation complete: 3 contributions deleted, 2 pages removed, 1 rebuilt. Next: …' };
  eq(sbRevokeDoneStatus(intermediateFrame), null,
    'a done frame with no `result` renders nothing (reproduces, then closes, the "?  contributions deleted" flash)');
  eq(sbRevokeDoneStatus({ type: 'done' }), null, 'a done frame with neither `result` nor `message` also renders nothing');
  eq(sbRevokeDoneStatus({ type: 'done', result: {} }), null, 'a done frame with an EMPTY result object renders nothing (not "? ? ?")');
}

section('11. sbRevokeDoneStatus — the real frame prefers result.summary (server owns the wording)');
{
  const realFrame = {
    type: 'done',
    result: {
      ok: true,
      summary: 'Revocation complete: 3 contributions, 2 pages deleted, 1 rebuilt, 0 problems. Next: tell every contributor to Pull updates.',
      contributions_deleted: 3, pages_deleted: 2, pages_rebuilt: 1,
    },
  };
  eq(sbRevokeDoneStatus(realFrame), realFrame.result.summary,
    'when result.summary is present it is used verbatim — the server owns the wording');
}

section('12. sbRevokeDoneStatus — fallback string when summary is absent but counts exist');
{
  const oldShapeFrame = { type: 'done', result: { contributions_deleted: 5, pages_deleted: 4, pages_rebuilt: 2 } };
  const msg = sbRevokeDoneStatus(oldShapeFrame);
  ok(typeof msg === 'string' && msg.includes('5') && msg.includes('4') && msg.includes('2'),
    'a result with counts but no summary (older/mocked backend shape) still renders the hand-built fallback with the real numbers');
  ok(!/\?/.test(msg), 'the fallback string never contains a "?" placeholder when the counted fields are all present');

  // Reproduce the ORIGINAL bug shape directly: counts present but each one
  // individually undefined (matches the pre-fix code's `res.x ?? '?'`
  // guard) — must still degrade to '?' per-field rather than crash, but
  // ONLY takes this branch at all because contributions_deleted is defined.
  const partialFrame = { type: 'done', result: { contributions_deleted: 0, pages_deleted: undefined, pages_rebuilt: undefined } };
  const partialMsg = sbRevokeDoneStatus(partialFrame);
  ok(partialMsg.includes('0 contributions deleted') && partialMsg.includes('? pages removed') && partialMsg.includes('? rebuilt'),
    'contributions_deleted:0 (falsy but defined) still enters the counted branch; missing sibling fields degrade to "?" individually');
}

// ── 13. app.js wiring — the SSE handler calls sbRevokeDoneStatus ───────────
section('13. app.js — the revoke SSE done-handler is wired to sbRevokeDoneStatus, old inline logic is gone');
{
  ok(/const msg = sbRevokeDoneStatus\(payload\);\s*\n\s*if \(msg\) setStatus\(msg\);/.test(appSrc),
    'runSharedBrainRevoke\'s done branch calls sbRevokeDoneStatus and only sets status when it returns something');
  // The hand-built "? contributions deleted" template must exist EXACTLY
  // ONCE in the whole file — inside sbRevokeDoneStatus's own fallback
  // branch — not a second time duplicated inline in the SSE handler (which
  // is where the original bug lived, reading straight off `res` with no
  // frame-emptiness check at all).
  const contribTemplateOccurrences = (appSrc.match(/contributions_deleted \?\? '\?'/g) || []).length;
  eq(contribTemplateOccurrences, 1,
    'the "? contributions deleted" template appears exactly once total (not duplicated between the SSE handler and sbRevokeDoneStatus)');
  // That one occurrence must live INSIDE sbRevokeDoneStatus, not inline in
  // runSharedBrainRevoke's SSE loop — the count check alone can't tell
  // "moved" from "never duplicated"; this containment check can.
  const sbRevokeFnSrc = extractFn(appSrc, 'sbRevokeDoneStatus') || '';
  ok(/contributions_deleted \?\? '\?'/.test(sbRevokeFnSrc),
    'the one remaining occurrence lives inside sbRevokeDoneStatus, confirming it moved out of the inline SSE handler');
  // The error path (result now attached there too) must still render on a
  // guaranteed-visible, per-card surface — never behind a hidden overlay.
  ok(/setStatus\(`Error: \$\{payload\.message\}`, true\)/.test(appSrc),
    'the revoke error branch still renders visibly via the same per-card setStatus() as done/progress');
}

// ── 14. next/views/shared.js — the revoke UI, and the same visibility rule ─
//
// v3.6.2 recorded here that `/next` contained no revoke UI at all, so job 2
// needed no change in that file. That was a TRUE statement about that release
// and is now false BY DESIGN: the parity release built the /next admin
// surface, because shipping a cutover where an admin cannot serve an Article
// 17 erasure was the gap this assertion was documenting.
//
// The absence check is replaced rather than deleted, because the property
// section 13 actually cares about is not "no revoke UI exists" — it is "the
// structured result reaches a visible surface on BOTH terminal frames".
// That property now has to hold in two frontends, so it is asserted in two.
// Behavioural coverage of the /next side lives in
// scripts/test-next-sharedbrain-admin.js; these are the seams that keep the
// two frontends from drifting apart on the rule section 13 exists to protect.
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

// ── 15. Mutation proof — formatHealthCost ───────────────────────────────────
// Prove the unpriced-branch assertion in section 3 can actually go red for a
// BEHAVIOURAL reason (not a crash/TDZ), by re-running the exact same check
// against a deliberately-broken clone of the function.
section('15. Mutation proof — formatHealthCost (behavioural RED, then restore)');
{
  const goodSrc = extractFn(appSrc, 'formatHealthCost');
  ok(goodSrc !== null, 'baseline extraction succeeded (precondition for the mutation test)');

  // Mutation: reproduce the ORIGINAL bug — unpriced always renders ''.
  const brokenSrc = goodSrc.replace(
    /return \(obj && typeof obj\.costNote === 'string' && obj\.costNote\)\s*\n\s*\? obj\.costNote\s*\n\s*: 'Cost estimate unavailable[^']*';/,
    "return '';"
  );
  ok(brokenSrc !== goodSrc, 'the mutation actually changed the source text (precondition: a no-op mutation would prove nothing)');

  const brokenFn = new Function(`${brokenSrc}\nreturn formatHealthCost;`)();
  const unpriced = { estimatedUsd: null, priceKnown: false, costNote: 'Cost estimate unavailable — no published price for model "x".' };

  // The mutated function must still be CALLABLE (a syntax error or crash
  // here would be a red for the WRONG reason and would prove nothing about
  // the behaviour under test).
  let brokenResult;
  let threw = false;
  try { brokenResult = brokenFn(unpriced); } catch { threw = true; }
  ok(!threw, 'the mutated function runs without throwing (a red here would be a crash, not the intended behavioural failure)');
  eq(brokenResult, '', 'CONFIRMED RED: the mutated function reproduces the original bug (blank string for an unpriced model)');
  ok(brokenResult !== unpriced.costNote, 'the mutated function\'s output no longer matches the real function\'s output — the assertion in section 3 would fail against this code');

  // Restore: re-extract from the UNMODIFIED source (never write back to
  // disk) and confirm the real function is unaffected and still passes.
  const restoredFn = new Function(`${goodSrc}\nreturn formatHealthCost;`)();
  eq(restoredFn(unpriced), unpriced.costNote, 'RESTORED: the real (unmutated) function is unaffected and passes again');
  eq(goodSrc, extractFn(appSrc, 'formatHealthCost'), 'the source on disk was never touched by this mutation test (re-extraction is byte-identical)');
}

// ── 16. Mutation proof — sbRevokeDoneStatus ─────────────────────────────────
section('16. Mutation proof — sbRevokeDoneStatus (behavioural RED, then restore)');
{
  const goodSrc = extractFn(appSrc, 'sbRevokeDoneStatus');
  ok(goodSrc !== null, 'baseline extraction succeeded (precondition for the mutation test)');

  // Mutation: reproduce the ORIGINAL bug — always build the hand-rolled
  // string straight off `res`, ignoring both the empty-frame case and
  // result.summary.
  const brokenSrc = goodSrc.replace(
    /const res = \(payload && payload\.result\) \|\| \{\};[\s\S]*?return null;/,
    `const res = (payload && payload.result) || {};
  return \`Revocation complete: \${res.contributions_deleted ?? '?'} contributions deleted, \` +
    \`\${res.pages_deleted ?? '?'} pages removed, \${res.pages_rebuilt ?? '?'} rebuilt.\`;`
  );
  ok(brokenSrc !== goodSrc, 'the mutation actually changed the source text (precondition: a no-op mutation would prove nothing)');

  const brokenFn = new Function(`${brokenSrc}\nreturn sbRevokeDoneStatus;`)();
  let threw = false;
  let brokenResult;
  try { brokenResult = brokenFn({ type: 'done', message: 'irrelevant' }); } catch { threw = true; }
  ok(!threw, 'the mutated function runs without throwing (a red here would be a crash, not the intended behavioural failure)');
  eq(brokenResult, 'Revocation complete: ? contributions deleted, ? pages removed, ? rebuilt.',
    'CONFIRMED RED: the mutated function reproduces the exact original "?  ?  ?" flash for the empty intermediate frame');

  // Restore: re-extract from the UNMODIFIED source and confirm the real
  // function silences the same empty frame.
  const restoredFn = new Function(`${goodSrc}\nreturn sbRevokeDoneStatus;`)();
  eq(restoredFn({ type: 'done', message: 'irrelevant' }), null, 'RESTORED: the real function silences the empty intermediate frame again');
  eq(goodSrc, extractFn(appSrc, 'sbRevokeDoneStatus'), 'the source on disk was never touched by this mutation test (re-extraction is byte-identical)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All health-cost-readouts (Job 1 + Job 2 dead-data-fix) offline assertions green');
