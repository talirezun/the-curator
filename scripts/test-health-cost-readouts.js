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
// v3.67.0 — the run line and the text roles, REAL (the kit and the renderers
// domains.js imports), so the Quick maintenance assertions below measure the
// markup that ships.
import { renderRunsOn, renderSpent, aiActionDisabledAttrs } from '../src/public/next/shared/ai-run.js';
import { renderStatus, renderDescription } from '../src/public/next/shared/text.js';

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

// ═══════════════════════════════════════════════════════════════════════════
// v3.67.0 — WIKI HEALTH'S AI ACTIONS: disabled, never hidden; one run line
// under the bar; the run line first in each confirm; the actual cost after.
// ═══════════════════════════════════════════════════════════════════════════
// Every renderer below is lifted from the REAL domains.js and executed with
// the REAL kit injected (a module-level import is not visible inside a lifted
// body). The key-less case is the one the maintainer's Q3 decided: the three
// ✨ buttons stay on screen, disabled, described by the no-key line whose
// door lands on Settings › Providers & keys (it used to hide them, and its
// only door landed on General).
const GIT_UNDO_NOTE_SRC = (domainsSrc.match(/const GIT_UNDO_NOTE = ('[^\n]*');/) || [])[1];
const GIT_UNDO_NOTE = GIT_UNDO_NOTE_SRC ? new Function('return ' + GIT_UNDO_NOTE_SRC)() : '';
const PRICED = { job: 'wiki-health', jobLabel: 'Wiki health', needsKey: false, provider: 'gemini',
  providerLabel: 'Gemini', model: 'gemini-2.5-flash-lite', modelLabel: 'Flash Lite 2.5',
  priceKnown: true, free: false, costNote: 'priced' };
