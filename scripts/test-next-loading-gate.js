/**
 * test-next-loading-gate.js — OFFLINE suite, zero dependencies.
 *
 * Guards the delay-gated loading behaviour introduced to fix the measured
 * "you load some data, nothing happens, and then all of a sudden something
 * happens" complaint. Three things are pinned:
 *
 *   1. THE GATE'S DECISION, exhaustively. `shouldShowLoader` and
 *      `settleDelayMs` are pure, so their truth table is tested by
 *      enumeration rather than by example. `createLoadingGate` is driven
 *      with an INJECTED clock and injected timers, so elapsed time is
 *      exact and the suite never sleeps.
 *
 *   2. THE CLASS INVARIANT (§5): no ungated loading placeholder may exist
 *      anywhere under src/public/next/**. Files are enumerated by WALKING
 *      THE DIRECTORY — never a hardcoded list, because a hardcoded list is
 *      exactly how guards in this repo have gone blind before (v3.9.1's
 *      MCP stdout check covered 4 of 33 files on its own import graph).
 *      Legitimate long-wait loaders are carried in an explicit EXEMPT
 *      table, each with a written reason, and every exemption must MATCH
 *      SOMETHING or the suite fails — a stale exemption is a silent hole.
 *
 *   3. THE TWO BEHAVIOURAL FIXES (§6, §7), by EXECUTING the real functions
 *      lifted out of the live source with `new Function` (the technique
 *      scripts/test-next-provider-rows.js and -model-fallback.js use), not
 *      by asserting that a line of source exists. "A test that proves a
 *      line exists proves nothing about what it does."
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  · The delay: no loader for work finishing under LOADER_DELAY_MS.
 *  · The clamp: a loader that HAS appeared stays LOADER_MIN_VISIBLE_MS,
 *    and the finished result is held back until it has.
 *  · The two constants are distinct, ordered, and not swapped.
 *  · cancel() clears armed timers, and a timer that fires after cancel()
 *    neither paints nor calls back.
 *  · Counted begin()/settle(): concurrent loads share one gate correctly.
 *  · No loading-ish string literal under src/public/next/** outside a
 *    loaderHtml()/gatedLoader() call or the EXEMPT table.
 *  · Chat never asserts "you have no domains" before boot() concluded.
 *  · The health report survives re-entry (stale-while-revalidate) AND is
 *    refused when its recorded slug is not the domain being rendered —
 *    both layers, independently.
 *  · Every view that owns a gate cancels it in its teardown.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · THE MIN-VISIBLE CLAMP IS DELAY-ONLY IN THREE PLACES: settings.js's
 *    four section loaders, mcp-wizard.js's loadAll, and
 *    shared-brain-wizard.js's populateDomains all commit their state and
 *    paint from several branches of their own, so a result landing between
 *    200 ms and 600 ms paints through the clamp instead of waiting it out.
 *    All three were measured at ~2-3 ms, so the loader never appears there
 *    at all — but the gap is real and this suite does not test for it.
 *  · Only SINGLE-QUOTED string literals are scanned in §5. A loading
 *    placeholder written with a template literal or double quotes is
 *    invisible to it. Neither form appears in this tree today, and the
 *    scan reports how many literals it examined so a collapse to zero is
 *    visible, but the shape is a real hole.
 *  · §5's "is it gated" test is LINE-SCOPED: it asks whether
 *    loaderHtml(/gatedLoader( appears on the same source line. A call
 *    split across lines would read as ungated (fail-safe — a false
 *    positive that blocks CI, never a false negative).
 *  · §5 cannot see whether a gated call is reached CONDITIONALLY. A view
 *    that called gatedLoader() with a gate that is always visible would
 *    pass. §3's behavioural coverage of the gate is what makes that
 *    uninteresting, but it is not the same guarantee.
 *  · TIMER HYGIENE IS SOURCE-SCANNED in §8, not executed. The suite proves
 *    each teardown CONTAINS a cancel call; it cannot prove that teardown
 *    runs, nor that no other timer was left behind. Driving real view
 *    teardowns would need a DOM and the whole shell.
 *  · Nothing here measures real rendering. The before/after layout numbers
 *    in the release notes come from a browser; a `scrollHeight` delta is
 *    not reproducible in Node, and `PerformanceObserver`'s layout-shift
 *    entries are useless for this defect anyway (the movement happens
 *    inside a scroll container via innerHTML replacement, which reports
 *    ZERO layout shifts).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOADER_DELAY_MS, LOADER_MIN_VISIBLE_MS,
  shouldShowLoader, settleDelayMs, createLoadingGate,
  loaderHtml, gatedLoader, settleGate,
} from '../src/public/next/shared/loading-gate.js';

// §7 executes the REAL renderHealthPanel through `new Function`, so every
// identifier that function references has to be handed in by name. When
// views/domains.js adopted the shared text system, the three renderers below
// became such identifiers and this suite CRASHED with a bare ReferenceError
// rather than failing — the hand-listed-dependency blind spot v3.11.0 records
// (a new module-level helper makes the suite die instead of go red).
//
// They are imported REAL rather than stubbed: shared/text.js deliberately
// takes no imports so that it stays executable in Node, and passing the true
// renderers means §7's assertions keep observing what the panel actually
// paints instead of a marker chosen by this file.
import {
  renderReadoutGroup, renderDescription, renderStatus,
} from '../src/public/next/shared/text.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── A deterministic fake clock + timer queue ─────────────────────────────
// The gate takes now/setTimer/clearTimer as dependencies precisely so this
// exists: elapsed time is exact, and the suite never sleeps.
function fakeScheduler() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    /** Advance the clock, firing every timer due at or before the new time,
     *  in due order (a timer armed by a callback can fire in the same run). */
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let next = null;
        for (const [id, e] of timers) if (e.at <= target && (next === null || e.at < timers.get(next).at)) next = id;
        if (next === null) break;
        const e = timers.get(next);
        timers.delete(next);
        t = e.at;
        e.fn();
      }
      t = target;
    },
    get armedCount() { return timers.size; },
  };
}

