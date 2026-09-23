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
// v3.67.0: block 2 derives its lede and its "Used by" row from the registry.
import { buildLaneJobs, AI_JOBS } from '../src/public/next/shared/ai-jobs.js';

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
  'ALL_MODELS_SCOPE', 'MODEL_LANE_FACETS', 'MODEL_PRICE_BANDS', 'BUILD_WORKING_SET_TOKENS',
  // Which providers publish a refetchable catalogue. Extracted rather than
  // re-declared here: it is the table that decides whether a Model lists row
  // gets Refresh or Check, and a local copy would keep this suite green after
  // a second provider joined it.
  'CATALOGUE_SYNC_PROVIDERS'];

const FNS = [
  'infoMark', 'providerLabel', 'activeModelLine', 'providerHasSavedKey', 'providerConnected',
  'qualIndex', 'buildModelFacts', 'buildLaneFacts', 'buildModelDisplayName',
  // v3.53.1: the per-model withdrawn verdict and its chip. Registered here
  // because renderModelOption / renderBuildList / renderModelBrowse CALL them;
  // the manifest is this suite's record of what settings.js needs to evaluate.
  'modelLiveMissing', 'renderGoneChip',
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
  // `refreshCatalogueButton` IS GONE, and its removal is the point. It rendered
  // block 4's footer copy of the refresh control — the SAME `data-sync-catalogue`
  // hook and the SAME route as the per-provider one, under a second name
  // (`Refresh catalogue` vs `Refresh model list`). One action under two names is
  // worse than two actions: the second name implies a second thing to learn, and
  // the maintainer could not tell them apart. There is now one control per
  // provider, in the Model lists group, named after the provider it refreshes.
  'renderModelBrowse', 'renderWorthTesting',
  // The Model lists group, which replaced the per-provider catalogue cards
  // (`renderCatalogueSync` + `renderModelPicker` per provider). Those were a
  // SECOND copy of block 4's table with a second search and a second sort, and
  // rows whose only control was a sentence saying the control was elsewhere.
  'renderModelListsGroup', 'renderModelListRow', 'renderModelCheckResult',
  'renderCatalogueSyncDetail',
  // The retired-build-model banner and its pure verdict. Extracted, never
  // re-implemented here: `liveMissing` is three-valued and the whole assertion
  // is about which of the three renders nothing.
  'modelGoneFacts', 'renderModelGoneBanner',
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
  modelCheckBusy: null, modelCheck: {}, modelCheckError: {}, worthTestingOpen: false,
  browseRowOpen: {},
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
  // v3.67.0 — the REAL registry. settings.js reads it through a `typeof`
  // guard (so the three unowned lifting suites that do not inject it render
  // the block without the row); this suite injects it and asserts the row.
  buildLaneJobs,
};

let R;
let SANDBOX_BODY = '';
/** A second sandbox over the SAME extracted bodies, with some collaborators
 *  replaced — how §12 drives the lede and the row with a different registry. */
