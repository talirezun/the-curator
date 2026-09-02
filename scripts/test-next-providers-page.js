#!/usr/bin/env node
/**
 * scripts/test-next-providers-page.js — the four-block Providers & keys page.
 *
 * ── WHY THIS SUITE EXISTS SEPARATELY FROM test-next-model-picker.js ─────────
 * That suite is enormous and it is about the PICKER: lanes, prices, refusals,
 * the atomic build write. This one is about the PAGE — the order of its four
 * blocks, what each block says in each state, and the facts it reads off the
 * route's new fields. Those are different subjects and mixing them is how a
 * 6,000-line suite becomes one nobody re-reads.
 *
 * ── IT DRIVES THE REAL RENDERERS AGAINST FIXTURE PAYLOADS ──────────────────
 * The isolated instance this page was rendered in has NO KEYS, so state A
 * (nothing connected) is the only state a real server can produce here. States
 * B and C — one key with a default build model, two keys with a hand-picked
 * one — are reached by feeding `renderProviders` a payload of the shape the
 * route sends. That is the ONLY honest way to test them offline, and it is why
 * every fixture below is written to the CONTRACT rather than to whatever the
 * current backend happens to emit: the new fields (`connected`, `build`,
 * `catalogueCounts`, `chat`) are being built in parallel, so this file also
 * serves as the executable statement of what this view expects to be sent.
 *
 * ── AND EVERY DEGRADED ARM IS DRIVEN TOO ───────────────────────────────────
 * Each new field has a fallback for a backend that predates it, and a fallback
 * nobody exercises is the shape this repo keeps finding broken. So the same
 * page is rendered from a payload with NONE of the new fields, and asserted to
 * still name the model, the provider and the counts.
 *
 * Run: node scripts/test-next-providers-page.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SETTINGS = path.join(ROOT, 'src/public/next/views/settings.js');
const settingsSrc = fs.readFileSync(SETTINGS, 'utf8');

let passed = 0;
let failed = 0;
function section(t) { console.log(`\n${t}`); }
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  \u2713 ${msg}`); }
  else { failed++; console.log(`  \u2717 ${msg}`); }
}
function okContains(hay, needle, msg) {
  ok(String(hay).includes(needle), msg + (String(hay).includes(needle) ? '' : ` (missing: ${JSON.stringify(needle)})`));
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a70  Extraction — brace-matched, and it must END at a closing brace');
// ══════════════════════════════════════════════════════════════════════════
// The same extractor the sibling suites use. The trailing-brace check is what
// makes a desync a LOUD failure rather than a sandbox that silently holds half
// a function and passes every assertion about the half it kept.
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
  if (/\bfunction\s/.test(extracted)) {
    throw new Error(`extractConst: "${name}" extraction swallowed a function`);
  }
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
  formatUsdHonest: (v) => (typeof v === 'number' && Number.isFinite(v) ? '$' + v.toFixed(2) : null),
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
  // Faithful about the things this suite asserts on — the control's id, and
  // every option's value and label — and deliberately NOT faithful about markup
  // shape. No assertion here may depend on that; the component has its own
  // suite (scripts/test-next-listbox.js), which drives the real renderer.
  renderListboxHtml: (cfg) => '<div data-listbox="' + cfg.id + '" data-listbox-value="' +
    String(cfg.value == null ? '' : cfg.value) + '">' +
    (cfg.options || []).map((o) => '<span data-listbox-option="' + o.value + '">' +
      escapeHtmlStub(o.label) + '</span>').join('') + '</div>',
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
  ok(typeof R.renderProviders === 'function', 'the page renderer extracted and evaluated');
  ok(Array.isArray(R.PROVIDER_ROWS) && R.PROVIDER_ROWS.length >= 3, 'PROVIDER_ROWS extracted');
} catch (err) {
  ok(false, `extraction did not throw (got: ${err.message})`);
  process.exit(1);
}

// ── The fixtures, written to RB's CONTRACT ────────────────────────────────
// Every field the route is gaining appears here in the shape it is specified
// in, so this file is the executable record of what the view consumes.
const GEM = [
  { id: 'gemini-2.5-flash-lite', label: 'Flash Lite 2.5', input: 0.10, output: 0.40,
    standardInput: 0.10, standardOutput: 0.40, suitability: 'general', jsonRaw: true,
    maxOutput: 65536, contextLength: null, note: 'plans 18-20 pages per source',
    measuredBy: 'curator', free: false, thinks: false },
  { id: 'gemini-3.1-flash-lite', label: 'Flash Lite 3.1', input: 0.25, output: 1.50,
    standardInput: 0.25, standardOutput: 1.50, suitability: 'general', jsonRaw: true,
    maxOutput: 65536, contextLength: null, note: 'plans 20 pages per source',
    measuredBy: 'curator', free: false, thinks: false },
];
const OR = [
  { id: 'upstage/solar-pro4', label: 'Solar Pro 4', input: 0.03, output: 0.12,
    standardInput: 0.03, standardOutput: 0.12, suitability: 'general', jsonRaw: true,
    maxOutput: 131072, contextLength: 524288, note: 'plans about 23 pages per source',
    measuredBy: 'curator', free: false, thinks: false },
  { id: 'ibm-granite/granite-4.0-h-micro', label: 'Granite 4.0 H Micro', input: 0.02, output: 0.11,
    standardInput: 0.02, standardOutput: 0.11, suitability: 'chat-only', jsonRaw: null,
    maxOutput: 65536, contextLength: 131072, note: 'never measured against the ingest prompt',
    measuredBy: null, free: false, thinks: false },
  { id: 'qwen/qwen3-max', label: 'Qwen3 Max', input: 1.20, output: 6.00,
    standardInput: 1.20, standardOutput: 6.00, suitability: 'chat-only', jsonRaw: null,
    maxOutput: 32768, contextLength: 262144, note: 'never measured against the ingest prompt',
    measuredBy: null, free: false, thinks: true },
  { id: 'minimax/minimax-m3:free', label: 'MiniMax M3 (free)', input: 0, output: 0,
    standardInput: 0, standardOutput: 0, suitability: 'chat-only', jsonRaw: null,
    maxOutput: 32768, contextLength: 196608, note: 'shared upstream pool',
    measuredBy: null, free: true, thinks: false },
  // ── THE ROW THAT MUST NOT REACH THE SHELF ────────────────────────────────
  // Cheap, unmeasured, and its published context is a THIRD of the build job's
  // working set. Without it every non-build row in this fixture cleared the
  // floor, so deleting the floor entirely changed nothing and the assertion
  // below reported green over a filter that was not running. Found by
  // mutation; the fixture was the vacuity, not the assertion.
  { id: 'tiny/short-context', label: 'Short Context Tiny', input: 0.01, output: 0.05,
    standardInput: 0.01, standardOutput: 0.05, suitability: 'chat-only', jsonRaw: null,
    maxOutput: 8192, contextLength: 32768, note: 'never measured against the ingest prompt',
    measuredBy: null, free: false, thinks: false },
];

function stateA() {
  return {
    geminiApiKey: '', anthropicApiKey: '', openrouterApiKey: '',
    hasGeminiKey: false, hasAnthropicKey: false, hasOpenrouterKey: false,
    connected: { gemini: false, anthropic: false, openrouter: false },
    activeProvider: null, activeModel: null,
    models: { gemini: 'gemini-2.5-flash-lite', anthropic: 'claude-haiku-4-5', openrouter: null },
    selectedModels: {}, fallback: null,
    offerable: { gemini: [], anthropic: [], openrouter: [] },
    build: null, buildModel: null,
    catalogueCounts: { total: 0, canBuild: 0, measured: 0, free: 0, batchHidden: null },
    chat: { startsOn: null, count: 0 },
    openrouterCatalogue: null, qualifications: [], minRunsToQualify: 9,
  };
}

function stateB() {
  return Object.assign(stateA(), {
    geminiApiKey: 'AIza\u2026f3a', hasGeminiKey: true,
    connected: { gemini: true, anthropic: false, openrouter: false },
    activeProvider: 'gemini', activeModel: 'gemini-2.5-flash-lite',
    offerable: { gemini: GEM, anthropic: [], openrouter: [] },
    build: {
      model: 'gemini-2.5-flash-lite', provider: 'gemini', source: 'default',
      facts: { contextLength: null, priceIn: 0.10, priceOut: 0.40, measured: 'curator',
        thinks: false, outlineNote: 'plans 18\u201320 pages per source' },
      cheapestMeasured: { model: 'gemini-2.5-flash-lite', provider: 'gemini',
        priceIn: 0.10, priceOut: 0.40, same: true },
    },
    buildModel: { provider: 'gemini', model: 'gemini-2.5-flash-lite', source: 'default',
      selectedHonoured: true, measuredBy: 'curator' },
    catalogueCounts: { total: 2, canBuild: 2, measured: 2, free: 0, batchHidden: null },
    chat: { startsOn: { model: 'gemini-2.5-flash-lite', provider: 'gemini' }, count: 2 },
  });
}

function stateC(over) {
  return Object.assign(stateB(), {
    openrouterApiKey: 'sk-or\u2026991', hasOpenrouterKey: true,
    connected: { gemini: true, anthropic: false, openrouter: true },
    activeProvider: 'openrouter',
    offerable: { gemini: GEM, anthropic: [], openrouter: OR },
    build: {
      model: 'upstage/solar-pro4', provider: 'openrouter', source: 'selected',
      selectedHonoured: true,
      facts: { contextLength: 524288, priceIn: 0.03, priceOut: 0.12, measured: 'curator',
        thinks: false, outlineNote: 'plans about 23 pages per source \u00b7 about 48s per call' },
      cheapestMeasured: { model: 'upstage/solar-pro4', provider: 'openrouter',
        priceIn: 0.03, priceOut: 0.12, same: true },
    },
    buildModel: { provider: 'openrouter', model: 'upstage/solar-pro4', source: 'selected',
      selectedHonoured: true, measuredBy: 'curator' },
    selectedModels: { openrouter: 'upstage/solar-pro4' },
    catalogueCounts: { total: 211, canBuild: 8, measured: 12, free: 5, batchHidden: 57 },
    chat: { startsOn: { model: 'upstage/solar-pro4', provider: 'openrouter' }, count: 211 },
  }, over || {});
}

function renderWith(keys) {
  Object.assign(stubState, {
    keys, keysError: null, keysActionError: null, keysActivationNotice: null,
    modelPickerOpen: {}, modelShelfOpen: false, buildListOpen: false,
    modelPickBusy: '', modelPickError: {}, modelPickErrorAt: '',
    modelFilter: {}, qualify: null,
  });
  INJECTED.pendingListboxes.length = 0;
  return R.renderProviders();
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a71  THE ORDER — four blocks, numbered, in every state');
// ══════════════════════════════════════════════════════════════════════════
// Block 1 is the only block that can act on a fresh install. Everything below
// it stays PRESENT and honestly empty: hiding an empty block loses a step
// silently and the page stops reading as a sequence.
for (const [name, keys] of [['state A', stateA()], ['state B', stateB()], ['state C', stateC()]]) {
  const html = renderWith(keys);
  const H = (t) => html.indexOf('<h2 class="settings-job-title">' + t + '</h2>');
  const i1 = H('Connect a provider');
  const i2 = H('What builds your wiki');
  const i3 = H('Chat');
  const i4 = H('All models');
  ok(i1 !== -1 && i2 !== -1 && i3 !== -1 && i4 !== -1, `${name}: all four blocks are present`);
  ok(i1 < i2 && i2 < i3 && i3 < i4, `${name}: and in order 1..4`);
  const nums = (html.match(/class="settings-block-num" aria-hidden="true">(\d)</g) || [])
    .map((m) => m.slice(-2, -1)).join(',');
  ok(nums === '1,2,3,4', `${name}: the numerals ascend (got ${nums || 'none'})`);
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a72  BLOCK 1 — plain words, never configuration vocabulary');
// ══════════════════════════════════════════════════════════════════════════
{
  const a = renderWith(stateA());
  const c = renderWith(stateC());

  ok((a.match(/provider-pill-off">/g) || []).length === 3,
    'state A: three rows, all reading Not connected');
  ok(!/provider-pill-on/.test(a), 'state A: and none reading Connected');
  ok((c.match(/provider-pill-on/g) || []).length === 2,
    'state C: exactly the two keyed providers read Connected');
  ok((c.match(/provider-pill-off/g) || []).length === 1, '\u2026and the third does not');

  // THE VOCABULARY. These three words each said something the row does not
  // answer, and two of them said it in developer language.
  for (const [name, html] of [['state A', a], ['state C', c]]) {
    for (const word of ['>configured<', '>not set<', '>active<']) {
      ok(!html.includes(word), `${name}: the retired word ${word} appears nowhere`);
    }
  }
  // ANTI-VACUITY: the scan can see a word that IS there.
  ok(a.includes('>Not connected<'), 'CONTROL: the scan above can see a status word when one is present');

  // Option B — the connection rows carry no build-lane control at all.
  ok(!/data-set-active=/.test(c),
    'no row offers "Set active": the build lane moves in block 2 and nowhere else');
  // \u2026and the escape hatch is not lost, only moved off the default path.
  const row = R.renderProviderRow(R.PROVIDER_ROWS[0], stateC(), false);
  ok(/data-set-active="gemini"/.test(row),
    'CONTROL: renderProviderRow called WITHOUT the page\u2019s opt still offers it \u2014 the degraded path survives');

  okContains(a, 'Start here.', 'state A: the lede leads with "Start here."');
  ok(!c.includes('Start here.'), 'state C: with a key connected, the bold lead-in is dropped');
  okContains(c, 'One key per provider', '\u2026and the rest of the sentence is unchanged');

  // The local model, and the 0600 footer, verbatim.
  okContains(a, 'It is not missing from your install; it does not exist yet.',
    'the local model is a footnote that says whose absence it is');
  ok(!/Local model<\/span>/.test(a), '\u2026and not a permanently disabled row');
  okContains(a, 'Keys live in <code class="mono">.curator-config.json</code> at 0600 on this machine. Never committed, never sent anywhere except the provider you call.',
    'the 0600 footer is verbatim');
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a73  BLOCK 2 — the four provenance variants, each stating one fact');
// ══════════════════════════════════════════════════════════════════════════
{
  const mk = (build, over) => renderWith(stateC(Object.assign({ build }, over || {})));

  // 1 \u2014 the app default.
  const dflt = mk(Object.assign({}, stateC().build, { source: 'default' }));
  okContains(dflt, 'follows the app default', 'source=default: says it follows the app default');
  ok(!/data-pick-clear=/.test(dflt), '\u2026and offers no "Follow the app default", which would be a no-op');

  // 2 \u2014 your choice.
  const sel = mk(Object.assign({}, stateC().build, { source: 'selected', selectedHonoured: true }));
  okContains(sel, 'You chose this one', 'source=selected: says you chose it');
  ok(/data-pick-clear="openrouter"/.test(sel),
    '\u2026and offers the ONLY way back to the app default');

  // 3 \u2014 set outside the app.
  const env = mk(Object.assign({}, stateC().build, { source: 'env' }));
  okContains(env, 'LLM_MODEL', 'source=env: names the environment variable');
  okContains(env, 'will not take effect until it is unset',
    '\u2026and says a choice here will not take effect');
  ok(!/data-pick-clear=/.test(env),
    '\u2026and offers no clear control, because there is no pin doing anything');

  // 4 \u2014 not the one running. BOTH shapes: an explicit `fallback` source and
  // a `selected` pin the engine refused. They are the same user-facing fact and
  // must read identically, or one of them is a state with no copy.
  for (const [what, b] of [
    ['source=fallback', Object.assign({}, stateC().build, { source: 'fallback' })],
    ['a refused pin', Object.assign({}, stateC().build, { source: 'selected', selectedHonoured: false })],
  ]) {
    const html = mk(b);
    okContains(html, '<strong>not the one running</strong>', `${what}: says it is not the one running`);
    ok(/build-current-warn/.test(html), `${what}: and carries the warn treatment`);
  }
  ok(!/build-current-warn/.test(dflt), 'CONTROL: the ordinary default state carries no warn treatment');

  // ── 5 \u2014 A SOURCE WE WERE NOT TAUGHT ─────────────────────────────────
  // Not a variant of the design; a wire anomaly, and the one case where the
  // right answer is to say NOTHING. A fabricated provenance on a spending
  // surface is worse than a gap, so an unrecognised value must not be
  // defaulted into one of the four above. Added because a mutation deleting
  // the allow-list entirely came back GREEN: every fixture sent a valid
  // source, so the validation was never exercised.
  const bogus = mk(Object.assign({}, stateC().build, { source: 'promotional-tier-3' }));
  okContains(bogus, 'upstage/solar-pro4', 'an unrecognised source still names the model that runs');
  ok(!/follows the app default|You chose this one|LLM_MODEL|not the one running/.test(bogus),
    '\u2026and makes NONE of the four provenance claims \u2014 an invented "why" is worse than a gap');
  ok(!/promotional-tier-3/.test(bogus),
    '\u2026and never echoes the unrecognised value back at the user');
  // ── AND THE RECORD ITSELF CARRIES `null`, NOT THE UNKNOWN STRING ──────
  // The rendered assertions above are satisfied either way, because every
  // branch that reads `source` compares it to a literal — so an unrecognised
  // string behaves exactly like null in the markup, and a mutation deleting
  // the allow-list came back GREEN twice. The allow-list is kept because
  // `source` is a FIELD of a record, not only a branch input, and the next
  // consumer may well switch on it or forward it; so the contract is asserted
  // where it is made.
  const bogusFacts = R.buildLaneFacts(stateC({
    build: Object.assign({}, stateC().build, { source: 'promotional-tier-3' }) }));
  ok(bogusFacts.source === null,
    'buildLaneFacts normalises an unrecognised source to NULL, never passing the string through');
  ok(bogusFacts.model === 'upstage/solar-pro4',
    '\u2026while keeping every field it WAS told, so one bad value costs one field');
  ok(R.buildLaneFacts(stateC()).source === 'selected',
    'CONTROL: a source on the list survives unchanged \u2014 the normaliser is not simply nulling everything');

  // THE POPUP IS THE CONTROL, and it is the shared listbox.
  const c = renderWith(stateC());
  ok(/data-listbox="build-model-lb"/.test(c), 'block 2 renders the build popup');
  ok(/data-listbox-value="openrouter::upstage\/solar-pro4"/.test(c),
    '\u2026with the model in force selected, qualified by its provider');
  // The name leads and the id follows, in the text face.
  okContains(c, '<span class="build-current-model">upstage/solar-pro4</span>',
    'the id is rendered in the text face, not in <code class="mono">');
  ok(!/<code class="mono build-current-model">/.test(c),
    '\u2026and the old monospace id line is gone');

  // The three fact chips.
  okContains(c, '$0.03 in \u00b7 $0.12 out per 1M tokens', 'the price chip carries both figures');
  okContains(c, 'plans about 23 pages per source', 'the measured finding is shown verbatim');
  okContains(c, 'measured by The Curator', 'and who measured it');
  // CONTEXT IS DELIBERATELY ABSENT \u2014 `contextLength` is null on every static
  // entry, i.e. on every model that can be the build model today.
  ok(!/524,288|524288/.test(c.slice(c.indexOf('build-facts'), c.indexOf('build-facts') + 900)),
    'no context chip: it would be blank or invented on exactly the rows that matter');

  // Cheapest measured \u2014 both arms.
  okContains(c, 'the one you are already using', 'cheapest measured, when it is the one running');
  const diff = mk(Object.assign({}, stateC().build, {
    cheapestMeasured: { model: 'gemini-2.5-flash-lite', provider: 'gemini',
      priceIn: 0.10, priceOut: 0.40, same: false },
  }));
  okContains(diff, 'Cheapest measured', 'cheapest measured, when it differs');
  ok(/data-build-model="gemini-2.5-flash-lite" data-build-provider="gemini"/.test(diff),
    '\u2026carries a "Use it" that writes through the SAME atomic endpoint as every other pick');
  ok(!/recommended|\bbest\b/i.test(diff),
    '\u2026and never says recommended or best \u2014 only "cheapest measured", which is a fact');

  // The two empty states are DIFFERENT states with different actions.
  const noKeys = renderWith(stateA());
  okContains(noKeys, 'Nothing builds your wiki yet.', 'no key: says nothing builds it yet');
  okContains(noKeys, 'Connect a provider above', '\u2026and names connecting as the action');
  const keyedNothing = renderWith(Object.assign(stateB(), {
    build: null, buildModel: null, activeProvider: null, activeModel: null,
    offerable: { gemini: [], anthropic: [], openrouter: [] },
  }));
  okContains(keyedNothing, 'nothing behind it has been measured',
    'a working key with nothing measured says so');
  okContains(keyedNothing, 'measure one on your own pages',
    '\u2026and names measuring as the action, not connecting');
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a74  BLOCK 3 — a statement and a readout, never a second picker');
// ══════════════════════════════════════════════════════════════════════════
{
  const c = renderWith(stateC());
  const i3 = c.indexOf('<h2 class="settings-job-title">Chat</h2>');
  const i4 = c.indexOf('<h2 class="settings-job-title">All models</h2>');
  const block = c.slice(i3, i4);
  okContains(block, 'Starts on', 'names what a new conversation starts on');
  okContains(block, 'Solar Pro 4', '\u2026by NAME');
  okContains(block, 'OpenRouter \u00b7 upstage/solar-pro4', '\u2026with the provider and the id under it');
  okContains(block, '211 models available', 'and how many chat can reach');
  ok(/composer/i.test(block), 'it points at the composer');
  ok(!/data-build-model|data-pick-model|data-listbox|data-set-active/.test(block),
    'and carries NO control at all \u2014 the composer owns this choice');

  const a = renderWith(stateA());
  const j3 = a.indexOf('<h2 class="settings-job-title">Chat</h2>');
  const j4 = a.indexOf('<h2 class="settings-job-title">All models</h2>');
  okContains(a.slice(j3, j4), 'No models are available to chat yet.',
    'with nothing connected it says what it is waiting for');
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a75  BLOCK 4 — facet counts, the hidden ids, and the honest shelf');
// ══════════════════════════════════════════════════════════════════════════
{
  const c = renderWith(stateC());
  const i4 = c.indexOf('<h2 class="settings-job-title">All models</h2>');
  const block = c.slice(i4);

  ok(/<details class="settings-shelf" data-model-shelf/.test(block),
    'the catalogue ships COLLAPSED');
  okContains(block, '211 in total', 'the summary states the true total');

  // ── THE COUNT THE CLIENT CANNOT RECOMPUTE ────────────────────────────
  // `batchHidden` names ids the eligibility filter REMOVED, so nothing in the
  // payload could recount them. Stating the number is the difference between a
  // catalogue that is smaller than the vendor's and one that is silently
  // partial \u2014 v3.42.0 records that 26% of the picker was dead rows.
  okContains(block, '57 batch-only ids hidden \u2014 they answer 404 on every call',
    'the hidden-id clause names the number AND why they are hidden');

  // A NULL IS NOT A ZERO. An older backend that never sent the field must
  // render no clause at all, rather than claiming none were hidden.
  const noCounts = renderWith(stateC({ catalogueCounts: undefined }));
  ok(!/batch-only ids hidden/.test(noCounts),
    'with no catalogueCounts, the hidden-id clause is ABSENT \u2014 never "0 hidden"');
  // ── AND THE ABSENCE IS CARRIED AS `null`, NOT COERCED TO A ZERO ───────
  // The rendered assertion above is satisfied by BOTH, because the renderer
  // only prints a POSITIVE count — so on its own it says nothing about which
  // one the reader produces. Mutating the fallback from `null` to `0` came
  // back GREEN for exactly that reason. These are different facts ("we were
  // not told" versus "we were told none") and the next consumer of this
  // record may well distinguish them, so the distinction is asserted where it
  // is made rather than only where it currently happens to be invisible.
  ok(R.catalogueCountsOf(stateC({ catalogueCounts: undefined })).batchHidden === null,
    'catalogueCountsOf reports batchHidden as NULL when it was not told \u2014 never 0');
  ok(R.catalogueCountsOf(stateC()).batchHidden === 57,
    'CONTROL: and reports the server\u2019s own number when it WAS told');
  const zero = renderWith(stateC({
    catalogueCounts: { total: 211, canBuild: 8, measured: 12, free: 5, batchHidden: 0 },
  }));
  ok(!/batch-only ids hidden/.test(zero),
    'and an explicit ZERO renders no clause either \u2014 a clause saying "0 hidden" is noise');

  // The facets, with live counts computed by the SAME filter that draws the
  // rows, so a count can never promise rows the table would not deliver.
  for (const [id, label] of R.MODEL_LANE_FACETS) {
    ok(block.includes('data-browse-lane="' + id + '"'), `the "${label}" facet is offered`);
  }
  ok(/data-browse-lane="all"[^>]*aria-pressed="true"/.test(block),
    'and "All" is the one selected by default');
  ok(/data-browse-band="free"/.test(block) && /data-browse-band="lt20"/.test(block),
    'the price bands are offered');
  ok(/data-listbox="browse-provider-lb"/.test(block) && /data-listbox="browse-sort-lb"/.test(block),
    'the provider and sort popups are the shared listbox');

  // The table, and the columns that make it one.
  okContains(block, '<th class="browse-num">In /1M</th>', 'the table carries an input-price column');
  okContains(block, '<th class="browse-num">Context</th>', '\u2026and a context column');
  okContains(block, 'Solar Pro 4', 'a build-lane model is listed');
  okContains(block, 'Building your wiki', '\u2026and the one in force says so rather than offering a button');
  okContains(block, 'not measured yet', 'an unmeasured model says UNMEASURED');
  // SCOPED TO THE TABLE, deliberately. `renderCatalogueSync`'s own note, in the
  // Model Lab section further down, does say a fetched model "cannot build your
  // wiki" — with the sentence that earns it ("only a real run can measure
  // whether it does our job") and a route into measuring it. That copy predates
  // this page and is not this suite's subject. What IS asserted is that the
  // browse TABLE, which is one word per row with no room for a caveat, never
  // makes the bare claim.
  const table = block.slice(block.indexOf('<table class="browse-table">'),
    block.indexOf('</table>'));
  ok(table.length > 200, 'CONTROL: the table slice is non-empty, so the scan below is not vacuous');
  ok(!/cannot build/i.test(table),
    'the table never says "cannot build": unmeasured means nobody looked, never a rejection');

  // The Worth-testing shelf: FACTS ONLY, capped, and honest when empty.
  okContains(block, 'Worth testing for this job', 'the shelf is present');
  ok(!/\brecommended\b|\bbest\b|\bcapable\b/i.test(block),
    'and it never says recommended, best or capable');
  const worth = R.worthTestingRows(R.allCatalogueRows(stateC()), R.buildLaneFacts(stateC()));
  ok(worth.length <= 5, `the shelf is capped at five (got ${worth.length})`);
  ok(worth.every(({ row }) => !R.laneBuildsWiki(row.lane)),
    'every entry is a model there is something to LEARN about \u2014 never one already in the lane');
  ok(worth.every(({ row }) => row.m.contextLength >= R.BUILD_WORKING_SET_TOKENS),
    'every entry clears the build lane\u2019s working set, on its PUBLISHED context');
  // NAMED, not just counted: the fixture carries a model that is cheaper than
  // everything else on the shelf and fails ONLY the working-set test, so this
  // assertion cannot pass unless that test is actually running.
  ok(!worth.some(({ row }) => row.m.id === 'tiny/short-context'),
    '\u2026and the cheap row whose context is a third of the working set is NOT on it');
  ok(block.includes('tiny/short-context'),
    'CONTROL: that row IS in the table \u2014 it is excluded from the shelf, never hidden from the catalogue');

  // The empty state, written out rather than left blank.
  const bare = renderWith(stateC({
    offerable: { gemini: GEM, anthropic: [], openrouter: [OR[0]] },
  }));
  okContains(bare, 'Nothing on your synced list stands out on facts alone for this job',
    'with no candidate, the shelf says so in words');
  okContains(bare, 'Every model stays reachable in the list above',
    '\u2026and says nothing has been hidden');

  // The two catalogue actions.
  ok(/data-open-model-lab="1"/.test(block), 'Open Model Lab is offered');
  ok(/data-sync-catalogue="openrouter"/.test(block), 'Refresh catalogue is offered');
  const noOr = renderWith(stateB());
  ok(!/data-sync-catalogue=/.test(noOr),
    'and Refresh is absent for a provider with no fetchable catalogue \u2014 derived, never hardcoded');
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a76  THE DEGRADED PAYLOAD — an older backend still renders a page');
// ══════════════════════════════════════════════════════════════════════════
// Every new field has a fallback, and a fallback nobody exercises is the shape
// this repo keeps finding broken. This is the SAME page with none of them.
{
  const old = stateC();
  delete old.connected;
  delete old.build;
  delete old.catalogueCounts;
  delete old.chat;
  const html = renderWith(old);

  ok((html.match(/provider-pill-on/g) || []).length === 2,
    'no `connected` map: the pills fall back to the saved-key test and still read correctly');
  okContains(html, 'upstage/solar-pro4', 'no `build`: the model in force is still named');
  okContains(html, 'You chose this one', '\u2026with the provenance the older `buildModel` carries');
  // SEVEN, not 211: the fallback counts the rows the CLIENT holds (two Gemini
  // plus five OpenRouter), which is the only honest number available without
  // the server's own count — and it is visibly smaller than the true catalogue,
  // which is exactly why `catalogueCounts` exists.
  okContains(html, '7 in total',
    'no `catalogueCounts`: the total is counted from the catalogue the client holds');
  okContains(html, '7 models available', 'no `chat`: the count falls back the same way');
  okContains(html, 'Solar Pro 4', '\u2026and chat\u2019s starting model is resolved from activeProvider');

  // The OLDEST payload of all: no `build` AND no `buildModel`, which is what a
  // backend from before either field sends. It still resolves a model.
  const oldest = Object.assign({}, old);
  delete oldest.buildModel;
  const h2 = renderWith(oldest);
  okContains(h2, 'upstage/solar-pro4',
    'no `buildModel` either: activeProvider + activeModel still name what runs');
  okContains(h2, 'This is what ingest, Health scans and Compile run on.',
    '\u2026and the copy claims exactly what that payload supports, and no provenance');
  ok(!/You chose this one|follows the app default|LLM_MODEL/.test(h2),
    '\u2026making none of the provenance claims it was never told');
  ok(!/Nothing builds your wiki/.test(h2),
    '\u2026and never telling a working install that nothing builds its wiki');
}

console.log(`\n  ${'\u2500'.repeat(46)}`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\u274c Providers-page assertions FAILED');
  process.exit(1);
}
console.log('\u2705 Providers page: four blocks, every state, every degraded arm');
