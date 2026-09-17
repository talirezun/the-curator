#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test-next-settings-render-cost.js — what a Settings render is allowed to
 *  cost, and what it is allowed to do to the page.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── THE COMPLAINT, AND THE MEASUREMENT THAT CORRECTED ITS DIAGNOSIS ────────
 *
 * The maintainer reported (v3.56.0, production): switching between the five
 * Settings sections "comes with delay — especially Providers & keys". The
 * obvious suspect was the render: `renderProviders` builds the whole OpenRouter
 * catalogue table on every one of ~40 render call sites, ~220 rows, and the
 * markup is emitted whether or not the shelf is open.
 *
 * MEASURED IN A REAL BROWSER against an isolated install with three saved keys
 * and a 197-entry catalogue (1440x900, Chrome, median of three):
 *
 *     WARM Providers render   251,020 bytes of HTML · 3,479 DOM nodes
 *                             build 1.8 ms · parse 4.1 ms · wire 3.8 ms
 *                             → 9.7 ms of script, painted inside one frame
 *     COLD Providers click    empty body at t+0.5 ms
 *                             delay-gated loader at t+203 ms
 *                             the real section at t+283 ms
 *                             two MORE full 251 KB repaints, last at t+622 ms
 *
 * So the table was never the delay. `GET /api/config/api-keys` is **277 ms**
 * (181 KB, composed from 198 offers) where the other three section endpoints
 * are 2.9-4.9 ms. The delay was ONE FETCH, plus three renders of one section.
 *
 * ── WHAT THIS SUITE PINS, THEREFORE ────────────────────────────────────────
 *
 *   §1  THE PREFETCH. Entering Settings warms every other section's data in
 *       idle time, once each, under the mount token, without the loading gate.
 *   §2  ONE REQUEST PER ENDPOINT. The click path and the prefetch join one
 *       in-flight load instead of firing two — including the two sections that
 *       share `loadConfig`.
 *   §3  AN UNCHANGED RENDER TOUCHES NOTHING. Byte-identical HTML is not
 *       written, and — the part that is a correctness property rather than a
 *       performance one — the listeners are NOT re-attached, because
 *       `wireGlobalListeners` calls `addEventListener` on whatever is in the
 *       document and the nodes would be the ones it wired last time.
 *   §4  THE TWO SURFACES PAINT AS ONE. If either half changed, both are
 *       written, for the same double-binding reason.
 *   §5  THE CATALOGUE TABLE IS STILL EMITTED WITH THE SHELF CLOSED. The
 *       v3.9.x invariant: a confirm inside a collapsed disclosure is no
 *       confirm, and render()'s capture/restore can only restore what was
 *       emitted. A future "optimisation" that windows or omits the rows trips
 *       this.
 *   §6  THE CLOCK DOES NOT RE-RENDER. The 1 s qualify tick writes one node's
 *       textContent; the sentence it writes is byte-identical to the one the
 *       renderer paints.
 *   §7  THE SECTION-CHANGE REVEAL IS ONE-SHOT. `content-reveal` on a section
 *       change, never on an in-section repaint.
 *
 * ── EXECUTED, NOT SCANNED ──────────────────────────────────────────────────
 * Every guard that can be driven is driven: the real functions are lifted out
 * of views/settings.js with a brace-matched extractor (never a lazy
 * `[\s\S]*?\n\}`, which stops at the first column-0 brace INSIDE a function and
 * truncates silently — the v3.54.0 note) and executed against injected
 * dependencies. The two source scans that remain (§6's "no render() in the
 * tick") each carry a POSITIVE CONTROL asserting the scan can see a call at
 * all, because a scan that finds nothing and a scan that is looking in the
 * wrong place are indistinguishable from a green tick.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stripComments, functionSource } from './test-helpers/source-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SETTINGS_JS = path.join(ROOT, 'src/public/next/views/settings.js');
