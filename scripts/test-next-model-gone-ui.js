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
console.log(`\n${'\u2500'.repeat(60)}`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  \u2717 ${f}`);
  console.log('\u274c model-gone / providers-restructure assertions FAILED');
  process.exit(1);
}
console.log('\u2705 Providers & keys restructure + the retired-model surfaces');
