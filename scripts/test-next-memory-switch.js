#!/usr/bin/env node
/**
 * test-next-memory-switch.js — OFFLINE. Switching project on Agent memory, and
 * opening a work-stream, driven through the SHIPPED functions.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT WAS REPORTED, AND WHAT WAS MEASURED
 * ─────────────────────────────────────────────────────────────────────────
 * From production, on v3.56.0: *"in Agent memory, when you go from project to
 * project, the main content of the project is loaded on the right side with
 * some delay — not good UX, missing transitions"*, and *"accessing the scopes
 * is not fluent and feels buggy"*.
 *
 * Measured in a real browser against a copy of a real store (four projects, up
 * to 22 work-streams), driving the SHIPPED build over CDP:
 *
 *   · ONE project switch cost THREE requests — the index, the project's
 *     work-stream list, and then the scoped read, the last two strictly in
 *     SERIES because the third URL is not knowable until the second answers;
 *   · THREE whole-column repaints, the first of them of an EMPTY column;
 *   · the main column collapsed from 5,062px to **215px** for a frame and
 *     then jumped back — which is what the eye reads as "delay" at 30ms;
 *   · going BACK to a project cost exactly the same as arriving at it, though
 *     nothing about it had changed;
 *   · pressing a work-stream row repainted the main column TWICE UNDER THE
 *     READER, once into an empty column.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE PINS, AND WHY EACH ONE NEEDS PINNING
 * ─────────────────────────────────────────────────────────────────────────
 *  §1  ONE REQUEST per uncached switch — the whole point of `?open=newest`.
 *      A second request reappearing is invisible to the eye at 10ms and is
 *      exactly the shape that was shipped for four releases.
 *  §2  ZERO requests on a cache hit's PAINT, and exactly one revalidation
 *      behind it. A cache that does not revalidate is a stale screen; one
 *      that paints after revalidating is not a cache.
 *  §3  An IDENTICAL revalidation costs ZERO repaints, a DIFFERING one costs
 *      exactly one. The same discipline `screenSignature` applies to the
 *      poll: a repaint that moves no pixel still closes an open ⓘ panel.
 *  §4  A reply for a project the user has already left is DROPPED — never
 *      written into state, so no later render can paint one project's
 *      document under another project's header.
 *  §5  The SKELETON reserves the table's height and claims no reading the
 *      index row does not carry. A loader in a collapsed column is the
 *      measured defect; an invented figure would be a worse one.
 *  §6  Opening a row issues NO main-column repaint, and the targeted update
 *      leaves the column byte-identical to what a full render would paint.
 *      That equality is the whole safety argument for patching at all.
 *  §7  The freshness MARK is the cached read's own time, not `now` — so a
 *      save that landed while the entry sat in the Map is still reported.
 *  §8  The two "Show more" call sites do the same thing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW, AND WHAT THAT COSTS
 * ─────────────────────────────────────────────────────────────────────────
 * Every function under test is LIFTED from `src/public/next/views/memory.js`
 * by brace-matching and EXECUTED, with a fake `fetch`, a fake clock and a DOM
 * MODEL — never asserted as a line of source. This file's siblings record why
 * twice: "a test that proves a line exists proves nothing about what it does",
 * and a source regex is satisfied by a comment.
 *
 * The DOM model is small and deliberately dumb: `innerHTML` is a string,
 * `children` is re-derived from it by counting `<tr`, and `querySelector`
 * understands the handful of selectors the shipped code actually uses. It is
 * not a browser. What it CAN prove is which path was taken and what was
 * written; what it cannot prove is layout, and the geometry claims in this
 * header were measured in Chrome, not here.
 *
 * NOT ENFORCED HERE, stated plainly: nothing about rendered pixels, nothing
 * about the reader overlay's own markup (app.js owns it), and nothing about
 * the server — `scripts/test-next-memory-view.js` §3b owns `?open=newest`.
 */

import { readFileSync } from 'node:fs';
// v3.99.2: lifted Context-page functions call the real plain-language error helpers.
import './test-helpers/context-error-globals.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMonitor } from '../src/public/next/shared/monitor.js';
// v4.2.0 fix: lifted renderers name machines by the REAL shared/machine-name.js
// (a free name in `new Function` code resolves on globalThis).
import * as MACHINE_NAME_MOD from '../src/public/next/shared/machine-name.js';
globalThis.machineDisplayName = MACHINE_NAME_MOD.machineDisplayName;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const VIEW = join(ROOT, 'src/public/next/views/memory.js');
const viewSrc = readFileSync(VIEW, 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected),
    'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }

/** Lift one top-level function by brace-matching. Throws rather than returning junk. */
function lift(name) {
  const marker = new RegExp('(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ' + name + '\\s*\\(');
  const m = marker.exec(viewSrc);
  if (!m) throw new Error('lift: "' + name + '" not found in memory.js');
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = viewSrc.indexOf('(', start);
  let parens = 0;
  for (; p < viewSrc.length; p++) {
    if (viewSrc[p] === '(') parens++;
    else if (viewSrc[p] === ')') { parens--; if (parens === 0) { p++; break; } }
  }
  let i = viewSrc.indexOf('{', p);
  let depth = 0;
  for (; i < viewSrc.length; i++) {
    if (viewSrc[i] === '{') depth++;
    else if (viewSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  // `export` is stripped: these run inside `new Function`, which is not a
  // module, and an exported declaration there is a SyntaxError rather than a
  // failing assertion. Nothing else about the source is touched.
  const out = viewSrc.slice(start, i).replace(/^export\s+/, '');
  // A desync produces something that still LOOKS like a function, so the
  // closing brace is required to start a line — the same check its sibling
  // suite makes, for the same reason.
  if (!/\n\}$/.test(out)) throw new Error('lift: "' + name + '" desynced in memory.js');
  return out;
}

/** A top-level `const NAME = <literal>;`, read off live source rather than typed. */
function liftConst(name) {
  const m = new RegExp('(?:^|\\n)const\\s+' + name + '\\s*=\\s*(-?[\\d_]+)\\s*;').exec(viewSrc);
  return m ? Number(m[1].replace(/_/g, '')) : null;
}
const WS_WINDOW = liftConst('WS_WINDOW');
const JOURNAL_PAGE = liftConst('JOURNAL_PAGE');
const JOURNAL_MORE = liftConst('JOURNAL_MORE');
const MAX_CACHE = liftConst('MAX_CACHE');
ok('the view\'s own constants were read off disk, not typed here',
  WS_WINDOW === 5 && JOURNAL_PAGE === 10 && JOURNAL_MORE === 50 && MAX_CACHE > 0,
  JSON.stringify([WS_WINDOW, JOURNAL_PAGE, JOURNAL_MORE, MAX_CACHE]));

// ═════════════════════════════════════════════════════════════════════════
// THE HARNESS
// ═════════════════════════════════════════════════════════════════════════

/**
 * Build a runnable copy of the switching machinery.
 *
 * `responder(url)` answers every fetch. `render` is a SPY, so "how many
 * repaints" is a count rather than an impression. The project cache is the
 * REAL one — a stub could only ever miss, and missing is one of the two arms
 * under test.
 */
function makeSwitcher(stateObj, responder, opts = {}) {
  // `knowledgeAsks` records step ③'s read (v3.62.0). A SPY rather than the
  // real `loadKnowledge`: what this harness is about is the SWITCH, and the
  // real one is driven against a fake fetch in test-next-memory-view.js §21f2.
  // `captureAsks` records the honesty meter's read (v3.63.0), a spy for the
  // same reason and recording the PAIR — the reading is per project.
  const calls = { urls: [], renders: 0, patches: 0, scopeLoads: [],
    knowledgeAsks: [], captureAsks: [] };
  let mounted = opts.mounted === undefined ? true : opts.mounted;

  const body =
    'const readCache = new Map();\n' +
    'const MAX_CACHE = ' + MAX_CACHE + ';\n' +
    lift('keyOf') + '\n' +
    lift('activeKey') + '\n' +
    lift('cacheKeyProject') + '\n' +
    lift('cacheKeyScope') + '\n' +
    lift('cacheGet') + '\n' +
    lift('cachePut') + '\n' +
    lift('forgetProject') + '\n' +
    lift('payloadSignature') + '\n' +
    lift('effectiveSave') + '\n' +
    lift('workStreamOrder') + '\n' +
    lift('fetchState') + '\n' +
    lift('applyProjectRead') + '\n' +
    // v3.72.1: selectProject re-asks step ③'s count once it is this old (F5).
    'const KNOWLEDGE_SELECT_MAX_AGE_MS = ' + liftConst('KNOWLEDGE_SELECT_MAX_AGE_MS') + ';\n' +
    lift('selectProject') + '\n' +
    lift('loadScope') + '\n' +
    'return { selectProject, applyProjectRead, loadScope, readCache, forgetProject, ' +
    'cacheKeyProject, cacheKeyScope, payloadSignature };';

  const api = new Function(
    'state', 'isCurrentMount', 'render', 'rememberProject', 'refreshIndex',
    'reportAsyncMountFailure', 'fetch', 'URLSearchParams', 'encodeURIComponent',
    'JOURNAL_PAGE', 'WS_WINDOW', 'patchOpenPair', 'loadKnowledge', 'loadCapture', 'Date', body)(
    stateObj,
    () => mounted,
    () => { calls.renders++; },
    () => {},
    async () => { calls.refreshed = (calls.refreshed || 0) + 1; },
    () => {},
    async (url) => {
      calls.urls.push(String(url));
      return responder(String(url), calls.urls.length);
    },
    URLSearchParams, encodeURIComponent, JOURNAL_PAGE, WS_WINDOW,
    () => { calls.patches++; },
    async (domain) => { calls.knowledgeAsks.push(domain); },
    async (domain, project) => { calls.captureAsks.push(domain + '/' + project); },
    // A controllable clock, so "the mark is the READ's time, not now" is a
    // measurement rather than a race with the wall clock.
    opts.Date || Date);

  return { ...api, calls, unmount: () => { mounted = false; } };
}

/** A (scope, machine) row of the shape `listWorkingScopes` returns. */
function pair(scope, machine, agentAgeSeconds, extra = {}) {
  return {
    scope,
    machine,
    headline: scope + ' headline',
    harness: 'claude-code',
    model: 'claude-opus-5',
    writtenAgeSeconds: agentAgeSeconds,
    writtenAt: new Date(1_700_000_000_000 - agentAgeSeconds * 1000).toISOString(),
    ageSeconds: 30,
    lastWriteAt: new Date(1_700_000_000_000 - 30_000).toISOString(),
    lastSaveKind: 'complete',
    lastSaveNotes: [],
    ...extra,
  };
}

/** A whole `?open=newest` payload: the index half plus the pair it opened. */
function payload(project, pairs, openPair, extra = {}) {
  const open = openPair
    ? {
      ok: true,
      project,
      scope: openPair.scope,
      machine: openPair.machine,
      machines: [{ machine: openPair.machine, ageSeconds: 30 }],
      machineCount: 1,
      machineIsThisMachine: true,
      installIdAvailable: true,
      current: { present: true, text: '# ' + openPair.scope + '\n\nbody\n', savedAt: openPair.writtenAt },
      journal: { entries: [{ at: openPair.writtenAt, harness: 'claude-code', model: 'x' }], returned: 1, total: 1 },
    }
    : null;
  return {
    ok: true,
    project,
    brief: { present: true, text: '## Brief\n\nx\n', updatedAt: '2026-01-01T00:00:00.000Z' },
    scopes: pairs,
    scopeCount: pairs.length,
    distinctScopeCount: new Set(pairs.map((p) => p.scope)).size,
    savedCopies: pairs.length,
    unlistedEntries: 0,
    unlistedReason: null,
    open,
    ...extra,
  };
}

function freshStateStub(over = {}) {
  return {
    loading: false,
    projects: [],
    activeDomain: null,
    activeProject: null,
    briefEdit: null,
    copied: null,
    projectRead: null,
    detail: null,
    detailError: null,
    detailLoading: false,
    scope: null,
    machine: null,
    journalLimit: JOURNAL_PAGE,
    wsWindow: WS_WINDOW,
    openFolds: {},
    detailFetchedAt: 0,
    scopesFetchedAt: 0,
    staleWrite: false,
    ...over,
  };
}

const PAIRS_A = [pair('alpha-new', 'box-a', 300), pair('alpha-old', 'box-b', 900000)];
const PAIRS_B = [pair('beta-one', 'box-a', 120), pair('beta-two', 'box-b', 4000)];
const OPEN_A = PAIRS_A[0];
const OPEN_B = PAIRS_B[0];

const respond = (map) => (url) => {
  for (const [frag, body] of map) {
    if (url.includes(frag)) return { ok: true, json: async () => body };
  }
  throw new Error('no fixture for ' + url);
};

// ═════════════════════════════════════════════════════════════════════════
section('§1 — ONE request per uncached switch');
// ═════════════════════════════════════════════════════════════════════════
{
  const st = freshStateStub();
  const s = makeSwitcher(st, respond([['/acme/alpha', payload('alpha', PAIRS_A, OPEN_A)]]));
  await s.selectProject('acme', 'alpha', 1);

  eq('an uncached project costs exactly ONE request', s.calls.urls.length, 1);
  ok('...and it is the combined read, not the two-step pair',
    /\?open=newest&as=project$/.test(s.calls.urls[0]), s.calls.urls[0]);
  // `as=project` is D-G (v3.62.0): `GET /:domain/projects` is the project LIST,
  // so a domain literally named `projects` collides with it and Express
  // answers the list. The marker falls through to the detail route. The
  // failure it prevents is SILENT — the page renders, about the wrong thing.
  ok('...and it marks itself as the PROJECT read, so a domain named `projects` '
    + 'is reachable at all', /[?&]as=project\b/.test(s.calls.urls[0]), s.calls.urls[0]);
  eq('the project index landed', st.projectRead && st.projectRead.scopeCount, 2);
  eq('the opened pair landed in the SAME response', st.scope, 'alpha-new');
  eq('...as a whole document, not a stub', st.detail && st.detail.current.present, true);
  eq('...and nothing is still loading', st.detailLoading, false);
  // TWO paints: the skeleton that acknowledges the click in its own frame, and
  // the fill. The shipped code took three, the first of which was empty.
  eq('two paints — the click\'s acknowledgement and the fill, never an empty column',
    s.calls.renders, 2);

  // NOBODY CHOSE THE MACHINE. `state.machine` is what makes Reload re-resolve
  // to the newest copy, and the default open is not a choice (v3.34.0).
  eq('the default open records NO machine choice', st.machine, null);
  ok('...although the pair it opened names one', st.detail.machine === 'box-a');
}

// The pair opened is the one the TABLE puts first, and the server's offer is
// CHECKED rather than trusted.
{
  // THE SERVER'S OFFER IS CHECKED, NOT TRUSTED. It offers the agent-OLDEST
  // pair here — a server that picked on the FILE clock, which is the v3.56.0
  // defect one layer up. The view keeps the decision and falls back to the
  // second request, which is exactly what it did before the option existed.
  const st = freshStateStub();
  const wrong = payload('alpha', PAIRS_A, PAIRS_A[1]);
  const s = makeSwitcher(st, (url) => ({
    ok: true,
    json: async () => (url.includes('scope=') ? payload('alpha', PAIRS_A, OPEN_A).open : wrong),
  }));
  await s.selectProject('acme', 'alpha', 1);
  eq('a disagreeing offer costs the SECOND request rather than opening the '
    + 'wrong pair', s.calls.urls.length, 2);
  ok('...and the second request names the pair the TABLE puts first',
    /scope=alpha-new/.test(s.calls.urls[1]), s.calls.urls[1]);
  eq('...so what ends up on screen is still the agent-newest', st.scope, 'alpha-new');
  eq('...and the disagreement is not reported as an error, because it is not one',
    st.detailError, null);
}
{
  // An OLDER server, with no `open` at all: the same fallback, unannounced.
  const st = freshStateStub();
  const oldServer = payload('alpha', PAIRS_A, null);
  delete oldServer.open;
  const s = makeSwitcher(st, (url) => ({
    ok: true,
    json: async () => (url.includes('scope=') ? payload('alpha', PAIRS_A, OPEN_A).open : oldServer),
  }));
  await s.selectProject('acme', 'alpha', 1);
  eq('a server that does not know the option degrades to the two-step read',
    s.calls.urls.length, 2);
  eq('...and the index half is still adopted, so the table paints',
    st.projectRead.scopes.length, 2);
  eq('...and the pair still opens', st.scope, 'alpha-new');
  // AN OMITTED KEY AND A NULL ONE ARE THE SAME FALLBACK, and that is the point
  // of the route answering `null` rather than nothing: the distinction exists
  // so a client can TELL them apart, not so it behaves differently.
  ok('CONTROL: the fixture really did omit the key', !('open' in oldServer));
}
{
  // A project with no work-streams at all: `open: null` is an ANSWER.
  const st = freshStateStub();
  const s = makeSwitcher(st, respond([['/acme/empty', payload('empty', [], null)]]));
  await s.selectProject('acme', 'empty', 1);
  eq('"nothing to open" settles rather than hanging on a loader', st.detailLoading, false);
  eq('...with no scope claimed', st.scope, null);
  eq('...and no second request', s.calls.urls.length, 1);
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — A cache hit paints with ZERO requests, and revalidates behind it');
// ═════════════════════════════════════════════════════════════════════════
{
  const st = freshStateStub();
  const body = payload('alpha', PAIRS_A, OPEN_A);
  const s = makeSwitcher(st, respond([
    ['/acme/alpha', body],
    ['/acme/beta', payload('beta', PAIRS_B, OPEN_B)],
  ]));

  await s.selectProject('acme', 'alpha', 1);
  const afterFirst = s.calls.urls.length;
  await s.selectProject('acme', 'beta', 1);
  const beforeReturn = s.calls.urls.length;
  const rendersBeforeReturn = s.calls.renders;

  // THE PAINT IS SYNCHRONOUS WITH THE CLICK. Measured by NOT awaiting: the
  // promise is captured and the screen is read before it settles, so "painted
  // from the cache" is a state of the world at that instant rather than an
  // outcome that might have arrived with the network.
  const back = s.selectProject('acme', 'alpha', 1);
  const paintedScope = st.scope;
  const paintedDoc = st.detail && st.detail.current && st.detail.current.present;
  const paintedLoading = st.detailLoading;
  const paintedRenders = s.calls.renders;
  eq('returning to a cached project puts the document on screen in the SAME '
    + 'turn as the click, before anything has come back', paintedScope, 'alpha-new');
  eq('...with the handoff already in hand', paintedDoc, true);
  eq('...and nothing claiming to be loading', paintedLoading, false);
  eq('...in ONE paint, not two — there is no skeleton to replace',
    paintedRenders, rendersBeforeReturn + 1);
  await back;
  eq('exactly one revalidation followed it — a cache that does not re-ask is a '
    + 'stale screen', s.calls.urls.length, beforeReturn + 1);
  eq('...and it changed nothing, so it cost no second paint',
    s.calls.renders, rendersBeforeReturn + 1);
  ok('CONTROL: the first visit really did cost a request', afterFirst === 1);
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — An identical revalidation costs no repaint; a differing one costs one');
// ═════════════════════════════════════════════════════════════════════════
{
  const st = freshStateStub();
  const body = payload('alpha', PAIRS_A, OPEN_A);
  const s = makeSwitcher(st, respond([['/acme/alpha', body], ['/acme/beta', payload('beta', PAIRS_B, OPEN_B)]]));
  await s.selectProject('acme', 'alpha', 1);
  await s.selectProject('acme', 'beta', 1);
  const before = s.calls.renders;
  await s.selectProject('acme', 'alpha', 1);
  eq('an UNCHANGED revalidation repaints exactly once — the cache paint, and '
    + 'nothing after it', s.calls.renders, before + 1);
}
{
  // The same project, answered differently the second time.
  const st = freshStateStub();
  const first = payload('alpha', PAIRS_A, OPEN_A);
  const moved = payload('alpha', [pair('alpha-new', 'box-a', 5), ...PAIRS_A.slice(1)],
    pair('alpha-new', 'box-a', 5));
  let nth = 0;
  const s = makeSwitcher(st, (url) => {
    if (url.includes('/acme/beta')) return { ok: true, json: async () => payload('beta', PAIRS_B, OPEN_B) };
    nth++;
    return { ok: true, json: async () => (nth === 1 ? first : moved) };
  });
  await s.selectProject('acme', 'alpha', 1);
  await s.selectProject('acme', 'beta', 1);
  const before = s.calls.renders;
  await s.selectProject('acme', 'alpha', 1);
  eq('a revalidation that found a NEWER save repaints twice — the cache, then '
    + 'the correction', s.calls.renders, before + 2);
  eq('...and what is on screen is the fresh one', st.projectRead.scopes[0].writtenAgeSeconds, 5);
}
{
  // The comparator must not be defeated by the server's own recomputed ages.
  const st = freshStateStub();
  const s = makeSwitcher(st, respond([['x', {}]]));
  const a = payload('alpha', PAIRS_A, OPEN_A);
  const b = JSON.parse(JSON.stringify(a));
  for (const p of b.scopes) { p.ageSeconds += 7; p.writtenAgeSeconds += 7; }
  eq('an age figure the SERVER recomputes on every read is not a change',
    s.payloadSignature(a), s.payloadSignature(b));
  const c = JSON.parse(JSON.stringify(a));
  c.scopes[0].writtenAt = '2030-01-01T00:00:00.000Z';
  ok('CONTROL: the STAMP those ages derive from still is one',
    s.payloadSignature(a) !== s.payloadSignature(c));
  const d = JSON.parse(JSON.stringify(a));
  d.open.current.text = 'different handoff';
  ok('CONTROL: so is the document itself', s.payloadSignature(a) !== s.payloadSignature(d));
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — A reply for a project the user has left is DROPPED');
// ═════════════════════════════════════════════════════════════════════════
{
  // The reply lands after the selection has moved on. It must not be written
  // into state at ALL — guarding only the render would leave one project's
  // document in `state.detail` under another project's header.
  const st = freshStateStub();
  let release = null;
  const held = new Promise((r) => { release = r; });
  const s = makeSwitcher(st, async (url) => {
    if (url.includes('/acme/slow')) { await held; return { ok: true, json: async () => payload('slow', PAIRS_A, OPEN_A) }; }
    return { ok: true, json: async () => payload('beta', PAIRS_B, OPEN_B) };
  });

  const slow = s.selectProject('acme', 'slow', 1);
  await s.selectProject('acme', 'beta', 1);
  eq('PRECONDITION: the user has moved to the other project', st.activeProject, 'beta');
  release();
  await slow;
  eq('the stale reply did not take the selection back', st.activeProject, 'beta');
  eq('...and did not put its work-streams on screen',
    st.projectRead.scopes[0].scope, 'beta-one');
  eq('...nor its document', st.detail.scope, 'beta-one');
}
{
  // An UNMOUNTED view drops it too, and for a different reason: the token.
  const st = freshStateStub();
  const s = makeSwitcher(st, respond([['/acme/alpha', payload('alpha', PAIRS_A, OPEN_A)]]));
  s.unmount();
  await s.selectProject('acme', 'alpha', 1);
  eq('a reply arriving after the view unmounted is not applied', st.projectRead, null);
}
{
  // A FAILED revalidation keeps what is on screen — the rule refreshIndex
  // follows. Reporting the error over a correct screen would be worse.
  const st = freshStateStub();
  let nth = 0;
  const s = makeSwitcher(st, (url) => {
    if (url.includes('/acme/beta')) return { ok: true, json: async () => payload('beta', PAIRS_B, OPEN_B) };
    nth++;
    if (nth === 1) return { ok: true, json: async () => payload('alpha', PAIRS_A, OPEN_A) };
    return { ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) };
  });
  await s.selectProject('acme', 'alpha', 1);
  await s.selectProject('acme', 'beta', 1);
  await s.selectProject('acme', 'alpha', 1);
  eq('a failed revalidation leaves the cached screen exactly where it was',
    st.scope, 'alpha-new');
  eq('...and reports no error over a screen that is still broadly true',
    st.detailError, null);
}
{
  // ...but a failed FIRST read IS the answer, because there is nothing on
  // screen for it to contradict.
  const st = freshStateStub();
  const s = makeSwitcher(st, () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }));
  await s.selectProject('acme', 'alpha', 1);
  eq('a failed FIRST read is reported', st.detailError, 'boom');
  eq('...and stops claiming to be loading', st.detailLoading, false);
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — The freshness mark is the READ\'s own time, never `now`');
// ═════════════════════════════════════════════════════════════════════════
{
  // A cached paint that stamped itself `now` would hide a save that landed
  // while the entry sat in the Map: `refreshIndex` compares the index's
  // `lastWriteAt` against `detailFetchedAt` to decide whether to offer Reload.
  let clock = 1_000_000;
  // `parse` is the real one: v3.76.0 (F4) takes every age from its stamp at
  // paint time, so the fake clock has to read stamps as well as tell time.
  const FakeDate = { now: () => clock, parse: Date.parse };
  const st = freshStateStub();
  const s = makeSwitcher(st, respond([
    ['/acme/alpha', payload('alpha', PAIRS_A, OPEN_A)],
    ['/acme/beta', payload('beta', PAIRS_B, OPEN_B)],
  ]), { Date: FakeDate });

  await s.selectProject('acme', 'alpha', 1);
  const readAt = st.detailFetchedAt;
  eq('the first read stamps the mark with the time it was ISSUED', readAt, 1_000_000);
  clock = 9_000_000;
  await s.selectProject('acme', 'beta', 1);
  clock = 9_500_000;
  await s.selectProject('acme', 'alpha', 1);
  ok('a CACHED paint keeps the original read\'s time, so a save in between is '
    + 'still reported as stale rather than hidden behind a fresh-looking mark',
  st.detailFetchedAt < 9_500_000, String(st.detailFetchedAt));
  eq('...and the scope list\'s own mark moves with it, not apart from it',
    st.scopesFetchedAt, st.detailFetchedAt);
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — The cache is bounded, and it is dropped where the view knows better');
// ═════════════════════════════════════════════════════════════════════════
{
  const st = freshStateStub();
  const s = makeSwitcher(st, (url) => {
    const m = /\/acme\/([^?]+)/.exec(url);
    return { ok: true, json: async () => payload(m[1], PAIRS_A, OPEN_A) };
  });
  for (let i = 0; i < MAX_CACHE + 6; i++) await s.selectProject('acme', 'p' + i, 1);
  ok('the cache is BOUNDED — a user clicking through hundreds of projects does '
    + 'not carry hundreds of handoffs for the life of the tab',
  s.readCache.size <= MAX_CACHE, 'size ' + s.readCache.size);
  ok('...and it is the OLDEST entry that goes', !s.readCache.has(s.cacheKeyProject('acme', 'p0')));
  ok('...while the newest stays', s.readCache.has(s.cacheKeyProject('acme', 'p' + (MAX_CACHE + 5))));
}
{
  const st = freshStateStub();
  const s = makeSwitcher(st, respond([['/acme/alpha', payload('alpha', PAIRS_A, OPEN_A)]]));
  await s.selectProject('acme', 'alpha', 1);
  ok('PRECONDITION: the project is cached', s.readCache.has(s.cacheKeyProject('acme', 'alpha')));
  s.forgetProject('acme', 'alpha');
  ok('forgetProject drops the project read', !s.readCache.has(s.cacheKeyProject('acme', 'alpha')));
  // ...and every scoped read under it, which is the half a prefix match exists
  // for: a brief save invalidates the whole project, not one row of it.
  s.readCache.set(s.cacheKeyScope('acme', 'alpha', 'x', 'm'), { data: {}, at: 0 });
  s.readCache.set(s.cacheKeyScope('acme', 'other', 'x', 'm'), { data: {}, at: 0 });
  s.forgetProject('acme', 'alpha');
  ok('...and every scoped read under it', !s.readCache.has(s.cacheKeyScope('acme', 'alpha', 'x', 'm')));
  ok('CONTROL: another project\'s entries are untouched',
    s.readCache.has(s.cacheKeyScope('acme', 'other', 'x', 'm')));
}
{
  // TWO DOMAINS, ONE PROJECT NAME. The expected shape once a user has more
  // than one domain, and a cache keyed on the project alone would serve one
  // domain's handoff under the other's header.
  const st = freshStateStub();
  const s = makeSwitcher(st, (url) => ({
    ok: true,
    json: async () => (url.includes('/one/main')
      ? payload('main', PAIRS_A, OPEN_A) : payload('main', PAIRS_B, OPEN_B)),
  }));
  await s.selectProject('one', 'main', 1);
  await s.selectProject('two', 'main', 1);
  const renders = s.calls.renders;
  const back = s.selectProject('one', 'main', 1);
  eq('two domains holding a project of the same name are two cache entries',
    st.detail.scope, 'alpha-new');
  eq('CONTROL: the return really was served from the cache — one paint, in the '
    + 'same turn as the click', s.calls.renders, renders + 1);
  await back;
  ok('...and the second domain kept its own', s.readCache.has(s.cacheKeyProject('two', 'main')));
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — Opening a work-stream row: no main-column repaint, and the patch is equivalent');
// ═════════════════════════════════════════════════════════════════════════
//
// The press opens an overlay. A `setMain` underneath it replaces the pane by
// innerHTML — closing every open ⓘ panel, dropping the journal fold, moving
// the scroll position and churning focus — for a user who is reading a
// document and will close it in a moment and find their page rearranged.
{
  const st = freshStateStub({
    activeDomain: 'acme', activeProject: 'alpha',
    projectRead: payload('alpha', PAIRS_A, OPEN_A),
    detail: payload('alpha', PAIRS_A, OPEN_A).open,
    scope: 'alpha-new', machine: null,
  });
  const s = makeSwitcher(st, respond([['scope=alpha-old', payload('alpha', PAIRS_A, PAIRS_A[1]).open]]));
  await s.loadScope('alpha-old', 'box-b', 1, { reader: true, cache: true });
  eq('opening a row issues NO main-column repaint', s.calls.renders, 0);
  eq('...it takes the targeted update instead', s.calls.patches, 1);
  eq('...and the selection really moved', st.scope, 'alpha-old');
  eq('...recording the machine, because a press IS a choice', st.machine, 'box-b');
  eq('...and read it once', s.calls.urls.length, 1);
}
{
  // THE PREVIOUS PAIR STAYS ON SCREEN FOR THE LENGTH OF THE FETCH. Dropping
  // it is what painted an empty column under the reader.
  const st = freshStateStub({
    activeDomain: 'acme', activeProject: 'alpha',
    projectRead: payload('alpha', PAIRS_A, OPEN_A),
    detail: payload('alpha', PAIRS_A, OPEN_A).open,
    scope: 'alpha-new',
  });
  let release = null;
  const held = new Promise((r) => { release = r; });
  const s = makeSwitcher(st, async () => {
    await held;
    return { ok: true, json: async () => payload('alpha', PAIRS_A, PAIRS_A[1]).open };
  });
  const p = s.loadScope('alpha-old', 'box-b', 1, { reader: true, cache: true });
  eq('the column still shows the pair it had while the read is in flight',
    st.detail && st.detail.scope, 'alpha-new');
  eq('...and is not claiming to be loading, because nothing on it is',
    st.detailLoading, false);
  release();
  await p;
  eq('...and the arrival replaces it', st.detail.scope, 'alpha-old');
}
{
  // A row opened EARLIER in the session opens with no request at all.
  const st = freshStateStub({
    activeDomain: 'acme', activeProject: 'alpha',
    projectRead: payload('alpha', PAIRS_A, OPEN_A),
    detail: payload('alpha', PAIRS_A, OPEN_A).open,
    scope: 'alpha-new',
  });
  const s = makeSwitcher(st, respond([['scope=alpha-old', payload('alpha', PAIRS_A, PAIRS_A[1]).open]]));
  await s.loadScope('alpha-old', 'box-b', 1, { reader: true, cache: true });
  await s.loadScope('alpha-new', 'box-a', 1, { reader: true, cache: true });
  const before = s.calls.urls.length;
  await s.loadScope('alpha-old', 'box-b', 1, { reader: true, cache: true });
  eq('a pair read earlier in the session opens from the cache', st.scope, 'alpha-old');
  eq('...and its revalidation is the only request it costs',
    s.calls.urls.length, before + 1);
}
{
  // A PAGINATED read is never cached: the payload is a different page size
  // under the same pair, and one key cannot mean two page sizes.
  const st = freshStateStub({
    activeDomain: 'acme', activeProject: 'alpha',
    projectRead: payload('alpha', PAIRS_A, OPEN_A),
    detail: payload('alpha', PAIRS_A, OPEN_A).open,
    scope: 'alpha-new', journalLimit: JOURNAL_MORE,
  });
  const s = makeSwitcher(st, respond([['scope=', payload('alpha', PAIRS_A, OPEN_A).open]]));
  await s.loadScope('alpha-new', 'box-a', 1, { cache: true });
  ok('a "show more" read names its page size in the URL',
    /journalLimit=50/.test(s.calls.urls[0]), s.calls.urls[0]);
  eq('...and writes NOTHING into the cache, because the key cannot say which '
    + 'page size it holds', s.readCache.size, 0);
}
{
  // Every path that is NOT the reader still renders, so nothing silently
  // stopped painting.
  const st = freshStateStub({
    activeDomain: 'acme', activeProject: 'alpha',
    projectRead: payload('alpha', PAIRS_A, OPEN_A),
    detail: payload('alpha', PAIRS_A, OPEN_A).open,
    scope: 'alpha-new',
  });
  const s = makeSwitcher(st, respond([['scope=alpha-old', payload('alpha', PAIRS_A, PAIRS_A[1]).open]]));
  await s.loadScope('alpha-old', 'box-b', 1);
  eq('CONTROL: without `reader`, the ordinary two-render path is unchanged',
    s.calls.renders, 2);
  eq('...and the targeted update is not used', s.calls.patches, 0);
}

// ═════════════════════════════════════════════════════════════════════════
section('§8 — patchOpenPair is ONE paint now (phase 2, Projects)');
// ═════════════════════════════════════════════════════════════════════════
//
// PHASE 2 (2026-11-27): the page behind the reader no longer prints the open
// pair in a table a patch could move in place (the work-stream table, its
// window and its journal fold are gone; the Now card keeps the NEWEST note,
// whichever pair the reader is on). So `patchOpenPair` is one render when the
// mount is current and nothing when it is not. Its old DOM-equivalence block
// (and §9's skeleton, §10's second "Show more" copy) had no subject and were
// deleted; the shipped function is driven here instead of being trusted.
{
  const calls = [];
  const mk = (mounted) => new Function('isCurrentMount', 'render',
    lift('patchOpenPair') + '\nreturn patchOpenPair;')(() => mounted, (t) => { calls.push(t); });
  eq('a current mount: ONE render, with the mount token', mk(true)(7), 'rendered');
  eq('...the token is passed through', calls.join(','), '7');
  eq('an unmounted view paints NOTHING (a late read never writes into another view)', mk(false)(8), 'fell-back:unmounted');
  eq('...not one render', calls.length, 1);
}

// ═════════════════════════════════════════════════════════════════════════
section('§9 — No motion in the view\'s stylesheets');
// ═════════════════════════════════════════════════════════════════════════
// The skeleton (`renderProjectSkeleton`) is gone: until a read arrives the
// tab says "Reading…" with aria-busy (scripts/test-projects-page.js §10). What
// survives of this section is the rule that this view declares no animation.
{
  const css = readFileSync(join(ROOT, 'src/public/next/views/memory.css'), 'utf8');
  const pcss = readFileSync(join(ROOT, 'src/public/next/views/projects/projects.css'), 'utf8');
  ok('memory.css declares no animation', !/^\s*animation\s*:/m.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('...and neither does projects.css', !/^\s*animation\s*:/m.test(pcss.replace(/\/\*[\s\S]*?\*\//g, '')));
}

// ═════════════════════════════════════════════════════════════════════════
section('§10 — The journal\'s "Show more" keeps the reader where it is');
// ═════════════════════════════════════════════════════════════════════════
// One call site now (`wire`; the copy in `patchOpenPair` went with the patch).
// `keepDetail` is what stops `loadScope` nulling `state.detail` and rendering
// before the fetch, so the Pro Now tab's journal does not vanish for the
// round trip.
{
  const strip = (x) => x.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const w = lift('wire');
  const i = w.indexOf('state.journalLimit = JOURNAL_MORE;');
  const j = w.indexOf('loadScope(', i);
  const a = i < 0 || j < 0 ? null : strip(w.slice(i, w.indexOf(';', j) + 1));
  ok('the handler was found', !!a, String(a));
  ok('...it re-reads the open pair', !!a && a.includes('loadScope(state.scope'), String(a));
  ok('...with `keepDetail`, so the column does not shrink under the reader', !!a && /keepDetail: true/.test(a), String(a));
  ok('CONTROL: patchOpenPair no longer carries a second copy', !lift('patchOpenPair').includes('JOURNAL_MORE'));
}

// ═════════════════════════════════════════════════════════════════════════
section('§10 — THE HANDOFF FROM DOMAINS: one project, once (v3.61.0, P1-10)');
// ═════════════════════════════════════════════════════════════════════════
//
// ── THE PROBLEM IT SOLVES ───────────────────────────────────────────────
// `navigate()` takes a view name and nothing else, and this view's arrival
// path picks the DOMAIN by save recency and then the project from a
// remembered-per-domain map. A project created a second ago has no saves, so
// it loses the recency question outright: "Open in Agent memory" on the create
// outcome would land on whichever project last had an agent write to it. That
// is a navigation that works MOST of the time, which is the worst property a
// navigation can have — and it is why writing the remembered map was rejected
// as the cheap fix.
//
// ── AND WHAT THE SHAPE HAS TO GUARANTEE ─────────────────────────────────
// Three properties, each driven below:
//   · it cannot go stale, because it is CLEARED ON READ;
//   · it needs no storage, so there is no new localStorage key and nothing to
//     migrate or forget (scripts/test-ui-state.js's registry does not move);
//   · `initialPick` stays PURE — the request is consulted BEFORE it, so the
//     ordinary arrival is byte-identical to what it was.
{
  // The two halves, lifted and executed together: they share a module variable
  // and neither claim is checkable from one of them alone.
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'let pendingProject = null;\n'
    + lift('requestProject') + '\n'
    + lift('takePendingProject') + '\n'
    + 'return { requestProject, takePendingProject, peek: () => pendingProject };')();

  eq('with nothing asked for, the read answers nothing', api.takePendingProject(), null);

  api.requestProject('acme', 'lumina');
  eq('a request is recorded as the pair', JSON.stringify(api.peek()),
    JSON.stringify({ domain: 'acme', project: 'lumina' }));
  const first = api.takePendingProject();
  eq('...and the read hands it back', JSON.stringify(first),
    JSON.stringify({ domain: 'acme', project: 'lumina' }));
  // ── CLEARED AT THE READ, NOT AT THE USE ───────────────────────────────
  // Whatever the caller then does with it — including deciding it names a
  // project the index does not have — the request is SPENT. That is the whole
  // staleness argument: a parameter left in storage would re-open a project
  // the owner had navigated away from three days later.
  eq('...and it is spent, so a second arrival is an ORDINARY arrival',
    api.takePendingProject(), null);
  eq('...with nothing left behind to go stale', api.peek(), null);

  // BOTH NAMES ARE REQUIRED. A request naming only a project would have to
  // guess the domain, which is the ambiguity `list_projects` refuses to guess
  // at one layer down — and a half-request must CLEAR rather than linger.
  api.requestProject('acme', 'lumina');
  api.requestProject('acme', '');
  eq('a request with no project clears rather than lingering', api.peek(), null);
  api.requestProject('acme', 'lumina');
  api.requestProject('', 'lumina');
  eq('...and so does one with no domain', api.peek(), null);
  api.requestProject(null, undefined);
  eq('...and a junk request records nothing', api.takePendingProject(), null);
  // TRIMMED, because the writer passes a name a person typed into a field.
  api.requestProject('  acme  ', '  lumina  ');
  eq('the pair is trimmed, because the writer passes what somebody typed',
    JSON.stringify(api.takePendingProject()),
    JSON.stringify({ domain: 'acme', project: 'lumina' }));

  // ── AND THE ARRIVAL DECISION HONOURS IT, but VERIFIES it first ─────────
  // The request is checked against the index rather than trusted: if the
  // create succeeded and the index read raced it, opening a project that is
  // not in the list would paint an error under a name nothing can answer
  // about. When the row is missing the ordinary arrival takes over — a worse
  // answer than the one asked for, and a much better one than a broken screen.
  // eslint-disable-next-line no-new-func
  const pick = new Function(lift('initialPick') + '\nreturn initialPick;')();
  const rows = [
    { domain: 'acme', project: 'quiet', lastWriteAt: null },
    { domain: 'other', project: 'busy', lastWriteAt: '2026-09-18T10:00:00.000Z' },
  ];
  const asked = { domain: 'acme', project: 'quiet' };
  const found = rows.find((r) => r.domain === asked.domain && r.project === asked.project);
  ok('a brand-new project with NO saves is findable in the index', !!found);
  ok('CONTROL: and `initialPick` on its own would NOT have reached it — which is '
    + 'the whole reason the handoff exists',
  pick(rows, null).project === 'busy', JSON.stringify(pick(rows, null)));
  const absent = rows.find((r) => r.domain === 'acme' && r.project === 'vanished');
  ok('a request naming a project the index does not have resolves to nothing, so '
    + 'the ordinary arrival takes over rather than a broken screen', !absent);
  // ── `initialPick` IS UNTOUCHED ────────────────────────────────────────
  ok('...and `initialPick` itself never mentions the handoff, so the ordinary '
    + 'arrival is byte-identical to what it was',
  !/pendingProject|takePendingProject/.test(lift('initialPick')));
  // NO NEW STORAGE KEY. The handoff is a module variable; the alternative
  // (writing the remembered-project map) is both wrong and persistent.
  ok('the handoff writes no storage at all',
    !/localStorage|sessionStorage/.test(lift('requestProject') + lift('takePendingProject')));
}

// ── §10b — `loadIndex` DRIVEN, because the two halves prove nothing alone ──
//
// §10 proves the request records and spends a pair. That is not the claim: the
// claim is that the ARRIVAL uses it, and verifies it against the index rather
// than trusting it. A mutation that deleted the consultation left every
// assertion in §10 green, which is precisely the shape this file exists to
// catch — so the real `loadIndex` runs here, against a fake index and a spy
// for `selectProject`.
{
  const rig = (rows) => {
    const picked = [];
    // eslint-disable-next-line no-new-func
    const domainReads = [];
    // eslint-disable-next-line no-new-func
    const api = new Function(
      'state', 'fetchIndex', 'isCurrentMount', 'render', 'settleGate', 'selectProject',
      'readRememberedProjects', 'loadGate',
      // ── THE DOMAIN LIST GOES OUT BESIDE THE INDEX (v3.65.0) ──────────
      // It is a free identifier inside `loadIndex`'s body, so a spy is
      // required or this harness is a ReferenceError. It is also the claim
      // worth making here: the list read must be UNAWAITED and must not sit
      // behind the index, or a slow answer delays the first paint of a
      // screen that already has everything it needs to draw.
      'loadDomainList', 'reportAsyncMountFailure',
      'let pendingProject = null;\n'
      + lift('requestProject') + '\n'
      + lift('takePendingProject') + '\n'
      + lift('initialPick') + '\n'
      + lift('loadIndex') + '\n'
      + 'return { loadIndex, requestProject };')(
      { projects: null, domainsScanned: 0, indexError: null, loading: true },
      async () => ({ projects: rows, domainsScanned: 1, error: null }),
      () => true,
      () => {},
      (_g, fn) => fn(),
      async (d, p) => { picked.push(d + '/' + p); },
      () => null,
      null,
      // NEVER RESOLVES, deliberately: if `loadIndex` awaited it, nothing
      // below would ever run and the suite would hang rather than pass.
      () => { domainReads.push(1); return new Promise(() => {}); },
      () => {});
    return { api, picked, domainReads };
  };
  const ROWS = [
    // A brand-new project: NO saves at all, so recency cannot reach it.
    { domain: 'acme', project: 'lumina', lastWriteAt: null },
    // The project an agent wrote to most recently, in another domain.
    { domain: 'other', project: 'busy', lastWriteAt: '2026-09-18T10:00:00.000Z' },
  ];

  {
    const { api, picked, domainReads } = rig(ROWS);
    await api.loadIndex(1);
    eq('CONTROL: with no request, the ordinary arrival opens the freshest save '
      + '— which is NOT the new project', picked.join(), 'other/busy');
    // ── THE DOMAIN LIST WENT OUT, AND IT WAS NOT AWAITED (v3.65.0) ─────
    // The spy returns a promise that NEVER settles, so an awaited call would
    // hang this harness rather than pass it — which is what makes the second
    // half a measurement instead of a hope.
    eq('the install\'s domain list is asked for once, beside the index', domainReads.length, 1);
    eq('...and the index still resolved, so the read is not awaited', picked.length, 1);
  }
  {
    const { api, picked } = rig(ROWS);
    api.requestProject('acme', 'lumina');
    await api.loadIndex(1);
    eq('a requested project is opened, although it has no saves and would lose '
      + 'the recency question outright', picked.join(), 'acme/lumina');
  }
  {
    // VERIFIED, NOT TRUSTED. If the create succeeded and the index read raced
    // it, opening a project that is not in the list would paint an error under
    // a name nothing can answer about. The ordinary arrival takes over — a
    // worse answer than the one asked for, and a much better one than a
    // broken screen.
    const { api, picked } = rig(ROWS);
    api.requestProject('acme', 'vanished');
    await api.loadIndex(1);
    eq('a request naming a project the index does not have falls back to the '
      + 'ordinary arrival rather than opening nothing', picked.join(), 'other/busy');
  }
  {
    // AND IT IS SPENT. A second arrival is an ordinary arrival, so the handoff
    // cannot re-open a project the owner navigated away from.
    const { api, picked } = rig(ROWS);
    api.requestProject('acme', 'lumina');
    await api.loadIndex(1);
    await api.loadIndex(2);
    eq('the request survives exactly ONE arrival', picked.join(), 'acme/lumina,other/busy');
  }
  {
    // A domain is part of the request for a reason: two domains can hold a
    // project of the same name, and guessing is the ambiguity `list_projects`
    // refuses to guess at one layer down.
    const { api, picked } = rig([
      { domain: 'acme', project: 'shared-name', lastWriteAt: null },
      { domain: 'other', project: 'shared-name', lastWriteAt: '2026-09-18T10:00:00.000Z' },
    ]);
    api.requestProject('acme', 'shared-name');
    await api.loadIndex(1);
    eq('the DOMAIN in the request decides between two projects of one name',
      picked.join(), 'acme/shared-name');
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) {
  console.log('❌ Agent-memory switching assertions FAILED');
  process.exit(1);
}
console.log('✅ Agent-memory switching + row-open assertions green');