const src = readFileSync(SETTINGS_JS, 'utf8');
const code = stripComments(src);

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  [32m✓[0m ' + msg); }
  else { failed++; console.log('  [31m✗[0m ' + msg); }
}
function section(t) { console.log('\n[1m' + t + '[0m'); }

// The stripper must not have eaten the things under test — a scan over a
// gutted string passes every assertion below vacuously.
for (const needle of ['function prefetchOtherSections(', 'function startSectionLoad(',
  'function renderMain(', 'function renderSidebar(', 'data-qualify-clock']) {
  if (!code.includes(needle)) throw new Error(`stripComments over-reached: "${needle}" is gone`);
}

// ── Extraction: brace-matched, loud on desync ─────────────────────────────
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`extractFunction: "${name}" not found in views/settings.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start);
  let parenDepth = 0;
  for (; p < source.length; p++) {
    if (source[p] === '(') parenDepth++;
    else if (source[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = source.indexOf('{', p);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = source.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" did not end at a top-level brace — the matcher desynced`);
  }
  return extracted;
}

/** Build a sandbox holding one or more real functions plus named deps. */
function build(names, deps, ...fns) {
  const keys = Object.keys(deps);
  const body = fns.map((n) => extractFunction(src, n)).join('\n') +
    `\nreturn {${names.join(', ')}};`;
  return new Function(...keys, body)(...keys.map((k) => deps[k]));
}

const escapeHtml = (x) => String(x === undefined || x === null ? '' : x)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  The prefetch warms every OTHER section, once, in idle time');
// ═══════════════════════════════════════════════════════════════════════════
//
// EXECUTED against the real `prefetchOtherSections` + the real
// `startSectionLoad` + the real `sectionLoaderFor`, with fake loaders and a
// fake idle scheduler. Injecting the loaders (rather than stubbing
// startSectionLoad) is what makes this a test of the QUEUE: a prefetch that
// fired every loader in one burst, or skipped one, or ran the section the user
// is already looking at, fails here.

const SECTIONS_FIXTURE = [
  ['general', 'General', 'hint'],
  ['providers', 'Providers & keys', 'hint'],
  ['storage', 'Knowledge base', 'hint'],
  ['mcp', 'MCP bridge', 'hint'],
  ['health', 'Health & scan limits', 'hint'],
];

function prefetchHarness({ section: current = 'general', tokenOk = () => true } = {}) {
  const calls = [];
  const state = { section: current, keys: null, mcp: null, aiHealth: null, config: null };
  const mark = (name, field) => (token) => {
    calls.push({ name, token });
    state[field] = { loaded: true };
    return Promise.resolve();
  };
  let idleQueue = [];
  const deps = {
    state,
    SETTINGS_SECTIONS: SECTIONS_FIXTURE,
    isCurrentMount: tokenOk,
    sectionLoads: new Map(),
    loadKeys: mark('loadKeys', 'keys'),
    loadMcp: mark('loadMcp', 'mcp'),
    loadAiHealth: mark('loadAiHealth', 'aiHealth'),
    loadConfig: mark('loadConfig', 'config'),
    // The fake scheduler. A REAL requestIdleCallback is deliberately absent
    // from the sandbox, so the fallback arm would throw rather than silently
    // making this a setTimeout test; both arms are covered by driving this
    // binding, which both arms call.
    requestIdleCallback: (fn) => { idleQueue.push(fn); },
    setTimeout: (fn) => { idleQueue.push(fn); },
  };
  const S = build(['prefetchOtherSections', 'startSectionLoad', 'sectionLoaderFor'],
    deps, 'prefetchOtherSections', 'startSectionLoad', 'sectionLoaderFor');
  // ── DRAINING, AND WHY IT IS NOT A `while (queue.length)` ─────────────────
  // Each idle callback starts ONE load and only queues the next from that
  // load's `.then`, which lands several microtask turns later (the loader's
  // promise, the `.finally` that clears the in-flight map, then the `.then`).
  // A loop that stopped as soon as the queue was momentarily empty therefore
  // reported ONE load and passed a "fires three" assertion by measuring the
  // harness rather than the code — the first draft of this file did exactly
  // that. So: a fixed number of microtask turns, running whatever has been
  // queued each time.
  const runSlot = () => { const q = idleQueue; idleQueue = []; for (const fn of q) fn(); };
  const drain = async () => {
    for (let i = 0; i < 80; i++) {
      await Promise.resolve();
      if (idleQueue.length) runSlot();
    }
  };
  const settle = async (turns = 8) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };
  return { S, calls, state, drain, settle, runSlot, deps };
}

