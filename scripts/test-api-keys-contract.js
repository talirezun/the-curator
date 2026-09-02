#!/usr/bin/env node
/**
 * scripts/test-api-keys-contract.js — the SEAM between GET /api/config/api-keys
 * and the Providers & keys page, driven end to end.
 *
 * ══ WHY THIS FILE EXISTS ═══════════════════════════════════════════════════
 * v3.45.0 assembled two branches built in parallel against one contract, and
 * they disagreed about a field. The route emitted `build.facts.measured` as a
 * BOOLEAN; the view read `'curator' | 'user' | null`. Both halves passed their
 * own suites — the route's suite asserted `=== true`, the view's suite fed
 * fixtures written to the three-valued shape — and neither could see the other.
 * That is the seam defect this repo has now recorded three times (v3.34.0's
 * dropped warning, v3.36.0's two update paths, and this), and the shape is
 * always the same: TWO SUITES, EACH GREEN, AND NOTHING DRIVING THE JOIN.
 *
 * So this suite owns the join and nothing else. It:
 *
 *   1. boots the REAL express router in an isolated user-data directory,
 *   2. saves a fake key over the REAL POST route so a REAL build model resolves,
 *   3. takes the ACTUAL JSON the route serialises — never a fixture, never a
 *      hand-written payload — and
 *   4. feeds it to the REAL view functions lifted out of settings.js.
 *
 * A field that changes shape on either side reddens here, because the value
 * asserted on the view side is the value the route actually produced.
 *
 * ── THE THREE FACTS IT PINS, AND WHY EACH IS A FACT AND NOT A PREFERENCE ───
 *
 * §2 `facts.measured` IS THREE-VALUED. `measurementProvenance` (llm.js) computes
 *    'curator' / 'user' / null in one place, and its own docblock says why they
 *    must not be collapsed: they are three different epistemic claims, and
 *    "we measured this across many documents" is not "you ran nine last
 *    Tuesday". A boolean can be rendered as only ONE of the two badges, so a
 *    model the user qualified on their own wiki would have been badged as one
 *    The Curator measured — and the client could not recover the difference,
 *    because it never left the server.
 *
 * §3 A FREE MODEL RENDERS AS THE WORD `free`, NEVER `$0.00` AND NEVER BLANK.
 *    The route sends `priceIn`/`priceOut` as NULL for a free model, because
 *    free has no per-token figure to quote. Null alone cannot say WHICH null it
 *    is — unpriced is also null — so the wire carries `free` beside them. Both
 *    wrong answers are recorded defects: `$0.00` states a rate that does not
 *    exist (v3.3.1 shipped that figure), and a blank makes a free model
 *    indistinguishable from one nobody has published a price for.
 *
 * §4 `catalogueCounts.batchHidden` IS NULL WHEN UNKNOWN, AND NULL IS NOT ZERO.
 *    An OpenRouter catalogue persisted by an older build carries no funnel, so
 *    the count is unknown. A `0` would ASSERT that no batch-only id was found —
 *    false for 64 of them on the 2026-09-02 catalogue. The view must render no
 *    clause at all rather than "0 batch-only ids hidden".
 *
 * Every assertion carries a control that MUST fire, because a contract test
 * that cannot tell agreement from vacuity is the thing it exists to prevent.
 *
 * OFFLINE: no network, no API key, no provider call. The keys saved below are
 * obviously-synthetic strings that are never sent anywhere — nothing in this
 * file makes an LLM call.
 *
 * Run: node scripts/test-api-keys-contract.js
 */

import fs from 'node:fs';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  \u2713 ${label}`); }
  else { failed++; failures.push(label); console.log(`  \u2717 ${label}`); }
}
function eq(actual, expected, label) {
  const same = Object.is(actual, expected);
  ok(same, same ? label : `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function okContains(hay, needle, label) {
  const hit = String(hay).includes(needle);
  ok(hit, hit ? label : `${label} (missing: ${JSON.stringify(needle)})`);
}
function okMissing(hay, needle, label) {
  ok(!String(hay).includes(needle), label + (String(hay).includes(needle) ? ` (unexpectedly present: ${JSON.stringify(needle)})` : ''));
}
function section(t) { console.log(`\n${t}`); }

