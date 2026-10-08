#!/usr/bin/env node
/**
 * test-tiered-pricing.js — OFFLINE. The tier-aware money path, the Anthropic
 * 5.5 catalogue, the retirement of two-generation-old Anthropic models and
 * their forward migration (2026-10-08).
 *
 * WHAT IT PINS
 *   §1  priceUsageUsd — ONE call priced at the tier of its own prompt: exactly
 *       100,000 prompt tokens is the LOWER tier, 100,001 the UPPER; cache
 *       tokens count toward the prompt; cache rates per tier and per model —
 *       every expectation typed from the provider's PAGE figures, never read
 *       back from the code under test.
 *   §2  the accumulator's per-call split, and the THREE finished-call surfaces
 *       that consume it (chargeForItem → the budget cap, ai-run spentFromUsage
 *       → Health/Compile/ingest `spent`, chat's priceServedAnswer) all equal
 *       the sum of the calls priced one by one; a total that cannot say which
 *       calls crossed is priced at the UPPER tier (conservative).
 *   §3  estimates are conservative: a planned call that could cross is quoted
 *       at the upper tier (batch estimate, compile estimate, describeRun).
 *   §4  the structural guard: a tiered model may build only with a full
 *       schedule priced by the tier-aware path; anything else refuses.
 *   §5  catalogue: the 5.5 generation is offerable for building and chat;
 *       retired ids are not offerable, unpriced, not rungs; the chain
 *       escalates forward, cheapest-first, every rung priced.
 *   §6  migration: a stored build pick of a retired model moves FORWARD
 *       (read side before the rewrite; write side once, one note, dismissable)
 *       and the browser's remembered chat pick moves the same way, once.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpUD = mkdtempSync(path.join(os.tmpdir(), 'curator-tier-ud-'));
const tmpDom = mkdtempSync(path.join(os.tmpdir(), 'curator-tier-dom-'));
process.env.CURATOR_TEST_USER_DATA_DIR = tmpUD;
process.env.CURATOR_TEST_DOMAINS_DIR = tmpDom;
delete process.env.LLM_MODEL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
process.on('exit', () => {
  try { rmSync(tmpUD, { recursive: true, force: true }); } catch {}
  try { rmSync(tmpDom, { recursive: true, force: true }); } catch {}
});

const llm = await import('../src/brain/llm.js');
const { makeUsageAccumulator } = await import('../src/brain/ingest.js');
const { __testing: q, CHARS_PER_TOKEN } = await import('../src/brain/ingest-queue.js');
const { spentFromUsage } = await import('../src/brain/ai-run.js');
const { priceServedAnswer } = await import('../src/brain/chat.js');
const config = await import('../src/brain/config.js');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }
const near = (a, b) => typeof a === 'number' && typeof b === 'number'
  && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));

const H55 = 'claude-haiku-5-5';
// ── The provider's PAGE figures (platform.claude.com pricing, read 2026-10-08),
// typed here independently of llm.js so neither side defines its own truth.
const PAGE = {
  [H55]: {
    lower: { input: 0.10, output: 0.50, cacheWrite5m: 0.125, cacheRead: 0.01 },
    upper: { input: 0.50, output: 2.50, cacheWrite5m: 0.625, cacheRead: 0.05 },
  },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.50, cacheRead: 0.10 },
  'claude-opus-5-5':   { input: 4, output: 20, cacheWrite5m: 5.00, cacheRead: 0.20 },
  'claude-haiku-4-5':  { input: 1, output: 5,  cacheWrite5m: 1.25, cacheRead: 0.10 },
};
const bill = (u, r) => ((u.inputTokens || 0) * r.input + (u.outputTokens || 0) * r.output
  + (u.cacheWriteTokens || 0) * r.cacheWrite5m + (u.cachedReadTokens || 0) * r.cacheRead) / 1e6;
const call = (o) => ({ provider: 'anthropic', model: H55, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0, ...o });

// ─────────────────────────────────────────────────────────────────────────────
section('§1 priceUsageUsd — one call, priced at the tier of its OWN prompt');
{
  const at = call({ inputTokens: 100000, outputTokens: 2000 });
  const over = call({ inputTokens: 100001, outputTokens: 2000 });
  ok(near(llm.priceUsageUsd(H55, { ...at, calls: 1 }), bill(at, PAGE[H55].lower)),
    'exactly 100,000 prompt tokens bills the LOWER tier ("up to 100,000")');
  ok(near(llm.priceUsageUsd(H55, { ...over, calls: 1 }), bill(over, PAGE[H55].upper)),
    '★ 100,001 prompt tokens bills the UPPER tier on EVERY token of the call, output included');
  const under = call({ inputTokens: 99999, outputTokens: 2000 });
  ok(near(llm.priceUsageUsd(H55, { ...under, calls: 1 }), bill(under, PAGE[H55].lower)), 'just under: lower tier');
  // Cache tokens are part of the prompt: 60k fresh + 50k cached read = 110k crosses.
  const cached = call({ inputTokens: 60000, cachedReadTokens: 50000, outputTokens: 1000 });
  ok(near(llm.priceUsageUsd(H55, { ...cached, calls: 1 }), bill(cached, PAGE[H55].upper)),
    '★ cached-read tokens count toward the threshold (60k + 50k cached = upper tier, cache read at $0.05)');
  const cw = call({ inputTokens: 1000, cacheWriteTokens: 20000, cachedReadTokens: 30000, outputTokens: 500 });
  ok(near(llm.priceUsageUsd(H55, { ...cw, calls: 1 }), bill(cw, PAGE[H55].lower)),
    'lower-tier cache write $0.125 and cache read $0.01 per 1M (page)');
  const cw2 = call({ inputTokens: 1000, cacheWriteTokens: 90000, cachedReadTokens: 30000, outputTokens: 500 });
  ok(near(llm.priceUsageUsd(H55, { ...cw2, calls: 1 }), bill(cw2, PAGE[H55].upper)),
    'upper-tier cache write $0.625 and cache read $0.05 per 1M (page)');
  for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5']) {
    const u = { inputTokens: 300000, outputTokens: 4000, cachedReadTokens: 200000, cacheWriteTokens: 50000, calls: 1 };
    ok(near(llm.priceUsageUsd(id, u), bill(u, PAGE[id])), `${id}: flat at any size, cache read $${PAGE[id].cacheRead} / write $${PAGE[id].cacheWrite5m} per 1M (page)`);
  }
  ok(llm.priceUsageUsd('no-such-model', { inputTokens: 1, calls: 1 }) === null, 'an unpriced model is null, never 0');
}

// ─────────────────────────────────────────────────────────────────────────────
section('§2 the per-call split, and every finished-call surface that reads it');
{
  const calls = [
    call({ inputTokens: 128000, outputTokens: 9000 }),                              // outline on a big wiki — UPPER
    call({ inputTokens: 30000, outputTokens: 4000, cacheWriteTokens: 20000 }),      // batch 1 — lower
    call({ inputTokens: 10000, outputTokens: 4500, cachedReadTokens: 20000 }),      // batch 2 — lower
    call({ inputTokens: 40000, outputTokens: 4000, cachedReadTokens: 65000 }),      // 105k — UPPER
  ];
  const truth = calls.reduce((n, c) => n + llm.priceUsageUsd(H55, { ...c, calls: 1 }), 0);
  const truthPage = bill(calls[0], PAGE[H55].upper) + bill(calls[1], PAGE[H55].lower)
    + bill(calls[2], PAGE[H55].lower) + bill(calls[3], PAGE[H55].upper);
  ok(near(truth, truthPage), 'the per-call prices sum to the page-derived bill');
  const acc = makeUsageAccumulator();
  for (const c of calls) acc.onUsage(c);
  ok(acc.totals.aboveTier && acc.totals.aboveTier.calls === 2, 'the accumulator classifies each call as it lands (2 of 4 crossed)');
  ok(near(llm.priceUsageUsd(H55, acc.totals), truth), '★ priceUsageUsd(total) equals the sum of the calls priced one by one');
  const job = { items: [{ status: 'done' }], estimate: { usdHigh: 99 } };
  ok(near(q.chargeForItem(job, { tokenUsage: acc.totals }), truth), '★ chargeForItem (the budget cap\'s input) charges each call at its own tier');
  ok(job.spendIsEstimated !== true, '…as a MEASURED charge, not an estimate share');
  ok(near(q.chargePartialSpend({ items: [{ status: 'done' }], estimate: { usdHigh: 99 } }, {}, acc.totals), truth),
    'chargePartialSpend (a cancelled item) charges the same per-call tiers');
  ok(near(spentFromUsage(acc.totals).usd, truth), '★ ai-run spentFromUsage (ingest/Health/Compile `spent`) equals it');
  // Conservative: a total that cannot say which calls crossed.
  const { aboveTier, ...blind } = acc.totals;
  const blindUsd = llm.priceUsageUsd(H55, blind);
  ok(near(blindUsd, bill(blind, PAGE[H55].upper)), '★ a multi-call total WITHOUT a split is priced entirely at the UPPER tier');
  ok(blindUsd > truth, '…which over-states, never under-states, the true bill');
  ok(near(q.chargeForItem({ items: [{ status: 'done' }], estimate: { usdHigh: 99 } }, { tokenUsage: blind }), blindUsd),
    'chargeForItem takes the same conservative reading');
  // A flat model's charge is unchanged by the split field.
  const flat = makeUsageAccumulator();
  flat.onUsage(call({ model: 'claude-haiku-4-5', inputTokens: 150000, outputTokens: 3000 }));
  ok(flat.totals.aboveTier.calls === 0, 'a flat model never lands in the split');
  ok(near(q.chargeForItem({ items: [], estimate: null }, { tokenUsage: flat.totals }), bill({ inputTokens: 150000, outputTokens: 3000 }, PAGE['claude-haiku-4-5'])),
    'a flat model over 100k is billed its flat rate');
  // Chat: one answer is one call — recorded at its own tier, rates included.
  const small = await priceServedAnswer(H55, { inputTokens: 20000, outputTokens: 900, cachedReadTokens: 0, cacheWriteTokens: 0 });
  ok(small && near(small.costUsd, bill({ inputTokens: 20000, outputTokens: 900 }, PAGE[H55].lower)) && small.inPerM === 0.10 && small.outPerM === 0.50,
    'chat: a 20k-token answer is recorded at $0.10/$0.50 and priced at the lower tier');
  const big = await priceServedAnswer(H55, { inputTokens: 120000, outputTokens: 900, cachedReadTokens: 0, cacheWriteTokens: 0 });
  ok(big && near(big.costUsd, bill({ inputTokens: 120000, outputTokens: 900 }, PAGE[H55].upper)) && big.inPerM === 0.50 && big.outPerM === 2.50,
    '★ chat: a 120k-token answer is recorded at the UPPER tier\'s rates AND dollars');
}

// ─────────────────────────────────────────────────────────────────────────────
section('§3 estimates are conservative — a call that COULD cross is quoted upper');
{
  const lo = llm.estimateCallRates(H55, 20000, CHARS_PER_TOKEN);
  ok(lo && lo.input === 0.10 && lo.output === 0.50, 'a 20,000-char planned call (~7.5k tokens) quotes the lower tier');
  const hi = llm.estimateCallRates(H55, 341000, CHARS_PER_TOKEN);
  ok(hi && hi.input === 0.50 && hi.output === 2.50, 'a 341,000-char outline (a large wiki) quotes the UPPER tier');
  // The margin: estimated 80k tokens is below 100k but inside the margin.
  const marginChars = Math.ceil(80000 * CHARS_PER_TOKEN / 1.329);
  const m = llm.estimateCallRates(H55, marginChars, CHARS_PER_TOKEN);
  ok(m && m.input === 0.50, '★ an estimate of ~80k tokens — under the line on paper — is still quoted UPPER (it could cross)');
  ok(llm.estimateCallRates(H55, NaN, CHARS_PER_TOKEN).input === 0.50, 'an unknown prompt size quotes the upper tier');
  ok(llm.estimateCallRates('claude-sonnet-5-5', 5e6, CHARS_PER_TOKEN).input === 2, 'a flat model is its flat rate at any size');
  // The batch estimate itself, per planned call.
  const price = llm.getModelPrice(H55);
  const bigIndex = 'x'.repeat(300000);
  // A short note on a large wiki: ONE single-pass call carrying the whole index.
  const one = { name: 'note.md', size: 5000 };
  const est1 = q.estimateOneFile({ f: one, promptFiles: { entities: [], concepts: [] }, index: bigIndex, today: '2026-10-08', price, model: H55 });
  const flat1 = q.estimateOneFile({ f: one, promptFiles: { entities: [], concepts: [] }, index: bigIndex, today: '2026-10-08', price, model: null });
  // The upper tier is 5x on both rates; the tiered branch also applies the
  // model's measured 1.329x tokenizer premium to input, so the ratio lands in
  // [5, 5 x 1.329].
  const ratio1 = est1.usdHigh / flat1.usdHigh;
  ok(est1.totalCalls === 1 && ratio1 >= 5 - 1e-9 && ratio1 <= 5 * 1.329 + 1e-9,
    `★ batch estimate, one call carrying a large wiki's index: $${est1.usdHigh.toFixed(4)} — the upper tier (${ratio1.toFixed(2)}x the lower-tier $${flat1.usdHigh.toFixed(4)})`);
  // A long document: the outline carries the index (upper), the batches do not.
  const f = { name: 'doc.md', size: 40000 };
  const est = q.estimateOneFile({ f, promptFiles: { entities: [], concepts: [] }, index: bigIndex, today: '2026-10-08', price, model: H55 });
  const flatLower = q.estimateOneFile({ f, promptFiles: { entities: [], concepts: [] }, index: bigIndex, today: '2026-10-08', price, model: null });
  ok(est.usdHigh > flatLower.usdHigh && est.usdHigh < flatLower.usdHigh * 5,
    `multi-phase on a large wiki: $${est.usdHigh.toFixed(4)} — priced per planned call, between all-lower ($${flatLower.usdHigh.toFixed(4)}) and all-upper`);
  const small = q.estimateOneFile({ f: { name: 'n.md', size: 2000 }, promptFiles: { entities: [], concepts: [] }, index: '', today: '2026-10-08', price, model: H55 });
  const smallFlat = q.estimateOneFile({ f: { name: 'n.md', size: 2000 }, promptFiles: { entities: [], concepts: [] }, index: '', today: '2026-10-08', price, model: null });
  const rs = small.usdHigh / smallFlat.usdHigh;
  ok(rs >= 1 - 1e-4 && rs <= 1.329 + 1e-4, `a small file on an empty wiki is quoted at the LOWER tier (${rs.toFixed(3)}x the flat figure — only the tokenizer premium, never 5x)`);
  const s5 = llm.getModelPrice('claude-sonnet-5');
  const a = q.estimateOneFile({ f, promptFiles: { entities: [], concepts: [] }, index: bigIndex, today: '2026-10-08', price: s5, model: 'claude-sonnet-5' });
  const b = q.estimateOneFile({ f, promptFiles: { entities: [], concepts: [] }, index: bigIndex, today: '2026-10-08', price: s5, model: null });
  ok(a.usdHigh === b.usdHigh && a.usdLow === b.usdLow, 'a FLAT model\'s estimate is byte-identical to the pre-tier arithmetic');
}

// ─────────────────────────────────────────────────────────────────────────────
section('§4 the structural guard — a tiered model builds only through the tier-aware path');
{
  const { defineOfferableModel } = llm.__testing;
  const spec = { id: H55, label: 'x', contextLength: 1000000, thinks: true, jsonRaw: false, tokenizerFactor: 1.329, suitability: 'general', note: 'probe' };
  let built = null;
  try { built = defineOfferableModel('anthropic', spec); } catch { built = null; }
  ok(built && built.suitability === 'general', 'a tiered model WITH a full TIERED_PRICES schedule builds for the build lane');
  ok(built && built.priceAbove && built.priceAbove.input === 0.5 && built.priceTierThresholdTokens === 100000,
    'its entry carries the threshold and the upper tier, derived from the table');
  let threw = null;
  try { defineOfferableModel('anthropic', { ...spec, id: 'claude-sonnet-5', tiered: true }); } catch (e) { threw = String(e.message); }
  ok(threw && /tier schedule/i.test(threw), '★ a tiered model with NO schedule is refused for the build lane, naming why');
  threw = null;
  try { defineOfferableModel('anthropic', { ...spec, priceTierThresholdTokens: 200000 }); } catch (e) { threw = String(e.message); }
  ok(threw && /disagrees/.test(threw), 'a re-typed threshold that disagrees with the schedule is refused');
  threw = null;
  try { defineOfferableModel('openrouter', { id: 'vendor/tiered-x', label: 'x', thinks: false, tokenizerFactor: 1, suitability: 'general', note: 'n', tiered: true, price: { input: 1, output: 2 }, maxOutput: 1000 }, { dynamic: true }); } catch (e) { threw = String(e.message); }
  ok(!!threw, 'a FETCHED tiered entry can never build');
  let chatOnly = null;
  try { chatOnly = defineOfferableModel('anthropic', { ...spec, id: 'claude-sonnet-5', tiered: true, suitability: 'chat-only' }); } catch { chatOnly = null; }
  ok(chatOnly && chatOnly.suitability === 'chat-only', '⟨ANTI-VACUITY⟩ the same schedule-less tiered model is still admitted for CHAT');
}

// ─────────────────────────────────────────────────────────────────────────────
section('§5 catalogue — the 5.5 generation in, two-generations-old out, chain forward');
{
  const { FALLBACK_CHAINS, DEFAULTS } = llm.__testing;
  for (const id of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) {
    ok(llm.isOfferableModel('anthropic', id) && llm.isBuildLaneModel('anthropic', id), `${id} is offerable AND may build the wiki (measured 2026-10-08)`);
  }
  for (const id of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5']) {
    ok(llm.isOfferableModel('anthropic', id), `${id} (the previous generation) stays offerable`);
  }
  for (const [id, r] of Object.entries(llm.RETIRED_MODELS)) {
    ok(!llm.isOfferableModel('anthropic', id), `${id} is NOT offerable`);
    ok(llm.getModelPrice(id) === null, `${id} carries no price`);
    ok(!FALLBACK_CHAINS.anthropic.includes(id) && DEFAULTS.anthropic !== id, `${id} is neither a rung nor the default`);
    ok(llm.isBuildLaneModel('anthropic', r.successor), `${id} → ${r.successor}, which can build (a build pick moved forward must still build)`);
    ok(r.successor.split('-')[1] === id.split('-')[1], `${id} moves within its own family`);
  }
  ok(Object.keys(llm.AWAITING_MEASUREMENT).length === 0, 'nothing awaits measurement (opus-4-7/4-6 were retired, not measured)');
  ok(DEFAULTS.anthropic === 'claude-haiku-4-5', 'the Anthropic default is unchanged (claude-haiku-4-5 was not retired)');
  // Chain: forward in time, every rung priced and build-lane, cheapest-first.
  const chain = FALLBACK_CHAINS.anthropic;
  ok(chain.length >= 2, `the Anthropic chain has rungs: ${chain.join(' → ')}`);
  for (const id of chain) {
    ok(!!llm.getModelPrice(id), `rung ${id} is priced`);
    ok(llm.isBuildLaneModel('anthropic', id), `rung ${id} may build (a rung carries ingests)`);
  }
  const rate = (id) => (llm.priceTierFor(id) ? llm.priceTierFor(id).above : llm.getModelPrice(id));
  for (let i = 1; i < chain.length; i++) {
    ok(rate(chain[i - 1]).input <= rate(chain[i]).input, `${chain[i - 1]} (at its UPPER tier) is no dearer than ${chain[i]}`);
  }
  ok(chain[0] === 'claude-haiku-5-5', 'the first rung is the newest Haiku — cheaper than the default even at its upper tier');
}

// ─────────────────────────────────────────────────────────────────────────────
section('§6 migration — forward to the same family\'s newest model, told once');
{
  const cfgFile = path.join(tmpUD, '.curator-config.json');
  writeFileSync(cfgFile, JSON.stringify({ anthropicApiKey: 'fixture-anthropic-key-placeholder', activeProvider: 'anthropic', selectedModels: { anthropic: 'claude-opus-4-8' } }), { mode: 0o600 });
  ok(llm.getProviderInfo().model === 'claude-opus-5-5', '★ READ side: before any rewrite, a stored Opus 4.8 pick resolves to Opus 5.5 — never down to the default');
  const notes = llm.migrateRetiredModelSelections(new Date('2026-10-08T12:00:00Z'));
  ok(notes.length === 1 && notes[0].from === 'claude-opus-4-8' && notes[0].to === 'claude-opus-5-5', 'WRITE side: one migration, Opus 4.8 → Opus 5.5');
  ok(config.getSelectedModel('anthropic') === 'claude-opus-5-5', 'the stored pick now names the successor');
  ok(/Opus 4\.8 to Opus 5\.5/.test(notes[0].text) && /retired/.test(notes[0].text), 'the note says what changed and why');
  ok(config.getModelMigrationNotes().length === 1, 'the note is persisted for the app to show');
  ok(llm.migrateRetiredModelSelections().length === 0 && config.getModelMigrationNotes().length === 1, 'idempotent: a second run moves nothing and adds no note');
  config.dismissModelMigrationNotes();
  ok(config.getModelMigrationNotes().length === 0, 'Dismiss removes it — it is never shown again');
  const raw = JSON.parse(readFileSync(cfgFile, 'utf8'));
  ok(raw.anthropicApiKey === 'fixture-anthropic-key-placeholder' && raw.activeProvider === 'anthropic', 'the rest of the config is untouched');

  // The browser half, against an in-memory storage.
  const { migrateStoredChatModel, migrateChatModelId, LS_CHAT_MODEL, LS_RETIREMENT_NOTES, pendingRetirementNotes }
    = await import('../src/public/next/shared/model-retirement.js');
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const retired = {};
  for (const [id, r] of Object.entries(llm.RETIRED_MODELS)) {
    retired[id] = { successor: llm.retiredModelSuccessor(r.provider, id), chatNote: llm.retirementNoteText(id, r.successor, 'chat') };
  }
  mem.set(LS_CHAT_MODEL, 'claude-sonnet-4-6');
  const moved = migrateStoredChatModel('claude-sonnet-4-6', retired, storage);
  ok(moved === 'claude-sonnet-5-5' && mem.get(LS_CHAT_MODEL) === 'claude-sonnet-5-5', '★ BROWSER: a remembered Sonnet 4.6 chat pick moves to Sonnet 5.5 in localStorage');
  ok(pendingRetirementNotes(storage).length === 1 && /Your chat model moved from Sonnet 4\.6 to Sonnet 5\.5/.test(pendingRetirementNotes(storage)[0].text), 'one chat note, in words');
  migrateStoredChatModel('claude-sonnet-5-5', retired, storage);
  ok(pendingRetirementNotes(storage).length === 1, 'a pick that is not retired adds nothing (shown once)');
  ok(migrateChatModelId('gemini-2.5-flash-lite', retired).note === null, 'a non-Anthropic or current pick is left alone');
  mem.delete(LS_RETIREMENT_NOTES);
  ok(pendingRetirementNotes(storage).length === 0, 'cleared notes stay cleared');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ Tier-aware pricing, 5.5 catalogue, retirement + migration — all green');