{
  const h = prefetchHarness({ section: 'general' });
  // General's own data is already loaded by ensureSectionData on entry —
  // model that, so the prefetch is measured on the sections it OWNS.
  h.state.config = { loaded: true };
  h.S.prefetchOtherSections(7);
  await h.drain();
  const names = h.calls.map((c) => c.name).sort();
  ok(h.calls.length === 3,
    `the prefetch fires exactly three loads from the General landing (got ${h.calls.length}: ${names.join(', ')})`);
  ok(JSON.stringify(names) === JSON.stringify(['loadAiHealth', 'loadKeys', 'loadMcp']),
    'and they are the three the landing section did NOT already warm — storage shares loadConfig with general');
  ok(h.calls.every((c) => c.token === 7), 'every load is passed the mount token it was started under');
}

{
  // THE MOUNT GUARD. A prefetch queue that kept walking after the user left
  // Settings would fetch under a dead token and — worse — keep a stale mount's
  // promises in the shared map.
  const h = prefetchHarness({ section: 'general', tokenOk: () => false });
  h.S.prefetchOtherSections(7);
  await h.drain();
  ok(h.calls.length === 0, 'a prefetch started on a mount that has since been left fires NO load at all');
}

{
  // ONE AT A TIME, AND NEVER SYNCHRONOUSLY. A queue that fired all four loads
  // in one go would put a burst against a single-threaded local server at the
  // exact moment the user is trying to interact with the section in front of
  // them — and firing the first one synchronously would put it in the same
  // task as the entry render.
  const h = prefetchHarness({ section: 'general' });
  h.state.config = { loaded: true };
  h.S.prefetchOtherSections(7);
  ok(h.calls.length === 0, 'nothing is fetched synchronously — the first load waits for an idle slot');
  h.runSlot();
  ok(h.calls.length === 1, 'the first idle slot starts exactly ONE load, not a burst of three');
  await h.settle();
  h.runSlot();
  ok(h.calls.length === 2, 'and the next only enters the queue once that one has settled');
  await h.drain();
  ok(h.calls.length === 3, 'CONTROL: draining the rest really does run them (otherwise the lines above pass vacuously)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  One request per endpoint — the click path joins the prefetch');
// ═══════════════════════════════════════════════════════════════════════════
{
  let fired = 0;
  let resolveIt;
  const pending = new Promise((r) => { resolveIt = r; });
  const state = { section: 'general', keys: null, mcp: null, aiHealth: null, config: null };
  const deps = {
    state,
    SETTINGS_SECTIONS: SECTIONS_FIXTURE,
    isCurrentMount: () => true,
    sectionLoads: new Map(),
    loadKeys: () => { fired++; return pending; },
    loadMcp: () => Promise.resolve(),
    loadAiHealth: () => Promise.resolve(),
    loadConfig: () => { fired++; return Promise.resolve(); },
    requestIdleCallback: (fn) => fn(),
    setTimeout: (fn) => fn(),
  };
  const S = build(['startSectionLoad', 'sectionLoaderFor'], deps, 'startSectionLoad', 'sectionLoaderFor');
  const a = S.startSectionLoad('providers', 1);
  const b = S.startSectionLoad('providers', 1);
  ok(fired === 1, `two overlapping loads of one section fire ONE request (fired ${fired})`);
  ok(a === b, 'and the second caller is handed the SAME promise, so it settles with the first');
  resolveIt();
  await a;

  // The two sections that share an endpoint share the in-flight entry too.
  fired = 0;
  const S2 = build(['startSectionLoad', 'sectionLoaderFor'],
    Object.assign({}, deps, { sectionLoads: new Map(), state: { section: 'general', keys: null, mcp: null, aiHealth: null, config: null } }),
    'startSectionLoad', 'sectionLoaderFor');
  const g = S2.startSectionLoad('general', 1);
  const st = S2.startSectionLoad('storage', 1);
  ok(fired === 1, `general and storage share GET /api/config and therefore share ONE request (fired ${fired})`);
  ok(g === st, 'joined by LOADER identity, not by section name');
}
{
  // …and a section whose data is already in state asks for nothing.
  const deps = {
    state: { section: 'general', keys: { x: 1 }, mcp: { x: 1 }, aiHealth: { x: 1 }, config: { x: 1 } },
    SETTINGS_SECTIONS: SECTIONS_FIXTURE,
    isCurrentMount: () => true,
    sectionLoads: new Map(),
    loadKeys: () => { throw new Error('must not be called'); },
    loadMcp: () => { throw new Error('must not be called'); },
    loadAiHealth: () => { throw new Error('must not be called'); },
    loadConfig: () => { throw new Error('must not be called'); },
    requestIdleCallback: (fn) => fn(),
    setTimeout: (fn) => fn(),
  };
  const S = build(['startSectionLoad', 'sectionLoaderFor'], deps, 'startSectionLoad', 'sectionLoaderFor');
  let threw = false;
  let all = null;
  try { all = SECTIONS_FIXTURE.map(([id]) => S.startSectionLoad(id, 1)); } catch { threw = true; }
  ok(!threw && all.every((x) => x === null),
    'a fully warmed Settings asks for nothing — every section returns null, no loader runs');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  An unchanged render writes nothing and re-wires nothing');
// ═══════════════════════════════════════════════════════════════════════════
//
// The performance half is the 251 KB it does not re-parse. The CORRECTNESS
// half is the re-wire it does not perform: `wireGlobalListeners` attaches
// listeners to whatever is in the document, so calling it over nodes it
// already wired makes every handler fire twice. That is the assertion that
// matters if anyone ever "simplifies" the early return away.

function mainHarness(initialState) {
  const written = [];
  const state = initialState;
  const dom = {
    get(id) { return id === 'settings-view-body' ? this._body : null; },
    _body: { classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } } },
  };
  const deps = {
    state,
    pendingListboxes: [],
    SECTION_TITLES: { general: 'General', providers: 'Providers & keys', mcp: 'MCP bridge', health: 'Health', storage: 'Knowledge base' },
    SECTION_INFO: {},
    renderViewHeader: (o) => '<header>' + escapeHtml(o.title) + '</header>',
    renderGeneral: () => '<div class="g">' + escapeHtml(String(state.probe || '')) + '</div>',
    renderProviders: () => '<div class="p"></div>',
    renderMcp: () => '<div class="m"></div>',
    renderHealthLimits: () => '<div class="h"></div>',
    renderStorage: () => '<div class="s"></div>',
    setMain: (html) => { written.push(html); },
    lastMainHtml: null,
    document: { getElementById: (id) => dom.get(id) },
  };
  const S = build(['renderMain'], deps, 'renderMain');
  return { S, written, state, body: dom._body };
}

