#!/usr/bin/env node
/**
 * test-model-price-truth.js — OFFLINE suite for v3.72.1's "true numbers" fixes
 * on the model catalogue in src/brain/llm.js (truth audit, Settings F3, F4, F5,
 * and the withdrawn free OpenRouter model).
 *
 * ── WHAT IT PINS, EACH BEHAVIOURALLY ───────────────────────────────────────
 *
 *   §1  Every hand-typed price carries the day it was last checked against its
 *       source, and every hand-measured model the day it was measured — the two
 *       tables cover EXACTLY the priced / measured ids (no gap, no dead row),
 *       and the dates reach the wire on the offer entry. (F4)
 *   §2  The OpenRouter sync READS the live price of every hand-priced id instead
 *       of throwing it away: the entry carries `livePrice`/`livePriceDiffers`,
 *       an upward repricing raises the quote (never quote below the provider),
 *       a downward one is shown but never lowers it, and a sync that no longer
 *       lists the id clears the figure. (F3)
 *   §3  The live prices survive a restart through the sidecar, and an older
 *       sidecar without them reads back as "not compared", never as a price.
 *   §4  `minimax/minimax-m3:free` is gone: OpenRouter withdrew the free route
 *       (live catalogue and a real 404 on 2026-09-25), so it is not offerable,
 *       not free, and no hand-listed OpenRouter id is a `:free` id.
 *   §5  PRICE CLAIMS IN NOTE PROSE ARE RECOMPUTED. Every comparative or dollar
 *       phrase in a `note` / `cautionReason` must be registered below with a
 *       check against the price table, and the check must hold. A new
 *       unregistered claim, or a price change that falsifies a registered one,
 *       goes red — the "20x the pinned default" (really ~6.7x) and "the cheapest
 *       model on either provider" (three providers, four cheaper models)
 *       defects both shipped because nothing did this. (F5)
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * CURATOR_TEST_USER_DATA_DIR / CURATOR_TEST_DOMAINS_DIR point at a temp dir
 * BEFORE any app module loads, so the sidecar this suite writes and restores
 * is never the user's. No network: the sync's transport is injected.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const same = Object.is(actual, expected);
  ok(same, same ? label : `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-price-truth-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
for (const d of [TMP_USER, TMP_DOMAINS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.LLM_MODEL;

const llm = await import('../src/brain/llm.js');
const { OFFERABLE_MODELS } = llm;
const T = llm.__testing;
const PRICES = T.MODEL_PRICES_USD_PER_MTOK;
const CATALOGUE = path.join(TMP_USER, '.openrouter-catalogue.json');

console.log('test-model-price-truth.js — dated prices, live OpenRouter prices, no false price claims\n');

const STATIC = [];
for (const [provider, list] of Object.entries(OFFERABLE_MODELS)) for (const e of list) STATIC.push({ provider, e });
const byId = Object.fromEntries(STATIC.map(({ e }) => [e.id, e]));
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// ─────────────────────────────────────────────────────────────────────────
section('§1. Every hand-typed price and measurement carries its date [F4]');
{
  const priced = Object.keys(PRICES).sort();
  eq(Object.keys(T.PRICE_VERIFIED_ON).sort().join(','), priced.join(','),
    '★ PRICE_VERIFIED_ON covers EXACTLY the priced ids — a new price arrives with the day it was checked, a removed one leaves no dead date');
  const staticIds = STATIC.map(({ e }) => e.id).sort();
  eq(Object.keys(T.MEASURED_ON).sort().join(','), staticIds.join(','),
    '★ MEASURED_ON covers EXACTLY the hand-measured offers');
  const today = new Date().toISOString().slice(0, 10);
  ok(Object.values(T.PRICE_VERIFIED_ON).every(d => ISO_DAY.test(d) && d <= today),
    'every price date is a real ISO day, never in the future');
  ok(Object.values(T.MEASURED_ON).every(d => ISO_DAY.test(d) && d <= today),
    'every measurement date is a real ISO day, never in the future');
  for (const { e } of STATIC) {
    if (e.free) continue;
    if (e.priceAsOf !== T.PRICE_VERIFIED_ON[e.id]) { ok(false, `${e.id}: priceAsOf reaches the entry`); }
  }
  ok(STATIC.every(({ e }) => e.free || e.priceAsOf === T.PRICE_VERIFIED_ON[e.id]),
    '★ each priced offer carries `priceAsOf` on the entry — the field the Settings row renders');
  ok(STATIC.every(({ e }) => e.measuredOn === T.MEASURED_ON[e.id]),
    '★ each offer carries `measuredOn`');
  const wire = JSON.parse(JSON.stringify(OFFERABLE_MODELS.gemini[0]));
  ok(ISO_DAY.test(wire.priceAsOf) && ISO_DAY.test(wire.measuredOn),
    '…and both survive JSON serialisation, i.e. they are on the wire /api/config/api-keys sends');
  // A fetched entry claims neither date: nobody checked or measured it.
  const dyn = T.defineOfferableModel('openrouter', {
    id: 'zz-vendor/zz-dated-probe', label: 'Probe', thinks: false, tokenizerFactor: 1,
    suitability: 'chat-only', maxOutput: 8192, price: { input: 0.5, output: 1 },
    note: 'Chat only — never measured.',
  }, { dynamic: true });
  eq(dyn.priceAsOf, null, 'a fetched entry has NO priceAsOf — its price is as old as the sync, which is dated elsewhere');
  eq(dyn.measuredOn, null, '…and no measuredOn, because nobody measured it');
  eq(dyn.livePrice, null, '…and no livePrice: its price IS the listing');
}

// ─────────────────────────────────────────────────────────────────────────
section('§2. The OpenRouter sync keeps the live price of every hand-priced id [F3]');

const SOLAR = 'upstage/solar-pro4';
const GLM = 'z-ai/glm-5.3-flash';
const KIMI = 'moonshotai/kimi-k2-0905';
// OpenRouter publishes plain decimals; String(2.7e-7) would be scientific.
const perToken = (usdPerM) => (usdPerM / 1e6).toFixed(14).replace(/0+$/, '').replace(/\.$/, '');
function rec(id, inPerM, outPerM) {
  return {
    id, name: id, context_length: 262144,
    top_provider: { max_completion_tokens: 65536, context_length: 262144 },
    pricing: { prompt: perToken(inPerM), completion: perToken(outPerM) },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    supported_parameters: ['response_format', 'structured_outputs', 'max_tokens'],
  };
}
function transport(records) {
  return async () => new Response(JSON.stringify({ data: records }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}
const checked = (id) => PRICES[id];

{
  llm.__clearLiveCataloguePrices();
  const solarEntry = byId[SOLAR];
  eq(solarEntry.livePrice, null, 'before any sync: livePrice is null');
  eq(solarEntry.livePriceDiffers, null, '★ …and livePriceDiffers is NULL (not compared), never false ("matches")');

  // Solar Pro 4 TRIPLES again on OpenRouter; GLM's headline drops; Kimi is unchanged.
  const up = { input: checked(SOLAR).input * 3, output: checked(SOLAR).output * 3 };
  const down = { input: checked(GLM).input / 2, output: checked(GLM).output / 2 };
  await llm.syncOpenRouterCatalogue({
    fetchImpl: transport([
      rec(SOLAR, up.input, up.output),
      rec(GLM, down.input, down.output),
      rec(KIMI, checked(KIMI).input, checked(KIMI).output),
      rec('zz-vendor/brand-new', 0.5, 2),
    ]),
  });

  const s = byId[SOLAR];
  ok(s.livePrice && Math.abs(s.livePrice.input - up.input) < 1e-12 && Math.abs(s.livePrice.output - up.output) < 1e-12,
    '★ the sync RECORDED OpenRouter\'s live price for a hand-priced id [F3: the pre-fix sync threw it away]');
  ok(typeof s.livePrice.listedAt === 'string' && s.livePrice.listedAt.length > 0, '…with the time of the listing');
  eq(s.livePriceDiffers, true, '★ …and flags that it differs from the checked price');
  ok(Math.abs(llm.getModelPrice(SOLAR).input - up.input) < 1e-12
    && Math.abs(llm.getModelPrice(SOLAR).output - up.output) < 1e-12,
  '★★ an UPWARD repricing raises the quote every estimate reads — never quote below what the provider now publishes [the solar-pro4 2026-09-16 harm]');
  ok(Math.abs(s.input - up.input) < 1e-12, '…and the entry\'s own `input` (what the picker shows) agrees');
  eq(s.standardInput, checked(SOLAR).input, '…while `standardInput` keeps the checked figure, so both are on the wire');

  const g = byId[GLM];
  eq(g.livePriceDiffers, true, 'a DOWNWARD headline is flagged too');
  eq(llm.getModelPrice(GLM).input, checked(GLM).input,
    '★ …but never LOWERS the quote: a headline may not be the endpoint that answers; a lower figure enters only from a bill');
  eq(llm.getModelPrice(GLM).output, checked(GLM).output, '…on either component');

  eq(byId[KIMI].livePriceDiffers, false, 'an unchanged price reads as "compared, and matches" — false, not null');
  eq(llm.getModelPrice(KIMI), checked(KIMI), '…and the quote is the checked figure itself');

  // Mixed: live output higher, input lower — each component takes the higher.
  llm.__testing.recordLiveStaticPrices({ [SOLAR]: { input: checked(SOLAR).input / 2, output: checked(SOLAR).output * 2 } },
    { listedAt: new Date().toISOString(), source: 'network' });
  eq(llm.getModelPrice(SOLAR).input, checked(SOLAR).input, 'mixed move: the input stays at the higher, checked figure');
  eq(llm.getModelPrice(SOLAR).output, checked(SOLAR).output * 2, '…and the output takes the higher, live figure');

  // A listing that no longer carries the id clears its live figure.
  await llm.syncOpenRouterCatalogue({ fetchImpl: transport([rec(KIMI, checked(KIMI).input, checked(KIMI).output)]) });
  eq(byId[SOLAR].livePrice, null, '★ a sync that no longer lists the id CLEARS its live figure — rebuilt, never appended');
  eq(llm.getModelPrice(SOLAR), checked(SOLAR), '…and the quote returns to the checked price');

  // Nonsense prices record nothing.
  llm.__testing.recordLiveStaticPrices({ [SOLAR]: { input: 0, output: 0 }, [GLM]: { input: -1, output: 5 },
    'gemini-2.5-flash-lite': { input: 9, output: 9 }, 'zz/not-ours': { input: 1, output: 1 } }, {});
  eq(byId[SOLAR].livePrice, null, 'a zero price records nothing — absent, never "free"');
  eq(byId[GLM].livePrice, null, 'a negative (router "-1") price records nothing');
  eq(llm.liveCataloguePrice('gemini-2.5-flash-lite'), null, 'a non-OpenRouter id never takes a live figure');
  eq(llm.liveCataloguePrice('zz/not-ours'), null, 'nor does an id we do not hand-price');
  eq(T.liveStaticPriceFromRecord({ pricing: { prompt: '1e-7', completion: '0.0000002' } }), null,
    'scientific notation is unparseable and records nothing (the adapter\'s exact converter)');
}

// ─────────────────────────────────────────────────────────────────────────
section('§3. The live prices survive a restart; an older sidecar reads as "not compared"');
{
  const up = { input: checked(SOLAR).input * 2, output: checked(SOLAR).output * 2 };
  await llm.syncOpenRouterCatalogue({
    fetchImpl: transport([rec(SOLAR, up.input, up.output), rec('zz-vendor/brand-new', 0.5, 2)]),
  });
  ok(existsSync(CATALOGUE), 'the sync wrote its sidecar into the ISOLATED user-data dir');
  const file = JSON.parse(readFileSync(CATALOGUE, 'utf8'));
  ok(file.staticLivePrices && file.staticLivePrices[SOLAR]
    && Math.abs(file.staticLivePrices[SOLAR].input - up.input) < 1e-12,
  'the sidecar carries the hand-priced ids\' live prices');

  llm.__clearLiveCataloguePrices();
  eq(byId[SOLAR].livePrice, null, 'fixture: cleared, as at a cold start');
  const r = llm.restoreOpenRouterCatalogue();
  eq(r.restored, true, 'the sidecar restores');
  ok(byId[SOLAR].livePrice && Math.abs(byId[SOLAR].livePrice.input - up.input) < 1e-12,
    '★ …and so does the live price, so the comparison and the never-quote-below rule hold after a restart');
  ok(Math.abs(llm.getModelPrice(SOLAR).input - up.input) < 1e-12, '…including the quote');

  // An OLDER sidecar (no staticLivePrices) must not leave a stale figure behind.
  const older = Object.assign({}, file); delete older.staticLivePrices;
  writeFileSync(CATALOGUE, JSON.stringify(older));
  llm.restoreOpenRouterCatalogue();
  eq(byId[SOLAR].livePrice, null, '★ an older sidecar reads back as "not compared" — null, never a price');
  eq(byId[SOLAR].livePriceDiffers, null, '…and livePriceDiffers is null again');
  eq(llm.getModelPrice(SOLAR), checked(SOLAR), '…and the quote is the checked figure');
}

// ─────────────────────────────────────────────────────────────────────────
section('§4. The withdrawn free model is gone');
{
  const FREE_GONE = 'minimax/minimax-m3:free';
  eq(llm.isOfferableModel('openrouter', FREE_GONE), false,
    '★ minimax/minimax-m3:free is NOT offerable — OpenRouter answers 404 "unavailable for free" (measured 2026-09-25)');
  eq(llm.isFreeModel(FREE_GONE), false, '…and not free by membership: FREE_MODELS no longer carries a dead id');
  eq(T.FREE_MODELS.size, 0, 'FREE_MODELS is empty — its only member was the withdrawn id');
  ok(OFFERABLE_MODELS.openrouter.every(e => !/:free$/.test(e.id)),
    'no hand-listed OpenRouter id is a `:free` id');
  ok(!Object.hasOwn(PRICES, 'minimax/minimax-m3'),
    'the PAID slug was NOT slipped in as a replacement: it measured 0/9 parseable, and measurements never carry across sibling ids');
  eq(OFFERABLE_MODELS.openrouter[0].id, 'ibm-granite/granite-4.0-h-micro',
    'the list is still cheapest-first, led by the cheapest paid entry');
  const orPrices = OFFERABLE_MODELS.openrouter.map(e => PRICES[e.id].input);
  ok(orPrices.every((p, i) => i === 0 || orPrices[i - 1] <= p), '…in non-decreasing input price');
  eq(PRICES['z-ai/glm-5.3-flash'].input, 0.045, 'glm-5.3-flash is quoted at what it BILLED on 2026-09-25 ($0.045 in)');
  eq(PRICES['z-ai/glm-5.3-flash'].output, 0.14, '…and $0.14 out');
}

// ─────────────────────────────────────────────────────────────────────────
section('§5. Every price claim in a model note is registered and recomputed [F5]');
{
  const std = (id) => PRICES[id];
  const promo = (id) => T.PROMOTIONAL_PRICES[id] && T.PROMOTIONAL_PRICES[id].price;
  const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b));
  const listOf = (p) => OFFERABLE_MODELS[p].map(e => e.id);
  const orBuild = () => OFFERABLE_MODELS.openrouter.filter(e => e.suitability !== 'chat-only').map(e => e.id);
  const minIn = (ids) => Math.min(...ids.map(i => std(i).input));
  const maxIn = (ids) => Math.max(...ids.map(i => std(i).input));
  const tf = (id) => byId[id].tokenizerFactor;
  const cap = (id) => byId[id].maxOutput;
  const $pair = (id) => `$${std(id).input}/$${std(id).output}`.replace(/\.0+(?=\/|$)/g, '');
  // A non-price phrase the detector cannot tell from a price claim, registered
  // with the reason it is not one, so the registry still has to be read.
  const NOT_A_RATE = () => true;

  // id -> [[exact substring, check]]. The substring must be IN the text; every
  // detector hit must fall inside one of them; every check must hold.
  const CLAIMS = {
    'gemini-2.5-flash-lite': [
      ['the cheapest Gemini model', () => std('gemini-2.5-flash-lite').input === minIn(listOf('gemini'))],
    ],
    'gemini-3.1-flash-lite': [
      ['2.5x the input and 3.75x the output price of the default', () =>
        near(std('gemini-3.1-flash-lite').input / std('gemini-2.5-flash-lite').input, 2.5)
        && near(std('gemini-3.1-flash-lite').output / std('gemini-2.5-flash-lite').output, 3.75)],
      ['Dearer than the default', () => std('gemini-3.1-flash-lite').input > std('gemini-2.5-flash-lite').input],
    ],
    'gemini-2.5-flash': [
      ['at 3x the input price', () => near(std('gemini-2.5-flash').input / std('gemini-2.5-flash-lite').input, 3)],
    ],
    'gemini-3.5-flash-lite': [
      ['gemini-2.5-flash costs exactly the same', () =>
        std('gemini-2.5-flash').input === std('gemini-3.5-flash-lite').input
        && std('gemini-2.5-flash').output === std('gemini-3.5-flash-lite').output],
    ],
    'gemini-3.7-flash': [
      ['PROMOTIONAL PRICE: $0.75/$3.75 per 1M tokens through 2026-12-31, then $1.50/$7.50 from 2027-01-01', () =>
        promo('gemini-3.7-flash').input === 0.75 && promo('gemini-3.7-flash').output === 3.75
        && T.PROMOTIONAL_PRICES['gemini-3.7-flash'].untilIso === '2026-12-31'
        && std('gemini-3.7-flash').input === 1.5 && std('gemini-3.7-flash').output === 7.5],
      ['the standard price is what standardInput/standardOutput carry', () => byId['gemini-3.7-flash'].standardInput === std('gemini-3.7-flash').input],
      ['far cheaper default', () => std('gemini-2.5-flash-lite').input * 5 <= promo('gemini-3.7-flash').input],
      ['the promotional price doubles when it ends', () => near(std('gemini-3.7-flash').input / promo('gemini-3.7-flash').input, 2)],
    ],
    'gemini-3.6-flash': [
      ['PROMOTIONAL PRICE: $0.75/$3.75 per 1M tokens through 2026-12-31, then $1.50/$7.50 from 2027-01-01', () =>
        promo('gemini-3.6-flash').input === 0.75 && promo('gemini-3.6-flash').output === 3.75
        && std('gemini-3.6-flash').input === 1.5 && std('gemini-3.6-flash').output === 7.5],
      ['the same price', () => std('gemini-3.6-flash').input === std('gemini-3.7-flash').input
        && std('gemini-3.6-flash').output === std('gemini-3.7-flash').output],
      ['Same price and coverage as Flash 3.7', () => std('gemini-3.6-flash').input === std('gemini-3.7-flash').input],
    ],
    'gemini-3.5-flash': [
      ['The most expensive Gemini model here', () => std('gemini-3.5-flash').output === Math.max(...listOf('gemini').map(i => std(i).output))
        && std('gemini-3.5-flash').input === maxIn(listOf('gemini'))],
      ['15x the input and 22.5x the output price of the default', () =>
        near(std('gemini-3.5-flash').input / std('gemini-2.5-flash-lite').input, 15)
        && near(std('gemini-3.5-flash').output / std('gemini-2.5-flash-lite').output, 22.5)],
      ['The dearest Gemini here', () => std('gemini-3.5-flash').input === maxIn(listOf('gemini'))],
    ],
    'claude-haiku-4-5': [
      ['the cheapest Anthropic model', () => std('claude-haiku-4-5').input === minIn(listOf('anthropic'))],
    ],
    'claude-sonnet-5': [
      ['cheaper than both Sonnet 4.6 and 4.5', () => std('claude-sonnet-5').input < std('claude-sonnet-4-6').input
        && std('claude-sonnet-5').input < std('claude-sonnet-4-5').input],
      ['Two costs the headline price hides', NOT_A_RATE],
      ['1.329x more input tokens', () => tf('claude-sonnet-5') === 1.329],
      ['$2 per 1M input is really ~$2.66', () => std('claude-sonnet-5').input === 2 && near(2 * tf('claude-sonnet-5'), 2.66)],
    ],
    'claude-sonnet-4-6': [
      ['At $3/$15 it is 50% dearer than claude-sonnet-5', () => $pair('claude-sonnet-4-6') === '$3/$15'
        && near(std('claude-sonnet-4-6').input / std('claude-sonnet-5').input, 1.5)],
    ],
    'claude-sonnet-4-5': [
      ['Same $3/$15 as claude-sonnet-4-6', () => $pair('claude-sonnet-4-5') === '$3/$15' && $pair('claude-sonnet-4-6') === '$3/$15'],
      ['half the output ceiling', () => cap('claude-sonnet-4-5') * 2 === cap('claude-sonnet-4-6')],
      ['claude-sonnet-5 is cheaper', () => std('claude-sonnet-5').input < std('claude-sonnet-4-5').input],
      ['the same-priced Sonnet 4.6', () => std('claude-sonnet-4-5').input === std('claude-sonnet-4-6').input],
    ],
    'claude-opus-5': [
      ['the most expensive: $5/$25 headline', () => $pair('claude-opus-5') === '$5/$25'
        && std('claude-opus-5').input === maxIn(listOf('anthropic'))],
      ['1.329x more input tokens', () => tf('claude-opus-5') === 1.329],
      ['the real input cost is ~$6.65 per 1M Haiku-equivalent tokens — 6.6x the default, not the 5x the headline implies', () =>
        near(std('claude-opus-5').input * tf('claude-opus-5'), 6.65)
        && near(std('claude-opus-5').input * tf('claude-opus-5') / std('claude-haiku-4-5').input, 6.6)
        && near(std('claude-opus-5').input / std('claude-haiku-4-5').input, 5)],
    ],
    'claude-opus-4-8': [
      ['Priced identically to claude-opus-5 ($5/$25)', () => $pair('claude-opus-4-8') === $pair('claude-opus-5') && $pair('claude-opus-5') === '$5/$25'],
      ['same 1.329x tokenizer premium', () => tf('claude-opus-4-8') === tf('claude-opus-5')],
      ['at the identical price', () => $pair('claude-opus-4-8') === $pair('claude-opus-5')],
    ],
    'claude-opus-4-5': [
      ['at the identical $5/$25', () => $pair('claude-opus-4-5') === '$5/$25' && $pair('claude-opus-5') === '$5/$25'],
      ['half the output ceiling', () => cap('claude-opus-4-5') * 2 === cap('claude-opus-5')],
      ['at two-fifths of the price', () => near(std('claude-sonnet-5').input / std('claude-opus-4-5').input, 0.4)],
      ['paying $5 per 1M', () => std('claude-opus-4-5').input === 5],
      ['at the identical price', () => $pair('claude-opus-4-5') === $pair('claude-opus-5')],
    ],
    'ibm-granite/granite-4.0-h-micro': [
      ['The cheapest OpenRouter model offered for building a wiki', () => std('ibm-granite/granite-4.0-h-micro').input === minIn(orBuild())],
      ['pick it when cost dominates', () => std('ibm-granite/granite-4.0-h-micro').input === minIn(orBuild())],
    ],
    'z-ai/glm-5.3-flash': [
      ['Two measured costs', NOT_A_RATE],
      ['79-86%', NOT_A_RATE],
      ['Its price is the rate its cheapest JSON-capable endpoint billed on the day shown beside it', () => ISO_DAY.test(byId['z-ai/glm-5.3-flash'].priceAsOf)],
      ['real cost is likeliest to change', NOT_A_RATE],
    ],
    'upstage/solar-pro4': [
      ['rather than on price', NOT_A_RATE],
      ['Its price tripled on 2026-09-16', NOT_A_RATE], // a dated historical event, recorded beside MODEL_PRICES
      ['Granite 4.0 H Micro and GLM 5.3 Flash both cost less', () =>
        std('ibm-granite/granite-4.0-h-micro').input < std('upstage/solar-pro4').input
        && std('z-ai/glm-5.3-flash').input < std('upstage/solar-pro4').input],
    ],
    'moonshotai/kimi-k2-0905': [
      ['cost $0.107 against ~$0.048 for a normal run', NOT_A_RATE], // one measured run's bill, not a rate
      ['the dearest OpenRouter model offered for building a wiki', () => std('moonshotai/kimi-k2-0905').input === maxIn(orBuild())],
      ['Its price at least cannot surprise you', NOT_A_RATE],
    ],
  };

  // The detector: any word or figure that makes a statement about money.
  const DETECT = /cheap\w*|dear\w*|expensive|\bcosts?\b|\bpric\w*|\$\d[\d.]*|\b\d+(?:\.\d+)?x\b|\b(?:a (?:sixth|third|quarter)|two-fifths|nine tenths|half the)\b|\d+%/gi;
  ok(DETECT.test('20x the pinned default on input'), 'CONTROL: the detector catches the retired "20x the pinned default"');
  DETECT.lastIndex = 0;
  ok(/cheap/i.test('the cheapest model on either provider'), 'CONTROL: …and "the cheapest model on either provider"');

  let hits = 0, unregistered = [];
  for (const { e } of STATIC) {
    const claims = CLAIMS[e.id] || [];
    for (const field of ['note', 'cautionReason']) {
      const text = e[field];
      if (typeof text !== 'string') continue;
      const spans = claims
        .map(([sub]) => { const i = text.indexOf(sub); return i >= 0 ? [i, i + sub.length] : null; })
        .filter(Boolean);
      for (const m of text.matchAll(DETECT)) {
        hits++;
        if (!spans.some(([a, b]) => m.index >= a && m.index + m[0].length <= b)) {
          unregistered.push(`${e.id}.${field}: "${text.slice(Math.max(0, m.index - 30), m.index + 30)}"`);
        }
      }
    }
  }
  ok(hits > 40, `the detector found ${hits} money phrases across the notes — the registry below is not vacuous`);
  ok(unregistered.length === 0,
    '★★ every money phrase in every note is a REGISTERED claim — a new comparative or dollar figure must arrive with a check' +
    (unregistered.length ? ` — UNREGISTERED: ${unregistered.join(' | ')}` : ''));

  let stale = [], falsified = [];
  for (const [id, claims] of Object.entries(CLAIMS)) {
    const e = byId[id];
    const all = e ? `${e.note || ''}\n${e.cautionReason || ''}` : '';
    for (const [sub, check] of claims) {
      if (!all.includes(sub)) stale.push(`${id}: "${sub}"`);
      else if (!check()) falsified.push(`${id}: "${sub}"`);
    }
  }
  ok(stale.length === 0, 'every registered claim is still in its note (a reworded note updates the registry)' +
    (stale.length ? ` — STALE: ${stale.join(' | ')}` : ''));
  ok(falsified.length === 0, '★★ every registered price claim still HOLDS against the price table [F5]' +
    (falsified.length ? ` — FALSE NOW: ${falsified.join(' | ')}` : ''));

  // The two sentences the audit found false, by name.
  ok(!/20x the pinned default/.test(byId['moonshotai/kimi-k2-0905'].note), 'the false "20x the pinned default" is gone from Kimi K2 0905');
  ok(!/cheapest model on either provider/.test(byId['gemini-2.5-flash-lite'].note), 'the false "cheapest model on either provider" is gone');
  ok(!/\$0\.075|\$0\.03\/\$0\.12|nine tenths|a sixth/.test(OFFERABLE_MODELS.openrouter.map(e => e.note).join(' ')),
    'no OpenRouter note restates a rate or a ratio that the price table and its date now carry');
}

// ─────────────────────────────────────────────────────────────────────────
section('§6. GET /api/health/ai-settings serves the default from the ONE constant, priced on the model in force [F7]');
{
  const { DEFAULT_AI_HEALTH } = await import('../src/brain/config.js');
  const { default: express } = await import('express');
  const { default: healthRouter } = await import('../src/routes/health.js');
  const app = express(); app.use(express.json()); app.use('/api/health', healthRouter);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/health/ai-settings`;
  try {
    // A synthetic Gemini key, assembled from parts (the repo's secret hook).
    writeFileSync(path.join(TMP_USER, '.curator-config.json'),
      JSON.stringify({ geminiApiKey: ['AIza', 'Sy', 'Z'.repeat(33)].join(''), activeProvider: 'gemini' }), { mode: 0o600 });
    const body = await (await fetch(url)).json();
    eq(JSON.stringify(body.defaults), JSON.stringify(DEFAULT_AI_HEALTH),
      '★ `defaults` IS config.js\'s DEFAULT_AI_HEALTH — the view states no second copy');
    eq(body.costCeilingTokens, DEFAULT_AI_HEALTH.costCeilingTokens, 'CONTROL: with nothing stored, the value in force is that default');
    const ro = body.defaultRunsOn;
    ok(ro && ro.model === llm.getProviderInfo().model, `★ the default is priced on the model that builds the wiki now (${ro && ro.model})`);
    const p = llm.getModelPrice(ro.model);
    const want = Math.round((DEFAULT_AI_HEALTH.costCeilingTokens * 0.6 / 1e6 * p.input + DEFAULT_AI_HEALTH.costCeilingTokens * 0.4 / 1e6 * p.output) * 1e6) / 1e6;
    ok(Math.abs(ro.usdHigh - want) < 1e-9, `★ …at that model's catalogue price, on the scan's own 60/40 split ($${ro.usdHigh})`);
    const posted = await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ costCeilingTokens: 123456 }) })).json();
    eq(posted.costCeilingTokens, 123456, 'a save returns the value in force');
    ok(posted.defaults && posted.defaults.costCeilingTokens === DEFAULT_AI_HEALTH.costCeilingTokens,
      '…and the same defaults, so the hint survives a save');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log('\n' + '─'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ model price-truth assertions FAILED'); process.exit(1); }
console.log('✅ All model price-truth assertions green');