function makeGate(extra) {
  const s = fakeScheduler();
  const changes = [];
  const gate = createLoadingGate({
    onChange: () => changes.push(s.now()),
    now: s.now, setTimer: s.setTimer, clearTimer: s.clearTimer,
    ...(extra || {}),
  });
  return { s, gate, changes };
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  Pure core — shouldShowLoader (exhaustive around the boundary)');

ok(LOADER_DELAY_MS === 200, 'LOADER_DELAY_MS is 200');
ok(LOADER_MIN_VISIBLE_MS === 400, 'LOADER_MIN_VISIBLE_MS is 400');
// M3: swapping the two constants must be detectable, so they must differ
// AND be ordered. A suite that only checked "both are numbers" would stay
// green on a swap.
ok(LOADER_DELAY_MS !== LOADER_MIN_VISIBLE_MS, 'the two constants are distinct');
ok(LOADER_MIN_VISIBLE_MS > LOADER_DELAY_MS,
  'min-visible exceeds the delay (a clamp shorter than the delay cannot prevent a strobe)');

for (let e = 0; e <= 400; e += 1) {
  const want = e >= 200;
  if (shouldShowLoader(e) !== want) { ok(false, `shouldShowLoader(${e}) should be ${want}`); break; }
}
ok(shouldShowLoader(199) === false, '199 ms → no loader');
ok(shouldShowLoader(200) === true, '200 ms → loader (boundary is inclusive)');
ok(shouldShowLoader(201) === true, '201 ms → loader');
ok(shouldShowLoader(0) === false, '0 ms → no loader');
ok(shouldShowLoader(1e9) === true, 'very long wait → loader');
ok(shouldShowLoader(50, 10) === true, 'custom threshold honoured (50 >= 10)');
ok(shouldShowLoader(5, 10) === false, 'custom threshold honoured (5 < 10)');
for (const bad of [NaN, Infinity, -Infinity, null, undefined, 'x', {}, []]) {
  ok(shouldShowLoader(bad) === false, `non-finite elapsed ${String(bad)} → false (fail-safe)`);
}
ok(shouldShowLoader(500, NaN) === false, 'non-finite threshold → false (fail-safe)');

// ═════════════════════════════════════════════════════════════════════════
section('§2  Pure core — settleDelayMs (exhaustive)');

ok(settleDelayMs(null, 12345) === 0, 'never shown → nothing to hold back');
ok(settleDelayMs(undefined, 12345) === 0, 'undefined shownAt → 0');
ok(settleDelayMs(200, 200) === 400, 'shown this instant → hold the full 400 ms');
ok(settleDelayMs(200, 250) === 350, 'shown at 200, now 250 → hold 350 more (release at 600)');
ok(settleDelayMs(200, 599) === 1, 'one millisecond left');
ok(settleDelayMs(200, 600) === 0, 'exactly at the boundary → release now');
ok(settleDelayMs(200, 601) === 0, 'past the boundary → release now, never negative');
ok(settleDelayMs(200, 99999) === 0, 'long past → 0, never negative');
ok(settleDelayMs(200, 250, 0) === 0, 'zero clamp → never holds');
ok(settleDelayMs(200, 250, 1000) === 950, 'custom clamp honoured');
for (const bad of [NaN, Infinity, 'x', {}]) {
  ok(settleDelayMs(bad, 100) === 0, `non-finite shownAt ${String(bad)} → 0`);
  ok(settleDelayMs(100, bad) === 0, `non-finite now ${String(bad)} → 0`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  Controller — the full behavioural truth table');

{ // fast work: the measured case at all 13 sites
  const { s, gate, changes } = makeGate();
  let painted = null;
  gate.begin();
  s.advance(199);
  ok(gate.visible === false, 'at 199 ms the loader has NOT appeared');
  gate.settle(() => { painted = s.now(); });
  ok(painted === 199, 'resolving at 199 ms paints IMMEDIATELY — nothing is delayed');
  ok(changes.length === 0, 'and onChange never fired: no render was forced');
  s.advance(5000);
  ok(gate.visible === false, 'the armed show-timer was cancelled, not merely ignored');
  ok(s.armedCount === 0, 'no timer left behind');
  ok(changes.length === 0, 'still no onChange after 5 s');
}

{ // exactly at the boundary
  const { s, gate } = makeGate();
  gate.begin();
  s.advance(200);
  ok(gate.visible === true, 'at exactly 200 ms the loader HAS appeared');
}

{ // the clamp: shown at 200, resolves at 250, must stay until 600
  const { s, gate, changes } = makeGate();
  let painted = null;
  gate.begin();
  s.advance(210);
  ok(gate.visible === true, 'loader shown by 210 ms');
  ok(changes.length === 1 && changes[0] === 200, 'onChange fired once, at exactly 200 ms');
  s.advance(40);                      // now 250
  gate.settle(() => { painted = s.now(); });
  ok(painted === null, 'work finishing at 250 ms does NOT paint yet — the clamp holds it');
  ok(gate.visible === true, 'and the loader is still up at 250 ms');
  s.advance(349);                     // now 599
  ok(painted === null, 'still held at 599 ms');
  ok(gate.visible === true, 'loader still up at 599 ms');
  s.advance(1);                       // now 600 = 200 + 400
  ok(painted === 600, 'released at exactly 600 ms — shownAt(200) + minVisible(400)');
  ok(gate.visible === false, 'loader hidden at release');
  ok(changes.length === 2, 'onChange fired exactly twice: show, then hide');
  ok(s.armedCount === 0, 'no timer left behind after release');
}

{ // shown, then a long wait: no artificial delay is ever added
  const { s, gate } = makeGate();
  let painted = null;
  gate.begin();
  s.advance(900);
  gate.settle(() => { painted = s.now(); });
  ok(painted === 900, 'a loader already past its minimum releases with ZERO extra delay');
}

{ // counted begin/settle — several loads sharing one gate
  const { s, gate } = makeGate();
  const order = [];
  gate.begin(); gate.begin();
  s.advance(250);
  ok(gate.visible === true, 'loader up while two loads are outstanding');
  gate.settle(() => order.push('first@' + s.now()));
  ok(order[0] === 'first@250', 'the first settle paints immediately — other work is still running');
  ok(gate.visible === true, 'and the loader stays up for the outstanding load');
  s.advance(100);                     // now 350
  gate.settle(() => order.push('second@' + s.now()));
  ok(order.length === 1, 'the LAST settle is the one the clamp applies to');
  s.advance(249);                     // now 599
  ok(order.length === 1, 'still held at 599 ms — the clamp is measured from when the loader APPEARED (200), not from the last settle');
  s.advance(1);                       // now 600
  ok(order[1] === 'second@600', 'released at 600 = shownAt(200) + minVisible(400)');
  ok(gate.visible === false, 'loader hidden once the last load released');
}

{ // re-arm during the hold: a new load must keep the loader up
  const { s, gate } = makeGate();
  let a = null, b = null;
  gate.begin();
  s.advance(210);
  gate.settle(() => { a = s.now(); });   // held until 600
  gate.begin();                          // new work arrives during the hold
  s.advance(500);                        // past 600
  ok(a !== null, 'the held paint still ran');
  ok(gate.visible === true, 'loader STAYS up — new work took over during the hold');
  gate.settle(() => { b = s.now(); });
  ok(b !== null, 'the new work paints');
  ok(gate.visible === false, 'and the loader finally goes down');
}

{ // cancel() — teardown
  const { s, gate, changes } = makeGate();
  let painted = false;
  gate.begin();
  s.advance(100);
  ok(s.armedCount === 1, 'a show-timer is armed at 100 ms');
  gate.cancel();
  ok(s.armedCount === 0, 'cancel() CLEARS the armed timer');
  s.advance(10000);
  ok(gate.visible === false, 'no loader ever appears after cancel()');
  ok(changes.length === 0, 'cancel() never fires onChange');
  gate.settle(() => { painted = true; });
  ok(painted === false, 'settle() after cancel() does NOT paint — a torn-down view must not repaint');
  gate.begin();
  s.advance(10000);
  ok(gate.visible === false, 'a cancelled gate stays dead: begin() after cancel() is inert');
  ok(gate.cancel() === undefined && s.armedCount === 0, 'cancel() is idempotent');
}

{ // cancel DURING the min-visible hold: the held paint must be abandoned
  const { s, gate } = makeGate();
  let painted = false;
  gate.begin();
  s.advance(210);
  gate.settle(() => { painted = true; });
  ok(painted === false, 'paint is being held');
  ok(s.armedCount === 1, 'a hold-timer is armed');
  gate.cancel();
  ok(s.armedCount === 0, 'cancel() clears the HOLD timer too, not just the show timer');
  s.advance(10000);
  ok(painted === false, 'the held paint never runs after teardown');
}

{ // settle() with no callback, and with a non-function, must not throw
  const { s, gate } = makeGate();
  gate.begin(); s.advance(300);
  let threw = false;
  try { gate.settle(); gate.settle(null); gate.settle(42); } catch { threw = true; }
  ok(threw === false, 'settle() tolerates a missing or non-function callback');
}

{ // a stray settle() with nothing outstanding must not underflow
  const { s, gate } = makeGate();
  let n = 0;
  gate.settle(() => n++); gate.settle(() => n++);
  ok(gate.pending === 0, 'pending never goes negative');
  gate.begin(); s.advance(250);
  ok(gate.visible === true, 'and the gate still works normally afterwards');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  Markup helpers');

ok(/role="status"/.test(loaderHtml('x')), 'loaderHtml carries role="status" for assistive tech');
ok(loaderHtml().includes('Loading…'), 'loaderHtml defaults to "Loading…"');
ok(loaderHtml('Hi').includes('Hi'), 'loaderHtml uses the supplied label');
ok(loaderHtml('Hi').includes('class="view-body"'), 'loaderHtml defaults to the view-body class');
ok(loaderHtml('Hi', 'sidebar-hint').includes('class="sidebar-hint"'), 'loaderHtml honours a custom class');
// HONESTY DOCTRINE: this component must never imply measurable progress.
for (const bad of ['%', 'width:', 'progress', 'aria-valuenow', 'pring-', '<progress']) {
  ok(!loaderHtml('Loading…').toLowerCase().includes(bad.toLowerCase()),
    `loaderHtml emits no faux-progress affordance ("${bad}")`);
}

ok(gatedLoader(null, 'x') === '', 'gatedLoader(null) → empty (a missing gate shows nothing)');
ok(gatedLoader(undefined, 'x') === '', 'gatedLoader(undefined) → empty');
{
  const { s, gate } = makeGate();
  gate.begin();
  ok(gatedLoader(gate, 'x') === '', 'gatedLoader before the delay → empty');
  s.advance(250);
  ok(gatedLoader(gate, 'x').includes('x'), 'gatedLoader after the delay → markup');
  gate.cancel();
  ok(gatedLoader(gate, 'x') === '', 'gatedLoader after cancel → empty');
}
{ // settleGate degrades to painting, never to silence
  let painted = false;
  settleGate(null, () => { painted = true; });
  ok(painted === true, 'settleGate(null) paints immediately — a missing gate must not strand content');
  painted = false;
  settleGate(undefined, () => { painted = true; });
  ok(painted === true, 'settleGate(undefined) paints immediately');
  let threw = false;
  try { settleGate(null); } catch { threw = true; }
  ok(threw === false, 'settleGate tolerates a missing callback');
  const { s, gate } = makeGate();
  gate.begin(); s.advance(10);
  let p2 = false;
  settleGate(gate, () => { p2 = true; });
  ok(p2 === true, 'settleGate with a real gate delegates to settle()');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  CLASS INVARIANT — no ungated loading placeholder under src/public/next/**');

/** Recursive walk. NEVER a hardcoded file list: a hardcoded list is how a
 *  guard in this repo went blind before, and a new view added next month
 *  must be covered without anyone remembering to add it here. */
function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkJs(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Loaders that are CORRECT and must stay. Each entry: the file's path
 *  suffix, a substring that identifies the occurrence, and WHY it is
 *  exempt. Measured lifetimes are from a real browser against a 3,376-page
 *  domain. An exemption that stops matching fails the suite — a stale
 *  exemption is a hole nobody can see. */
const EXEMPT = [
  { file: 'shared/loading-gate.js', needle: 'Loading…',
    why: 'the gate module\'s own default label — the single source the whole tree renders through' },
  { file: 'next/app.js', needle: 'reader-loading',
    why: 'reader overlay: measured 63 ms warm / 295-322 ms cold — a real wait, and on the KEEP list' },
  { file: 'views/domains.js', needle: '<div class="dm-health-body">Scanning…</div>',
    why: 'health scan: measured ~654 ms. Deliberately NOT gated — an honest indicator for a genuinely long wait. The skeleton this earns is a separate change with its own proof.' },
  { file: 'views/domains.js', needle: "buttonRingHtml() + ' Scanning…'",
    why: 'Rescan BUTTON label during a user-initiated scan, not a view-entry placeholder' },
  { file: 'views/domains.js', needle: "rescan: 'Scanning the wiki…'",
    why: 'progress label for a user-initiated action' },
  { file: 'views/domains.js', needle: "'semanticPreview:' + key",
    why: 'Preview-diff BUTTON label during a user-initiated LLM call (seconds)' },
  { file: 'views/mcp-wizard.js', needle: 'Checking your setup…',
    why: 'lives inside panelLoading(), which ships HIDDEN and is revealed only by the gate — asserted below, so this exemption is not taken on trust' },
  { file: 'views/settings.js', needle: "state.quickLoading ? 'Scanning…'",
    why: 'System-check BUTTON label during a user-initiated scan' },
  // RE-ANCHORED, not widened, when views/shared.js adopted shared/text.js.
  // The markup was `<div class="sb-card-cohort-row sb-card-cohort-note">
  // Loading…</div>`; it is now the shared description role. Same call site,
  // same wait, same reason — the exemption going red on the stale needle is
  // the mechanism working, since a stale exemption is a hole nobody can see.
  { file: 'views/shared.js', needle: "renderDescription('Loading…')",
    why: 'cohort details: a network round-trip to the shared GitHub repo (seconds)' },
  { file: 'views/shared.js', needle: 'Loading the contributor list',
    why: 'member directory: a network round-trip to the shared GitHub repo (seconds)' },
];
const exemptHits = new Array(EXEMPT.length).fill(0);

const LOADING_TOKEN = /(Loading|Scanning|Checking your setup)/;
const files = walkJs(NEXT);
// A walk that finds nothing passes everything. Pin the floor.
ok(files.length >= 15, `the walk found ${files.length} .js files under src/public/next (>= 15)`);
ok(files.some(f => f.endsWith('views/domains.js')), 'the walk reaches views/domains.js');
ok(files.some(f => f.endsWith('shared/loading-gate.js')), 'the walk reaches shared/loading-gate.js');
ok(files.some(f => f.endsWith('next/app.js')), 'the walk reaches the shell app.js');

let literalsScanned = 0, loadingLiterals = 0, gatedCount = 0;
const offenders = [];
for (const p of files) {
  const src = readFileSync(p, 'utf8');
  const lines = src.split('\n');
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
    literalsScanned++;
    if (!LOADING_TOKEN.test(m[1])) continue;
    loadingLiterals++;
    const lineNo = src.slice(0, m.index).split('\n').length;
    const line = lines[lineNo - 1];
    if (/\b(loaderHtml|gatedLoader)\s*\(/.test(line)) { gatedCount++; continue; }
    const rel = relative(ROOT, p).replace(/\\/g, '/');
    const i = EXEMPT.findIndex(e => rel.endsWith(e.file) && line.includes(e.needle));
    if (i >= 0) { exemptHits[i]++; continue; }
    offenders.push(`${rel}:${lineNo}  ${line.trim().slice(0, 90)}`);
  }
}
ok(literalsScanned > 2000, `scanned ${literalsScanned} string literals (a collapse to ~0 would silently pass everything)`);
ok(loadingLiterals >= 20, `found ${loadingLiterals} loading-ish literals to classify`);
ok(gatedCount >= 12, `${gatedCount} of them route through loaderHtml()/gatedLoader() (the 13 replaced sites)`);
ok(offenders.length === 0,
  offenders.length ? `UNGATED loading placeholder(s):\n      ${offenders.join('\n      ')}` : 'no ungated loading placeholder anywhere under src/public/next/**');
for (let i = 0; i < EXEMPT.length; i++) {
  ok(exemptHits[i] > 0, `EXEMPT entry still matches something: ${EXEMPT[i].file} / "${EXEMPT[i].needle}" (${EXEMPT[i].why})`);
}

// The mcp-wizard exemption above claims its panel ships hidden. Prove it,
// rather than taking the comment's word: if that class is dropped, the
// panel flashes on every open again and the exemption becomes false.
{
  const mw = readFileSync(join(NEXT, 'views/mcp-wizard.js'), 'utf8');
  ok(/id="mcpw-panel-loading" class="mcpw-panel mcpw-hidden"/.test(mw),
    'mcp-wizard: the loading panel ships HIDDEN, so it can only appear via the gate');
  // The loading phase must be reachable ONLY from the gate's onChange —
  // exactly one call site, and it must sit inside that callback.
  const showLoadingCalls = [...mw.matchAll(/showPhase\('loading'/g)];
  ok(showLoadingCalls.length === 1, `mcp-wizard: exactly one showPhase('loading') call site (found ${showLoadingCalls.length})`);
  const gateBlock = /loadGate = createLoadingGate\(\{[\s\S]*?\n  \}\);/.exec(mw);
  ok(!!gateBlock && gateBlock[0].includes("showPhase('loading'"),
    'mcp-wizard: that call site is INSIDE the gate\'s onChange, so the panel cannot appear un-gated');
  ok(/loadGate\.begin\(\)/.test(mw), 'mcp-wizard: the gate is started at open');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  BEHAVIOURAL — Chat never claims "no domains" before boot concluded');

/** Brace-matched extraction of a real function from live source. Throws
 *  loudly on a desync rather than producing a confusing SyntaxError later.
 *  (Same helper as scripts/test-next-provider-rows.js.) */
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start), parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  return out;
}

const chatSrc = readFileSync(join(NEXT, 'views/chat.js'), 'utf8');
const domainsSrc = readFileSync(join(NEXT, 'views/domains.js'), 'utf8');

{
  // The REAL renderMain, executed. Only the two zero-domain branches are
  // reached by these fixtures, so the rest of the view needs no fixture.
  const fn = new Function(
    'state', 'bootGate', 'isCurrentMount', 'setMain', 'eyebrow', 'gatedLoader',
    'icon', 'navigate', 'document',
    extractFunction(chatSrc, 'renderMain', 'chat.js') + '\nreturn renderMain;'
  );
  const run = (state, gate) => {
    let html = null;
    const rm = fn(
      state, gate,
      () => true,
      (h) => { html = h; },
      (t) => `<eyebrow>${t}</eyebrow>`,
      gatedLoader,                                   // the REAL gate helper
      () => '<icon/>',
      () => {},
      { getElementById: () => null }
    );
    rm(1);
    return html;
  };

  const FALSE_CLAIM = /needs at least one domain/;

  // (a) THE DEFECT: pre-boot, zero domains, gate not yet fired.
  const g1 = makeGate(); g1.gate.begin();
  let html = run({ booted: false, loadError: null, domains: [] }, g1.gate);
  ok(html !== null, 'pre-boot: renderMain still paints (the column is never left untouched)');
  ok(!FALSE_CLAIM.test(html), 'pre-boot: does NOT claim "needs at least one domain" — the defect');
  ok(html.includes('Chat'), 'pre-boot: the chrome (title) IS painted, so the column does not blank');
  ok(html.includes('eyebrow'), 'pre-boot: the eyebrow is painted too');
  ok(!html.includes('role="status"'), 'pre-boot, gate not fired: no loader either — nothing flashes');

  // (b) same, once the wait has earned a loader
  g1.s.advance(250);
  html = run({ booted: false, loadError: null, domains: [] }, g1.gate);
  ok(html.includes('role="status"'), 'pre-boot past 200 ms: a loader appears');
  ok(!FALSE_CLAIM.test(html), 'pre-boot past 200 ms: still no false claim');

  // (c) boot concluded with genuinely zero domains → the REAL empty state
  html = run({ booted: true, loadError: null, domains: [] }, g1.gate);
  ok(FALSE_CLAIM.test(html), 'post-boot with zero domains: the real empty state IS shown');
  ok(html.includes('chat-goto-domains'), 'post-boot: and it offers the route to Domains');

  // (d) a boot that FAILED must not sit on a loader — loadError is excluded
  //     from the guard precisely so the failure surfaces.
  html = run({ booted: false, loadError: 'server down', domains: [] }, g1.gate);
  ok(!html.includes('role="status"'), 'boot error: falls through to a real frame, never a loader');
  ok(FALSE_CLAIM.test(html), 'boot error: renders the concluded branch (the error itself shows in the sidebar)');

  // (e) domains exist → the guard must not intercept, booted or not
  let reached = false;
  try {
    run({ booted: false, loadError: null, domains: [{ slug: 'a' }], activeDomain: 'a' }, g1.gate);
  } catch { reached = true; }   // it dives into the full render and hits an unstubbed dep
  ok(reached, 'with domains present the pre-boot guard does NOT intercept — it falls through to the real render');
}

// The finally-backstop: `booted` must be flipped from a settle inside a
// .finally(), so no boot outcome can strand a new user on a loader.
ok(/\.finally\(\(\) => \{[\s\S]{0,900}?state\.booted = true;/.test(chatSrc),
  'chat: state.booted is flipped inside a .finally() backstop');
ok(/settleGate\(bootGate,/.test(chatSrc), 'chat: the backstop goes through the gate, honouring the clamp');

// ═════════════════════════════════════════════════════════════════════════
section('§7  BEHAVIOURAL — health stale-while-revalidate, and the slug gate');

{
  const keepFn = new Function(
    extractFunction(domainsSrc, 'shouldKeepHealthOnReload', 'domains.js') + '\nreturn shouldKeepHealthOnReload;'
  )();
  const REPORT = { counts: {}, scannedAt: 1 };

  // LAYER 1 — the re-entry decision.
  ok(keepFn(REPORT, 'articles', 'articles') === true, 'keeps a report scanned for THIS domain');
  ok(keepFn(REPORT, 'articles', 'business') === false,
    'REFUSES a report scanned for a DIFFERENT domain (the correctness half — showing A under B is worse than the flicker)');
  ok(keepFn(null, 'articles', 'articles') === false, 'no report → nothing to keep');
  ok(keepFn(REPORT, null, 'articles') === false, 'a report with no recorded slug is never trusted');
  ok(keepFn(REPORT, 'articles', null) === false, 'no target slug → refuse');
  ok(keepFn(REPORT, undefined, undefined) === false, 'undefined on both sides does NOT compare equal');
  ok(keepFn(REPORT, '', '') === false, 'empty-string slugs do NOT compare equal');
  ok(keepFn('a report', 'articles', 'articles') === false, 'a non-object report is refused');
  ok(keepFn(REPORT, 'Articles', 'articles') === false, 'slug comparison is exact, not case-insensitive');
}

{
  // The REAL renderHealthPanel, executed. Everything it composes is stubbed
  // to a marker so the assertions are about ITS branching, not the stubs'.
  const deps = {
    icon: () => '', escapeHtml: (x) => String(x), pluralize: (n, w) => `${n} ${w}`,
    relTime: () => 'just now', buttonRingHtml: () => '<RING/>',
    totalOpenIssues: () => 6, renderBanner: () => '', renderMirrorNote: () => '',
    renderQuickMaintenance: () => '<QUICK/>', renderAiProgressRing: () => '',
    renderConfirmCard: () => '', renderPendingPlan: () => '',
    activeSemanticScan: () => null, renderSemanticScanResult: () => '',
    renderIssueGroups: () => '<GROUPS/>',
    HEALTH_CATEGORIES: [{ key: 'brokenLinks', label: 'Broken links' }],
    inFlightWriteSlugs: new Set(),
    renderReadoutGroup, renderDescription, renderStatus,
  };
  const names = Object.keys(deps);
  const fn = new Function(
    'state', ...names,
    extractFunction(domainsSrc, 'shouldKeepHealthOnReload', 'domains.js') + '\n' +
    extractFunction(domainsSrc, 'renderHealthPanel', 'domains.js') + '\nreturn renderHealthPanel;'
  );
  const render = (state) => fn(state, ...names.map(n => deps[n]))({ slug: 'articles' }, false);

  const REPORT = { counts: { entities: 1, concepts: 2, summaries: 3, dismissed: 0 }, scannedAt: 1, brokenLinks: [] };
  const COLLAPSED = /dm-health-body">Scanning…/;
  // The open-issue total, which totalOpenIssues is stubbed to report as 6.
  // It used to be the literal 'Found 6 issues'; the panel now renders it as a
  // READOUT rather than a prose sentence, so the needle follows the figure
  // instead of the wording. The property being guarded is unchanged and is
  // the one that matters: whether THIS domain's cached figures are on screen.
  // The four sibling counts are 1/2/3/0, so this matches only the total.
  const FIGURES = /tx-readout-value">6</;

  // THE DEFECT: re-entry used to null the report and collapse the panel.
  let h = render({ healthLoading: true, health: REPORT, healthSlug: 'articles', healthError: null, busyKey: null, expandedGroups: new Set() });
  ok(!COLLAPSED.test(h), 'rescan with a cached report for THIS domain does NOT collapse to "Scanning…"');
  ok(FIGURES.test(h), 'the cached figures stay on screen');
  ok(h.includes('Re-scanning… showing the previous result'),
    'and they are LABELLED as the previous scan — the figures stay useful, nothing claims they are current');
  ok(h.includes('<RING/>'), 'the Rescan control shows the scan is running');

  // M7 — THE CORRECTNESS HALF. Layer 2 must refuse a foreign report even
  // if layer 1 were ever removed. Without this, "keep stale data" is worse
  // than the bug it fixes.
  h = render({ healthLoading: true, health: REPORT, healthSlug: 'business', healthError: null, busyKey: null, expandedGroups: new Set() });
  ok(COLLAPSED.test(h), 'a report scanned for ANOTHER domain is refused — collapses to "Scanning…" instead');
  ok(!FIGURES.test(h), 'and that domain\'s figures are NOT rendered under this heading');

  // settled state
  h = render({ healthLoading: false, health: REPORT, healthSlug: 'articles', healthError: null, busyKey: null, expandedGroups: new Set() });
  ok(FIGURES.test(h), 'settled: the report renders');
  ok(!h.includes('Re-scanning…'), 'settled: no stale marker');

  // a settled foreign report renders NOTHING rather than the wrong domain's
  h = render({ healthLoading: false, health: REPORT, healthSlug: 'business', healthError: null, busyKey: null, expandedGroups: new Set() });
  ok(!FIGURES.test(h), 'settled + foreign slug: renders nothing rather than another domain\'s figures');

  // first-ever scan, nothing cached
  h = render({ healthLoading: true, health: null, healthSlug: null, healthError: null, busyKey: null, expandedGroups: new Set() });
  ok(COLLAPSED.test(h), 'cold scan with nothing cached: "Scanning…" is still shown (an honest 654 ms wait)');

  // an error still wins over stale data
  h = render({ healthLoading: false, health: REPORT, healthSlug: 'articles', healthError: 'boom', busyKey: null, expandedGroups: new Set() });
  ok(h.includes('boom'), 'a failed rescan surfaces the error');
  ok(!FIGURES.test(h), 'and does NOT leave stale figures sitting under it implying success');
}

// ── §7b — THE RESET ITSELF, executed ─────────────────────────────────────
// M6 CAUGHT A HOLE HERE. The first version of this suite tested the
// predicate and the renderer but never loadHealth's own reset, so the
// mutation that reinstates the exact shipped bug — `state.health = null`
// unconditionally on re-entry — left it 206/0 GREEN. A guard that cannot
// fail on the bug it was written for is worse than no guard, so the reset
// is now driven directly.
{
  const deps = {
    resetDomainScopedHealthState: () => {},
    totalOpenIssues: () => 6,
    loadEstimates: () => Promise.resolve(),
    reportAsyncActionFailure: () => {},
    isCurrentMount: () => true,
    render: () => {},
    // Never resolves: we assert on the SYNCHRONOUS half of loadHealth, the
    // part that runs before its first await. That is exactly the reset
    // being guarded, and it keeps the test free of async sequencing.
    fetchJSON: () => new Promise(() => {}),
  };
  const names = Object.keys(deps);
  const build = new Function('state', ...names,
    extractFunction(domainsSrc, 'loadHealth', 'domains.js') + '\nreturn loadHealth;');

  const REPORT = { counts: {}, scannedAt: 1 };
  const freshState = () => ({
    activeSlug: 'articles', health: REPORT, healthSlug: 'articles',
    healthError: 'old error', healthLoading: false, healthStale: false,
    healthSummary: {}, aiAvailable: false,
  });

  // (a) THE FIX: a caller that says keep must keep.
  let st = freshState();
  build(st, ...names.map(n => deps[n]))('articles', 1, { keepHealth: true });
  ok(st.health === REPORT, 'loadHealth with keepHealth: the cached report SURVIVES (the whole stale-while-revalidate fix)');
  ok(st.healthSlug === 'articles', 'and its recorded slug survives with it');
  ok(st.healthStale === true, 'and it is FLAGGED stale rather than silently presented as current');
  ok(st.healthLoading === true, 'while the rescan is marked in flight');
  ok(st.healthError === null, 'a previous error is cleared on a new scan');

  // (b) THE SAFETY DEFAULT: no flag at all — which is what selectDomain,
  //     i.e. every DOMAIN SWITCH, passes — must CLEAR.
  st = freshState();
  build(st, ...names.map(n => deps[n]))('business', 1);
  ok(st.health === null, 'loadHealth with NO flag CLEARS the report — the domain-switch path');
  ok(st.healthSlug === null, 'and clears the recorded slug with it');
  ok(st.healthStale === false, 'and is not marked stale, because nothing is being shown');

  // (c) an explicitly false flag clears too
  st = freshState();
  build(st, ...names.map(n => deps[n]))('business', 1, { keepHealth: false });
  ok(st.health === null, 'keepHealth: false clears');

  // (d) an unrelated opts object must not accidentally read as "keep"
  st = freshState();
  build(st, ...names.map(n => deps[n]))('business', 1, { keepSemanticScan: true });
  ok(st.health === null, 'an opts object carrying only keepSemanticScan does NOT keep health');

  // (e) silent refreshes never touch the report either way
  st = freshState();
  st.healthLoading = false;
  build(st, ...names.map(n => deps[n]))('articles', 1, { silent: true });
  ok(st.health === REPORT, 'a silent refresh leaves the report alone');
  ok(st.healthLoading === false, 'and does not raise the scanning flag');
}

// loadHealth must no longer null the report unconditionally.
ok(!/if \(!silent\) \{ state\.healthLoading = true; state\.healthError = null; state\.health = null; \}/.test(domainsSrc),
  'domains: the unconditional `state.health = null` on re-entry is gone');
// loadHealth takes the keep decision FROM ITS CALLER (the shape
// `keepSemanticScan` already uses), and the default is the SAFE one.
ok(/const keepStale = !!\(opts && opts\.keepHealth\);/.test(domainsSrc),
  'domains: loadHealth reads the keep decision from opts, defaulting to CLEAR');
ok(/keepHealth: shouldKeepHealthOnReload\(state\.health, state\.healthSlug, state\.activeSlug\)/.test(domainsSrc),
  'domains: the re-entry call site evaluates the slug-gated predicate');
// THE SAFETY PROPERTY: a domain SWITCH must pass no keep flag at all, so
// it takes the clearing path. selectDomain is the switch path.
{
  const sd = extractFunction(domainsSrc, 'selectDomain', 'domains.js');
  ok(/loadHealth\(slug, myMountToken\)/.test(sd),
    'domains: selectDomain (the DOMAIN SWITCH path) passes NO keep flag — a switch always clears');
  ok(!/keepHealth/.test(sd), 'domains: selectDomain never asks to keep health across a switch');
  ok(!/keepSemanticScan/.test(sd), 'domains: nor the semantic scan (it authorises a DESTRUCTIVE merge)');
}
ok(/state\.healthSlug = slug;/.test(domainsSrc),
  'domains: a successful scan records WHICH domain it was for');

// ═════════════════════════════════════════════════════════════════════════
section('§8  Timer hygiene — every gate owner cancels in teardown');

const OWNERS = [
  ['views/chat.js', 'bootGate'],
  ['views/domains.js', 'loadGate'],
  ['views/ingest.js', 'loadGate'],
  ['views/settings.js', 'loadGate'],
  ['views/shared.js', 'loadGate'],
  ['views/sync.js', 'loadGate'],
  ['views/mcp-wizard.js', 'loadGate'],
  ['views/shared-brain-wizard.js', 'domainsGate'],
];
for (const [file, handle] of OWNERS) {
  const src = readFileSync(join(NEXT, file), 'utf8');
  ok(src.includes("from '../shared/loading-gate.js'"), `${file}: imports the shared gate (no second copy)`);
  ok(new RegExp(`${handle} = createLoadingGate\\(`).test(src), `${file}: builds its gate`);
  ok(new RegExp(`if \\(${handle}\\) \\{ ${handle}\\.cancel\\(\\); ${handle} = null; \\}`).test(src),
    `${file}: CANCELS ${handle} on teardown — an armed timer must never outlive its mount`);
}
// Nobody may hand-roll a second gate implementation.
for (const p of files) {
  if (p.endsWith('shared/loading-gate.js')) continue;
  const src = readFileSync(p, 'utf8');
  ok(!/function\s+(createLoadingGate|shouldShowLoader|settleDelayMs)\s*\(/.test(src),
    `${relative(ROOT, p)}: does not redeclare a gate primitive (two hand-maintained copies is this repo's named failure shape)`);
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