// ── Isolation FIRST, before any app module is imported ───────────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-api-keys-contract-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
for (const d of [TMP_USER, TMP_DOMAINS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;
delete process.env.LLM_MODEL;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(REPO_ROOT, f));
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const FINGERPRINT_BEFORE = fingerprint();

const llm = await import('../src/brain/llm.js');
const { default: configRouter } = await import('../src/routes/config.js');
const { default: express } = await import('express');

console.log('test-api-keys-contract.js — the route and the page, joined and driven\n');

// ═════════════════════════════════════════════════════════════════════════════
section('\u00a70. The REAL route, on an ephemeral loopback port');
// ═════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use('/api/config', configRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
ok(server.address().port > 0 && server.address().address === '127.0.0.1',
  `mounted on 127.0.0.1:${server.address().port} \u2014 never 3333, never a non-loopback interface`);

const getKeys = async () => (await fetch(BASE + '/api/config/api-keys')).json();
const postKeys = async (body) => (await fetch(BASE + '/api/config/api-keys', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

// Obviously-synthetic. Never printed, never sent to a provider, never a real
// credential shape — nothing in this suite makes an LLM call.
const FAKE_GEMINI = 'FAKE-TEST-GEMINI-KEY-do-not-use-1234567890abcdef';

await postKeys({ geminiApiKey: FAKE_GEMINI });
const WIRE = await getKeys();
ok(WIRE && typeof WIRE === 'object' && WIRE.build && typeof WIRE.build === 'object',
  'a real build model resolves, so `build` is a real object and not the honest null');

// ═════════════════════════════════════════════════════════════════════════════
section('\u00a71. The REAL view, lifted out of settings.js and evaluated');
// ═════════════════════════════════════════════════════════════════════════════
//
// Same brace-matching extractor scripts/test-next-providers-page.js uses, and
// for the reason CLAUDE.md records at v3.0.17: a test that proves a line exists
// proves nothing about what it does. The trailing-brace check makes a desync a
// LOUD failure rather than a sandbox holding half a function.

const SETTINGS = path.join(REPO_ROOT, 'src/public/next/views/settings.js');
const settingsSrc = fs.readFileSync(SETTINGS, 'utf8');

function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in settings.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace`);
  }
  return extracted;
}
function extractConst(src, name) {
  const re = new RegExp(`(?:^|\\n)(?:export\\s+)?const ${name} =[\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found in settings.js`);
  const extracted = m[0].trim().replace(/^export\s+/, '');
  if (/\bfunction\s/.test(extracted)) throw new Error(`extractConst: "${name}" swallowed a function`);
  return extracted;
}

function escapeHtmlStub(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CONSTS = ['PROVIDER_ROWS', 'TX_INFO_GLYPH', 'MODEL_LANES', 'CHAT_LANE_COLLAPSE_AT',
  'MODEL_SORTS', 'MODEL_SORT_KEYS', 'MODEL_SORT_UNRANKED_LABEL', 'MODEL_SORT_OPTIONS',
  'MODEL_FILTER_MIN_ROWS', 'MEASUREMENT_CHIPS', 'ACTIVATION_SKIP_REASONS',
  'BUILD_PICK_ERROR_ID', 'QUALIFY_CONFIRM_ID', 'MEASURED_CALL_SECONDS',
  'ALL_MODELS_SCOPE', 'MODEL_LANE_FACETS', 'MODEL_PRICE_BANDS', 'BUILD_WORKING_SET_TOKENS'];

const FNS = [
  'infoMark', 'providerLabel', 'activeModelLine', 'providerHasSavedKey', 'providerConnected',
  'qualIndex', 'buildModelFacts', 'buildLaneFacts', 'buildModelDisplayName',
  'inertPins', 'buildCandidates', 'chatModelCount', 'chatStartFacts',
  'catalogueCountsOf', 'allCatalogueRows',
  'measurementChip', 'renderMeasurementChip',
  'modelLaneOf', 'laneBuildsWiki', 'qualificationFor', 'isCuratorMeasured', 'modelSearchText',
  'splitSentences', 'withoutLaneClaim', 'formatIsoDay', 'formatTokenCount', 'formatModelPrice',
  'formatSyncedAt', 'formatDuration', 'measuredCallSeconds',
  'modelSortKey', 'countUnrankedForSort', 'orderModels', 'setModelFilter', 'cssEscapeAttr',
  'modelFilterFor', 'renderModelFilterBar', 'renderModelFilterEmpty', 'renderModelLanes',
  'renderModelOption', 'renderEmptyModelPicker', 'renderQualification', 'renderQualifyPanel',
  'renderModelPickerScope', 'renderModelPicker', 'renderCatalogueSync', 'filterModels',
  'browseLanePass', 'browseBandPass', 'browseFilter', 'worthTestingRows',
  'renderModelBrowse', 'refreshCatalogueButton',
  'settingsBlock', 'renderConnectBlock', 'renderAllModelsBlock',
  'renderBuildBlock', 'renderBuildCurrent', 'renderBuildList', 'renderChatBlock',
  'renderProviderRow', 'renderActivationNotice', 'renderProviders',
  'buildPickButtonId', 'classifyFallback',
];

const stubState = {
  keys: null, keysError: null, keysActionError: null, keysActivationNotice: null,
  replacing: null, replaceValue: '', keysBusy: null, keyTestBusy: null, keyTest: {},
  modelPickerOpen: {}, modelRowOpen: {}, modelLaneOpen: {}, modelShelfOpen: false,
  buildListOpen: false, modelPickBusy: '', modelPickError: {}, modelPickErrorAt: '',
  catalogueSyncBusy: null, catalogueSync: {}, qualify: null, modelFilter: {},
};

const INJECTED = {
  escapeHtml: escapeHtmlStub,
  // THE REAL ONE, imported rather than stubbed. `$0.00` is one of the two wrong
  // answers §3 is about, and it is this function that produces it for a 0 — so
  // a stub here would be the suite deciding the outcome it is measuring.
  formatUsdHonest: (await import('../src/public/next/shared/format-usd.js')).formatUsdHonest,
  formatModelSummary: (m) => (m && typeof m.note === 'string' ? m.note : ''),
  icon: (name, size) => `<svg data-icon="${name}" width="${size}"></svg>`,
  state: stubState,
  crossWriteBusy: () => false,
  crossWriteTitle: (msg) => 'cross-write: ' + msg,
  renderCrossWriteBanner: () => '',
  renderFallbackBanner: () => '',
  renderActiveModelLine: () => '',
  gatedLoader: () => '<LOADER/>',
  loadGate: null,
  pendingListboxes: [],
  renderListboxHtml: (cfg) => '<div data-listbox="' + cfg.id + '"></div>',
  render: () => {},
  onPickBuildModel: () => {},
  myMountToken: 1,
};

let R;
try {
  const names = Object.keys(INJECTED);
  const body =
    CONSTS.map((n) => extractConst(settingsSrc, n)).join('\n') + '\n' +
    FNS.map((n) => extractFunction(settingsSrc, n)).join('\n') + '\n' +
    'return { ' + CONSTS.concat(FNS).join(', ') + ' };';
  R = new Function(...names, body)(...names.map((n) => INJECTED[n]));
  ok(typeof R.renderProviders === 'function' && typeof R.buildLaneFacts === 'function',
    'the page renderer and the build normaliser extracted and evaluated');
} catch (err) {
  ok(false, `extraction threw: ${err.message}`);
  process.exit(1);
}

// ── SCOPED NEEDLES ────────────────────────────────────────────────────────
// The page also renders a MODEL LIST, and the same words appear on its rows.
// An assertion on a bare phrase would therefore be green whatever block 2 said,
// which is the vacuity this file exists to refuse. These match the build
// block's OWN chip markup, so each one is about the model in force and nothing
// else, and both are composed here exactly as renderBuildCurrent composes them.
const measuredChip = (label) => '<span class="build-fact build-fact-measured">' + label + '</span>';
const priceChip = (text) => '<span class="build-fact build-fact-num mono">' + text + '</span>';
const PRICE_CHIP_OPEN = '<span class="build-fact build-fact-num mono">';

// A deep clone, so a section that edits one field to drive a state cannot leak
// into the next. The wire payload is JSON by construction.
const wire = () => JSON.parse(JSON.stringify(WIRE));

// `renderProviders()` reads `state.keys` rather than taking an argument, so the
// payload is installed the way the live view installs it — after a fetch — and
// every per-render flag is reset, so no section can inherit another's open
// panel. Same helper shape scripts/test-next-providers-page.js uses.
function renderWith(keys, extra) {
  Object.assign(stubState, {
    keys, keysError: null, keysActionError: null, keysActivationNotice: null,
    modelPickerOpen: {}, modelShelfOpen: false, buildListOpen: false,
    modelPickBusy: '', modelPickError: {}, modelPickErrorAt: '',
    modelFilter: {}, qualify: null,
  }, extra || {});
  INJECTED.pendingListboxes.length = 0;
  return R.renderProviders();
}

// ═════════════════════════════════════════════════════════════════════════════
section('\u00a72. `facts.measured` names WHO measured it \u2014 three values, never a boolean');
// ═════════════════════════════════════════════════════════════════════════════
{
  const m = WIRE.build.facts.measured;
  ok(typeof m !== 'boolean',
    `the ROUTE never sends a boolean here (sent ${JSON.stringify(m)})`);
  ok(m === 'curator' || m === 'user' || m === null,
    '\u2026it is one of the three documented values');
  eq(m, 'curator',
    'and on a hand-measured default build model it is `curator` \u2014 the strongest claim, made only where it is true');

  // ONE PRODUCER. `buildModel.measuredBy` is the older field about the same
  // fact; two objects describing one model must not be able to disagree.
  eq(WIRE.build.facts.measured, WIRE.buildModel.measuredBy,
    '`build.facts.measured` and `buildModel.measuredBy` agree, because one helper produces both');
  eq(WIRE.build.facts.measured, llm.measurementProvenance(WIRE.build.provider, WIRE.build.model),
    '\u2026and both equal llm.js\u2019s own measurementProvenance for that pair');

  // THE VIEW, fed the ACTUAL wire value.
  const b = R.buildLaneFacts(wire());
  eq(b.measuredBy, 'curator', 'the view normalises the real payload to `curator`');
  const html = renderWith(wire());
  okContains(html, measuredChip('measured by The Curator'),
    'and BLOCK 2 renders that badge from the value the route sent');
  okMissing(html, measuredChip('measured on your wiki'), '\u2026and not the other one');
}
{
  // ── THE DISCRIMINATION CONTROL ─────────────────────────────────────────
  // If the view rendered "measured by The Curator" for every value, everything
  // above would be green over a page that cannot tell the two apart. Drive the
  // OTHER value through the SAME real renderer, changing exactly one field of
  // the real payload.
  const k = wire();
  k.build.facts.measured = 'user';
  k.buildModel.measuredBy = 'user';
  const html = renderWith(k);
  okContains(html, measuredChip('measured on your wiki'),
    'CONTROL: `user` renders the user badge \u2014 so the page reads the value rather than assuming one');
  okMissing(html, measuredChip('measured by The Curator'),
    '\u2026and block 2 drops the Curator claim entirely');

  const k2 = wire();
  k2.build.facts.measured = null;
  k2.buildModel.measuredBy = null;
  const html2 = renderWith(k2);
  okContains(html2, measuredChip('not measured'),
    'CONTROL: an explicit `null` renders "not measured" \u2014 nobody looked, which is a third distinct claim');

  // The boolean the route used to send. It is still absorbed by the view as a
  // legacy shape, and that is deliberate — but §2 above is what guarantees it
  // can never fire, because the ROUTE is asserted never to produce one. A shim
  // whose only proof is the shim is not a guarantee.
  const k3 = wire();
  k3.build.facts.measured = true;
  ok(R.buildLaneFacts(k3).measuredBy === 'curator',
    'a legacy boolean is still absorbed rather than crashing \u2014 unreachable from this route, and asserted so above');
}

// ═════════════════════════════════════════════════════════════════════════════
section('\u00a73. A free model renders as `free` \u2014 never $0.00, never blank');
// ═════════════════════════════════════════════════════════════════════════════
{
  // The route sends `free` beside the prices precisely so the client never has
  // to decide what a null price means. Prove the paid case first, from the real
  // payload, so the free case below is a CHANGE rather than a coincidence.
  const paid = WIRE.build.facts;
  ok(typeof paid.priceIn === 'number' && typeof paid.priceOut === 'number',
    'the real default build model is PAID, and both prices arrive as numbers');
  eq(paid.free, false, '\u2026with `free: false` stated rather than left to be inferred');
  okContains(renderWith(wire()), PRICE_CHIP_OPEN, 'so block 2 carries a price chip\u2026');
  okContains(renderWith(wire()), priceChip('$0.10 in \u00b7 $0.40 out per 1M tokens'),
    '\u2026quoting the real per-token rate the route sent');

  // ── THE FREE ARM ──────────────────────────────────────────────────────
  // Free is a price we know EXACTLY and it has no per-token figure, so the
  // route nulls both numbers. That null is indistinguishable from "unpublished"
  // without the flag — which is the whole reason the flag is on the wire.
  const k = wire();
  k.build.facts.free = true;
  k.build.facts.priceIn = null;
  k.build.facts.priceOut = null;
  const html = renderWith(k);
  okContains(html, priceChip('free \u2014 this model bills nothing'),
    'a free build model says FREE in words');
  okMissing(html, '$0.00',
    '\u2026and never $0.00, which would state a per-token rate that does not exist');
  okMissing(html, 'bills nothing per 1M',
    '\u2026and never appends "per 1M" to the word free');

  // ── AND THE OTHER NULL STILL READS AS UNKNOWN ─────────────────────────
  // Same two nulls, `free: false`. The page must say nothing about price rather
  // than inventing either a rate or the word free.
  const u = wire();
  u.build.facts.free = false;
  u.build.facts.priceIn = null;
  u.build.facts.priceOut = null;
  const uHtml = renderWith(u);
  okMissing(uHtml, PRICE_CHIP_OPEN,
    'an UNPRICED model gets NO price chip at all \u2014 no rate quoted, nothing invented');
  okMissing(uHtml, 'bills nothing', '\u2026and is never called free \u2014 the two nulls stay different facts');

  // ── THE SAME SPLIT ON `cheapestMeasured` ──────────────────────────────
  ok(WIRE.build.cheapestMeasured && typeof WIRE.build.cheapestMeasured === 'object',
    'the route sends a `cheapestMeasured` record');
  ok(Object.hasOwn(WIRE.build.cheapestMeasured, 'free'),
    '\u2026carrying its own `free` flag, for the same reason the facts do');
  const c = wire();
  c.build.cheapestMeasured.same = false;
  c.build.cheapestMeasured.model = 'vendor/some-free-model';
  c.build.cheapestMeasured.provider = 'openrouter';
  c.build.cheapestMeasured.free = true;
  c.build.cheapestMeasured.priceIn = null;
  c.build.cheapestMeasured.priceOut = null;
  const cHtml = renderWith(c);
  okContains(cHtml, 'Cheapest measured', 'the cheapest-measured line renders when it differs from the model in force');
  okContains(cHtml, '<span class="mono">free</span>',
    '\u2026and a free alternative is quoted as the word `free`');
  okMissing(cHtml, '$0.00', '\u2026never as $0.00');
}

// ═════════════════════════════════════════════════════════════════════════════
section('\u00a74. `catalogueCounts.batchHidden` \u2014 null is UNKNOWN, and unknown is not zero');
// ═════════════════════════════════════════════════════════════════════════════
{
  const counts = WIRE.catalogueCounts;
  ok(counts && typeof counts === 'object', 'the route sends `catalogueCounts`');
  eq(counts.batchHidden, null,
    'with no OpenRouter key and no synced funnel, batchHidden is NULL \u2014 never 0, which would assert a measurement');
  ok(Number.isInteger(counts.total) && Number.isInteger(counts.canBuild)
    && Number.isInteger(counts.measured) && Number.isInteger(counts.free),
    '\u2026while every count that IS known arrives as an integer');

  // The view. Block 4 is collapsed by default, so drive the count line's own
  // producer as well as the page, and assert the clause is ABSENT.
  const nullHtml = renderWith(wire(), { modelShelfOpen: true });
  okMissing(nullHtml, 'batch-only ids hidden',
    'an unknown batchHidden renders NO clause \u2014 the page says nothing rather than saying zero');
  okMissing(nullHtml, '0 batch-only', '\u2026and certainly never "0 batch-only"');

  // ── THE CONTROL: a KNOWN count does render ────────────────────────────
  // Without this, "renders nothing" would be green for a page that can never
  // render the clause at all — which is the vacuity this whole file is about.
  const k = wire();
  k.catalogueCounts.batchHidden = 57;
  k.catalogueCounts.total = Math.max(k.catalogueCounts.total, 1);
  const knownHtml = renderWith(k, { modelShelfOpen: true });
  okContains(knownHtml, '57 batch-only ids hidden',
    'CONTROL: a KNOWN batchHidden renders the clause with the real number');

  // And an explicit ZERO is treated as "none found", which renders nothing —
  // the same OUTPUT as unknown, but reached by a different and stated route.
  const z = wire();
  z.catalogueCounts.batchHidden = 0;
  okMissing(renderWith(z, { modelShelfOpen: true }), 'batch-only ids hidden',
    'an explicit 0 renders no clause either \u2014 there is nothing to report, and "0 hidden" is noise');
}

// ═════════════════════════════════════════════════════════════════════════════
section('\u00a75. The whole real payload renders without throwing');
// ═════════════════════════════════════════════════════════════════════════════
{
  // The cheapest guard against a field the route added and the view chokes on:
  // render the ACTUAL response, in both shelf states, and require a page.
  for (const open of [false, true]) {
    let html = '';
    let threw = null;
    try { html = renderWith(wire(), { modelShelfOpen: open }); } catch (err) { threw = err; }
    ok(!threw, `the real route payload renders with the catalogue shelf ${open ? 'OPEN' : 'closed'}${threw ? ` (threw: ${threw.message})` : ''}`);
    ok(html.length > 500, '\u2026and produces a real page rather than an empty string');
  }
  okContains(renderWith(wire()), WIRE.build.model,
    'and it names the model the route actually resolved');
}

// ═════════════════════════════════════════════════════════════════════════════
section('\u00a76. Isolation \u2014 the real credential files were never touched');
// ═════════════════════════════════════════════════════════════════════════════
eq(fingerprint(), FINGERPRINT_BEFORE,
  'the real .curator-config.json / .sync-config.json / .sharedbrain-config.json are byte-identical (sha256 + size + existence)');

await new Promise(r => server.close(r));
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log('\n' + '\u2500'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\u274c FAILURES');
  for (const f of failures) console.log('  \u2717 ' + f);
  process.exit(1);
}
console.log('\u2705 The api-keys contract holds end to end \u2014 route JSON into the real renderer');
