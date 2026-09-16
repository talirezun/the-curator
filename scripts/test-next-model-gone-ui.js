#!/usr/bin/env node
/**
 * scripts/test-next-model-gone-ui.js — OFFLINE suite for the Providers & keys
 * RESTRUCTURE and the retired-build-model surfaces across three views.
 *
 * No network, no API key, no server, no browser. Every renderer is lifted out
 * of the shipping source by brace-matching and EXECUTED, and every assertion
 * below is made against RENDERED HTML sliced by a marker — never against the
 * presence of a line of source. That distinction is this repo's most expensive
 * recorded lesson (v3.0.17: a source-regex assertion gave positive assurance
 * for a measurement that was always wrong).
 *
 * ── WHAT THIS SUITE IS ABOUT ───────────────────────────────────────────────
 * The maintainer's verdict on Settings → Providers & keys was "so confusing
 * that I built the app and I don't understand it — a sea of information". Six
 * asks came out of it, and each one is a section here:
 *
 *   1. clear separation between the four blocks       → §7 (the CSS rhythm)
 *   2. explainer paragraphs behind the ⓘ pattern      → §1, §2
 *   3. refresh must be obvious per provider           → §3
 *   4. the five identical "Worth testing" bullets go  → §4
 *   5. rows that can build must be choosable there    → §5
 *   6. fewer words, naming provider and lane          → §2, §3
 *
 * Plus the wire contract the backend is growing in the same release:
 * `liveMissing`, three-valued, on `build` and `buildModel` — §8, §9, §10.
 *
 * ── THE DUMB CROSS-CHECK (§5) ──────────────────────────────────────────────
 * The per-provider catalogues were a SECOND copy of block 4's table: the same
 * rows, a second search box, a second sort. A clever assertion about "the
 * picker is gone" can be satisfied by renaming a class. So §5 instead counts
 * the MULTISET of rendered model ids inside block 4 and fails on any duplicate
 * — a measurement that is wrong in a different way from any structural check,
 * and one that reds the moment the duplicate list comes back under any name.
 * CONTRIBUTING.md's second lesson, applied.
 *
 * Run: node scripts/test-next-model-gone-ui.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStatus } from '../src/public/next/shared/text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const settingsSrc = read('src/public/next/views/settings.js');
const settingsCss = read('src/public/next/views/settings.css');
const chatSrc = read('src/public/next/views/chat.js');
const ingestSrc = read('src/public/next/views/ingest.js');

let passed = 0;
let failed = 0;
const failures = [];
function section(t) { console.log(`\n${t}`); }
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  \u2713 ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  \u2717 ${msg}`); }
}
// Identity, never `==`: the verdicts asserted below are `true | false | null`
// and a loose compare makes `null` and `false` the same assertion, which is the
// exact collapse those verdicts exist to prevent. The failure message carries
// BOTH values, because "expected null" with no "got" cannot be diagnosed.
function eq(actual, expected, msg) {
  const same = Object.is(actual, expected);
  ok(same, same ? msg : `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a70  Extraction — brace-matched, and it must END at a closing brace');
// ══════════════════════════════════════════════════════════════════════════
// A desync that silently keeps half a function is worse than a crash: every
// assertion about the half it kept still passes. The trailing-brace check makes
// it loud.
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
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
    throw new Error(`extractFunction: "${name}" does not end at a top-level closing brace`);
  }
  return extracted;
}
function extractConst(src, name, where) {
  const re = new RegExp(`(?:^|\\n)(?:export\\s+)?const ${name} =[\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found in ${where}`);
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

const SET_CONSTS = [
  'PROVIDER_ROWS', 'TX_INFO_GLYPH', 'MODEL_LANES', 'CHAT_LANE_COLLAPSE_AT',
  'MODEL_SORTS', 'MODEL_SORT_KEYS', 'MODEL_SORT_UNRANKED_LABEL', 'MODEL_SORT_OPTIONS',
  'MODEL_FILTER_MIN_ROWS', 'MEASUREMENT_CHIPS', 'ACTIVATION_SKIP_REASONS',
  'BUILD_PICK_ERROR_ID', 'QUALIFY_CONFIRM_ID', 'MEASURED_CALL_SECONDS',
  'ALL_MODELS_SCOPE', 'MODEL_LANE_FACETS', 'MODEL_PRICE_BANDS', 'BUILD_WORKING_SET_TOKENS',
  'CATALOGUE_SYNC_PROVIDERS',
];
const SET_FNS = [
  'infoMark', 'providerLabel', 'activeModelLine', 'providerHasSavedKey', 'providerConnected',
  'qualIndex', 'buildModelFacts', 'buildLaneFacts', 'buildModelDisplayName',
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
  'renderModelBrowse', 'renderWorthTesting',
  'renderModelListsGroup', 'renderModelListRow', 'renderModelCheckResult',
  'renderCatalogueSyncDetail', 'modelGoneFacts', 'renderModelGoneBanner',
  'settingsBlock', 'renderConnectBlock', 'renderAllModelsBlock',
  'renderBuildBlock', 'renderBuildCurrent', 'renderBuildList', 'renderChatBlock',
  'renderProviderRow', 'renderActivationNotice', 'renderProviders',
  'buildPickButtonId', 'classifyFallback',
];

const setState = {
  keys: null, keysError: null, keysActionError: null, keysActivationNotice: null,
  replacing: null, replaceValue: '', keysBusy: null, keyTestBusy: null, keyTest: {},
  modelPickerOpen: {}, modelRowOpen: {}, modelLaneOpen: {}, modelShelfOpen: false,
  buildListOpen: false, modelPickBusy: '', modelPickError: {}, modelPickErrorAt: '',
  catalogueSyncBusy: null, catalogueSync: {}, catalogueSyncError: {},
  modelCheckBusy: null, modelCheck: {}, modelCheckError: {}, worthTestingOpen: false,
  browseRowOpen: {},
  qualify: null, modelFilter: {},
};

const SET_INJECTED = {
  escapeHtml: escapeHtmlStub,
  formatUsdHonest: (v) => (typeof v === 'number' && Number.isFinite(v)
    ? '$' + (Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(2)) : null),
  formatModelSummary: (m) => (m && typeof m.note === 'string' ? m.note : ''),
  icon: (name, size) => `<svg data-icon="${name}" width="${size}"></svg>`,
  state: setState,
  crossWriteBusy: () => false,
  crossWriteTitle: (msg) => 'A write is running — ' + msg,
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

let S;
try {
  const names = Object.keys(SET_INJECTED);
  const body =
    SET_CONSTS.map((n) => extractConst(settingsSrc, n, 'settings.js')).join('\n') + '\n' +
    SET_FNS.map((n) => extractFunction(settingsSrc, n, 'settings.js')).join('\n') + '\n' +
    'return { ' + SET_CONSTS.concat(SET_FNS).join(', ') + ' };';
  S = new Function(...names, body)(...names.map((n) => SET_INJECTED[n]));
  ok(typeof S.renderProviders === 'function', 'settings.js renderers extracted and evaluated');
} catch (err) {
  ok(false, `settings.js extraction threw: ${err.message}`);
  process.exit(1);
}

// ── THE FIXTURE MATRIX ────────────────────────────────────────────────────
// Written to the ROUTE'S CONTRACT, not to whatever the backend happens to emit
// today, so this file is also the executable statement of what the view reads.
//
// `dear/expensive-15` is load-bearing and is named rather than left implicit:
// §6 asserts it is present in the DEFAULT render. Price is a displayed FACT and
// never a quality gate (v3.16.0, where a mutation ADDING a price ceiling redded
// 13 assertions), and the only way to keep that true is to put a model far above
// every band's midpoint in the fixture and demand it be drawn.
const GEM = [
  { id: 'gemini-2.5-flash-lite', label: 'Flash Lite 2.5', input: 0.10, output: 0.40,
    standardInput: 0.10, standardOutput: 0.40, suitability: 'general', jsonRaw: true,
    maxOutput: 65536, contextLength: null, note: 'plans 18-20 pages per source',
    measuredBy: 'curator', free: false, thinks: false },
  { id: 'gemini-3.5-flash-lite', label: 'Flash Lite 3.5', input: 0.10, output: 0.40,
    standardInput: 0.10, standardOutput: 0.40, suitability: 'chat-only', jsonRaw: false,
    maxOutput: 65536, contextLength: 1000000, note: 'unrepairable JSON in 2 of 9 ingest runs',
    cautionReason: 'unrepairable JSON in 2 of 9 ingest runs',
    measuredBy: 'curator', free: false, thinks: false },
];
const ANT = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', input: 1.00, output: 5.00,
    standardInput: 1.00, standardOutput: 5.00, suitability: 'general', jsonRaw: true,
    maxOutput: 64000, contextLength: 200000, note: 'plans 15 pages per source',
    measuredBy: 'curator', free: false, thinks: false },
];
const OR = [
  { id: 'upstage/solar-pro4', label: 'Solar Pro 4', input: 0.03, output: 0.12,
    standardInput: 0.03, standardOutput: 0.12, suitability: 'general', jsonRaw: true,
    maxOutput: 32768, contextLength: 131072, note: 'plans about 23 pages per source',
    measuredBy: 'curator', free: false, thinks: false },
  { id: 'vendor/unmeasured-big', label: 'Unmeasured Big', input: 0.02, output: 0.09,
    standardInput: 0.02, standardOutput: 0.09, suitability: 'chat-only', jsonRaw: null,
    maxOutput: 32768, contextLength: 262144, note: '', measuredBy: null,
    free: false, thinks: false },
  { id: 'vendor/free-one', label: 'Free One', input: null, output: null,
    standardInput: null, standardOutput: null, suitability: 'chat-only', jsonRaw: null,
    maxOutput: 32768, contextLength: 262144, note: '', measuredBy: null,
    free: true, thinks: false },
  // MEASURED BY US AND FOUND UNFIT, on a provider that CAN self-test. Added
  // after a mutation dropping the lane half of the Test control's gate came
  // back GREEN: the only measured-and-unfit row in the corpus was a GEMINI one,
  // and Gemini cannot self-test at all, so the provider half alone was enough
  // to satisfy every assertion. A fixture that cannot reach a branch is a
  // fixture that certifies it silently -- the v3.15.0 shape this suite's
  // siblings record.
  { id: 'vendor/measured-unfit', label: 'Measured Unfit', input: 0.05, output: 0.20,
    standardInput: 0.05, standardOutput: 0.20, suitability: 'chat-only', jsonRaw: false,
    maxOutput: 32768, contextLength: 262144, note: 'unrepairable JSON in 3 of 9 ingest runs',
    cautionReason: 'unrepairable JSON in 3 of 9 ingest runs',
    measuredBy: 'curator', free: false, thinks: false },
  { id: 'dear/expensive-15', label: 'Dear Fifteen', input: 15.00, output: 75.00,
    standardInput: 15.00, standardOutput: 75.00, suitability: 'chat-only', jsonRaw: null,
    maxOutput: 32768, contextLength: 400000, note: '', measuredBy: null,
    free: false, thinks: false },
];
const CATALOGUE = { gemini: GEM, anthropic: ANT, openrouter: OR };

function keysFor(connected, over) {
  const k = {
    hasGeminiKey: connected.includes('gemini'),
    hasAnthropicKey: connected.includes('anthropic'),
    hasOpenrouterKey: connected.includes('openrouter'),
    activeProvider: connected[0] || null,
    models: {}, selectedModels: {}, offerable: {},
    minRunsToQualify: 9,
    qualifications: [],
    catalogueCounts: null,
    openrouterCatalogue: connected.includes('openrouter')
      ? { loaded: true, stale: false, reason: null, count: 216, syncedAt: '2026-09-15T20:33:00.000Z' }
      : null,
  };
  for (const p of connected) {
    k.offerable[p] = CATALOGUE[p];
    k.models[p] = CATALOGUE[p][0].id;
  }
  const first = connected[0];
  k.build = first ? {
    model: CATALOGUE[first][0].id,
    provider: first,
    source: 'default',
    facts: {
      contextLength: CATALOGUE[first][0].contextLength,
      priceIn: CATALOGUE[first][0].input,
      priceOut: CATALOGUE[first][0].output,
      measured: 'curator',
      free: false,
      thinks: false,
      outlineNote: 'plans 18-20 pages per source',
    },
    cheapestMeasured: null,
  } : null;
  k.buildModel = first ? {
    provider: first, model: CATALOGUE[first][0].id, source: 'default',
    selectedHonoured: false, measuredBy: 'curator',
  } : null;
  k.chat = first ? { count: 3, startsOn: { provider: first, model: CATALOGUE[first][0].id } } : null;
  return Object.assign(k, over || {});
}

function renderWith(k, mutate) {
  setState.keys = k;
  setState.modelFilter = {};
  setState.modelShelfOpen = false;
  setState.worthTestingOpen = false;
  setState.qualify = null;
  setState.catalogueSync = {};
  setState.modelCheck = {};
  setState.modelCheckError = {};
  if (mutate) mutate(setState);
  return S.renderProviders();
}

// ── THE SLICER MEASURES CONTAINMENT, NOT ADJACENCY ────────────────────────
//
// FOUND BY A MUTATION THAT CAME BACK GREEN, and recorded rather than quietly
// fixed. The first version of this sliced from one block's opening tag to the
// NEXT block's opening tag — so a fold panel emitted immediately AFTER a
// block's closing `</div>` still landed inside that block's slice, and the
// mutation which moved every panel out of its block passed §1 unchanged. That
// is the v3.48.1 shape one screen over, where `includes('dm-proj-new-btn')` was
// green throughout the defect it was supposed to catch, and the fix there is
// the fix here: parse the element and assert DESCENDANT.
//
// The depth walk is deliberately dumb — it counts `<div` against `</div>` and
// nothing else. It cannot be fooled by the markup this page emits (no
// self-closing divs, no `<div` inside an attribute value), and being dumb is
// the point: it is wrong in a different way from any structural assertion built
// on top of it, so the two disagreeing is itself a signal.
const BLOCK_IDS = ['connect', 'build', 'chat', 'all'];
function sliceBlocks(html) {
  const out = {};
  for (const id of BLOCK_IDS) {
    const at = html.indexOf('<div class="settings-job-block settings-block settings-block-' + id + '"');
    if (at === -1) { out[id] = ''; continue; }
    let depth = 0;
    let i = at;
    let end = -1;
    while (i < html.length) {
      const open = html.indexOf('<div', i);
      const close = html.indexOf('</div>', i);
      if (close === -1) break;
      if (open !== -1 && open < close) { depth++; i = open + 4; continue; }
      depth--;
      i = close + 6;
      if (depth === 0) { end = i; break; }
    }
    out[id] = end === -1 ? html.slice(at) : html.slice(at, end);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a71  ONE \u24d8 FOLD PER BLOCK, AND ITS PANEL IS IN THE SAME BLOCK');
// ══════════════════════════════════════════════════════════════════════════
// The maintainer asked for the explainer paragraphs to go behind the ⓘ the
// Domains screen already uses. The property that makes a fold work is
// CONTAINMENT: shared/text.js's one delegated listener resolves the panel by
// id, so a panel emitted outside its block still toggles — and still opens
// under the wrong heading. Asserting containment is what catches that.
{
  const html = renderWith(keysFor(['gemini', 'anthropic', 'openrouter']));
  const blocks = sliceBlocks(html);
  // ── THE SLICER'S OWN CONTROLS ──────────────────────────────────────────
  // A containment assertion is only worth what the slicer is worth, so the
  // slicer is checked first and independently: every slice must CLOSE (end at
  // `</div>`), and the four must be DISJOINT. A slicer that ran to the end of
  // the document would satisfy every containment check below vacuously — which
  // is exactly the failure the first version of this file had.
  for (const id of BLOCK_IDS) {
    ok(blocks[id].endsWith('</div>'), `slicer CONTROL: block "${id}" closes at its own </div>`);
  }
  {
    const spans = BLOCK_IDS.map((id) => ({ id, at: html.indexOf(blocks[id]), len: blocks[id].length }));
    const overlap = spans.some((a) => spans.some((b) =>
      a.id !== b.id && b.at >= a.at && b.at < a.at + a.len));
    ok(!overlap, 'slicer CONTROL: the four block slices are disjoint');
    // The positive half: a slice must STOP at its own block. A run-on slicer
    // would swallow the next block and make every containment check below
    // pass for the wrong reason.
    for (const id of BLOCK_IDS) {
      const others = BLOCK_IDS.filter((x) => x !== id)
        .filter((x) => blocks[id].includes('settings-block-' + x + '"'));
      ok(others.length === 0,
        `slicer CONTROL: block "${id}" does not swallow another block (${others.join(', ') || 'none'})`);
    }
  }
  for (const id of BLOCK_IDS) {
    const b = blocks[id];
    ok(b !== '', `block "${id}" is rendered`);
    const btns = b.match(new RegExp('data-tx-info="settings-block-info-' + id + '"', 'g')) || [];
    ok(btns.length === 1,
      `block "${id}" carries exactly ONE lede fold (found ${btns.length})`);
    ok(b.includes('<div class="tx-vh-panel" id="settings-block-info-' + id + '"'),
      `\u2026and its PANEL is inside the same block \u2014 a fold that opens under another heading is not a fold`);
    ok(/id="settings-block-info-[a-z]+" role="group"[^>]*hidden/.test(b),
      `\u2026rendered hidden on first paint, so nothing opens itself`);
  }
  // The DUMB half: every fold panel anywhere on the page belongs to some block
  // slice. A panel that escaped its block would still match the per-block
  // checks above if a second one were emitted, so this counts the whole page.
  const allPanels = (html.match(/<div class="tx-vh-panel" id="([^"]+)"/g) || []).length;
  const inBlocks = BLOCK_IDS
    .reduce((n, id) => n + (blocks[id].match(/<div class="tx-vh-panel" id="([^"]+)"/g) || []).length, 0);
  ok(allPanels === inBlocks && allPanels >= 4,
    `every \u24d8 panel on the page sits inside a block slice (${inBlocks} of ${allPanels})`);
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a72  THE VISIBLE LEDE IS ONE SENTENCE — 20 WORDS OR FEWER');
// ══════════════════════════════════════════════════════════════════════════
// Four ledes totalling ~130 words was the "sea of information". The cap is on
// what is VISIBLE: the folded remainder is not deleted and is not counted.
//
// Words are counted as tokens CONTAINING A LETTER OR DIGIT, so an em dash or a
// middot is not a word. That is the deliberately dumb rule — it cannot be
// gamed by punctuation, and it is wrong in a different way from any clever
// tokenizer.
function visibleWords(blockHtml) {
  const m = blockHtml.match(/<p class="settings-job-lede settings-block-lede">([\s\S]*?)<\/p>/);
  if (!m) return null;
  const text = m[1]
    .replace(/<button[\s\S]*?<\/button>/g, ' ')   // the ⓘ control is not prose
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ');
  return text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
}
{
  const html = renderWith(keysFor(['gemini', 'openrouter']));
  const blocks = sliceBlocks(html);
  for (const id of BLOCK_IDS) {
    const w = visibleWords(blocks[id]);
    ok(Array.isArray(w) && w.length > 0, `block "${id}" still has a visible lede`);
    ok(w && w.length <= 20,
      `block "${id}" lede is ${w ? w.length : '?'} visible words (\u2264 20)`);
  }
  // CONTROL: the folded text is NOT empty — a lede trimmed by DELETING its
  // explanation would pass the cap above and lose the explanation, which is the
  // opposite of what was asked for.
  for (const id of BLOCK_IDS) {
    const m = blocks[id].match(/<div class="tx-vh-panel" id="settings-block-info-[a-z]+" role="group" aria-label="[^"]*" hidden>([\s\S]*?)<\/div>/);
    const folded = m ? m[1].replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean) : [];
    ok(folded.length >= 8,
      `block "${id}" FOLDED the explanation rather than deleting it (${folded.length} words behind the \u24d8)`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a73  ONE MODEL-LIST CONTROL PER PROVIDER, AND IT NAMES THE PROVIDER');
// ══════════════════════════════════════════════════════════════════════════
// "Refresh must be obvious per provider." Two controls — `Refresh catalogue` in
// block 4's footer and `Refresh model list` on the OpenRouter card — carried
// the SAME hook and posted to the SAME route under two names. One action under
// two names is worse than two actions.
{
  const html = renderWith(keysFor(['gemini', 'anthropic', 'openrouter']));
  const blocks = sliceBlocks(html);
  const all = blocks.all;

  const rows = all.match(/data-model-list="([a-z]+)"/g) || [];
  ok(rows.length === 3, `one Model lists row per connected provider (found ${rows.length})`);

  const controls = (all.match(/data-sync-catalogue="[a-z]+"/g) || [])
    .concat(all.match(/data-check-models="[a-z]+"/g) || []);
  ok(controls.length === 3,
    `exactly one refresh-or-check control per connected provider (found ${controls.length})`);
  ok((all.match(/data-sync-catalogue=/g) || []).length === 1,
    'and exactly ONE of them is a catalogue refresh \u2014 the footer copy is gone');

  for (const [pid, name] of [['gemini', 'Gemini'], ['anthropic', 'Anthropic'], ['openrouter', 'OpenRouter']]) {
    const i = all.indexOf('data-model-list="' + pid + '"');
    const j = all.indexOf('</div>', all.indexOf('cur-group-control', i));
    const row = all.slice(i, j === -1 ? i + 2000 : j + 6);
    ok(new RegExp('Refresh ' + name + ' model list|Check ' + name + ' model availability').test(row),
      `the ${name} control NAMES the provider, so "which list?" is answered by the button`);
  }

  // THE STATUS AND THE BUTTON ARE ONE ROW. A freshness claim only means
  // something beside the thing that refreshes it.
  const iOr = all.indexOf('data-model-list="openrouter"');
  const orRow = all.slice(iOr, all.indexOf('data-model-list="openrouter"') + 900);
  ok(/Last refreshed/.test(orRow) && /data-sync-catalogue="openrouter"/.test(orRow),
    'the refresh row carries BOTH the control and its "Last refreshed" line');
  ok(/216 loaded/.test(orRow), '\u2026and how many models that refresh actually loaded');

  // The busy label is PINNED and must stay byte-identical.
  const busy = renderWith(keysFor(['openrouter']), (st) => { st.catalogueSyncBusy = 'openrouter'; });
  ok(busy.includes('>Refreshing\u2026</button>'),
    'the busy label is still exactly "Refreshing\u2026"');
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a74  "WORTH TESTING" IS A CLOSED DISCLOSURE WITH A TABLE');
// ══════════════════════════════════════════════════════════════════════════
// Five <li>s of 33 words, 29 of them identical across every row. The shared
// clause is now ONE rule line; the per-row cell says only what DIFFERS.
{
  const html = renderWith(keysFor(['openrouter', 'gemini']));
  const all = sliceBlocks(html).all;
  const i = all.indexOf('<details class="browse-worth"');
  ok(i !== -1, 'the shortlist is a <details>');
  const worth = all.slice(i, all.indexOf('</details>', i) + 10);

  ok(!/^<details class="browse-worth" data-worth-testing="1" open/.test(worth),
    'CLOSED by default \u2014 it invites spending time and money, so it is not a warning');
  ok(/<summary class="browse-worth-summary">[\s\S]*?Worth testing for this job/.test(worth),
    'the summary carries the verbatim phrase "Worth testing for this job"');
  ok(/browse-worth-count">\d+</.test(worth),
    '\u2026and a COUNT, so the fold cannot hide that there is something here');
  ok(/<table class="browse-table browse-worth-table">/.test(worth),
    'the body is a TABLE \u2014 the comparison this list exists for needs columns');
  ok((worth.match(/data-qualify-model="/g) || []).length >= 1,
    'and at least one row carries the Test control that makes it actionable');
  ok(!/<ul>/.test(worth), 'the five-bullet list is gone');
  ok((worth.match(/browse-worth-rule/g) || []).length === 1,
    'the clause every bullet repeated is stated ONCE, as a rule line');
  ok(/never a ranking/.test(worth),
    '\u2026and the rule line says it is a filter, never a ranking (v3.16.1\u2019s refusal)');

  // ORDER IS THE CATALOGUE'S OWN. A shortlist that sorted would be the ranking
  // v3.16.1 measured to be unsupportable.
  const ids = [...worth.matchAll(/data-worth-model="([^"]+)"/g)].map((m) => m[1]);
  const delivered = S.allCatalogueRows(setState.keys).map((r) => r.m.id).filter((id) => ids.includes(id));
  ok(JSON.stringify(ids) === JSON.stringify(delivered),
    'the rows are in the catalogue\u2019s DELIVERED order \u2014 no sort is applied');

  // THE EMPTY ARM IS RENDERED, NOT OMITTED. Both sentences verbatim.
  const bare = renderWith(keysFor(['anthropic']));
  const bAll = sliceBlocks(bare).all;
  ok(bAll.includes('Nothing on your synced list stands out on facts alone for this job'),
    'with no candidate the shortlist SAYS SO \u2014 it is not omitted');
  ok(bAll.includes('Every model stays reachable in the list above'),
    '\u2026and says nothing has been hidden');
  ok(bAll.includes('<details class="browse-worth"'),
    '\u2026in the same disclosure, so the surface does not change shape between states');
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a75  THE DUMB CROSS-CHECK — no model is drawn twice in block 4');
// ══════════════════════════════════════════════════════════════════════════
// The per-provider catalogues were a second copy of block 4's table. A
// structural assertion ("no .model-picker") can be satisfied by renaming a
// class; counting the MULTISET of rendered ids cannot. It is wrong in a
// different way from every other check here, which is the only property a
// cross-check needs (CONTRIBUTING.md, "Writing a good test", lesson 2).
{
  const html = renderWith(keysFor(['gemini', 'anthropic', 'openrouter']));
  const blocks = sliceBlocks(html);
  const idsIn = (h) => [...h.matchAll(/data-model-id="([^"]*)"/g)].map((m) => m[1]);

  const inAll = idsIn(blocks.all);
  const dupes = inAll.filter((id, i) => inAll.indexOf(id) !== i);
  ok(dupes.length === 0,
    `block 4 draws each model exactly once (duplicates: ${dupes.join(', ') || 'none'})`);

  const inBuild = idsIn(blocks.build);
  const bDupes = inBuild.filter((id, i) => inBuild.indexOf(id) !== i);
  ok(bDupes.length === 0,
    `block 2 draws each candidate exactly once (duplicates: ${bDupes.join(', ') || 'none'})`);

  // CONTROL: the check is not vacuous — there ARE rows, and a build-lane model
  // legitimately appears in both blocks, which is the one repetition the ask
  // allows ("no duplicate OUTSIDE block 2's candidates").
  ok(inAll.length >= 7, `CONTROL: block 4 drew ${inAll.length} rows, so the scan has a subject`);
  ok(inBuild.some((id) => inAll.includes(id)),
    'CONTROL: a build-lane model appears in BOTH blocks \u2014 the allowed repetition');

  // ── `can build — choose above` IS UNREACHABLE ──────────────────────────
  // That sentence was a row's only "control": it said the control was
  // elsewhere. The maintainer's fifth ask was that rows which can build be
  // choosable where they are shown. Driven across the whole matrix rather than
  // one fixture, because the branch was reachable only on a per-provider list
  // and a single render could miss it by accident.
  const COMBOS = [[], ['gemini'], ['openrouter'], ['gemini', 'anthropic'],
    ['gemini', 'openrouter'], ['gemini', 'anthropic', 'openrouter']];
  let reachable = [];
  for (const combo of COMBOS) {
    for (const shelfOpen of [false, true]) {
      for (const qual of [null, [{ modelId: 'vendor/unmeasured-big', domain: 'articles',
        outcome: 'NO_DEFECT_FOUND', qualifies: true, runsCompleted: 9, stillOffered: true,
        counts: { raw: 9, repaired: 0, unrepairable: 0, unusable: 0 },
        pages: {}, latencyMs: {}, measuredAt: '2026-09-10T10:00:00.000Z' }]]) {
        const k = keysFor(combo, { qualifications: qual || [] });
        const out = renderWith(k, (st) => { st.modelShelfOpen = shelfOpen; });
        if (out.includes('choose above')) {
          reachable.push(combo.join('+') + '/shelf=' + shelfOpen + '/qual=' + (qual ? 'y' : 'n'));
        }
      }
    }
  }
  ok(reachable.length === 0,
    `"can build \u2014 choose above" is unreachable across ${COMBOS.length * 4} states (reached in: ${reachable.join(', ') || 'none'})`);
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a76  PRICE IS A DISPLAYED FACT, NEVER A GATE');
// ══════════════════════════════════════════════════════════════════════════
// v3.16.0's rule, and the release that set it redded 13 assertions with a
// mutation that ADDED a price ceiling. The restructure must not reintroduce one
// by the back door — e.g. by defaulting the price facet to anything but "any".
{
  const html = renderWith(keysFor(['openrouter']));
  const all = sliceBlocks(html).all;
  ok(all.includes('data-model-id="dear/expensive-15"'),
    'a $15.00/1M model is drawn in the DEFAULT render \u2014 price removes no row');
  ok(/\$15\.00/.test(all), '\u2026with its price stated rather than hidden');

  const f = S.modelFilterFor(S.ALL_MODELS_SCOPE);
  ok(f.band === 'any', `the price facet defaults to "any" (got "${f.band}")`);
  ok(f.lane === 'all', `the lane facet defaults to "all" (got "${f.lane}")`);
  ok(S.MODEL_PRICE_BANDS[0][0] === 'any',
    'and "Any price" is the first band, so the default is also the first thing offered');

  // The footer rule that says so, VISIBLE and unfolded.
  ok(all.includes('Nothing here is hidden from chat. A model only leaves the ' +
    'build lane by failing a measurement, never by price.'),
    'the footer states the rule verbatim');
  const panels = [...all.matchAll(/<div class="tx-vh-panel"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  ok(!panels.some((p) => p.includes('never by price')),
    '\u2026and it is NOT inside a fold \u2014 a rule behind a click is not a rule');
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a77  THE FREE-MODEL CAUTION IS NEVER FOLDED, AND THE RHYTHM IS ONE RULE');
// ══════════════════════════════════════════════════════════════════════════
{
  // The free caution lives on the per-provider list's `freeNote`, which the
  // restructure removed from the page. It is asserted through the renderer that
  // still owns it, so the claim is about the shipping text and not about a
  // surface that no longer exists — and §7b records where it must land next.
  const note = S.renderModelPicker(
    S.PROVIDER_ROWS.find((p) => p.id === 'openrouter'),
    keysFor(['openrouter']), true, false);
  ok(note.includes('open question'),
    'CONTROL: the free-routing caution is still produced by the renderer that owns it');
  const panels = [...note.matchAll(/<div class="tx-vh-panel"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  ok(!panels.some((p) => /open question/.test(p)),
    'the free-model caution is a descendant of NO fold panel');

  // ── THE BLOCK RHYTHM IS ONE DECLARATION ──────────────────────────────
  // v3.50.0's finding on Domains, one screen over: four gaps from four
  // unrelated declarations, one of them zero. Asserted on the STYLESHEET
  // because a computed gap needs a browser — and stated as such rather than
  // dressed up as behaviour.
  const rule = /\.settings-job-block \+ \.settings-job-block\s*\{\s*margin-top:\s*var\(--space-12\)\s*;?\s*\}/;
  ok(rule.test(settingsCss),
    'SOURCE GUARD: one adjacent-sibling rule gives every block break the same gap');
  ok(/\.settings-job-block \{[\s\S]*?padding-top: var\(--space-12\);[\s\S]*?\}/.test(settingsCss),
    'SOURCE GUARD: \u2026and the matching padding above the rule, so the gap reads 24 | hairline | 24');
  // Run against DECLARATIONS, never raw text: the rule that removed this pull
  // explains itself in a comment that QUOTES it, and a check reading its own
  // subject's comment is this repo's named "a guard that stopped reaching the
  // thing it protects" shape. Found here on the first run, by this assertion
  // going red for exactly that reason.
  const cssCode = settingsCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const syncRule = (cssCode.match(/\.catalogue-sync \{[\s\S]*?\}/) || [''])[0];
  ok(syncRule !== '', 'CONTROL: the .catalogue-sync rule is still in the stylesheet to inspect');
  ok(!/margin-top:\s*-4px/.test(syncRule),
    'the hand-tuned -4px pull is gone from .catalogue-sync \u2014 spacing has one owner');
  ok(/margin-top: -4px/.test(settingsCss),
    'CONTROL: the stripper removed a COMMENT that quotes it, so the check above reads code, not prose');
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a78  THE MODEL-GONE BANNER — three values, and only one renders');
// ══════════════════════════════════════════════════════════════════════════
// `liveMissing` is `true | false | null`. An UNKNOWN must not read as GONE:
// sending a user to change a working model because a list endpoint could not be
// reached is a worse outcome than saying nothing, and it is the fact-versus-
// its-absence collapse this repo has shipped before (v3.16.0).
{
  const mk = (v) => {
    const k = keysFor(['gemini', 'openrouter']);
    if (v !== undefined) { k.build.liveMissing = v; k.buildModel.liveMissing = v; }
    return k;
  };
  const gone = sliceBlocks(renderWith(mk(true))).build;
  ok(gone.includes('provider-gone-banner'), 'liveMissing === true renders the banner');
  ok(/is no longer offered by <strong>?Gemini|no longer\s+offered by Gemini/.test(gone.replace(/<[^>]+>/g, (t) => t)) ||
     /is no\s*longer offered by Gemini/.test(gone.replace(/<\/?strong>/g, '')),
    '\u2026naming the provider that stopped offering it');
  ok(gone.includes('data-model-gone-pick="gemini"'),
    '\u2026with a button that carries the provider it is about');

  ok(!sliceBlocks(renderWith(mk(false))).build.includes('provider-gone-banner'),
    'liveMissing === false renders NOTHING \u2014 there is nothing to say');
  ok(!sliceBlocks(renderWith(mk(null))).build.includes('provider-gone-banner'),
    'liveMissing === null renders NOTHING \u2014 unknown must never read as gone');
  ok(!sliceBlocks(renderWith(mk(undefined))).build.includes('provider-gone-banner'),
    'an ABSENT field renders nothing either \u2014 an older backend is not an alarm');

  // THE BUTTON TARGETS BLOCK 2. Asserted by containment, not by proximity: the
  // banner is inside the block-2 wrapper and block 2 is what holds the list the
  // button opens.
  const html = renderWith(mk(true));
  const blocks = sliceBlocks(html);
  ok(blocks.build.includes('data-model-gone-pick='),
    'the banner is INSIDE block 2 \u2014 a banner between two blocks belongs to neither');
  ok(!blocks.connect.includes('provider-gone-banner') && !blocks.all.includes('provider-gone-banner'),
    '\u2026and nowhere else');
  ok(blocks.build.indexOf('provider-gone-banner') < blocks.build.indexOf('settings-block-hd'),
    '\u2026above the heading, so it is read before the block it is about');
  ok(blocks.build.includes('id="settings-build-list"'),
    'block 2 carries the addressable list the button opens');

  // NEVER A FOLD. Same rule as the fallback banner one screen up: a change to
  // what you are billed is not something you should have to click to discover.
  ok(!/provider-gone-banner[\s\S]{0,400}<details/.test(blocks.build),
    'the banner is not a <details> and carries no disclosure');

  // THE PURE VERDICT, driven directly.
  ok(S.modelGoneFacts(mk(true)) !== null, 'modelGoneFacts reports the true case');
  ok(S.modelGoneFacts(mk(false)) === null, '\u2026and refuses the false case');
  ok(S.modelGoneFacts(mk(null)) === null, '\u2026and the unknown case');
  ok(S.modelGoneFacts(null) === null, '\u2026and a missing payload entirely');
}

// ══════════════════════════════════════════════════════════════════════════
section('§8b  THE BANNER’S SUB-LINE STATES WHAT THE APP DOES, NOT WHAT IT USED TO');
// ══════════════════════════════════════════════════════════════════════════
// v3.53.0 shipped the pre-spend gate and, in the same release, a banner saying
// "The Curator falls back rather than failing, and a fallback is not always
// cheaper." `POST /api/ingest` and the batch queue REFUSE on a positive
// `missing` verdict before the first paid call (src/routes/ingest.js,
// src/brain/ingest-queue.js), so the sentence told a user a run would quietly
// continue on something else when it will not start at all.
//
// Pinned on BOTH sides. The presence check alone would stay green under a
// rewrite that added the truth and kept the falsehood; the absence check alone
// would stay green under a rewrite that deleted the sentence entirely.
{
  const k = keysFor(['gemini', 'openrouter']);
  k.build.liveMissing = true;
  k.buildModel.liveMissing = true;
  const banner = sliceBlocks(renderWith(k)).build;
  const sub = banner.slice(banner.indexOf('provider-gone-sub'),
    banner.indexOf('provider-gone-action'));
  const text = sub.replace(/<[^>]+>/g, '');

  ok(/refuse/i.test(text),
    '★★ the sub-line says ingest REFUSES [mutation: restoring "The Curator falls back rather than failing" reds this]');
  ok(!/falls?\s+back/i.test(text),
    '★★ …and no longer claims a fallback [mutation: the old sentence contains "falls back" and reds here]');
  ok(/batch queue/i.test(text),
    '…and names the OTHER surface that refuses, because a user mid-batch is the one who most needs to know');
  ok(/re-pinned|not changed|stays your/i.test(text),
    '…and states that nothing is re-pinned — docs/model-lifecycle.md §"Why there is no automatic re-pin"');
  // ── THE CLAIM IT DELIBERATELY DOES NOT MAKE ───────────────────────────
  // "chat, Compile and Health scans FAIL until you pick another" is true of a
  // free head and of every OpenRouter refusal, and FALSE of a paid Gemini or
  // Anthropic id that 404s: that is `model-retired`, and `callLLM` still walks
  // FALLBACK_CHAINS for it, deliberately and documented. Replacing one
  // over-claim with another would be the same defect wearing the opposite sign.
  ok(!/\bfail\b/i.test(text),
    '★ …and does NOT claim chat/Compile/Health will fail: a PAID Gemini or Anthropic 404 still walks FALLBACK_CHAINS, so that is not true on every path');
  ok(/no such gate|carry no|carries no/i.test(text),
    '…it states the thing that IS true of all three — there is no pre-spend gate on them');
  ok(banner.indexOf('provider-gone-sub') > -1 && !/provider-gone-sub[\s\S]{0,300}<details/.test(banner),
    'CONTROL: the sub-line is still unfolded');
}

// ══════════════════════════════════════════════════════════════════════════
section('§8c  ONE MODEL, ONE STORY — the picker and the table stop contradicting the banner');
// ══════════════════════════════════════════════════════════════════════════
// THE RENDERED DEFECT, on the isolated server with `minimax/minimax-m3:free`
// seeded as the build model: the banner said the model was no longer offered,
// block 2's sentence below it said "that is MiniMax M3 (free) — the one you are
// already using", block 2's picker showed it as "free — this model bills
// nothing", and block 4's table row read "Building your wiki" with no hint at
// all. Four surfaces, one model, two incompatible stories.
{
  const GONE_ID = 'upstage/solar-pro4';   // a build-lane, curator-measured OR row
  const LIVE_ID = 'gemini-2.5-flash-lite';

  // `liveMissingByModel` is the route's per-model map. Written to the CONTRACT,
  // three-valued, exactly as the wire carries it.
  const withMap = (map, over) => {
    const k = keysFor(['gemini', 'openrouter'], over);
    k.liveMissingByModel = map;
    return k;
  };
  const goneMap = { gemini: {}, anthropic: {}, openrouter: { [GONE_ID]: true } };
  const nullMap = { gemini: {}, anthropic: {}, openrouter: { [GONE_ID]: null } };
  const falseMap = { gemini: {}, anthropic: {}, openrouter: { [GONE_ID]: false } };

  // ── THE PURE VERDICT, THREE VALUES AND EVERY DEGRADATION ───────────────
  eq(S.modelLiveMissing(withMap(goneMap), 'openrouter', GONE_ID), true, 'modelLiveMissing reads a true verdict');
  eq(S.modelLiveMissing(withMap(falseMap), 'openrouter', GONE_ID), false, '…and a false one');
  eq(S.modelLiveMissing(withMap(nullMap), 'openrouter', GONE_ID), null, '…and a null one');
  eq(S.modelLiveMissing(withMap(goneMap), 'openrouter', 'not/in-the-map'), null,
    'an id the map does not carry is NULL, never false — we were told nothing about it');
  eq(S.modelLiveMissing(withMap(goneMap), 'anthropic', GONE_ID), null,
    'a provider with an empty map is NULL for every id — a disconnected provider is not a clean bill of health');
  eq(S.modelLiveMissing(keysFor(['gemini']), 'openrouter', GONE_ID), null,
    '★ an older backend that sends no map at all is NULL — the degradation is silence, not a warning');
  eq(S.modelLiveMissing(null, 'openrouter', GONE_ID), null, '…and so is no payload');
  eq(S.modelLiveMissing(withMap({ openrouter: { [GONE_ID]: 'yes' } }), 'openrouter', GONE_ID), null,
    '★ a WIRE ANOMALY is null too — a `!= null` read would have made a stray string an alarm');

  // ── BLOCK 2, THE PICKER ROW ────────────────────────────────────────────
  const openList = (st) => { st.buildListOpen = true; st.modelShelfOpen = true; };
  const goneHtml = renderWith(withMap(goneMap), openList);
  const nullHtml = renderWith(withMap(nullMap), openList);
  const gb = sliceBlocks(goneHtml);
  const nb = sliceBlocks(nullHtml);

  // The row, sliced by its own addressable id, so a chip drawn on some OTHER
  // row cannot satisfy this. Containment, not adjacency — §5's lesson.
  const liRow = (html, id) => {
    const at = html.indexOf('data-model-id="' + id + '"');
    if (at === -1) return '';
    const start = html.lastIndexOf('<li', at);
    const end = html.indexOf('</li>', at);
    return (start === -1 || end === -1) ? '' : html.slice(start, end);
  };

  const goneRow = liRow(gb.build, GONE_ID);
  ok(goneRow, 'fixture: the withdrawn model is still DRAWN in the block-2 picker — hiding it would remove the warning with the row');
  ok(goneRow.includes('model-badge-gone'),
    '★★ …carrying the withdrawn chip [mutation: dropping the badges.push reds this]');
  ok(/no longer offered by OpenRouter/.test(goneRow),
    '★ …which NAMES the provider, so it does not read as a Curator decision');
  ok(!/model-badge-gone[\s\S]{0,200}<details/.test(goneRow) && goneRow.indexOf('model-badge-gone') < goneRow.indexOf('model-row-body'),
    '…and sits in the row’s summary, never behind the fold — a warning you must click to find is not a warning');

  const nullRow = liRow(nb.build, GONE_ID);
  ok(nullRow, 'CONTROL: the same row is drawn on a NULL verdict');
  ok(!nullRow.includes('model-badge-gone'),
    '★★ …with NO chip [mutation: rendering on a null verdict reds this — unknown must never read as gone]');
  ok(nullRow.includes('data-build-model="' + GONE_ID + '"'),
    '…and its pick control intact');

  // THE CONTROL IS WITHHELD, AND ITS REASON IS VISIBLE TEXT, NOT A TOOLTIP.
  ok(!goneRow.includes('data-build-model="' + GONE_ID + '"'),
    '★★ the withdrawn row offers NO "Use this" write [mutation: reverting the arm restores data-build-model and reds this]');
  ok(/not available to pick/.test(goneRow.replace(/<[^>]+>/g, '')),
    '★ …and says so in RENDERED TEXT, because a tooltip does not exist on touch');

  // A LIVE ROW IN THE SAME LIST IS UNTOUCHED — the anti-vacuity control.
  const liveRow = liRow(gb.build, LIVE_ID);
  ok(liveRow && !liveRow.includes('model-badge-gone'),
    'CONTROL: a listed model in the SAME render carries no chip — the chip is per row, not per page');
  ok(liveRow.includes('data-build-model="' + LIVE_ID + '"') || liveRow.includes('model-pick-state'),
    'CONTROL: …and keeps whatever control it had');

  // ── BLOCK 4, THE "EVERY MODEL" TABLE ───────────────────────────────────
  const trRow = (html, id) => {
    const at = html.indexOf('data-model-id="' + id + '"');
    if (at === -1) return '';
    const start = html.lastIndexOf('<tr', at);
    const end = html.indexOf('</tr>', at);
    return (start === -1 || end === -1) ? '' : html.slice(start, end);
  };

  const goneTr = trRow(gb.all, GONE_ID);
  ok(goneTr, 'fixture: the withdrawn model has a row in block 4’s table');
  ok(goneTr.includes('model-badge-gone'),
    '★★ …and it carries the SAME chip [mutation: dropping the chip from the name cell reds this]');
  ok(!trRow(nb.all, GONE_ID).includes('model-badge-gone'),
    '★★ …and renders nothing on a NULL verdict [mutation: rendering on null reds this]');
  ok(!goneTr.includes('>Use for building<'),
    '★ the table’s "Use for building" control is withheld on a withdrawn row');
  ok(/not available to pick/.test(goneTr.replace(/<[^>]+>/g, '')),
    '…replaced by the reason, in text');
  ok(trRow(nb.all, GONE_ID).includes('>Use for building<'),
    'CONTROL: the null-verdict row still offers it — so the withholding above is not vacuous');

  // ── THE ROW THAT IS ACTUALLY RUNNING ───────────────────────────────────
  // The lane cell states WHAT IS IN FORCE. On a withdrawn id it must state both
  // halves: still pinned (nothing is re-pinned for you) AND gone.
  {
    const kInUse = withMap({ gemini: {}, anthropic: {},
      openrouter: { 'upstage/solar-pro4': true } },
      { activeProvider: 'openrouter' });
    kInUse.build = { model: 'upstage/solar-pro4', provider: 'openrouter', source: 'default',
      facts: { measured: 'curator', free: false, thinks: false, outlineNote: '' },
      cheapestMeasured: null, liveMissing: true };
    kInUse.buildModel = { provider: 'openrouter', model: 'upstage/solar-pro4',
      source: 'default', selectedHonoured: false, measuredBy: 'curator', liveMissing: true };
    const inUseTr = trRow(sliceBlocks(renderWith(kInUse, openList)).all, 'upstage/solar-pro4');
    const t = inUseTr.replace(/<[^>]+>/g, '');
    ok(/Building your wiki/.test(t),
      'the in-use row still says it is building your wiki — because it is, and nothing was re-pinned');
    ok(/Building your wiki — no longer offered/.test(t),
      '★★ …and says it is gone in the SAME cell [mutation: reverting to the plain label reds this]');
    ok(inUseTr.includes('model-badge-gone'), '…with the chip on its name cell as well');

    // CONTROL: the same row on a null verdict reads the plain label.
    const kLive = withMap({ gemini: {}, anthropic: {}, openrouter: { 'upstage/solar-pro4': null } },
      { activeProvider: 'openrouter' });
    kLive.build = Object.assign({}, kInUse.build, { liveMissing: null });
    kLive.buildModel = Object.assign({}, kInUse.buildModel, { liveMissing: null });
    const liveTr = trRow(sliceBlocks(renderWith(kLive, openList)).all, 'upstage/solar-pro4')
      .replace(/<[^>]+>/g, '');
    ok(/Building your wiki/.test(liveTr) && !/no longer offered/.test(liveTr),
      'CONTROL: on a null verdict the cell reads the plain label — the suffix is earned, not always-on');
  }

  // ── BLOCK 2’S CHEAPEST-MEASURED SENTENCE ────────────────────────────
  // The route now excludes a withdrawn candidate, so this cannot arrive from a
  // current backend. The guard is for an OLDER one — which is exactly the
  // install most likely to be sitting on a retired id.
  {
    const kStale = withMap(goneMap, { activeProvider: 'openrouter' });
    kStale.build = { model: GONE_ID, provider: 'openrouter', source: 'default',
      facts: { measured: 'curator', free: true, thinks: false, outlineNote: '' },
      liveMissing: true,
      cheapestMeasured: { model: GONE_ID, provider: 'openrouter', priceIn: null,
        priceOut: null, free: true, same: true } };
    kStale.buildModel = { provider: 'openrouter', model: GONE_ID, source: 'default',
      selectedHonoured: false, measuredBy: 'curator', liveMissing: true };
    const blk = sliceBlocks(renderWith(kStale, openList)).build;
    ok(blk.includes('provider-gone-banner'), 'fixture: the banner is up');
    ok(!/the one you are already using/.test(blk.replace(/<[^>]+>/g, '')),
      '★★ the block-2 sentence does NOT say "the one you are already using" about a withdrawn model [mutation: reverting the cheapestIsGone guard reds this]');
    ok(!/build-cheapest/.test(blk),
      '…the whole cheapest-measured line is withheld rather than reworded — there is nothing cheapest about a model that cannot answer');

    // CONTROL: the SAME payload with the verdict unknown renders the sentence,
    // so the suppression above is earned by the verdict and not by the shape.
    const kOk = withMap(nullMap, { activeProvider: 'openrouter' });
    kOk.build = Object.assign({}, kStale.build, { liveMissing: null });
    kOk.buildModel = Object.assign({}, kStale.buildModel, { liveMissing: null });
    const blkOk = sliceBlocks(renderWith(kOk, openList)).build;
    ok(/the one you are already using/.test(blkOk.replace(/<[^>]+>/g, '')),
      'CONTROL: on an unknown verdict the sentence renders exactly as before — nothing else changed');
  }

  // ── THE DUMB CROSS-CHECK ───────────────────────────────────────────────
  // A chip count taken a different way from every structural assertion above:
  // exactly ONE model id in the whole render is marked gone, and it is the one
  // the map named. Wrong in a different way from the row slicing, so the two
  // disagreeing is itself a signal (CONTRIBUTING.md's second lesson).
  {
    const marked = new Set();
    for (const seg of goneHtml.split('model-badge-gone').slice(1)) {
      const back = goneHtml.slice(0, goneHtml.indexOf(seg));
      const idAt = back.lastIndexOf('data-model-id="');
      if (idAt !== -1) marked.add(back.slice(idAt + 15, back.indexOf('"', idAt + 15)));
    }
    ok(marked.size === 1 && marked.has(GONE_ID),
      '★ exactly ONE model id in the entire render carries the chip, and it is the one the map named (saw: ' +
      [...marked].join(', ') + ')');
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a79  THE COMPOSER NOTICE — chat.js, driven across the matrix');
// ══════════════════════════════════════════════════════════════════════════
{
  const chatState = {
    sending: false, chatModel: null, buildModelId: '', buildLiveMissing: null,
    responseStyle: 'balanced',
  };
  const chatNames = ['escapeHtml', 'icon', 'state'];
  const chatBody =
    extractFunction(chatSrc, 'composerPrimaryButtonHtml', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'renderComposerHtml', 'chat.js') + '\n' +
    'return { renderComposerHtml };';
  const C = new Function(...chatNames, chatBody)(
    escapeHtmlStub,
    (name, size) => `<svg data-icon="${name}" width="${size}"></svg>`,
    chatState);

  const draw = (over) => {
    Object.assign(chatState, { chatModel: null, buildModelId: '', buildLiveMissing: null }, over);
    return C.renderComposerHtml({ slug: 'articles', displayName: 'Articles' });
  };

  ok(draw({ buildModelId: 'x/y', buildLiveMissing: true }).includes('chat-composer-notice'),
    'nothing picked + liveMissing true \u2192 the notice renders');
  ok(draw({ buildModelId: 'x/y', buildLiveMissing: true, chatModel: 'x/y' }).includes('chat-composer-notice'),
    'the SAME model picked \u2192 the notice renders');
  ok(!draw({ buildModelId: 'x/y', buildLiveMissing: true, chatModel: 'other/model' }).includes('chat-composer-notice'),
    'a DIFFERENT model picked \u2192 nothing, because the wire carries a verdict about one id only');
  ok(!draw({ buildModelId: 'x/y', buildLiveMissing: false }).includes('chat-composer-notice'),
    'liveMissing false \u2192 nothing');
  ok(!draw({ buildModelId: 'x/y', buildLiveMissing: null }).includes('chat-composer-notice'),
    'liveMissing null \u2192 nothing \u2014 unknown is not gone');
  ok(!draw({ buildModelId: '', buildLiveMissing: true }).includes('chat-composer-notice'),
    'a verdict with no model id names nothing, so it claims nothing');

  const live = draw({ buildModelId: 'z-ai/glm-5.3', buildLiveMissing: true });
  ok(live.includes('z-ai/glm-5.3'), 'the notice NAMES the model');
  ok(live.includes('id="chat-model-gone-settings"'), '\u2026and carries the one-click route to Settings');
  ok(live.indexOf('chat-composer-notice') < live.indexOf('id="chat-composer"'),
    '\u2026above the field, so it is read on the way to Send');
  ok(!/<details/.test(live), '\u2026and is not a fold');
  // CONTROL: the composer still renders normally underneath it.
  ok(live.includes('id="chat-input"'), 'CONTROL: the composer itself is unaffected');
}

// ══════════════════════════════════════════════════════════════════════════
section('\u00a710  MODEL_GONE IN INGEST — headed and actionable, not the red wall');
// ══════════════════════════════════════════════════════════════════════════
{
  const I = new Function('escapeHtml', 'icon', 'renderStatus',
    extractFunction(ingestSrc, 'renderIngestFailure', 'ingest.js') + '\n' +
    'return { renderIngestFailure };')(
    escapeHtmlStub,
    (name, size) => `<svg data-icon="${name}" width="${size}"></svg>`,
    renderStatus);

  const goneHtml = I.renderIngestFailure('claude-haiku-4-5 is no longer offered by Anthropic.', 'MODEL_GONE');
  ok(goneHtml.includes('The build model is gone'),
    'MODEL_GONE renders a HEADED block naming what happened');
  ok(goneHtml.includes('id="ing-model-gone-settings"'),
    '\u2026with a button to Settings \u2192 Providers & keys');
  ok(goneHtml.includes('claude-haiku-4-5 is no longer offered by Anthropic.'),
    '\u2026carrying the server\u2019s own sentence, unchanged');
  ok(/retrying will fail the same way/.test(goneHtml),
    '\u2026and saying why retrying is not the answer');
  ok(!/Ingest failed/.test(goneHtml),
    'the GENERIC red wall does not render for this code');
  ok(goneHtml.includes('data-ingest-error-code="MODEL_GONE"'),
    'the block is addressable by the code that produced it');

  const generic = I.renderIngestFailure('The provider returned 503.', null);
  ok(/Ingest failed/.test(generic),
    'CONTROL: an uncoded failure still renders the generic danger block');
  ok(!generic.includes('The build model is gone'),
    '\u2026and never borrows the MODEL_GONE heading');
  const other = I.renderIngestFailure('Something else.', 'SOME_OTHER_CODE');
  ok(/Ingest failed/.test(other) && !other.includes('The build model is gone'),
    'an UNKNOWN code falls through to the generic block \u2014 dispatch is on the code, never on the text');
  ok(I.renderIngestFailure('', 'MODEL_GONE') === '',
    'no message \u2192 no block at all');

  // THE CODE HAS TO SURVIVE THE THROW. Asserted as a SOURCE guard and labelled
  // as one: the stream consumer is 100 lines of fetch plumbing and lifting it
  // would prove less than saying plainly what is being relied on.
  ok(/e\.curatorCode = ev\.code/.test(ingestSrc),
    'SOURCE GUARD: the SSE frame\u2019s code is carried on the Error rather than thrown away');
  ok(/state\.errorCode = \(err && typeof err\.curatorCode === 'string'\)/.test(ingestSrc),
    'SOURCE GUARD: \u2026and read back in the catch, where both are still in scope');
  ok(/item\.errorCode === 'MODEL_GONE'/.test(ingestSrc),
    'SOURCE GUARD: the batch row dispatches on the same code, never on the message text');
}

// ══════════════════════════════════════════════════════════════════════════
section('§11  THE PROBE PANEL — "Run 0 of 9" was the screenshot');
// ══════════════════════════════════════════════════════════════════════════
// The maintainer pressed Test on my wiki and watched a panel reading **Run 0 of
// 9** for minutes. The `start` frame has carried `{modelId, domain, runs,
// promptChars}` since the feature shipped and the client discarded it, so the
// headline counted runs that had FINISHED — which is zero until the first one
// settles, and the slowest measured call is 382 s.
{
  const panel = (q) => S.renderQualifyPanel(q, 9);

  // THE DECISIVE ONE: a `start` frame alone, ZERO `run` frames.
  const waiting = panel({
    modelId: 'vendor/unmeasured-big', phase: 'running', runs: [],
    total: 9, startedAt: Date.now() - 42000,
    estimate: { runs: 9, domain: 'articles' },
  });
  ok(/Run 1 of 9/.test(waiting),
    'a start frame alone says "Run 1 of 9" — the run IN FLIGHT, not the runs completed');
  ok(!/Run 0 of 9/.test(waiting),
    '…and never "Run 0 of 9", which is what the screenshot showed');
  ok(/waiting for the model/.test(waiting),
    '…and says what it is waiting for, because there is no ETA to project from yet');
  ok(/so far/.test(waiting),
    '…with an elapsed clock, the same answer v3.16.1 gave to the identical complaint in chat');

  // The count comes from the START frame, not from the estimate, when they
  // disagree: what is running is the truth.
  const disagree = panel({
    modelId: 'a/b', phase: 'running', runs: [], total: 5, startedAt: Date.now(),
    estimate: { runs: 9, domain: 'articles' },
  });
  ok(/Run 1 of 5/.test(disagree),
    'the start frame’s own run count wins over the estimate the user was quoted');

  // The clamp: on the last frame `done === total`, and "Run 3 of 2" would be a
  // new wrong number in place of the old one.
  const last = panel({
    modelId: 'a/b', phase: 'running', total: 2, startedAt: Date.now(),
    runs: [{ run: 1, of: 2, outcome: 'COMPLETED', usable: true, parseClass: 'raw', pageCount: 20 },
      { run: 2, of: 2, outcome: 'COMPLETED', usable: true, parseClass: 'raw', pageCount: 21 }],
    estimate: { runs: 2 },
  });
  ok(/Run 2 of 2/.test(last) && !/Run 3 of 2/.test(last),
    'the run in flight is clamped to the total — never "Run 3 of 2"');

  // -- THE OFF-BY-ONE THE CLAMP TEST COULD NOT SEE -----------------------
  // FOUND BY A MUTATION THAT CAME BACK GREEN. Replacing `done + 1` with `done`
  // left every assertion above passing: the zero-run arm hardcodes "Run 1 of
  // N", and the clamp fixture has done === total, where the two expressions
  // agree by construction. So the ONE shape that separates them -- one run
  // settled, eight still to come -- was never rendered. It is the screenshot's
  // own bug one step in: a panel saying "Run 1 of 9" while run 2 is in flight.
  const midway = panel({
    modelId: 'a/b', phase: 'running', total: 9, startedAt: Date.now(),
    runs: [{ run: 1, of: 9, outcome: 'COMPLETED', usable: true, parseClass: 'raw',
      pageCount: 22, etaMs: 320000 }],
    estimate: { runs: 9 },
  });
  ok(/Run 2 of 9/.test(midway),
    'with ONE run settled the panel names run 2 — the one in flight, not the one that finished');
  ok(!/Run 1 of 9/.test(midway),
    '…and does not still say "Run 1 of 9", which is the screenshot’s bug one step in');
  ok(/about 5 min left/.test(midway),
    '…and the projection replaces the clock the moment there is evidence to project from');

  // The per-call ceiling, when the server sends it.
  const ceiling = panel({
    modelId: 'a/b', phase: 'running', runs: [], total: 9,
    startedAt: Date.now(), callTimeoutMs: 600000, estimate: { runs: 9 },
  });
  ok(/gives up after 10 min/.test(ceiling),
    'the per-call ceiling bounds the wait, which a projection cannot do before run 1');
  ok(!/gives up after/.test(waiting),
    '…and is omitted entirely when the server did not send one — never guessed');

  // ── A RUN THAT FAILED NAMES WHAT THE PROVIDER SAID ─────────────────────
  const failed = panel({
    modelId: 'a/b', phase: 'running', total: 9, startedAt: Date.now(),
    runs: [{ run: 1, of: 9, outcome: 'FAILED', errorClass: 'RATE_LIMITED',
      errorMessage: 'Provider returned 429: rate limit exceeded' }],
    estimate: { runs: 9 },
  });
  ok(/Run 1 of 9 failed: Provider returned 429: rate limit exceeded/.test(failed),
    'a run frame carrying errorMessage renders the message — not just "FAILED"');
  ok(/data-qualify-pick-another/.test(failed),
    '…with the route to a model that is already measured');
  const noMsg = panel({
    modelId: 'a/b', phase: 'running', total: 9, startedAt: Date.now(),
    runs: [{ run: 1, of: 9, outcome: 'FAILED', errorClass: 'RATE_LIMITED' }],
    estimate: { runs: 9 },
  });
  ok(!/failed:/.test(noMsg),
    'CONTROL: a frame with NO errorMessage invents none');
  ok(/FAILED/.test(noMsg), '…and the outcome code IS rendered, so the check above is not vacuous');

  // ── A `done` FRAME WITH AN ABORT CLASS ─────────────────────────────────
  const stoppedBurn = panel({
    modelId: 'a/b', phase: 'stopped', aborted: 'ABORTED_REASONING_BURN', stoppedAfter: 3,
    runs: [1, 2, 3], total: 9,
  });
  ok(/Stopped after run 3/.test(stoppedBurn), 'an aborted run says WHERE it stopped');
  ok(/hidden reasoning/.test(stoppedBurn), '…and WHY, in plain words');
  ok(!/Run \d+ of 9…/.test(stoppedBurn),
    '…and the running state is cleared — the panel does not sit on "Run N of 9" for ever');

  const stoppedRate = panel({
    modelId: 'a/b', phase: 'stopped', aborted: 'NOT_MEASURED_RATE_LIMITED', stoppedAfter: 2,
    runs: [1, 2], total: 9,
  });
  ok(/Nothing was recorded against the model/.test(stoppedRate),
    'a RATE LIMIT is a fact about the queue, so nothing is recorded against the model');
  ok(!/Nothing was recorded against the model/.test(stoppedBurn),
    '…and a reasoning burn does NOT borrow that sentence: it IS an observation about the model ' +
    'and it IS stored — the brief said otherwise for all three classes, and the record contradicts it');
  const stoppedUnknown = panel({
    modelId: 'a/b', phase: 'stopped', aborted: 'SOMETHING_NEW', stoppedAfter: 4, runs: [], total: 9,
  });
  ok(/Stopped after run 4/.test(stoppedUnknown) && !/because/.test(stoppedUnknown),
    'an UNRECOGNISED abort class states the fact and invents no reason for it');

  ok(panel({ phase: 'running', runs: [], total: 9, startedAt: Date.now() }).includes('qualify-stop'),
    'Stop is unchanged and still on the running panel');
}

// ══════════════════════════════════════════════════════════════════════════
section('§12  THE PROBE LIVES IN THE TABLE NOW');
// ══════════════════════════════════════════════════════════════════════════
{
  const k = keysFor(['openrouter', 'gemini']);
  const all = sliceBlocks(renderWith(k)).all;

  // The Test control is on the row that states the refusal, because that is the
  // row that has to offer the way past it.
  const i = all.indexOf('data-model-id="vendor/unmeasured-big"');
  const row = all.slice(i, all.indexOf('</tr>', i) + 5);
  ok(/not measured yet/.test(row), 'an unmeasured row still states the refusal');
  ok(/data-qualify-model="vendor\/unmeasured-big"/.test(row),
    '…and carries the Test control in the same Build-lane cell');

  // NOT offered where the server would refuse it: a model WE measured and found
  // unfit is a dead end by design, and a control whose only outcome is a
  // refusal is worse than no control.
  const j = all.indexOf('data-model-id="gemini-3.5-flash-lite"');
  const measuredChatOnly = all.slice(j, all.indexOf('</tr>', j) + 5);
  ok(/chat only — measured/.test(measuredChatOnly),
    'CONTROL: a measured chat-only row is present and says so');
  ok(!/data-qualify-model/.test(measuredChatOnly),
    '…and is NOT offered a self-test, because the server would refuse it');

  // -- AND THE SAME, ON A PROVIDER THAT *CAN* SELF-TEST -------------------
  // The row above proves the PROVIDER half of the gate (Gemini cannot
  // self-test at all). This one proves the LANE half, which nothing reached
  // until a mutation dropping it came back green: an OpenRouter model WE
  // measured and found unfit is a dead end BY DESIGN -- `POST
  // /api-keys/model` refuses a chat-only id -- so offering it a Test button
  // would be offering a control whose only outcome is a refusal.
  const u = all.indexOf('data-model-id="vendor/measured-unfit"');
  ok(u !== -1, 'CONTROL: a measured-and-unfit OpenRouter row is in the table');
  const unfitRow = all.slice(u, all.indexOf('</tr>', u) + 5);
  ok(/chat only — measured/.test(unfitRow), '…and says we measured it');
  ok(!/data-qualify-model/.test(unfitRow),
    '…and gets NO Test control, although its provider can self-test — the LANE half of the gate');

  // The evidence expands UNDER the row rather than replacing the page.
  ok(/data-browse-detail="upstage\/solar-pro4"/.test(all),
    'a row with measured evidence carries an expander');
  const opened = sliceBlocks(renderWith(k, (st) => {
    st.browseRowOpen = { 'upstage/solar-pro4': true };
  })).all;
  ok(/<tr class="browse-detail" data-browse-detail-row="upstage\/solar-pro4">/.test(opened),
    '…and opening it emits a detail ROW, not a panel somewhere else');
  ok(/plans about 23 pages per source/.test(opened),
    '…carrying the measured note that used to live on the per-provider list');
  ok(!/plans about 23 pages per source/.test(all),
    'CONTROL: the note is genuinely folded when the row is closed');

  // The live panel renders inside the row being measured, and the row is FORCED
  // open — a press re-renders, and a confirm inside a collapsed row is the
  // v3.8.0 shape where a click appears to do nothing.
  const probing = sliceBlocks(renderWith(k, (st) => {
    st.qualify = { modelId: 'vendor/unmeasured-big', phase: 'running', runs: [], total: 9,
      startedAt: Date.now(), estimate: { runs: 9 } };
  })).all;
  ok(/<tr class="browse-detail" data-browse-detail-row="vendor\/unmeasured-big">/.test(probing),
    'the row being measured is FORCED open, without the user having expanded it');
  ok(/Run 1 of 9/.test(probing), '…and the live panel is inside it');
  ok(!/browse-qualify-host/.test(probing),
    '…and the block-level host does NOT also render — two panels would be two #qualify-confirm ids');

  // The one gap the row cannot cover: the model being measured has been
  // filtered out of the table.
  const filtered = sliceBlocks(renderWith(k, (st) => {
    st.qualify = { modelId: 'vendor/unmeasured-big', phase: 'running', runs: [], total: 9,
      startedAt: Date.now(), estimate: { runs: 9 } };
    st.modelFilter = { [S.ALL_MODELS_SCOPE]: { q: 'solar' } };
  })).all;
  ok(!/data-model-id="vendor\/unmeasured-big"/.test(filtered),
    'CONTROL: the filter really did remove the row being measured');
  ok(/browse-qualify-host/.test(filtered),
    '…so the block-level host renders instead — a live stream never loses its panel');
  ok(/filters above have removed/.test(filtered),
    '…and says why it is there rather than in the table');
}


// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'\u2500'.repeat(60)}`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  \u2717 ${f}`);
  console.log('\u274c model-gone / providers-restructure assertions FAILED');
  process.exit(1);
}
console.log('\u2705 Providers & keys restructure + the retired-model surfaces');