function sandboxWith(over) {
  const inj = Object.assign({}, INJECTED, over || {});
  const names = Object.keys(inj);
  return new Function(...names, SANDBOX_BODY)(...names.map((n) => inj[n]));
}
try {
  const names = Object.keys(INJECTED);
  const body =
    CONSTS.map((n) => extractConst(settingsSrc, n)).join('\n') + '\n' +
    FNS.map((n) => extractFunction(settingsSrc, n)).join('\n') + '\n' +
    'return { ' + CONSTS.concat(FNS).join(', ') + ' };';
  SANDBOX_BODY = body;
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
  // v3.67.0 (Q2): block 2 is "Your AI model"; same id, same position.
  const i2 = H('Your AI model');
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
  // v3.67.0: on THIS card the claim is "measured for the build lane" — the
  // evidence is the ingest prompt, which every other AI job inherits (§12).
  okContains(c, '<span class="build-fact build-fact-measured">measured for the build lane</span>',
    'and who measured it, for which lane');
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
  // "Browse every model" became "Every model, all providers" and the count
  // dropped "in total": the shelf summary is a NAME plus a NUMBER, and "in
  // total" was a word doing no work beside a figure that is self-evidently one.
  okContains(block, 'Every model, all providers', 'the shelf names what it holds');
  okContains(block, '\u00b7 211', 'the summary states the true total');

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

  // ── THE TWO CATALOGUE ACTIONS ARE NOW ONE, AND IT NAMES ITS PROVIDER ──
  // `Open Model Lab` navigated NOWHERE — it opened every provider's <details>
  // and scrolled, and the thing it scrolled to has been removed. `Refresh
  // catalogue` was the SAME action as the per-provider control under a second
  // name, through the same hook and the same route. Asserting their ABSENCE is
  // what stops a later edit restoring the pair that the maintainer could not
  // tell apart.
  ok(!/data-open-model-lab/.test(block),
    'Open Model Lab is GONE — a scroll dressed as a destination, to a section that no longer exists');
  ok(!/>Refresh catalogue</.test(block),
    'and so is the unqualified "Refresh catalogue" — one action under two names');
  ok(/data-sync-catalogue="openrouter"/.test(block), 'ONE refresh control survives');
  ok(/Refresh OpenRouter model list/.test(block),
    '\u2026and it NAMES the provider, so "which list does this refresh?" is answered by the button');
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
  okContains(html, '\u00b7 7',
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


// ══════════════════════════════════════════════════════════════════════════
section('§9  THE BUILD LANE IS VISIBLE ON THE ROW, not only in the last cell');
// ══════════════════════════════════════════════════════════════════════════
// THE REPORT: in block 4's 200-row table and block 2's list, the rows that can
// build the wiki looked exactly like the rows that cannot, and the only tell
// was whether the LAST of five columns held a button — a column that scrolls
// out of view inside `.browse-table-wrap`.
//
// ── THE SECOND MEASUREMENT IS DELIBERATELY DUMB ─────────────────────────────
// The expected set is derived from the FIXTURE's own `suitability` field, not
// from `modelLaneOf` — the function under test's own predicate. Comparing the
// renderer against the rule it uses would agree with itself whatever the rule
// became; comparing it against the raw data is the independent cross-check this
// repo's v3.1.0 lesson asks for. `qualifications` is empty in every fixture
// here, so `suitability !== 'chat-only'` IS the lane, with no second opinion.
function rowAttrs(html, tag) {
  // Deliberately a scan for OPEN TAGS carrying data-model-id, not a parse: the
  // attributes are what is asserted, so reading them out of the literal source
  // is the closest thing to reading the rendered attribute list.
  const out = new Map();
  const re = new RegExp('<' + tag + '\\s([^>]*?)data-model-id="([^"]*)"([^>]*)>', 'g');
  let m;
  while ((m = re.exec(html)) !== null) {
    out.set(m[2], (m[1] || '') + (m[3] || ''));
  }
  return out;
}
function laneMarked(attrMap) {
  const s = new Set();
  for (const [id, attrs] of attrMap) if (/data-lane="build"/.test(attrs)) s.add(id);
  return s;
}
function sorted(set) { return Array.from(set).sort().join(','); }

{
  const keys = stateC();
  const html = renderWith(keys);

  // Block 4's table. Every catalogue row is drawn, from both connected
  // providers, so the mixed case is the one under test.
  const tableRows = rowAttrs(html, 'tr');
  const expectBuild = new Set();
  const expectChat = new Set();
  for (const p of ['gemini', 'openrouter']) {
    for (const m of keys.offerable[p]) {
      (m.suitability === 'chat-only' ? expectChat : expectBuild).add(m.id);
    }
  }
  ok(expectBuild.size >= 2 && expectChat.size >= 2,
    `the fixture is genuinely mixed (${expectBuild.size} build, ${expectChat.size} chat-only) ` +
    '— without both kinds every assertion below is vacuous');
  ok(tableRows.size === expectBuild.size + expectChat.size,
    `block 4 draws every catalogue row (got ${tableRows.size})`);

  const marked = laneMarked(tableRows);
  ok(sorted(marked) === sorted(expectBuild),
    'block 4: EXACTLY the build-lane rows carry data-lane="build" ' +
    `(got ${sorted(marked) || 'none'})`);
  let chatMarked = 0;
  for (const id of expectChat) if (marked.has(id)) chatMarked++;
  ok(chatMarked === 0, `block 4: no chat-only row carries the marker (got ${chatMarked})`);

  // The row IN FORCE gets the stronger variant, and there is exactly one of it
  // on the whole page — the same "in use must mean one model" rule
  // renderModelOption states for its badge.
  const current = [];
  for (const [id, attrs] of tableRows) if (/data-build-current="1"/.test(attrs)) current.push(id);
  ok(current.length === 1 && current[0] === 'upstage/solar-pro4',
    `block 4: exactly one row is marked as building now (got ${current.join(',') || 'none'})`);
  for (const [id, attrs] of tableRows) {
    if (!marked.has(id)) continue;
    ok(/browse-row-builds/.test(attrs), `block 4: ${id} carries the paint class too`);
  }
  ok(/browse-row-inuse/.test(tableRows.get('upstage/solar-pro4') || ''),
    'block 4: the row in force carries the stronger paint class');

  // The chip, in the FIRST cell — the one that never scrolls out of view.
  const builds = (html.match(/model-badge-lane">builds</g) || []).length;
  const now = (html.match(/model-badge-lane-now">building now</g) || []).length;
  ok(now === 1, `block 4: one "building now" chip (got ${now})`);
  ok(builds === expectBuild.size - 1,
    `block 4: a "builds" chip on every other build row (got ${builds}, expected ${expectBuild.size - 1})`);

  // Block 2's list. EVERY row there is a build candidate, so the assertion is
  // set equality against the whole list — and there is no `builds` chip,
  // deliberately: a flag on 100% of a list carries no information (v3.16.1).
  const liRows = rowAttrs(html, 'li');
  ok(liRows.size >= 2, `block 2 draws its candidates (got ${liRows.size})`);
  const liMarked = laneMarked(liRows);
  ok(liMarked.size === liRows.size,
    `block 2: every candidate row carries the marker (${liMarked.size} of ${liRows.size})`);
  const liCurrent = [];
  for (const [id, attrs] of liRows) if (/data-build-current="1"/.test(attrs)) liCurrent.push(id);
  ok(liCurrent.length === 1 && liCurrent[0] === 'upstage/solar-pro4',
    `block 2: exactly one row is marked as building now (got ${liCurrent.join(',') || 'none'})`);
  for (const [, attrs] of liRows) {
    ok(/model-option-builds/.test(attrs), 'block 2: …and the paint class with it');
    break;
  }
}

{
  // THE NEGATIVE STATE. With nothing connected there is no catalogue, so there
  // must be no marker anywhere — a marker that survived an empty page would
  // mean it is being emitted unconditionally, which is the mutation this
  // section exists to catch.
  const html = renderWith(stateA());
  ok(!/data-lane="build"/.test(html),
    'state A: nothing connected, so nothing is marked as building');
  ok(!/model-badge-lane/.test(html), 'state A: …and no lane chip is emitted');
}

{
  // PRICE NEVER TOUCHES THE COLOUR (v3.16.0: price is a fact, never a gate).
  // Driven, not asserted from the stylesheet: the free row and the dearest row
  // in this fixture are BOTH chat-only, and the build rows span $0.03 to $0.25
  // output — so if price leaked into the marker the sets would differ.
  const keys = stateC();
  const html = renderWith(keys);
  const marked = laneMarked(rowAttrs(html, 'tr'));
  ok(!marked.has('minimax/minimax-m3:free'),
    'the free model is not marked — being free is not a lane');
  ok(!marked.has('qwen/qwen3-max'),
    'the dearest model is not marked either — price is not a lane');
  const prices = Array.from(marked).map((id) => {
    for (const p of ['gemini', 'openrouter']) {
      for (const m of keys.offerable[p]) if (m.id === id) return m.output;
    }
    return null;
  });
  ok(new Set(prices).size > 1,
    `the marked rows do NOT share one price (got ${prices.join(', ')}) — so the marker ` +
    'cannot be a price band wearing a lane’s name');
}

{
  // THE STYLESHEET ACTUALLY PAINTS THEM. A marker class nothing styles is a
  // marker nobody can see, which is the whole report.
  const css = fs.readFileSync(path.join(ROOT, 'src/public/next/views/settings.css'), 'utf8');
  for (const sel of ['.browse-row-builds > td:first-child', '.browse-row-inuse > td:first-child',
    '.model-option-builds', '.model-badge-lane']) {
    ok(css.indexOf(sel) !== -1, `settings.css styles ${sel}`);
  }
  const ruleBlock = (sel) => {
    const i = css.indexOf(sel);
    if (i === -1) return '';
    const open = css.indexOf('{', i);
    return css.slice(open, css.indexOf('}', open));
  };
  ok(/var\(--accent\)/.test(ruleBlock('.browse-row-builds > td:first-child')),
    'the rule down a build row is painted in --accent (4.30:1 dark / 6.57:1 light, measured)');
  ok(/var\(--text\)/.test(ruleBlock('.model-badge-lane')),
    'the chip LABEL is --text, not the accent — the measured treatment the other ' +
    'model badges use (14.75:1 dark / 16.16:1 light on the chip’s own tint)');
  ok(/padding-left/.test(ruleBlock('.browse-table th:first-child')),
    'every first cell reserves the rule’s space, header included, so a marked row’s ' +
    'name does not sit two pixels right of an unmarked one’s');
  // CONTROL: the extractor really does read a block, so the scans above are not
  // three vacuous truths about an empty string.
  ok(ruleBlock('.browse-row-inuse > td:first-child').length > 5,
    'CONTROL: the rule-block reader returns real declarations');
}

// ══════════════════════════════════════════════════════════════════════════
section('§10  THE RUN ENDS AND THE PANEL SAYS SO');
// ══════════════════════════════════════════════════════════════════════════
// THE REPORT: nine runs finished and nothing said they had. `state.qualify` was
// set to null on the `stored` frame, so the panel simply vanished and the only
// evidence was a lane cell changing somewhere in a 200-row table.
{
  const rec = (over) => Object.assign({
    modelId: 'ibm-granite/granite-4.0-h-micro', provider: 'openrouter', domain: 'probe',
    runsCompleted: 9, minRunsToQualify: 9, outcome: 'NO_DEFECT_FOUND', aborted: null,
    counts: { raw: 9, repaired: 0, unrepairable: 0, unusable: 0, notMeasured: 0, failed: 0 },
  }, over || {});

  const clean = R.renderQualifyPanel({
    modelId: 'ibm-granite/granite-4.0-h-micro', phase: 'done', runs: [], total: 9,
    qualifies: true, record: rec(),
  }, 9, 'upstage/solar-pro4');
  okContains(clean, 'Done — no defect found in 9 runs. This model can now build your wiki.',
    'a clean run says so, in the panel the user has been watching');
  okContains(clean, 'data-build-model="ibm-granite/granite-4.0-h-micro"',
    '…and carries the lane control right there');
  okContains(clean, 'data-build-provider="openrouter"',
    '…naming the provider too, because the route applies both together');
  okContains(clean, 'data-qualify-cancel="1"',
    '…and a way to dismiss it, through the one handler that clears state.qualify');

  // THE PROVIDER IS READ, NEVER GUESSED. A record without one withholds the
  // button rather than pinning a model under a key the user is not using.
  const noProv = R.renderQualifyPanel({
    modelId: 'ibm-granite/granite-4.0-h-micro', phase: 'done', runs: [], total: 9,
    qualifies: true, record: rec({ provider: null }),
  }, 9, '');
  okContains(noProv, 'This model can now build your wiki.',
    'a record with no provider still reports the outcome');
  ok(!/data-build-model=/.test(noProv),
    '…and withholds the control rather than guessing which key would be billed');

  // ALREADY THE BUILD MODEL: report, never offer a write that rewrites the
  // value it has — this file’s named invitation-to-a-no-op.
  const already = R.renderQualifyPanel({
    modelId: 'ibm-granite/granite-4.0-h-micro', phase: 'done', runs: [], total: 9,
    qualifies: true, record: rec(),
  }, 9, 'ibm-granite/granite-4.0-h-micro');
  ok(!/data-build-model=/.test(already),
    'the model already building the wiki is not offered the button again');
  okContains(already, 'Building your wiki', '…it reports that state instead');

  // THE FAILING ARM, with the reason.
  const bad = R.renderQualifyPanel({
    modelId: 'ibm-granite/granite-4.0-h-micro', phase: 'done', runs: [], total: 9,
    qualifies: false,
    record: rec({ outcome: 'DEFECT_OBSERVED',
      counts: { raw: 2, repaired: 0, unrepairable: 7, unusable: 0, notMeasured: 0, failed: 0 } }),
  }, 9, '');
  okContains(bad, 'Done — 7 of 9 runs failed; it stays chat-only.',
    'a failing run names how many failed and what it means');
  okContains(bad, '7 returned JSON that could not be repaired.',
    '…with the reason, not just the count');
  ok(!/data-build-model=/.test(bad),
    '…and never offers a control the pin route would refuse');

  // A RATE LIMIT IS NOT A DEFECT. llm.js records this in as many words: it is a
  // fact about a shared upstream queue, not about the model.
  const rl = R.renderQualifyPanel({
    modelId: 'ibm-granite/granite-4.0-h-micro', phase: 'done', runs: [], total: 9,
    qualifies: false,
    record: rec({ outcome: 'NOT_MEASURED', runsCompleted: 0,
      counts: { raw: 0, repaired: 0, unrepairable: 0, unusable: 0, notMeasured: 9, failed: 0 } }),
  }, 9, '');
  okContains(rl, 'Done — nothing was measured; it stays chat-only.',
    'a rate-limited run is reported as not measured');
  okContains(rl, 'says nothing about the model',
    '…and is explicitly NOT counted against it');
  ok(!/runs failed/.test(rl),
    '…so it never says a run "failed", which would be a finding it does not have');

  // CLEAN BUT SHORT OF THE BAR — say WHICH, rather than letting a clean
  // result read as a refusal for an unstated reason.
  const short = R.renderQualifyPanel({
    modelId: 'ibm-granite/granite-4.0-h-micro', phase: 'done', runs: [], total: 9,
    qualifies: false,
    record: rec({ runsCompleted: 3,
      counts: { raw: 3, repaired: 0, unrepairable: 0, unusable: 0, notMeasured: 0, failed: 0 } }),
  }, 9, '');
  okContains(short, 'Done — no defect found, but it stays chat-only.',
    'clean-but-short says both halves');
  okContains(short, 'Only 3 of the 9 runs needed', '…and names the bar it fell short of');

  // A BACKEND THAT SENDS NO `counts` MUST STILL PRODUCE A NUMBER, from the run
  // frames the client already holds — never a silent zero.
  const framesOnly = R.renderQualifyPanel({
    modelId: 'ibm-granite/granite-4.0-h-micro', phase: 'done', total: 9, qualifies: false,
    runs: [
      { run: 1, outcome: 'COMPLETED', usable: true },
      { run: 2, outcome: 'COMPLETED', usable: false },
      { run: 3, outcome: 'FAILED' },
    ],
    record: { modelId: 'ibm-granite/granite-4.0-h-micro', provider: 'openrouter',
      outcome: 'DEFECT_OBSERVED', runsCompleted: 3 },
  }, 9, '');
  okContains(framesOnly, 'Done — 2 of 9 runs failed',
    'no `counts` on the record: the count comes from the frames, not from nowhere');

  // The phases that existed before this one are untouched.
  const running = R.renderQualifyPanel({
    modelId: 'a/b', phase: 'running', runs: [], total: 9, startedAt: Date.now(),
  }, 9, '');
  okContains(running, 'Run 1 of 9', 'the running arm is unchanged');
  ok(!/Done —/.test(running), '…and never claims to be done');
  ok(R.renderQualifyPanel(null, 9, '') === '', 'no panel with no qualification in flight');
}

{
  // THE COMPLETION NOTICE EXISTS ONCE ON THE PAGE. A model that PASSES moves
  // into the build lane, so the instant `loadKeys` lands it is ALSO a block 2
  // row — and block 2 renders the same panel for the row being measured.
  // Without the phase guard in renderModelOption the notice, and the button
  // with it, would render twice in two different blocks.
  const keys = stateC();
  stubState.qualify = {
    modelId: 'ibm-granite/granite-4.0-h-micro', phase: 'done', runs: [], total: 9,
    qualifies: true,
    record: { modelId: 'ibm-granite/granite-4.0-h-micro', provider: 'openrouter',
      domain: 'probe', runsCompleted: 9, outcome: 'NO_DEFECT_FOUND',
      counts: { raw: 9, repaired: 0, unrepairable: 0, unusable: 0 } },
  };
  // The model is chat-only in the fixture, so give it the qualification the
  // run just produced — which is exactly what promotes it into block 2.
  keys.qualifications = [{ modelId: 'ibm-granite/granite-4.0-h-micro', provider: 'openrouter',
    qualifies: true, outcome: 'NO_DEFECT_FOUND', runsCompleted: 9, domain: 'probe',
    counts: { raw: 9, repaired: 0, unrepairable: 0, unusable: 0 } }];
  INJECTED.pendingListboxes.length = 0;
  Object.assign(stubState, { keys, keysError: null, keysActionError: null,
    keysActivationNotice: null, modelPickerOpen: {}, modelShelfOpen: false,
    buildListOpen: false, modelPickBusy: '', modelPickError: {}, modelPickErrorAt: '',
    modelFilter: {} });
  const html = R.renderProviders();
  const marked = laneMarked(rowAttrs(html, 'li'));
  ok(marked.has('ibm-granite/granite-4.0-h-micro'),
    'CONTROL: the freshly-qualified model really is a block 2 row now — without ' +
    'that, the duplicate this guard prevents is unreachable and the assertion is vacuous');
  const notices = (html.match(/id="qualify-done"/g) || []).length;
  ok(notices === 1, `the completion notice renders exactly once on the page (got ${notices})`);
  stubState.qualify = null;
}

// ══════════════════════════════════════════════════════════════════════════
section('§11  render() KEEPS OPEN WHAT THE USER OPENED');
// ══════════════════════════════════════════════════════════════════════════
// THE REPORT: an ⓘ fold and the model `<details>` rows closed by themselves
// while a "Test on my wiki" run streamed. Two causes, measured in the browser:
// the folds live ONLY in the DOM (shared/text.js flips `hidden` and
// `aria-expanded` and records nothing), and the `<details>` are state-backed but
// lose a race, because the spec QUEUES the `toggle` event so a render landing
// between the click and that task rebuilds from state that is one task stale.
//
// Both are closed by capturing off the LIVE DOM before the swap, so this drives
// the REAL render() against a fake document — the same way
// test-next-settings-scroll-and-scale.js drives it with spies.
{
  function el(tag, attrs, extra) {
    const a = Object.assign({}, attrs || {});
    const node = Object.assign({
      tagName: tag.toUpperCase(),
      open: false,
      hidden: false,
      get attributes() {
        return Object.keys(a).map((name) => ({ name, value: a[name] }));
      },
      getAttribute(n) { return Object.hasOwn(a, n) ? a[n] : null; },
      setAttribute(n, v) { a[n] = String(v); },
    }, extra || {});
    return node;
  }
  function makeRoot(nodes) {
    return {
      querySelectorAll(sel) {
        // Deliberately literal. An unrecognised selector THROWS rather than
        // returning nothing: a fake that silently answers "no matches" turns a
        // renamed selector into a green test, which is this repo's named
        // worse-than-no-test shape.
        if (sel === 'details[open]') return nodes.filter((n) => n.tagName === 'DETAILS' && n.open);
        if (sel === 'details') return nodes.filter((n) => n.tagName === 'DETAILS');
        if (sel === '[data-tx-info][aria-expanded="true"]') {
          return nodes.filter((n) => n.getAttribute('data-tx-info') !== null &&
            n.getAttribute('aria-expanded') === 'true');
        }
        if (sel === '[data-tx-info]') {
          return nodes.filter((n) => n.getAttribute('data-tx-info') !== null);
        }
        throw new Error('fake DOM: unhandled selector ' + sel);
      },
    };
  }

  // BEFORE the render: what the user has open.
  const shelfBefore = el('details', { 'data-model-shelf': '1' }); shelfBefore.open = true;
  const rowBefore = el('details', { 'data-model-row': 'z-ai/glm-5.3-flash' });
  const barefoot = el('details', {}); barefoot.open = true;   // no data- hook at all
  const infoOnBefore = el('button', { 'data-tx-info': 'p1', 'aria-expanded': 'true' });
  const infoOffBefore = el('button', { 'data-tx-info': 'p2', 'aria-expanded': 'false' });
  const rootBefore = makeRoot([shelfBefore, rowBefore, barefoot, infoOnBefore, infoOffBefore]);

  // AFTER the render: exactly what a template string emits — everything
  // closed, every panel hidden, every button "false".
  const shelfAfter = el('details', { 'data-model-shelf': '1' });
  const rowAfter = el('details', { 'data-model-row': 'z-ai/glm-5.3-flash' });
  const barefootAfter = el('details', {});
  const infoOnAfter = el('button', { 'data-tx-info': 'p1', 'aria-expanded': 'false' });
  const infoOffAfter = el('button', { 'data-tx-info': 'p2', 'aria-expanded': 'false' });
  const p1 = el('div', {}); p1.hidden = true;
  const p2 = el('div', {}); p2.hidden = true;
  const rootAfter = makeRoot([shelfAfter, rowAfter, barefootAfter, infoOnAfter, infoOffAfter]);

  let current = rootBefore;
  const doc = {
    getElementById(id) {
      if (id === 'view-root') return current;
      if (id === 'p1') return p1;
      if (id === 'p2') return p2;
      return null;
    },
  };
  const seen = [];
  const renderFn = new Function('document', 'preserveMainScroll', 'renderSidebar',
    'renderMain', 'wireGlobalListeners',
    extractFunction(settingsSrc, 'render') + '\nreturn render;')(
    doc,
    (f) => f(),
    () => seen.push('sidebar'),
    () => {
      // The swap. The replacement is CLOSED, which is what makes the assertions
      // below able to fail: only the restore can reopen anything.
      current = rootAfter;
      seen.push({ step: 'main', shelfOpenAtSwap: shelfAfter.open, p1HiddenAtSwap: p1.hidden });
    },
    () => seen.push({ step: 'wire', shelfOpenAtWire: shelfAfter.open, p1HiddenAtWire: p1.hidden }),
  );

  renderFn('tok');

  const mainStep = seen.find((s) => s && s.step === 'main');
  const wireStep = seen.find((s) => s && s.step === 'wire');
  ok(mainStep && mainStep.shelfOpenAtSwap === false && mainStep.p1HiddenAtSwap === true,
    'CONTROL: the freshly-rendered subtree really is closed and hidden at the swap — ' +
    'so anything open afterwards came from the restore and nowhere else');

  ok(shelfAfter.open === true,
    'the shelf the user had open is open again after the re-render');
  ok(rowAfter.open === false,
    'a row that was CLOSED is left closed — the restore only opens, never guesses');
  ok(infoOnAfter.getAttribute('aria-expanded') === 'true' && p1.hidden === false,
    'the ⓘ fold that was open is open again, BOTH halves — panel shown and button ' +
    'expanded, because shared/text.js reads aria-expanded to decide the next click');
  ok(infoOffAfter.getAttribute('aria-expanded') === 'false' && p2.hidden === true,
    'a fold that was closed stays closed');

  ok(wireStep && wireStep.shelfOpenAtWire === true && wireStep.p1HiddenAtWire === false,
    'the restore runs BEFORE wireGlobalListeners, so the listeners bind to the ' +
    'subtree the user will actually see');

  ok(barefootAfter.open === false,
    'a <details> with no data- hook cannot be keyed and is skipped — the stated ' +
    'limit of the scheme, pinned so it is a decision and not a surprise');
}

{
  // THE KEY IS THE COMPOSED data- HOOKS, so two disclosures that differ only in
  // their hook value do not restore each other. Without this, opening one model
  // row would reopen every model row on the next repaint.
  function el2(attrs, open) {
    const a = Object.assign({}, attrs);
    return {
      tagName: 'DETAILS', open: !!open, hidden: false,
      get attributes() { return Object.keys(a).map((name) => ({ name, value: a[name] })); },
      getAttribute(n) { return Object.hasOwn(a, n) ? a[n] : null; },
      setAttribute(n, v) { a[n] = String(v); },
    };
  }
  const mk = (nodes) => ({
    querySelectorAll(sel) {
      if (sel === 'details[open]') return nodes.filter((n) => n.open);
      if (sel === 'details') return nodes;
      if (sel === '[data-tx-info][aria-expanded="true"]') return [];
      if (sel === '[data-tx-info]') return [];
      throw new Error('fake DOM: unhandled selector ' + sel);
    },
  });
  const aBefore = el2({ 'data-model-row': 'a/one' }, true);
  const bBefore = el2({ 'data-model-row': 'b/two' }, false);
  const aAfter = el2({ 'data-model-row': 'a/one' }, false);
  const bAfter = el2({ 'data-model-row': 'b/two' }, false);
  let cur = mk([aBefore, bBefore]);
  const doc = { getElementById: (id) => (id === 'view-root' ? cur : null) };
  const renderFn = new Function('document', 'preserveMainScroll', 'renderSidebar',
    'renderMain', 'wireGlobalListeners',
    extractFunction(settingsSrc, 'render') + '\nreturn render;')(
    doc, (f) => f(), () => {}, () => { cur = mk([aAfter, bAfter]); }, () => {});
  renderFn('tok');
  ok(aAfter.open === true, 'the row that was open is restored');
  ok(bAfter.open === false,
    '…and its sibling is NOT — the key carries the hook’s VALUE, so one open ' +
    'row cannot open every row');
}

{
  // EVERY <details> THE PAGE EMITS CARRIES A data- HOOK, and this is the guard
  // that keeps that true: an unhooked one is silently unpreservable, which is
  // exactly the defect being fixed, reintroduced quietly.
  //
  // SCANNED OVER EMITTED STRING LITERALS, never over the file. A bare
  // `<details>` scan matched this file's own PROSE — settings.js discusses
  // disclosures in a dozen comments — and reported nine failures that were
  // sentences. The opening quote is what makes it markup being BUILT; the
  // window after it is the rest of that tag, which is where the hook has to be
  // (the shelf splits its tag across three concatenated fragments, so a
  // per-literal check would be wrong for the opposite reason).
  const emitted = [];
  const reDet = /'<details\b/g;
  let hit;
  while ((hit = reDet.exec(settingsSrc)) !== null) {
    const win = settingsSrc.slice(hit.index, hit.index + 400);
    const close = win.indexOf('>');
    emitted.push(close === -1 ? win : win.slice(0, close + 1));
  }
  const unhooked = emitted.filter((h) => !/data-[a-z-]+="/.test(h));
  ok(emitted.length >= 5,
    `CONTROL: the scan finds the page’s EMITTED disclosures (got ${emitted.length})`);
  ok(unhooked.length === 0,
    'every <details> settings.js emits carries a data- hook, so render() can key it ' +
    `(unhooked: ${unhooked.length})`);
}

// ══════════════════════════════════════════════════════════════════════════
section('§12  BLOCK 2 IS "YOUR AI MODEL" — every AI job, derived from AI_JOBS (v3.67.0)');
// ══════════════════════════════════════════════════════════════════════════
// The maintainer's Q2: one model runs every AI job (Chat alone picks per
// message), and block 2 now SAYS which jobs — its lede and its "Used by · N
// jobs" row are derived from the registry, never typed. Everything below runs
// the REAL renderers with the REAL registry injected.
{
  const esc = (t) => escapeHtmlStub(t);
  const blockOf = (html) => {
    const a = html.indexOf('<h2 class="settings-job-title">Your AI model</h2>');
    const b = html.indexOf('<h2 class="settings-job-title">Chat</h2>');
    return a === -1 || b === -1 ? '' : html.slice(a, b);
  };
  const JOBS = buildLaneJobs();
  ok(JOBS.length === 6 && AI_JOBS.length === 7,
    `PRECONDITION: the registry holds six build-lane jobs and Chat (got ${JOBS.length}/${AI_JOBS.length})`);

  const b2 = blockOf(renderWith(stateB()));
  ok(b2.length > 0, 'block 2 is found between its own heading and block 3’s');

  // THE LEDE — the contract's sentence, verbatim, and derived.
  okContains(b2, 'Every AI job runs on this one model: ingest, compile, wiki health, Shared Brain and reading plans.',
    'the lede names every AI job the model runs, in the contract’s words');
  ok(!/Ingest, Health scans and Compile all run on this one model/.test(b2),
    'and the three-job lede it replaces is gone');
  // THE ⓘ — ai-jobs P5, verbatim.
  okContains(b2, esc('There is nothing separate to set for each job: one model keeps one bill to read. ' +
    'Choosing a model from another provider makes that provider the active one, so the bill moves with it. ' +
    'Chat is the exception: pick any connected model per message, in the composer.'),
    'the ⓘ is P5’s three sentences, verbatim');

  // THE CARD — "measured for the build lane", with its own ⓘ.
  const card = b2.slice(b2.indexOf('build-current'), b2.indexOf('build-change') === -1 ? undefined : b2.indexOf('build-change'));
  okContains(card, '<span class="build-fact build-fact-measured">measured for the build lane</span>',
    'the current-model card says "measured for the build lane"');
  ok(!card.includes('measured by The Curator'),
    '…and no longer "measured by The Curator" — the evidence is one job’s, which the lane inherits');
  okContains(card, esc('Measured on the ingest prompt, 9 runs; the other jobs are the same kind of structured-output task.'),
    'its ⓘ says what "for the build lane" means');
  // CONTROL: the per-row chips in the Change… list keep their own words.
  okContains(b2.slice(b2.indexOf('build-change')), 'measured by The Curator',
    'CONTROL: the list rows below keep MEASUREMENT_CHIPS verbatim — only the card is re-worded');
  // CONTROL: a user-measured model still reads as the user’s claim on the card.
  {
    const k = stateB();
    k.build.facts.measured = 'user'; k.buildModel.measuredBy = 'user';
    const u = blockOf(renderWith(k));
    okContains(u, '<span class="build-fact build-fact-measured">measured on your wiki</span>',
      'CONTROL: "measured on your wiki" is untouched on the card');
    ok(!u.includes('>measured for the build lane<'), '…and is not relabelled as the lane’s');
  }

  // USED BY — a closed fold row, "6 jobs", one row per build-lane job.
  const fold = b2.slice(b2.indexOf('<details class="settings-usedby"'));
  ok(b2.includes('<details class="settings-usedby" data-used-by="1">'),
    'a "Used by" fold row, CLOSED by default, carrying the data- hook render() keys its open state on');
  ok(b2.indexOf('settings-usedby') > b2.indexOf('build-current'),
    '…and it sits under the model card, inside block 2');
  okContains(fold, '<span class="settings-usedby-title">Used by</span>', 'its title reads "Used by"');
  okContains(fold, '<span class="mono settings-usedby-count">' + JOBS.length + ' jobs</span>',
    `its summary reads "${JOBS.length} jobs" — N is the registry’s length, right-aligned in mono`);
  const rows = [...fold.matchAll(/<tr data-ai-job="([^"]+)"><th scope="row">([^<]*)<\/th><td>([^<]*)<\/td><td class="mono">([^<]*)<\/td><\/tr>/g)];
  ok(rows.length === JOBS.length, `one table row per build-lane job (got ${rows.length})`);
  ok(rows.every((r, i) => JOBS[i] && r[1] === JOBS[i].id && r[2] === esc(JOBS[i].label)
      && r[3] === esc(JOBS[i].startedFrom) && r[4] === esc(JOBS[i].costShown)),
    'each row is its job’s label · started from · cost shown, in registry order');
  ok(!fold.includes('data-ai-job="chat"'), 'Chat is NOT a row — it is not on this model');
  okContains(fold, '<th scope="col">Job</th><th scope="col">Started from</th><th scope="col">Cost shown</th>',
    'the table is headed Job · Started from · Cost shown');
  okContains(fold, 'Chat is separate: any connected model, per message, in the composer.',
    'the footer sentence says where Chat’s model is chosen');
  ok(!/cur-mon|role="status"/.test(fold.slice(0, fold.indexOf('</details>'))),
    'a static description, not a monitor: no live-state markup inside it');

  // OPEN STATE survives a repaint (state-backed, like the shelf).
  stubState.usedByOpen = true;
  ok(renderWith(stateB()).includes('<details class="settings-usedby" data-used-by="1" open>'),
    'state.usedByOpen reopens it on the next paint');
  stubState.usedByOpen = false;

  // DERIVED, NOT TYPED — a registry with a seventh job moves both the lede
  // and the count; one without Shared Brain drops it from both.
  {
    const extra = { id: 'zz-tidy', label: 'Tidy tags', startedFrom: 'Domains › ⑤ Wiki health',
      lane: 'build', mode: 'json', costShown: 'before', modules: [] };
    const R7 = sandboxWith({ buildLaneJobs: () => [...JOBS, extra] });
    const h7 = R7.renderBuildBlock(stateB(), false);
    okContains(h7, '<span class="mono settings-usedby-count">7 jobs</span>', 'a seventh job reads "7 jobs"');
    okContains(h7, 'Shared Brain, reading plans and tidy tags.',
      '…and appears in the lede by its own label, with no edit to settings.js');
    ok(h7.includes('data-ai-job="zz-tidy"'), '…and as a row');
    const R5 = sandboxWith({ buildLaneJobs: () => JOBS.filter((j) => j.id !== 'shared-brain') });
    const h5 = R5.renderBuildBlock(stateB(), false);
    okContains(h5, '<span class="mono settings-usedby-count">5 jobs</span>', 'a registry without Shared Brain reads "5 jobs"');
    okContains(h5, 'this one model: ingest, compile, wiki health and reading plans.',
      '…and its lede drops it');
    const R1 = sandboxWith({ buildLaneJobs: () => [JOBS[0]] });
    okContains(R1.renderBuildBlock(stateB(), false), '<span class="mono settings-usedby-count">1 job</span>',
      'one job is "1 job", not "1 jobs"');
    // THE GUARD: a lifting sandbox that injects no registry still renders the
    // block (the three unowned suites), with the plain lede and no row.
    const R0 = sandboxWith({ buildLaneJobs: undefined });
    const h0 = R0.renderBuildBlock(stateB(), false);
    ok(h0.includes('Every AI job runs on this one model.') && !h0.includes('settings-usedby'),
      'with NO registry bound, the block still renders: the plain lede and no row (the typeof guard)');
  }

  // THE BROWSER ALWAYS BINDS IT: the import is real, so the guard is always
  // true in the app. Over comment-stripped source, so a commented-out import
  // cannot satisfy it.
  const code = settingsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/import \{ buildLaneJobs \} from '\.\.\/shared\/ai-jobs\.js';/.test(code),
    'settings.js imports buildLaneJobs from shared/ai-jobs.js');
  ok(/typeof buildLaneJobs === 'function' \? buildLaneJobs\(\) : \[\]/.test(extractFunction(settingsSrc, 'renderBuildBlock')),
    'renderBuildBlock reads the registry through the typeof guard, and nowhere else');
  // No hand list of job names in the renderer: the only nouns it types are
  // the lede's spoken forms, keyed by the registry's ids.
  const rbb = extractFunction(settingsSrc, 'renderBuildBlock');
  ok(!/Compile to wiki|Domains ›|Settings › General|before · after/.test(rbb),
    'the renderer types no row of the table — labels, origins and costs all come from AI_JOBS');

  // THE STYLESHEET: tokens only, no tone on a description.
  const css = fs.readFileSync(path.join(ROOT, 'src/public/next/views/settings.css'), 'utf8');
  const usedCss = css.slice(css.indexOf('/* ── BLOCK 2 · "Used by'), css.indexOf('/* The System check’s run line'));
  ok(usedCss.length > 200 && /\.settings-usedby\s*\{/.test(usedCss), 'settings.css styles the Used by row');
  ok(!/--(success|attention|danger|warn|error)[a-z-]*/.test(usedCss) && !/#[0-9a-f]{3,6}\b|rgba?\(/i.test(usedCss),
    '…with no tone token and no colour literal');
}

console.log(`\n  ${'\u2500'.repeat(46)}`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\u274c Providers-page assertions FAILED');
  process.exit(1);
}
console.log('\u2705 Providers page: four blocks, every state, every degraded arm');