{
  const h = mainHarness({ section: 'general', probe: 'a', sectionJustChanged: false });
  const first = h.S.renderMain(1);
  const second = h.S.renderMain(1);
  ok(first === true && h.written.length === 1, 'the first render writes the main column');
  ok(second === false && h.written.length === 1,
    'a second render with identical inputs writes NOTHING and reports it (false)');
  h.state.probe = 'b';
  const third = h.S.renderMain(1);
  ok(third === true && h.written.length === 2,
    'a CHANGED input writes exactly once more — the skip is a comparison, not a latch');
  const forced = h.S.renderMain(1, true);
  ok(forced === true && h.written.length === 3,
    'and `force` writes even when the HTML is unchanged (render() uses it to keep both surfaces in step)');
}

{
  // The sidebar half, same property.
  const written = [];
  const deps = {
    state: { section: 'general', version: null },
    SETTINGS_SECTIONS: SECTIONS_FIXTURE,
    escapeHtml,
    setSidebar: (html) => { written.push(html); },
    lastSidebarHtml: null,
  };
  const S = build(['renderSidebar'], deps, 'renderSidebar');
  ok(S.renderSidebar(1) === true && written.length === 1, 'the sidebar paints on first render');
  ok(S.renderSidebar(1) === false && written.length === 1, 'and skips an identical repaint');
  deps.state.version = { version: '9.9.9' };
  ok(S.renderSidebar(1) === true && written.length === 2, 'the version arriving repaints it');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  render(): both surfaces paint together, or neither, and the wire follows');
// ═══════════════════════════════════════════════════════════════════════════
//
// The REAL render(), executed with spies — the same technique
// test-next-settings-scroll-and-scale.js §3 uses, and this suite's reason for
// needing it is the same: it drives the chokepoint all ~40 call sites reach.
function renderHarness(sidebarResult, mainResult) {
  const calls = [];
  const deps = {
    preserveMainScroll: (f) => { calls.push('preserve:in'); f(); calls.push('preserve:out'); },
    renderSidebar: (t, force) => { calls.push('sidebar' + (force === true ? ':forced' : '')); return sidebarResult.shift(); },
    renderMain: (t, force) => { calls.push('main' + (force === true ? ':forced' : '')); return mainResult.shift(); },
    wireGlobalListeners: () => { calls.push('wire'); },
  };
  const S = build(['render'], deps, 'render');
  S.render('tok');
  return calls;
}
{
  const both = renderHarness([true], [true]);
  ok(both.join(',') === 'preserve:in,sidebar,main:forced,wire,preserve:out',
    'when the sidebar paints, main is written with it and the pair is re-wired once, all inside preserveMainScroll');

  const neither = renderHarness([false], [false]);
  ok(neither.join(',') === 'preserve:in,sidebar,main,preserve:out',
    'when NEITHER painted, wireGlobalListeners is not called — the nodes are the ones it already wired');
  ok(!neither.includes('wire'),
    'stated as its own assertion because this is the double-binding guard, not a performance one');

  const onlyMain = renderHarness([false, true], [true]);
  ok(onlyMain.join(',') === 'preserve:in,sidebar,main,sidebar:forced,wire,preserve:out',
    'when only main painted, the sidebar is FORCED to repaint before the wire — half-fresh nodes would double-bind the other half');

  const onlySidebar = renderHarness([true], [false]);
  ok(onlySidebar.includes('wire'), 'when only the sidebar changed, the wire still runs…');
  ok(onlySidebar.join(',') === 'preserve:in,sidebar,main:forced,wire,preserve:out',
    '…and main was forced by the sidebar having painted, so both halves are fresh');

  // CONTROL: the spies return undefined in the sandbox other suites build.
  // `!== false` must therefore read as "painted", or those suites crash on a
  // change to this file rather than failing an assertion.
  const undef = renderHarness([undefined], [undefined]);
  ok(undef.join(',') === 'preserve:in,sidebar,main:forced,wire,preserve:out',
    'CONTROL: a spy returning undefined counts as PAINTED — only an explicit false skips');
  ok(undef.includes('wire'),
    'CONTROL, stated separately: the sandbox scripts/test-next-settings-scroll-and-scale.js builds — four spies, all returning undefined — still reaches wireGlobalListeners');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  The catalogue table is emitted with the shelf CLOSED');
// ═══════════════════════════════════════════════════════════════════════════
//
// v3.9.x: a confirm rendered inside a collapsed disclosure is no confirm, and
// render()'s capture/restore can only restore an element that was EMITTED.
// The measured warm render is 9.7 ms — inside a frame — so there is nothing to
// win by windowing or omitting these rows, and this is what a future attempt
// has to argue with.
{
  const rows = [];
  const deps = {
    state: { modelShelfOpen: false },
    escapeHtml,
    icon: () => '<svg/>',
    catalogueCountsOf: () => ({ total: 212, canBuild: 4, measured: 4, free: 9, batchHidden: 3 }),
    modelFilterFor: () => ({ q: '', lane: 'any', band: 'any', provider: '', sort: 'cheapest' }),
    allCatalogueRows: () => rows,
    renderModelBrowse: () => '<table class="browse-table"><tbody>' +
      '<tr data-model-id="a"><td><button data-build-model="a">Use for building</button></td></tr>' +
      '</tbody></table>',
    renderModelListsGroup: () => '<div class="mlists"></div>',
    settingsBlock: (num, id, title, lede, body) => '<section class="settings-job-block">' +
      '<h2>' + escapeHtml(title) + '</h2>' + body + '</section>',
    ALL_MODELS_SCOPE: 'all',
  };
  const S = build(['renderAllModelsBlock'], deps, 'renderAllModelsBlock');
  const html = S.renderAllModelsBlock({ models: {} }, false);
  ok(/data-model-shelf="1"/.test(html) && !/<details[^>]*\sopen/.test(html),
    'CONTROL: the shelf really is rendered CLOSED in this fixture');
  ok(/class="browse-table"/.test(html) && /data-model-id="a"/.test(html),
    'the table and its rows are in the document anyway — nothing is deferred until the disclosure opens');
  ok(/data-build-model="a"/.test(html),
    'and the row\'s build control — a money control — is emitted with it, never hidden behind the open state');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The 1 s qualify clock writes textContent — it never re-renders');
// ═══════════════════════════════════════════════════════════════════════════
//
// v3.54.0 wrote the rule down after v3.53.1 had to add a capture/restore for
// the disclosures THIS TICK was closing: a clock writes textContent to a
// targeted node and never calls render().
{
  const go = functionSource(code, 'onQualifyGo');
  ok(go !== null, 'CONTROL: onQualifyGo is found (a scan over null would pass vacuously)');
  const tick = /setInterval\(\(\) => \{([\s\S]*?)\}, 1000\);/.exec(go || '');
  ok(tick !== null, 'CONTROL: the 1 s interval callback is found inside it');
  const body = tick ? tick[1] : '';
  ok(body.length > 100, `CONTROL: the callback body really was captured (${body.length} chars)`);
  ok(!/(?<![.\w$])render\s*\(/.test(body),
    'the 1 s tick contains no render() call');
  ok(/textContent\s*=/.test(body),
    'it writes textContent instead');
  ok(/data-qualify-clock/.test(body),
    'and it addresses the node by the attribute the renderer emits, so there is no second name to keep in step');
  // POSITIVE CONTROL for the scan itself: the same regex must SEE a render
  // call in a string that has one. Without this, a regex that can never match
  // reports the same green.
  ok(/(?<![.\w$])render\s*\(/.test('  if (x) render(token);\n'),
    'CONTROL: the "no render()" scan can see a render() call when there is one');
}
{
  // …and the SENTENCE is byte-identical to the single escaped string this used
  // to build. Executed: the panel's text, tags stripped, against a literal.
  const deps = {
    escapeHtml,
    formatDuration: (ms) => Math.round(ms / 1000) + ' s',
    formatUsdHonest: () => '$0.00',
    formatTokenCount: (n) => String(n),
    formatSyncedAt: () => '',
    QUALIFY_CONFIRM_ID: 'qualify-confirm',
    renderQualification: () => '',
    measuredCallSeconds: () => null,
    icon: () => '',
    buildPickButtonId: () => 'x',
    BUILD_PICK_ERROR_ID: 'build-pick-error',
    state: {},
    providerLabel: (x) => String(x),
    formatIsoDay: () => '',
  };
  const S = build(['renderQualifyPanel'], deps, 'renderQualifyPanel');
  const html = S.renderQualifyPanel({
    phase: 'running', modelId: 'x/y', runs: [], total: 9,
    startedAt: Date.now() - 42000, callTimeoutMs: 120000,
  }, 9, '');
  const head = /<p class="model-qual-head">([\s\S]*?)<\/p>/.exec(html);
  ok(head !== null, 'CONTROL: the running panel emits a head line');
  const text = head ? head[1].replace(/<[^>]*>/g, '') : '';
  const expected = 'Run 1 of 9 — waiting for the model… 42 s so far (it gives up after 120 s)';
  ok(text === expected,
    `the sentence a user reads is unchanged: ${JSON.stringify(text)}`);
  ok(/<span data-qualify-clock="elapsed">\s*42 s so far<\/span>/.test(head[1]),
    'the clock clause — and only the clock clause — is wrapped in the node the tick writes');

  // THE ETA ARM MUST NOT CARRY THE ATTRIBUTE. An ETA is a projection from
  // measured runs; a tick overwriting it with the elapsed time every second
  // would replace a better number with a worse one.
  const withEta = S.renderQualifyPanel({
    phase: 'running', modelId: 'x/y', total: 9, startedAt: Date.now() - 42000,
    runs: [{ outcome: 'COMPLETED', usable: true, parseClass: 'RAW', pageCount: 12, etaMs: 60000 }],
  }, 9, '');
  const h2 = /<p class="model-qual-head">([\s\S]*?)<\/p>/.exec(withEta);
  ok(h2 && /about 60 s left/.test(h2[1]), 'CONTROL: once a run lands, the panel shows the ETA');
  ok(h2 && !/data-qualify-clock/.test(h2[1]),
    'and the clock attribute is ABSENT on that arm, so the tick cannot overwrite the projection');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  content-reveal is a section-change reveal, not a repaint animation');
// ═══════════════════════════════════════════════════════════════════════════
{
  const h = mainHarness({ section: 'general', probe: 'a', sectionJustChanged: true });
  h.S.renderMain(1);
  ok(h.body.classList.contains('content-reveal'),
    'a render that follows a section change puts content-reveal on the section body');
  ok(h.state.sectionJustChanged === false,
    'and CONSUMES the flag, so it is a one-shot');

  const h2 = mainHarness({ section: 'general', probe: 'a', sectionJustChanged: false });
  h2.S.renderMain(1);
  ok(!h2.body.classList.contains('content-reveal'),
    'an in-section re-render does NOT — the section body is not re-animated on a keystroke or a poll');

  // The flag is consumed even on a render that paints nothing, or it would
  // leak into the next repaint and animate it.
  const h3 = mainHarness({ section: 'general', probe: 'a', sectionJustChanged: false });
  h3.S.renderMain(1);
  h3.state.sectionJustChanged = true;
  h3.S.renderMain(1);                 // reveal forces the write
  ok(h3.written.length === 2, 'a section change repaints even when the HTML is unchanged (the class must land on a fresh node)');
  h3.body.classList._s.clear();
  h3.S.renderMain(1);
  ok(!h3.body.classList.contains('content-reveal'), 'and the very next render does not re-add it');
}
{
  // The flag is SET where a section actually changes, and nowhere else.
  const wire = functionSource(code, 'wireGlobalListeners');
  ok(wire !== null, 'CONTROL: wireGlobalListeners is found');
  ok(/state\.section = btn\.dataset\.section;[\s\S]{0,400}?state\.sectionJustChanged = true;/.test(wire || ''),
    'the section-switch handler sets the one-shot flag beside the section it just changed');
  const sets = (code.match(/state\.sectionJustChanged = true/g) || []).length;
  ok(sets === 1, `and it is set in exactly ONE place (${sets} found) — a second setter is a second animation nobody asked for`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