const NOKEY = { job: 'wiki-health', jobLabel: 'Wiki health', needsKey: true };
function quickSandbox(state) {
  const kit = {
    state, formatUsdHonest, renderRunsOn, renderSpent, aiActionDisabledAttrs, renderStatus, renderDescription,
    GIT_UNDO_NOTE, escapeHtml: (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    icon: (n) => '<svg data-icon="' + n + '"></svg>', buttonRingHtml: () => '<RING/>',
  };
  return buildSandbox(domainsSrc, ['formatUsd', 'costReadout', 'pluralize', 'countSafeFixable',
    'quickAiButton', 'renderQuickMaintenance', 'renderConfirmCard'], kit);
}
const REPORT = { brokenLinks: [{}, {}, {}], orphans: [{}, {}], crossFolderDupes: [], hyphenVariants: [],
  folderPrefixLinks: [], missingBacklinks: [] };
const EMPTY_REPORT = { brokenLinks: [], orphans: [], crossFolderDupes: [], hyphenVariants: [],
  folderPrefixLinks: [], missingBacklinks: [] };
const aiButtons = (html) => [...html.matchAll(/<button class="btn btn-ai btn-xs dm-quick-btn" data-action="([a-zA-Z]+)"([^>]*)>/g)]
  .map((m) => ({ key: m[1], attrs: m[2] }));

section('16. No key → the three ✨ AI actions are disabled, never hidden (v3.67.0)');
{
  const st = { busyKey: null, aiAvailable: false, aiRunsOn: NOKEY, estimates: {}, aiSpent: null };
  const html = quickSandbox(st).renderQuickMaintenance({ slug: 'articles' }, REPORT, false);
  const btns = aiButtons(html);
  eq(btns.map((b) => b.key).join(','), 'brokenLinks,orphans,semanticDupes',
    'disabled, never hidden: all three AI actions render with no key');
  ok(btns.every((b) => b.attrs === ' disabled aria-disabled="true" aria-describedby="dm-quick-runs-on"'),
    '…each one DISABLED with the kit\'s attributes, described by the no-key line');
  ok(/<p class="ai-run" role="note" id="dm-quick-runs-on">/.test(html) && /Needs an AI provider key/.test(html),
    'the no-key run line sits under the bar, carrying the id the buttons point at');
  ok(/data-ai-run-door="providers">Add one in Providers &amp; keys</.test(html),
    '…and its door is the shared one to Providers & keys');
  ok(!/dm-open-settings-btn|Open Settings/.test(html) && !/dm-open-settings-btn/.test(domainsSrc),
    'the old "Open Settings" door (which landed on General) is gone, from the markup AND the listeners');
  ok(html.indexOf('dm-quick-actions') < html.indexOf('dm-quick-runs-on')
    && html.indexOf('dm-quick-runs-on') < html.indexOf('dm-quick-footnote'),
    'the line sits directly under the action bar, above the cost promise');

  // With nothing structural to fix and no key, the bar used to be REPLACED by
  // a sentence. Now the bar stays, with the one always-offered AI action.
  const empty = quickSandbox({ ...st }).renderQuickMaintenance({ slug: 'articles' }, EMPTY_REPORT, false);
  eq(aiButtons(empty).map((b) => b.key).join(','), 'semanticDupes',
    'disabled, never hidden: with nothing to fix and no key, "Find duplicate pages" is still on screen, disabled');
  ok(/QUICK MAINTENANCE/.test(empty), '…inside the Quick maintenance bar, not a replacement sentence');

  // No probe answer at all (state.aiRunsOn null, aiAvailable false): the fail-
  // safe reading is "no key" — disabled, the direction the old code took by hiding.
  const unknown = quickSandbox({ busyKey: null, aiAvailable: false, aiRunsOn: null, estimates: {} })
    .renderQuickMaintenance({ slug: 'articles' }, REPORT, false);
  ok(aiButtons(unknown).length === 3 && aiButtons(unknown).every((b) => /aria-disabled="true"/.test(b.attrs)),
    'with no probe answer, the three are shown disabled (fail-safe), never hidden');
}

section('17. A key → one run line under the bar; the per-button cost badges stay (v3.67.0)');
{
  const st = { busyKey: null, aiAvailable: true, aiRunsOn: PRICED, aiSpent: null,
    estimates: { brokenLinks: { estimatedUsd: 0.004, priceKnown: true, costNote: null },
      orphans: { estimatedUsd: 0.002, priceKnown: true, costNote: null } } };
  const html = quickSandbox(st).renderQuickMaintenance({ slug: 'articles' }, REPORT, false);
  const btns = aiButtons(html);
  ok(btns.length === 3 && btns.every((b) => !/disabled/.test(b.attrs)), 'with a key the three are enabled');
  const line = (html.match(/<p class="ai-run"[\s\S]*?<\/p>/) || [''])[0];
  const text = line.replace(/<[^>]+>/g, '');
  eq(text, 'Runs on Flash Lite 2.5 · each action shows its cost · Change model',
    'ONE line under the bar, the kit\'s group form (region B)');
  ok(/title="Gemini · gemini-2\.5-flash-lite"/.test(line), '…the model by its label, Provider · id in the title');
  eq((html.match(/class="ai-run"/g) || []).length, 1, 'exactly one run line for the three actions, never one per button');
  ok(/<span class="dm-quick-cost">\$0\.0040<\/span>/.test(html) && /<span class="dm-quick-cost">\$0\.0020<\/span>/.test(html),
    'each button keeps its compact cost badge (costReadout)');
  ok(!/<details/.test(html), 'the line is not behind a chevron (v3.16.1)');
  // The route may not have sent runsOn (an older backend): the probe then
  // rebuilds one from provider/model, and the line still names the model.
  const bare = quickSandbox({ ...st, aiRunsOn: { job: 'wiki-health', needsKey: false, provider: 'gemini', model: 'gemini-2.5-flash-lite' } })
    .renderQuickMaintenance({ slug: 'articles' }, REPORT, false);
  ok(/Runs on <span class="ai-run-model" title="gemini · gemini-2\.5-flash-lite">gemini-2\.5-flash-lite<\/span>/.test(bare),
    'a probe with no runsOn still yields a line naming the model (by its id)');
}

section('18. After a plan or a scan → what ran and what it cost, on THIS domain only (v3.67.0)');
{
  const SPENT = { provider: 'gemini', providerLabel: 'Gemini', model: 'gemini-2.5-flash-lite', modelLabel: 'Flash Lite 2.5',
    inputTokens: 5812, outputTokens: 640, cachedReadTokens: 0, cacheWriteTokens: 0, calls: 2, usd: 0.0008372,
    estimated: false, fallbackFrom: null };
  const st = { busyKey: null, aiAvailable: true, aiRunsOn: PRICED, estimates: {}, aiSpent: { slug: 'articles', spent: SPENT } };
  const html = quickSandbox(st).renderQuickMaintenance({ slug: 'articles' }, REPORT, false);
  const text = html.replace(/<[^>]+>/g, '');
  ok(text.includes('Ran on Flash Lite 2.5 · 5,812 in / 640 out · $0.0008'), 'the after-line: model, tokens in/out, dollars');
  ok(html.indexOf('dm-quick-runs-on') < html.indexOf('dm-quick-spent'), '…under the before-line (it adds a line, replaces nothing)');
  const other = quickSandbox({ ...st }).renderQuickMaintenance({ slug: 'research' }, REPORT, false);
  ok(!/Ran on/.test(other), 'another domain never shows this domain\'s bill');
  const unpriced = quickSandbox({ ...st, aiSpent: { slug: 'articles', spent: { ...SPENT, usd: null } } })
    .renderQuickMaintenance({ slug: 'articles' }, REPORT, false);
  ok(/price not published/.test(unpriced) && !/\$0\.00\b/.test(unpriced.replace(/<[^>]+>/g, '')),
    'an unpriced run says "price not published", never $0.00');

  // The three runners record `spent` off their own done frame — EXECUTED, with
  // a stand-in stream. An EMPTY plan was still paid for, so it records too.
  const runners = { brokenLinks: 'runBrokenLinksPlan', orphans: 'runOrphansPlan', semantic: 'runSemanticScan' };
  for (const [kind, name] of Object.entries(runners)) {
    const body = extractFn(domainsSrc, name);
    ok(body !== null, `${name} extracts`);
    for (const plan of kind === 'semantic' ? [null] : [[{ a: 1 }], []]) {
      const state = { aiSpent: { slug: 'x', spent: SPENT } };
      let spentAtStart = 'unset';
      const fn = new Function('state', 'render', 'streamSSE', 'isCurrentMount', 'noteAiProgress', 'emptyPlanNotice',
        'myMountToken', `return (async ${body});`)(state,
        () => { if (spentAtStart === 'unset') spentAtStart = state.aiSpent; },
        async (_u, _b, on) => { on('done', kind === 'semantic' ? { pairs: [], spent: SPENT } : { plan, summary: {}, spent: SPENT }); },
        () => true, () => {}, () => 'empty', 1);
      await fn('articles');
      ok(spentAtStart === null, `${name}${plan ? (plan.length ? ' (a plan)' : ' (an EMPTY plan)') : ''}: the previous bill is cleared when the run starts`);
      ok(state.aiSpent && state.aiSpent.slug === 'articles' && state.aiSpent.spent === SPENT,
        `${name}${plan ? (plan.length ? ' (a plan)' : ' (an EMPTY plan)') : ''}: records the done frame's spent, keyed by domain`);
    }
  }
}

section('19. The run line is the FIRST line of each AI confirm (v3.67.0)');
{
  const st = { confirm: { title: 'Ask AI to resolve broken links?', body: 'Sends each broken link…',
    confirmLabel: 'Build plan', runLineHtml: renderRunsOn(PRICED, { id: 'dm-confirm-runs-on' }) } };
  const card = quickSandbox(st).renderConfirmCard();
  const iT = card.indexOf('dm-confirm-title'), iL = card.indexOf('class="ai-run"'), iB = card.indexOf('dm-confirm-body');
  ok(iT !== -1 && iL > iT && iL < iB, 'title, then the run line, then the body');
  const plain = quickSandbox({ confirm: { title: 'Fix 3 safe issues?', body: 'No AI.', confirmLabel: 'Fix now' } }).renderConfirmCard();
  ok(!/ai-run/.test(plain), 'a confirm that spends nothing carries no run line');
  // The three builders compose it — EXECUTED: the estimate's own runsOn wins,
  // the resting probe's is the fallback.
  const EST_RUNSON = { ...PRICED, inputTokens: 18000, outputTokensLow: 400, outputTokensHigh: 900, usdLow: 0.002, usdHigh: 0.004 };
  for (const [name, key] of [['confirmBrokenLinksPlan', 'brokenLinks'], ['confirmOrphansPlan', 'orphans']]) {
    const body = extractFn(domainsSrc, name);
    for (const [est, want] of [[{ estimatedUsd: 0.003, priceKnown: true, inventorySize: 10, needAi: 3, resolveFree: 0, runsOn: EST_RUNSON }, '≈$0.0020–$0.0040'],
                               [{ estimatedUsd: 0.003, priceKnown: true, inventorySize: 10, needAi: 3, resolveFree: 0 }, 'Runs on']]) {
      const state = { estimates: { [key]: est }, aiRunsOn: PRICED, aiProvider: 'gemini', aiModel: 'gemini-2.5-flash-lite' };
      const fn = new Function('state', 'costReadout', 'render', 'myMountToken', 'renderRunsOn', 'runBrokenLinksPlan', 'runOrphansPlan',
        `return (${body});`)(state, () => '$0.0030', () => {}, 1, renderRunsOn, () => {}, () => {});
      fn('articles');
      const line = state.confirm && state.confirm.runLineHtml;
      ok(typeof line === 'string' && line.includes(want) && /id="dm-confirm-runs-on"/.test(line),
        `${name}: the confirm's run line ${est.runsOn ? 'is the ESTIMATE\'s own (its range)' : 'falls back to the resting model'}`);
    }
  }
  ok(/runLineHtml: renderRunsOn\(\(est && est\.runsOn\) \|\| state\.aiRunsOn, \{ id: 'dm-confirm-runs-on' \}\)/.test(extractFn(domainsSrc, 'confirmSemanticScan') || '')
    || /runLineHtml: renderRunsOn\(\(est && est\.runsOn\) \|\| state\.aiRunsOn, \{ id: 'dm-confirm-runs-on' \}\)/.test(domainsSrc.slice(domainsSrc.indexOf('async function confirmSemanticScan'))),
    'confirmSemanticScan composes the same line (its estimate is fetched on click)');
}

section('20. The privacy disclosure names OpenRouter; its consent key is byte-identical (v3.67.0)');
{
  ok(/const AI_DISCLOSURE_KEY = 'curator-ai-health-disclosure-seen-v1';/.test(domainsSrc),
    'the consent key is unchanged, so nobody who accepted is asked again');
  const copy = (domainsSrc.match(/const AI_DISCLOSURE_COPY =([\s\S]*?);\n/) || [])[1] || '';
  const joined = String(new Function('return (' + copy + ');')());
  ok(/Google Gemini, Anthropic or OpenRouter/.test(joined), 'the disclosure names all three providers');
  ok(!/Gemini or Anthropic —/.test(joined), '…and no longer the two-provider phrasing');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All health-cost-readouts (/next dead-data-fix) offline assertions green');
